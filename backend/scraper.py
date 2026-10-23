import asyncio
import html as html_lib
import json
import random
import re
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

from playwright.async_api import Playwright
from backend import db


def _clean_url(url: str) -> str:
    """Strip query params — IG serves different content with DM-specific params."""
    p = urlparse(url)
    return f"https://www.instagram.com{p.path}"


def _caption_url(url: str) -> str:
    """Return /p/{shortcode}/ — og:description is served reliably here for all post types."""
    p = urlparse(url)
    parts = [x for x in p.path.split("/") if x]
    shortcode = parts[-1] if parts else ""
    return f"https://www.instagram.com/p/{shortcode}/"


def _extract_thumbnail(html: str) -> str:
    for pattern in [
        r'<meta\s+property="og:image"\s+content="([^"]*)"',
        r'<meta\s+content="([^"]*)"\s+property="og:image"',
    ]:
        m = re.search(pattern, html)
        if m:
            return m.group(1)
    return ""


def _extract_caption(html: str) -> str | None:
    # Handle both attribute orderings Instagram uses
    for pattern in [
        r'<meta\s+property="og:description"\s+content="([^"]*)"',
        r'<meta\s+content="([^"]*)"\s+property="og:description"',
    ]:
        m = re.search(pattern, html)
        if m:
            return html_lib.unescape(m.group(1))
    return None


def _find_messages_node(data: dict) -> dict | None:
    d = data.get("data") or {}
    for getter in [
        lambda: d["fetch__SlideThread"]["as_ig_direct_thread"]["slide_messages"],
        lambda: d["fetch__SlideThread"]["as_ig_direct_thread"]["messages"],
        lambda: d["xdt_message_thread"]["messages"],
        lambda: d["message_thread"]["messages"],
        lambda: d["thread"]["messages"],
        lambda: d["get_slide_thread_nullable"]["as_ig_direct_thread"]["slide_messages"],
    ]:
        try:
            node = getter()
            if node:
                return node
        except (KeyError, TypeError):
            continue
    return None


def extract_reels_from_response(data: dict) -> list[dict]:
    reels = []
    messages_node = _find_messages_node(data)
    if not messages_node:
        return reels

    for edge in messages_node.get("edges", []):
        node = edge.get("node", {})
        xma = node.get("xma") or (node.get("content") or {}).get("xma") or {}
        target_url = _clean_url(xma.get("target_url") or xma.get("url") or "")
        if not target_url or "instagram.com" not in target_url:
            continue

        preview = xma.get("preview_image") or xma.get("xmaPreviewImage") or {}
        thumb_url = (preview.get("url") or "") if isinstance(preview, dict) else ""
        sender = xma.get("header_title_text") or xma.get("xmaHeaderTitle") or "unknown"

        ts_ms = int(node.get("timestamp_ms") or node.get("timestamp") or 0)
        ts = (
            datetime.fromtimestamp(ts_ms / (1000 if ts_ms > 1e10 else 1)).strftime("%b %d, %Y %H:%M")
            if ts_ms else ""
        )

        reels.append({
            "url": target_url,
            "thumbnail": thumb_url,
            "caption": "",
            "sender": sender,
            "timestamp": ts,
            "source": "dm",
            "source_label": "_DM_PLACEHOLDER_",  # filled in by caller
        })

    return reels


async def login_and_save_session(playwright: Playwright, data_dir: Path, on_event) -> None:
    on_event({"type": "log", "msg": "No session found — opening browser for login..."})
    browser = await playwright.chromium.launch(headless=False)
    context = await browser.new_context()
    page = await context.new_page()
    await page.goto("https://www.instagram.com/accounts/login/")
    on_event({"type": "log", "msg": "Please log in to Instagram. You have 3 minutes."})

    await page.wait_for_url("https://www.instagram.com/**", timeout=180_000)

    for _ in range(60):
        if "login" not in page.url and "challenge" not in page.url and "two_factor" not in page.url:
            break
        await page.wait_for_timeout(2_000)

    await context.storage_state(path=str(data_dir / "session.json"))
    on_event({"type": "log", "msg": "✓ Session saved. Starting scrape..."})
    await browser.close()


async def scrape_reels(
    playwright: Playwright,
    thread_url: str,
    data_dir: Path,
    on_event,
    source_label: str = "DM",
    known_urls: set[str] | None = None,
    full_scan: bool = False,
) -> list[dict]:
    """Scroll the thread to the top, collecting every shared post.

    Stops after `patience` scroll rounds where no new message page loaded.
    A page of plain text messages still counts as progress, so long stretches
    without reels don't end the scan early. full_scan waits much longer for
    slow loads on very old threads.
    """
    session_file = data_dir / "session.json"
    if not session_file.exists():
        await login_and_save_session(playwright, data_dir, on_event)

    known_urls = known_urls or set()
    all_reels: list[dict] = []
    seen_urls: set[str] = set()
    n_done = 0
    seen_message_ids: set[str] = set()
    patience = 15 if full_scan else 5

    browser = await playwright.chromium.launch(headless=False)
    context = await browser.new_context(
        storage_state=str(session_file),
        viewport={"width": 1280, "height": 900},
    )

    # Caption worker: separate page, runs concurrently with scroll loop
    caption_queue: asyncio.Queue = asyncio.Queue()
    anon_context = await browser.new_context()

    async def caption_worker() -> None:
        nonlocal n_done
        cap_page = await anon_context.new_page()
        while True:
            reel = await caption_queue.get()
            if reel is None:
                break
            try:
                cached = db.get_by_url(reel["url"])
                if cached and cached.get("caption"):
                    reel["caption"] = cached["caption"]
                    on_event({"type": "caption_update", "url": reel["url"], "caption": cached["caption"]})
                    n_done += 1
                    on_event({"type": "log_replace", "replace_id": "cap_progress",
                              "msg": f"↩ [{n_done}/{len(all_reels)}] caption from cache"})
                    continue

                await asyncio.sleep(random.uniform(2.5, 4.5))
                await cap_page.goto(_caption_url(reel["url"]), wait_until="domcontentloaded", timeout=15_000)
                caption = _extract_caption(await cap_page.content())
                n_done += 1
                if caption:
                    reel["caption"] = caption
                    on_event({"type": "caption_update", "url": reel["url"], "caption": caption})
                    on_event({"type": "log_replace", "replace_id": "cap_progress",
                              "msg": f"  [{n_done}/{len(all_reels)}] ✓ caption fetched"})
                else:
                    on_event({"type": "log_replace", "replace_id": "cap_progress",
                              "msg": f"  [{n_done}/{len(all_reels)}] ✗ no caption found"})
            except Exception as exc:
                n_done += 1
                on_event({"type": "log_replace", "replace_id": "cap_progress",
                          "msg": f"  [{n_done}/{len(all_reels)}] ✗ {str(exc)[:80]}"})
            finally:
                caption_queue.task_done()
        await cap_page.close()
        await anon_context.close()

    worker = asyncio.create_task(caption_worker())

    # Main page — DM thread scroll loop
    page = await context.new_page()

    on_event({"type": "log", "msg": "Navigating to thread..."})
    await page.goto(thread_url, wait_until="domcontentloaded", timeout=30_000)

    if "login" in page.url or "accounts" in page.url:
        caption_queue.put_nowait(None)
        await worker
        await browser.close()
        session_file.unlink(missing_ok=True)
        on_event({"type": "error", "msg": "Session expired — re-run to log in again."})
        return []

    on_event({"type": "log", "msg": "Waiting for page to settle..."})
    await page.wait_for_timeout(5_000)

    async def on_response(response) -> None:
        if "api/graphql" not in response.url:
            return
        try:
            body = await response.text()
            if body.startswith("for (;;);"):
                body = body[len("for (;;);"):]
            data = json.loads(body)
            node = _find_messages_node(data)
            for edge in (node or {}).get("edges", []):
                n = edge.get("node") or {}
                mid = n.get("message_id") or n.get("id") or n.get("timestamp_ms")
                if mid:
                    seen_message_ids.add(str(mid))
            reels = extract_reels_from_response(data)
            for r in reels:
                if r["url"] not in seen_urls:
                    seen_urls.add(r["url"])
                    r["source_label"] = source_label
                    all_reels.append(r)
                    if r["url"] not in known_urls:
                        on_event({"type": "reel", "data": r})
                        caption_queue.put_nowait(r)
                    # known URLs are silently counted — shown in scroll status
        except Exception:
            pass

    page.on("response", on_response)

    on_event({"type": "log", "msg": "Scrolling through thread..."})
    vp = page.viewport_size or {"width": 1280, "height": 900}
    await page.mouse.click(vp["width"] // 2, vp["height"] // 2)
    await page.wait_for_timeout(500)

    no_change = 0
    prev_progress = (0, 0)
    mode = "full scan" if full_scan else "scan"

    while no_change < patience:
        for _ in range(6):
            await page.mouse.wheel(0, -800)
            await page.wait_for_timeout(200)
        await page.wait_for_timeout(4_000 if full_scan and no_change else 2_500)

        progress = (len(all_reels), len(seen_message_ids))
        if progress == prev_progress:
            no_change += 1
            if no_change % 3 == 0:
                # Nudge: scroll down a bit and back up to retrigger the loader
                await page.mouse.wheel(0, 1600)
                await page.wait_for_timeout(600)
        else:
            no_change = 0
            prev_progress = progress

        new_count = sum(1 for r in all_reels if r["url"] not in known_urls)
        skip_count = len(all_reels) - new_count
        skip_str = f", {skip_count} skipped" if skip_count else ""
        on_event({"type": "log_replace", "replace_id": "scroll_status",
                  "msg": f"{len(all_reels)} reels in {len(seen_message_ids)} messages ({new_count} new{skip_str}), "
                         f"{caption_queue.qsize()} captions pending… [{mode} {no_change}/{patience}]"})

    on_event({"type": "log_replace", "replace_id": "scroll_status",
              "msg": f"Scroll done — waiting for {caption_queue.qsize()} remaining captions…"})

    # Drain the caption queue before closing
    await caption_queue.join()
    caption_queue.put_nowait(None)  # stop worker
    await worker
    await browser.close()

    new_reels = [r for r in all_reels if r["url"] not in known_urls]
    enriched = sum(1 for r in new_reels if r.get("caption"))
    on_event({"type": "log", "msg": f"Thread done — {len(new_reels)} new reels, {enriched} captions"})

    return all_reels
