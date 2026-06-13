import asyncio
import json
import random
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


def _reel_id(url: str) -> str:
    parts = [p for p in urlparse(url).path.split("/") if p]
    return parts[-1] if parts else url[-12:]


async def _download_via_instaloader(
    url: str, reel_id: str, media_dir: Path, data_dir: Path, on_event
) -> dict | None:
    import instaloader

    L = instaloader.Instaloader(
        download_pictures=True,
        download_videos=True,
        download_video_thumbnails=False,
        save_metadata=False,
        post_metadata_txt_pattern="",
        compress_json=False,
        quiet=True,
    )

    session_path = data_dir / "session.json"
    if session_path.exists():
        try:
            state = json.loads(session_path.read_text())
            ig_cookies = {c["name"]: c["value"]
                          for c in state.get("cookies", [])
                          if "instagram.com" in c.get("domain", "")}
            if ig_cookies:
                L.context._session.cookies.update(ig_cookies)
        except Exception:
            pass

    def _do_download() -> list[Path]:
        post = instaloader.Post.from_shortcode(L.context, reel_id)
        L.download_post(post, target=media_dir)
        return sorted(f for f in media_dir.glob("*")
                      if f.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp", ".mp4"))

    max_retries = 10
    files = None
    for attempt in range(1, max_retries + 1):
        try:
            on_event({"type": "log", "msg": f"instaloader → {reel_id}… (attempt {attempt}/{max_retries})"})
            files = await asyncio.get_event_loop().run_in_executor(None, _do_download)
            break
        except Exception as exc:
            msg = str(exc)
            if attempt < max_retries:
                wait = min(5 * attempt, 60)
                on_event({"type": "log", "msg": f"  ✗ attempt {attempt}: {msg[:120]} — retry in {wait}s"})
                await asyncio.sleep(wait)
            else:
                on_event({"type": "log", "msg": f"  ✗ all {max_retries} attempts failed: {msg[:120]}"})
                return None

    if not files:
        on_event({"type": "log", "msg": "✗ instaloader: no files downloaded"})
        return None

    videos = [f for f in files if f.suffix.lower() == ".mp4"]
    images = [f for f in files if f.suffix.lower() != ".mp4"]

    if videos and not images:
        rel = f"media/{reel_id}/{videos[0].name}"
        on_event({"type": "log", "msg": f"✓ video: {videos[0].name}"})
        return {"video_path": rel, "post_type": "video"}

    rels = [f"media/{reel_id}/{f.name}" for f in (images or files)]
    post_type = "carousel_image" if len(rels) > 1 else "image"
    on_event({"type": "log", "msg": f"✓ {len(rels)} image(s) saved"})
    return {"image_paths": rels, "post_type": post_type}


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

    pending_urls = [r["url"] for r in pending]
    total = len(pending_urls)
    on_event({"type": "transcription_start", "total": total})
    on_event({"type": "log", "msg": f"── Transcripts — {total} pending"})

    # Stage 1: audio download (parallel, semaphore=3)
    on_event({"type": "log", "msg": f"Stage 1/2 — audio download ({total} reels, parallel)"})
    sem = asyncio.Semaphore(3)
    dl_done = 0
    dl_skip = 0
    dl_errors: list[str] = []

    async def _download_one(url: str) -> None:
        nonlocal dl_done, dl_skip
        reel_id = _reel_id(url)
        if list(audio_dir.glob(f"{reel_id}*.mp3")):
            dl_skip += 1
            on_event({"type": "log_replace", "replace_id": "audio_progress",
                      "msg": f"↩ [{dl_done + dl_skip}/{total}] {reel_id} — audio cached"})
            return
        async with sem:
            on_event({"type": "log_group_start", "label": f"[{dl_done + dl_skip + 1}/{total}] audio {reel_id}…"})
            proc = await asyncio.create_subprocess_exec(
                "yt-dlp", url,
                "-x", "--audio-format", "mp3",
                "-o", str(audio_dir / "%(id)s.%(ext)s"),
                "--no-playlist", "--ignore-errors",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
            async for raw in proc.stdout:
                on_event({"type": "log", "msg": raw.decode().rstrip()})
            rc = await proc.wait()
            on_event({"type": "log_group_end", "success": rc == 0})
            if rc != 0:
                dl_errors.append(reel_id)
            else:
                dl_done += 1
            on_event({"type": "log_replace", "replace_id": "audio_progress",
                      "msg": f"[{dl_done + dl_skip}/{total}] audio downloaded"})

    await asyncio.gather(*[_download_one(u) for u in pending_urls])

    summary = f"✓ Audio — {dl_done} downloaded, {dl_skip} cached"
    if dl_errors:
        summary += f", {len(dl_errors)} failed"
    on_event({"type": "log_replace", "replace_id": "audio_progress", "msg": summary})

    try:
        from faster_whisper import WhisperModel  # noqa: F401
    except ImportError:
        on_event({"type": "error", "msg": "faster-whisper not installed — run: pip install faster-whisper"})
        return

    # Stage 2: transcription (sequential — CPU/GPU bound)
    compute_type = "float16" if whisper_device == "cuda" else "int8"
    model = _get_whisper("base", whisper_device, compute_type)

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
                    on_event({"type": "log", "msg": "  ffmpeg not found — falling back to yt-dlp"})

    ytdlp_log: list[str] = []
    if not mp3_path.exists():
        on_event({"type": "log_group_start", "label": f"Downloading audio for {reel_id} via yt-dlp…"})
        proc = await asyncio.create_subprocess_exec(
            "yt-dlp", url,
            "-x", "--audio-format", "mp3",
            "-o", str(audio_dir / "%(id)s.%(ext)s"),
            "--no-playlist", "--ignore-errors",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        async for line in proc.stdout:
            decoded = line.decode().rstrip()
            ytdlp_log.append(decoded)
            on_event({"type": "log", "msg": decoded})
        rc = await proc.wait()
        on_event({"type": "log_group_end", "success": rc == 0})

    mp3_files = list(audio_dir.glob(f"{reel_id}*.mp3"))
    if not mp3_files:
        joined = " ".join(ytdlp_log)
        if "429" in joined:
            on_event({"type": "error", "msg": "Instagram rate-limited yt-dlp (429) — wait a few minutes and retry."})
        elif "login" in joined.lower() or "private" in joined.lower():
            on_event({"type": "error", "msg": "Reel is private or requires login — audio unavailable."})
        elif ytdlp_log:
            on_event({"type": "error", "msg": "yt-dlp failed — reel may be deleted or unsupported."})
        else:
            on_event({"type": "error", "msg": f"No audio source found for {reel_id} — no local video and yt-dlp unavailable."})
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
                return {"video_path": cached["video_path"], "post_type": cached.get("post_type", "video")}
        if cached.get("image_paths"):
            paths = cached["image_paths"]
            if isinstance(paths, list) and all((data_dir / p).exists() for p in paths):
                on_event({"type": "log", "msg": f"↩ already in cache — {len(paths)} image(s)"})
                return {"image_paths": paths, "post_type": cached.get("post_type", "carousel_image")}

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
