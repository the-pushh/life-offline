"""
Saved posts scraper — lightbox arrow-navigation approach.

Strategy:
1. Navigate to /{username}/saved/all-posts/
2. Click the FIRST grid thumbnail to open the lightbox
3. Loop: extract data → skip carousel slides → ArrowRight to next post → repeat
4. Stop when ArrowRight produces no URL change
"""

import json
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

from playwright.async_api import Playwright

from backend.scraper import _clean_url, login_and_save_session


# ── API metadata parser ────────────────────────────────────────────────────────

def _parse_api_metadata(data: dict) -> dict[str, dict]:
    """Extract url→metadata from API/GraphQL responses."""
    meta: dict[str, dict] = {}
    items: list[dict] = []

    if "items" in data:
        for item in data.get("items", []):
            items.append(item.get("media") or item)

    d = data.get("data", {})
    for key in (
        "xdt_api__v1__feed__saved__connection",
        "xdt_api__v1__feed__saved",
        "xdt_api__v1__feed__collection__media",
    ):
        node = d.get(key)
        if not node:
            continue
        for edge in (node.get("edges", []) if isinstance(node, dict) else []):
            items.append(edge.get("node", {}))

    for media in items:
        code = media.get("code") or media.get("shortcode")
        if not code:
            continue

        url = f"https://www.instagram.com/reel/{code}/"

        images = media.get("image_versions2") or {}
        candidates = images.get("candidates", []) if isinstance(images, dict) else []
        thumb = (
            candidates[0].get("url", "") if candidates
            else media.get("display_url") or media.get("thumbnail_src") or ""
        )

        user = media.get("user") or media.get("owner") or {}
        author = user.get("username") or user.get("full_name") or ""

        ts_s = int(media.get("taken_at") or media.get("timestamp") or 0)
        ts = datetime.fromtimestamp(ts_s).strftime("%b %d, %Y %H:%M") if ts_s else ""

        # Carousel / post type detection
        media_type_code = int(media.get("media_type") or 0)
        if media_type_code == 8:
            carousel_items: list[dict] = []
            for cm in media.get("carousel_media", []):
                cm_type = int(cm.get("media_type") or 1)
                if cm_type == 2:  # video
                    vv = cm.get("video_versions", [])
                    carousel_items.append({"type": "video", "dl_url": vv[0]["url"] if vv else ""})
                else:  # image
                    imgs = (cm.get("image_versions2") or {}).get("candidates", [])
                    carousel_items.append({"type": "image", "dl_url": imgs[0]["url"] if imgs else ""})
            all_types = {c["type"] for c in carousel_items}
            post_type = "carousel_video" if all_types == {"video"} else "carousel_image"
        elif media_type_code == 2:
            post_type = "video"
            carousel_items = []
        else:
            post_type = "image"
            carousel_items = []

        meta[url] = {
            "thumbnail": thumb,
            "sender": author,
            "timestamp": ts,
            "post_type": post_type,
            "carousel_items": carousel_items,
        }

    return meta


# ── URL helpers ────────────────────────────────────────────────────────────────

def _canonical(url: str) -> str | None:
    parts = [p for p in urlparse(url).path.split("/") if p]
    for i, part in enumerate(parts):
        if part in ("reel", "p") and i + 1 < len(parts):
            return f"https://www.instagram.com/{part}/{parts[i + 1]}/"
    return None


def _author_from_url(url: str) -> str:
    """/{author}/reel/{code}/ → author username, else empty string."""
    parts = [p for p in urlparse(url).path.split("/") if p]
    if len(parts) >= 2 and parts[1] in ("reel", "p"):
        return parts[0]
    return ""


# ── DOM extractors ─────────────────────────────────────────────────────────────

_CAPTION_JS = """
() => {
    const dialog = document.querySelector('div[role="dialog"]');
    if (!dialog) return '';
    const ul = dialog.querySelector('article ul');
    if (!ul) return '';
    const li = ul.firstElementChild;
    if (!li) return '';
    const walker = document.createTreeWalker(li, NodeFilter.SHOW_TEXT);
    const parts = [];
    let node;
    while ((node = walker.nextNode())) {
        if (!node.parentElement.closest('a')) {
            const t = node.textContent.trim();
            if (t) parts.push(t);
        }
    }
    return parts.join(' ').trim();
}
"""

_AUTHOR_JS = """
() => {
    const dialog = document.querySelector('div[role="dialog"]');
    if (!dialog) return '';
    const header = dialog.querySelector('article header');
    if (!header) return '';
    for (const link of header.querySelectorAll('a[href]')) {
        const m = link.getAttribute('href').match(/^\\/([A-Za-z0-9._]+)\\/?$/);
        if (m) return m[1];
    }
    return '';
}
"""

_OG_IMAGE_JS = (
    "() => { const m = document.querySelector('meta[property=\"og:image\"]');"
    " return m ? m.content : ''; }"
)


async def _safe_eval(page, js: str, default="") -> str:
    try:
        return await page.evaluate(js) or default
    except Exception:
        return default


# ── Navigation ─────────────────────────────────────────────────────────────────

async def _navigate_to_next_post(page, on_event=None) -> bool:
    """Skip carousel slides, then navigate to next post.
    Uses canonical URL comparison (ignores ?img_index=N) so carousel slide
    changes don't get mistaken for post navigation.
    Retries with patience windows for Instagram's batch lazy-loading."""
    prev_canon = _canonical(page.url)

    # Skip carousel slides — only stop when Next is gone OR canonical URL changes
    had_carousel = False
    for _ in range(30):
        btn = await page.query_selector('button[aria-label="Next"]')
        if not btn:
            break
        had_carousel = True
        await btn.click()
        await page.wait_for_timeout(400)
        new_canon = _canonical(page.url)
        if new_canon and new_canon != prev_canon:
            return True  # Next button navigated to a different post

    # Re-focus dialog so ArrowRight hits lightbox navigation, not carousel container
    if had_carousel:
        await page.evaluate("""
            () => {
                const d = document.querySelector('div[role="dialog"]');
                if (d) { d.setAttribute('tabindex', '-1'); d.focus(); }
            }
        """)
        await page.wait_for_timeout(300)
        new_canon = _canonical(page.url)
        if new_canon and new_canon != prev_canon:
            return True

    # Navigate to next post — retry with backoff for Instagram's batch lazy-loading
    for attempt in range(3):
        await page.keyboard.press("ArrowRight")
        for _ in range(10):
            await page.wait_for_timeout(500)
            new_canon = _canonical(page.url)
            if new_canon and new_canon != prev_canon:
                return True
        if attempt < 2:
            await page.wait_for_timeout(3_000)

    return False


# ── Main ───────────────────────────────────────────────────────────────────────

async def scrape_saved_posts(
    playwright: Playwright,
    username: str,
    data_dir: Path,
    on_event,
    source_label: str = "Saved",
    known_urls: set[str] | None = None,
) -> list[dict]:
    session_file = data_dir / "session.json"
    if not session_file.exists():
        await login_and_save_session(playwright, data_dir, on_event)

    browser = await playwright.chromium.launch(headless=False)
    context = await browser.new_context(
        storage_state=str(session_file),
        viewport={"width": 1280, "height": 900},
    )
    page = await context.new_page()

    api_meta: dict[str, dict] = {}

    async def on_response(response) -> None:
        url = response.url
        if "feed/saved" not in url and "graphql" not in url and "/api/v1/" not in url:
            return
        try:
            body = await response.text()
            if body.startswith("for (;;);"):
                body = body[len("for (;;);"):]
            api_meta.update(_parse_api_metadata(json.loads(body)))
        except Exception:
            pass

    page.on("response", on_response)

    # ── Load grid ──────────────────────────────────────────────────────────────
    saved_url = f"https://www.instagram.com/{username}/saved/all-posts/"
    on_event({"type": "log", "msg": f"Loading saved posts for @{username}..."})
    await page.goto(saved_url, wait_until="domcontentloaded", timeout=30_000)

    if "login" in page.url or "accounts" in page.url:
        await browser.close()
        session_file.unlink(missing_ok=True)
        on_event({"type": "error", "msg": "Session expired — re-run to log in again."})
        return []

    # Wait for grid posts to actually render (lazy-loaded, can take 5-10 s)
    on_event({"type": "log", "msg": "Waiting for saved posts grid to load..."})
    try:
        await page.wait_for_selector(
            'a[href*="/reel/"], a[href*="/p/"]',
            timeout=20_000,
        )
    except Exception:
        # Selector timed out — scroll once to trigger lazy load and wait again
        on_event({"type": "log", "msg": "Grid slow — scrolling to trigger load..."})
        await page.mouse.wheel(0, 600)
        await page.wait_for_timeout(4_000)

    # Small extra pause so more thumbnails render beyond just the first
    await page.wait_for_timeout(2_000)

    # Click FIRST grid post — try img/video child first, fall back to main/article scope
    handle = await page.evaluate_handle("""
        () => {
            const re = /\\/(reel|p)\\/[A-Za-z0-9_-]+/;
            // Preferred: a link containing an img or video (avoids nav/header links)
            const withMedia = Array.from(document.querySelectorAll('a'))
                .find(a => re.test(a.href) && a.querySelector('img, video'));
            if (withMedia) return withMedia;
            // Fallback: any reel/post link inside main content
            return Array.from(document.querySelectorAll('main a, article a, section a, div[role="main"] a'))
                .find(a => re.test(a.href)) || null;
        }
    """)
    first_el = handle.as_element()
    if not first_el:
        on_event({"type": "log", "msg": "No saved reel thumbnails found in grid."})
        await browser.close()
        return []

    on_event({"type": "log", "msg": "Opening first saved post..."})
    await first_el.click()
    await page.wait_for_timeout(2_500)

    # ── Lightbox loop ──────────────────────────────────────────────────────────
    known_urls = known_urls or set()
    all_reels: list[dict] = []
    seen: set[str] = set()
    stall = 0
    consecutive_empty = 0

    while stall < 2:
        await page.wait_for_timeout(400)
        current_url = page.url
        canon = _canonical(current_url)
        if not canon:
            break

        if canon in seen:
            stall += 1
        else:
            stall = 0
            seen.add(canon)

            is_known = canon in known_urls
            partial = api_meta.get(canon, {})

            author = (
                partial.get("sender")
                or _author_from_url(current_url)
                or await _safe_eval(page, _AUTHOR_JS)
                or "unknown"
            )

            caption = await _safe_eval(page, _CAPTION_JS)
            thumbnail = partial.get("thumbnail") or await _safe_eval(page, _OG_IMAGE_JS)

            # Detect Instagram rate-limiting: lightbox stops rendering real data
            is_empty = author == "unknown" and not thumbnail and not caption
            if is_empty:
                consecutive_empty += 1
                if consecutive_empty >= 5:
                    on_event({"type": "log", "msg": f"⚠ Instagram stopped serving data after {len(all_reels)} posts (rate limited) — stopping scrape."})
                    break
                # Skip storing/emitting garbage entries
                moved = await _navigate_to_next_post(page, on_event)
                if not moved:
                    break
                continue
            else:
                consecutive_empty = 0

            reel: dict = {
                "url": canon,
                "thumbnail": thumbnail,
                "caption": caption,
                "sender": author,
                "timestamp": partial.get("timestamp", ""),
                "source": "saved",
                "source_label": source_label,
                "post_type": partial.get("post_type", "video"),
                "carousel_items": partial.get("carousel_items", []),
            }
            all_reels.append(reel)

            if is_known:
                on_event({"type": "log_replace", "replace_id": "saved_skip",
                          "msg": f"  ↩ [{len(all_reels)}] @{author} already scraped"})
            else:
                on_event({"type": "reel", "data": reel})
                pt = reel["post_type"]
                n_items = len(reel["carousel_items"])
                lbl = f" [{pt}, {n_items} items]" if n_items else f" [{pt}]"
                on_event({
                    "type": "log",
                    "msg": f"  [{len(all_reels)}] @{author}{lbl} {'✓' if caption else '✗ no caption'}",
                })

        moved = await _navigate_to_next_post(page, on_event)
        if not moved:
            break

    await browser.close()
    on_event({"type": "log", "msg": f"Saved posts done — {len(all_reels)} reels"})
    return all_reels
