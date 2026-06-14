import asyncio
import json
import random
import re
from pathlib import Path
from urllib.parse import urlparse

from playwright.async_api import async_playwright
from backend.scraper import _extract_caption, _clean_url, _caption_url
from backend import db

_whisper_cache: dict = {}


def _get_whisper(model_size: str, device: str, compute_type: str):
    key = (model_size, device, compute_type)
    if key not in _whisper_cache:
        from faster_whisper import WhisperModel
        _whisper_cache[key] = WhisperModel(model_size, device=device, compute_type=compute_type)
    return _whisper_cache[key]


_SHORTCODE_RE = re.compile(r'^[A-Za-z0-9_\-]{6,}$')

def _reel_id(url: str) -> str:
    parts = [p for p in urlparse(url).path.split("/") if p]
    candidate = parts[-1] if parts else ""
    return candidate if _SHORTCODE_RE.match(candidate) else ""


async def _download_via_instaloader(
    url: str, reel_id: str, media_dir: Path, data_dir: Path, on_event
) -> dict | None:
    if not reel_id:
        on_event({"type": "log", "msg": f"✗ cannot extract shortcode from URL: {url}"})
        return None

    import instaloader

    def _make_loader(with_session: bool = False) -> "instaloader.Instaloader":
        L = instaloader.Instaloader(
            download_pictures=True,
            download_videos=True,
            download_video_thumbnails=True,
            save_metadata=False,
            post_metadata_txt_pattern="",
            compress_json=False,
            quiet=True,
        )
        if with_session:
            session_file = data_dir / "session.json"
            if session_file.exists():
                try:
                    state = json.loads(session_file.read_text())
                    ig_cookies = {c["name"]: c["value"]
                                  for c in state.get("cookies", [])
                                  if "instagram.com" in c.get("domain", "")}
                    if ig_cookies:
                        L.context._session.cookies.update(ig_cookies)
                except Exception:
                    pass
        return L

    def _do_download(L) -> list[Path]:
        import contextlib, os
        with open(os.devnull, "w") as _null:
            with contextlib.redirect_stderr(_null):
                post = instaloader.Post.from_shortcode(L.context, reel_id)
                L.download_post(post, target=media_dir)
        return sorted(f for f in media_dir.glob("*")
                      if f.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp", ".mp4"))

    files = None

    # ── Phase 1: anonymous (3 attempts, 5s between) ───────────────────────────
    L_anon = _make_loader(with_session=False)
    anon_ok = False
    for attempt in range(1, 4):
        try:
            on_event({"type": "log", "msg": f"instaloader → {reel_id}… (attempt {attempt}/3)"})
            files = await asyncio.get_event_loop().run_in_executor(None, lambda: _do_download(L_anon))
            anon_ok = True
            break
        except Exception as exc:
            msg = str(exc)
            if attempt < 3:
                on_event({"type": "log", "msg": f"  ✗ attempt {attempt}: {msg[:120]} — retry in 5s"})
                await asyncio.sleep(5)
            else:
                on_event({"type": "log", "msg": f"  ✗ anonymous failed: {msg[:120]} — trying with session…"})

    # ── Phase 2: authenticated fallback (2 attempts, 5s between) ─────────────
    if not anon_ok:
        session_file = data_dir / "session.json"
        if not session_file.exists():
            on_event({"type": "log", "msg": "  ✗ no saved session — run scrape to log in first"})
            return None

        L_auth = _make_loader(with_session=True)
        for attempt in range(1, 3):
            try:
                on_event({"type": "log", "msg": f"  ↻ session attempt {attempt}/2…"})
                files = await asyncio.get_event_loop().run_in_executor(None, lambda: _do_download(L_auth))
                on_event({"type": "log", "msg": f"  ✓ downloaded via session"})
                break
            except Exception as exc:
                msg = str(exc)
                if attempt < 2:
                    on_event({"type": "log", "msg": f"  ✗ session attempt {attempt}: {msg[:120]} — retry in 5s"})
                    await asyncio.sleep(5)
                else:
                    on_event({"type": "log", "msg": f"  ✗ session failed: {msg[:120]}"})
                    return None

    if not files:
        on_event({"type": "log", "msg": "✗ instaloader: no files downloaded"})
        return None

    videos = [f for f in files if f.suffix.lower() == ".mp4"]
    images = [f for f in files if f.suffix.lower() != ".mp4"]

    if videos:
        # Video post — any jpg alongside it is the cover thumbnail
        video_rel = f"media/{reel_id}/{videos[0].name}"
        thumb = f"media/{reel_id}/{images[0].name}" if images else None
        on_event({"type": "log", "msg": f"✓ video: {videos[0].name}"})
        result: dict = {"video_path": video_rel, "post_type": "video"}
        if thumb:
            result["thumbnail"] = thumb
        return result

    rels = [f"media/{reel_id}/{f.name}" for f in images]
    post_type = "carousel_image" if len(rels) > 1 else "image"
    thumb = f"media/{reel_id}/{images[0].name}" if images else None
    on_event({"type": "log", "msg": f"✓ {len(rels)} image(s) saved"})
    result = {"image_paths": rels, "post_type": post_type}
    if thumb:
        result["thumbnail"] = thumb
    return result


async def enrich_captions(data_dir: Path, on_event, url_filter: list[str] | None = None) -> None:
    pending = db.get_pending_captions()
    if url_filter:
        url_set = set(url_filter)
        pending = [r for r in pending if r["url"] in url_set]
    total = db.count()

    if not pending:
        on_event({"type": "log", "msg": "↩ all captions already fetched"})
        on_event({"type": "done", "stage": "captions", "count": total})
        return

    n = len(pending)
    on_event({"type": "log", "msg": f"── Captions — {n} pending, {total - n} already done"})

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=False)
        context = await browser.new_context()
        page = await context.new_page()

        fetched = 0
        failed = 0
        for idx, reel in enumerate(pending):
            on_event({"type": "log_replace", "replace_id": "caption_progress",
                      "msg": f"[{idx + 1}/{n}] fetching @{reel.get('sender', '')[:20]}…"})
            try:
                await asyncio.sleep(random.uniform(3.0, 6.0))
                try:
                    await page.goto(_caption_url(reel["url"]), wait_until="domcontentloaded", timeout=15_000)
                except Exception as exc:
                    msg = str(exc)
                    if "429" in msg or "ERR_HTTP_RESPONSE_CODE_FAILURE" in msg:
                        on_event({"type": "log", "msg": "⏳ rate limited — waiting 45s"})
                        await asyncio.sleep(45)
                        try:
                            await page.goto(_caption_url(reel["url"]), wait_until="domcontentloaded", timeout=15_000)
                        except Exception:
                            on_event({"type": "log", "msg": f"✗ [{idx+1}/{n}] retry failed"})
                            failed += 1
                            continue
                    else:
                        on_event({"type": "log", "msg": f"✗ [{idx+1}/{n}] {msg[:80]}"})
                        failed += 1
                        continue
                caption = _extract_caption(await page.content())
                if caption:
                    db.update_caption(reel["url"], caption)
                    fetched += 1
                    on_event({"type": "caption_update", "url": reel["url"], "caption": caption})
                else:
                    failed += 1
            except Exception as exc:
                on_event({"type": "log", "msg": f"✗ [{idx+1}/{n}] {exc}"})
                failed += 1

        await browser.close()

    enriched = db.count_with_captions()
    on_event({"type": "log_replace", "replace_id": "caption_progress",
              "msg": f"✓ Captions — {fetched}/{n} fetched, {failed} failed, {enriched}/{total} total"})
    on_event({"type": "done", "stage": "captions", "count": enriched})


async def enrich_transcripts(data_dir: Path, whisper_device: str, on_event, url_filter: list[str] | None = None) -> None:
    audio_dir = data_dir / "audio"
    audio_dir.mkdir(exist_ok=True)

    pending = db.get_pending_transcripts()
    if url_filter:
        url_set = set(url_filter)
        pending = [r for r in pending if r["url"] in url_set]
    if not pending:
        on_event({"type": "log", "msg": "↩ all transcripts already done"})
        on_event({"type": "done", "stage": "transcripts", "count": 0})
        return

    total = len(pending)
    on_event({"type": "transcription_start", "total": total})
    on_event({"type": "log", "msg": f"── Transcripts — {total} pending"})

    # Stage 1: extract audio from local video files via ffmpeg
    on_event({"type": "log", "msg": f"Stage 1/2 — extracting audio ({total} reels)"})
    ext_done = 0
    ext_skip = 0

    for i, reel in enumerate(pending):
        reel_id = _reel_id(reel["url"])
        mp3_path = audio_dir / f"{reel_id}.mp3"

        if mp3_path.exists():
            on_event({"type": "log_replace", "replace_id": "audio_progress",
                      "msg": f"↩ [{i + 1}/{total}] {reel_id} — audio cached"})
            ext_done += 1
            continue

        video_path = reel.get("video_path")
        if not video_path or not (data_dir / video_path).exists():
            on_event({"type": "log_replace", "replace_id": "audio_progress",
                      "msg": f"✗ [{i + 1}/{total}] {reel_id} — no local video, download media first"})
            ext_skip += 1
            continue

        on_event({"type": "log_replace", "replace_id": "audio_progress",
                  "msg": f"[{i + 1}/{total}] extracting audio {reel_id}…"})
        try:
            proc = await asyncio.create_subprocess_exec(
                "ffmpeg", "-i", str(data_dir / video_path), "-vn", "-acodec", "mp3", "-y", str(mp3_path),
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await proc.wait()
            if mp3_path.exists():
                ext_done += 1
            else:
                ext_skip += 1
        except FileNotFoundError:
            on_event({"type": "error", "msg": "ffmpeg not found — install ffmpeg to enable transcripts"})
            on_event({"type": "done", "stage": "transcripts", "count": 0})
            return

    summary = f"✓ Audio — {ext_done} ready"
    if ext_skip:
        summary += f", {ext_skip} skipped (download media first)"
    on_event({"type": "log_replace", "replace_id": "audio_progress", "msg": summary})

    try:
        from faster_whisper import WhisperModel  # noqa: F401
    except ImportError:
        on_event({"type": "error", "msg": "faster-whisper not installed — run: pip install faster-whisper"})
        return

    # Stage 2: transcription (sequential — CPU/GPU bound)
    compute_type = "float16" if whisper_device == "cuda" else "int8"
    model = _get_whisper("base", whisper_device, compute_type)

    pending_urls = [r["url"] for r in pending]
    available = [(url, list(audio_dir.glob(f"{_reel_id(url)}*.mp3"))) for url in pending_urls]
    available = [(url, mp3s) for url, mp3s in available if mp3s]
    n_avail = len(available)
    on_event({"type": "log", "msg": f"Stage 2/2 — transcribing {n_avail}/{total} reels with Whisper"})

    done_count = 0
    for url, mp3_files in available:
        reel_id = _reel_id(url)
        on_event({"type": "transcribing_url", "url": url})
        on_event({"type": "log_replace", "replace_id": "transcribe_progress",
                  "msg": f"[{done_count + 1}/{n_avail}] transcribing {reel_id}…"})
        segments, _ = model.transcribe(str(mp3_files[0]))
        text = " ".join(seg.text.strip() for seg in segments)
        db.update_transcript(url, text)
        on_event({"type": "transcript_update", "id": reel_id, "transcript": text, "url": url})
        done_count += 1
        on_event({"type": "transcription_progress", "current": done_count, "total": n_avail})

    on_event({"type": "log_replace", "replace_id": "transcribe_progress",
              "msg": f"✓ Transcripts — {done_count}/{n_avail} done"})
    on_event({"type": "done", "stage": "transcripts", "count": done_count})


async def enrich_one_caption(url: str, data_dir: Path, on_event) -> None:
    reel = db.get_by_url(url)
    if not reel:
        on_event({"type": "error", "msg": f"Reel not found: {url}"})
        return

    on_event({"type": "log", "msg": f"Re-fetching caption for {url[:60]}..."})
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=False)
        context = await browser.new_context()
        page = await context.new_page()
        try:
            try:
                await page.goto(_caption_url(url), wait_until="domcontentloaded", timeout=15_000)
            except Exception as exc:
                msg = str(exc)
                if "ERR_HTTP_RESPONSE_CODE_FAILURE" in msg:
                    on_event({"type": "log", "msg": f"  ✗ reel unavailable (deleted or private): {_caption_url(url)}"})
                else:
                    on_event({"type": "log", "msg": f"  ✗ navigation failed: {msg[:120]}"})
                return
            caption = _extract_caption(await page.content())
            if caption:
                db.update_caption(url, caption)
                on_event({"type": "caption_update", "url": url, "caption": caption})
                on_event({"type": "log", "msg": "  ✓ caption fetched"})
            else:
                on_event({"type": "log", "msg": "  ✗ page loaded but no caption found"})
        except Exception as exc:
            on_event({"type": "log", "msg": f"  ✗ {exc}"})
        finally:
            await browser.close()

    on_event({"type": "done", "stage": "captions", "count": 1})


async def enrich_one_transcript(url: str, data_dir: Path, whisper_device: str, on_event) -> None:
    reel = db.get_by_url(url)
    if not reel:
        on_event({"type": "error", "msg": f"Reel not found: {url}"})
        return

    reel_id = _reel_id(url)
    audio_dir = data_dir / "audio"
    audio_dir.mkdir(exist_ok=True)
    mp3_path = audio_dir / f"{reel_id}.mp3"

    on_event({"type": "transcription_start", "total": 1})

    if not mp3_path.exists():
        local_video = reel.get("video_path")
        if local_video:
            video_full = data_dir / local_video
            if video_full.exists():
                on_event({"type": "log", "msg": "Extracting audio from local video..."})
                try:
                    proc = await asyncio.create_subprocess_exec(
                        "ffmpeg", "-i", str(video_full), "-vn", "-acodec", "mp3", "-y", str(mp3_path),
                        stdout=asyncio.subprocess.DEVNULL,
                        stderr=asyncio.subprocess.DEVNULL,
                    )
                    await proc.wait()
                except FileNotFoundError:
                    on_event({"type": "error", "msg": "ffmpeg not found — install ffmpeg to enable transcripts"})
                    on_event({"type": "done", "stage": "transcripts", "count": 0})
                    return

    mp3_files = list(audio_dir.glob(f"{reel_id}*.mp3"))
    if not mp3_files:
        on_event({"type": "error", "msg": f"No audio for {reel_id} — download media first, then retry transcripts."})
        on_event({"type": "done", "stage": "transcripts", "count": 0})
        return

    mp3 = mp3_files[0]
    on_event({"type": "log", "msg": f"Transcribing {mp3.name}…"})

    try:
        from faster_whisper import WhisperModel  # noqa: F401
    except ImportError:
        on_event({"type": "error", "msg": "faster-whisper not installed — run: pip install faster-whisper"})
        return

    compute_type = "float16" if whisper_device == "cuda" else "int8"
    model = _get_whisper("base", whisper_device, compute_type)
    segments, _ = model.transcribe(str(mp3))
    text = " ".join(seg.text.strip() for seg in segments)

    db.update_transcript(url, text)
    on_event({"type": "transcript_update", "id": reel_id, "transcript": text})
    on_event({"type": "transcription_progress", "current": 1, "total": 1})
    on_event({"type": "log", "msg": f"  ✓ transcript done ({len(text)} chars)"})
    on_event({"type": "done", "stage": "transcripts", "count": 1})


async def download_video_file(url: str, data_dir: Path, on_event) -> dict | None:
    reel_id = _reel_id(url)
    media_dir = data_dir / "media" / reel_id
    media_dir.mkdir(parents=True, exist_ok=True)

    # Check DB cache first — verify file still exists
    cached = db.get_by_url(url)
    if cached:
        if cached.get("video_path"):
            p = data_dir / cached["video_path"]
            if p.exists():
                on_event({"type": "log", "msg": f"↩ already in cache — {cached['video_path']}"})
                result: dict = {"video_path": cached["video_path"], "post_type": cached.get("post_type", "video")}
                if cached.get("thumbnail"):
                    result["thumbnail"] = cached["thumbnail"]
                return result
        if cached.get("image_paths"):
            paths = cached["image_paths"]
            if isinstance(paths, list) and all((data_dir / p).exists() for p in paths):
                on_event({"type": "log", "msg": f"↩ already in cache — {len(paths)} image(s)"})
                thumb = cached.get("thumbnail") or (paths[0] if paths else None)
                result = {"image_paths": paths, "post_type": cached.get("post_type", "carousel_image")}
                if thumb:
                    result["thumbnail"] = thumb
                return result

    # Filesystem fallback for files not yet in DB
    existing = sorted(media_dir.glob("*.*"))
    if existing:
        videos = [f for f in existing if f.suffix in (".mp4", ".webm", ".mkv", ".mov")]
        images = [f for f in existing if f.suffix in (".jpg", ".jpeg", ".png", ".webp")]
        if videos:
            rel = f"media/{reel_id}/{videos[0].name}"
            result = {"video_path": rel, "post_type": "video"}
            on_event({"type": "log", "msg": f"↩ found on disk — {rel}"})
            db.update_media(url, **result)
            return result
        if images:
            rels = [f"media/{reel_id}/{f.name}" for f in images]
            result = {"image_paths": rels, "post_type": "carousel_image"}
            on_event({"type": "log", "msg": f"↩ found on disk — {len(images)} image(s)"})
            db.update_media(url, **result)
            return result

    legacy = list((data_dir / "videos").glob(f"{reel_id}.*"))
    if legacy:
        rel = f"videos/{legacy[0].name}"
        result = {"video_path": rel, "post_type": "video"}
        on_event({"type": "log", "msg": f"↩ found in legacy videos/ — {rel}"})
        db.update_media(url, **result)
        return result

    result = await _download_via_instaloader(url, reel_id, media_dir, data_dir, on_event)
    if not result:
        on_event({"type": "log", "msg": f"✗ download failed for {reel_id}"})
        return None

    db.update_media(url, **result)
    return result
