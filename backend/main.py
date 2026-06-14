import asyncio
import json
import os
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from backend import db
from backend.scraper import scrape_reels
from backend.saved_posts import scrape_saved_posts
from backend.enricher import (
    enrich_captions,
    enrich_transcripts,
    enrich_one_caption,
    enrich_one_transcript,
    download_video_file,
)
from playwright.async_api import async_playwright

DATA_DIR = Path(os.getenv("DATA_DIR", "data"))
DATA_DIR.mkdir(exist_ok=True)
(DATA_DIR / "videos").mkdir(exist_ok=True)
(DATA_DIR / "media").mkdir(exist_ok=True)
(DATA_DIR / "audio").mkdir(exist_ok=True)
(DATA_DIR / "transcripts").mkdir(exist_ok=True)

db.init(DATA_DIR)

WHISPER_DEVICE = os.getenv("WHISPER_DEVICE", "cpu")
THREAD_URL_DEFAULT = os.getenv("THREAD_URL", "")

app = FastAPI(title="LifeOffline")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:3001"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_jobs: dict[str, asyncio.Queue] = {}
_current_job: str | None = None
_current_task: asyncio.Task | None = None
_download_lock = asyncio.Lock()


class ScrapeRequest(BaseModel):
    thread_url: str | None = None
    sources: list[dict] | None = None
    download_media: bool = False


class SingleReelRequest(BaseModel):
    url: str


class DownloadAllRequest(BaseModel):
    source_label: str | None = None
    urls: list[str] | None = None


class EnrichRequest(BaseModel):
    urls: list[str] | None = None


async def scrape_sources(
    playwright,
    sources: list[dict],
    data_dir: Path,
    on_event,
    download_media: bool = False,
) -> None:
    seen_urls: set[str] = db.get_urls()
    all_new: list[dict] = []

    dm_sources = [s for s in sources if s.get("type", "dm") == "dm"]
    n_dm = len(dm_sources)
    dm_idx = 0

    for source in sources:
        stype = source.get("type", "dm")

        if stype == "dm":
            url = source.get("url", "").strip()
            if not url:
                continue
            default_label = "DM" if n_dm == 1 else f"DM {dm_idx + 1}"
            label = source.get("name", "").strip() or default_label
            dm_idx += 1
            on_event({"type": "log", "msg": f"── {label}: {url[:60]}"})
            new_reels = await scrape_reels(playwright, url, data_dir, on_event, source_label=label, known_urls=seen_urls)
        elif stype == "saved":
            username = source.get("username", "").strip().lstrip("@")
            if not username:
                continue
            label = source.get("name", "").strip() or "Saved"
            on_event({"type": "log", "msg": f"── Saved Posts: @{username}"})
            new_reels = await scrape_saved_posts(
                playwright, username, data_dir, on_event, source_label=label, known_urls=seen_urls
            )
        else:
            continue

        for r in new_reels:
            is_new = r["url"] not in seen_urls
            seen_urls.add(r["url"])
            db.upsert(r)  # always upsert — ensures source_label is updated on re-scrape
            if is_new:
                all_new.append(r)

    if download_media and all_new:
        n_dl = len(all_new)
        on_event({"type": "log", "msg": f"── Media download — {n_dl} new reels"})
        dl_ok = 0
        for i, reel in enumerate(all_new):
            on_event({"type": "log_replace", "replace_id": "dl_progress",
                      "msg": f"[{i + 1}/{n_dl}] {reel['url'].split('/')[-2]}…"})
            on_event({"type": "download_progress", "current": i + 1, "total": n_dl})
            result = await download_video_file(reel["url"], data_dir, on_event)
            if result:
                on_event({"type": "reel_update", "url": reel["url"], "media": result})
                dl_ok += 1
        on_event({"type": "log_replace", "replace_id": "dl_progress",
                  "msg": f"✓ Media — {dl_ok}/{n_dl} downloaded"})

    total = db.count()
    enriched = db.count_with_captions()
    on_event({"type": "log", "msg": f"✓ All done — {len(all_new)} new reels ({total} total), {enriched} captions"})
    on_event({"type": "done", "stage": "scrape", "count": len(all_new)})


async def _run_job(job_id: str, coro) -> None:
    global _current_job, _current_task
    queue = _jobs[job_id]
    _current_job = job_id
    try:
        await coro(queue)
    except asyncio.CancelledError:
        queue.put_nowait({"type": "error", "msg": "Job cancelled"})
    except Exception as exc:
        queue.put_nowait({"type": "error", "msg": str(exc)})
    finally:
        queue.put_nowait(None)
        _current_job = None
        _current_task = None


def _start_job(coro_factory) -> str:
    global _current_task
    job_id = uuid4().hex[:8]
    _jobs[job_id] = asyncio.Queue()
    _current_task = asyncio.create_task(_run_job(job_id, coro_factory))
    return job_id


@app.post("/api/scrape")
async def start_scrape(req: ScrapeRequest):
    if _current_job:
        return JSONResponse({"error": "A job is already running"}, status_code=409)

    if req.sources:
        sources = req.sources
    elif req.thread_url:
        sources = [{"type": "dm", "url": req.thread_url}]
    else:
        return JSONResponse({"error": "Provide thread_url or sources"}, status_code=400)

    async def run(q: asyncio.Queue):
        async with async_playwright() as pw:
            await scrape_sources(pw, sources, DATA_DIR, q.put_nowait, download_media=req.download_media)

    return {"job_id": _start_job(run)}


@app.post("/api/enrich/captions")
async def start_captions(req: EnrichRequest = EnrichRequest()):
    if _current_job:
        return JSONResponse({"error": "A job is already running"}, status_code=409)

    async def run(q: asyncio.Queue):
        await enrich_captions(DATA_DIR, q.put_nowait, url_filter=req.urls)

    return {"job_id": _start_job(run)}


@app.post("/api/enrich/transcripts")
async def start_transcripts(req: EnrichRequest = EnrichRequest()):
    if _current_job:
        return JSONResponse({"error": "A job is already running"}, status_code=409)

    async def run(q: asyncio.Queue):
        await enrich_transcripts(DATA_DIR, WHISPER_DEVICE, q.put_nowait, url_filter=req.urls)

    return {"job_id": _start_job(run)}


@app.post("/api/enrich/download-all")
async def start_download_all(req: DownloadAllRequest):
    if _current_job:
        return JSONResponse({"error": "A job is already running"}, status_code=409)

    async def run(q: asyncio.Queue):
        from urllib.parse import urlparse
        def _sid(url: str) -> str:
            parts = [p for p in urlparse(url).path.split("/") if p]
            return parts[-1] if parts else url[-12:]

        if req.urls:
            all_reels = db.get_all()
            url_set = set(req.urls)
            targets = [r for r in all_reels if r["url"] in url_set]
        else:
            targets = db.get_without_media(req.source_label)
        total = len(targets)
        if not targets:
            q.put_nowait({"type": "log", "msg": "↩ all media already downloaded"})
            q.put_nowait({"type": "done", "count": 0})
            return

        label = f" ({req.source_label})" if req.source_label else ""
        q.put_nowait({"type": "log", "msg": f"── Media download{label} — {total} pending"})
        count = 0
        failed = 0
        for i, reel in enumerate(targets):
            sid = _sid(reel["url"])
            q.put_nowait({"type": "log_replace", "replace_id": "dl_progress",
                          "msg": f"[{i + 1}/{total}] {sid}…"})
            q.put_nowait({"type": "download_progress", "current": i + 1, "total": total})
            result = await download_video_file(reel["url"], DATA_DIR, q.put_nowait)
            if result:
                q.put_nowait({"type": "reel_update", "url": reel["url"], "media": result})
                count += 1
            else:
                failed += 1
        q.put_nowait({"type": "log_replace", "replace_id": "dl_progress",
                      "msg": f"✓ Media — {count}/{total} downloaded" + (f", {failed} failed" if failed else "")})
        q.put_nowait({"type": "done", "count": count})

    return {"job_id": _start_job(run)}


@app.post("/api/reel/caption")
async def reel_caption(req: SingleReelRequest):
    if _current_job:
        return JSONResponse({"error": "A job is already running"}, status_code=409)

    async def run(q: asyncio.Queue):
        await enrich_one_caption(req.url, DATA_DIR, q.put_nowait)

    return {"job_id": _start_job(run)}


@app.post("/api/reel/transcript")
async def reel_transcript(req: SingleReelRequest):
    if _current_job:
        return JSONResponse({"error": "A job is already running"}, status_code=409)

    async def run(q: asyncio.Queue):
        await enrich_one_transcript(req.url, DATA_DIR, WHISPER_DEVICE, q.put_nowait)

    return {"job_id": _start_job(run)}


@app.post("/api/job/cancel")
async def cancel_job():
    global _current_task
    if _current_task and not _current_task.done():
        _current_task.cancel()
        return {"cancelled": True}
    return {"cancelled": False}


@app.post("/api/reel/download")
async def reel_download(req: SingleReelRequest):
    if _current_job:
        return JSONResponse({"error": "A job is already running"}, status_code=409)

    async def run(q: asyncio.Queue):
        q.put_nowait({"type": "download_progress", "current": 0, "total": 1})
        result = await download_video_file(req.url, DATA_DIR, q.put_nowait)
        if result:
            q.put_nowait({"type": "download_progress", "current": 1, "total": 1})
            q.put_nowait({"type": "reel_update", "url": req.url, "media": result})
            q.put_nowait({"type": "done", "count": 1})
        else:
            q.put_nowait({"type": "error", "msg": "Download failed"})
            q.put_nowait({"type": "done", "count": 0})

    return {"job_id": _start_job(run)}


@app.get("/api/videos/{reel_id}")
async def serve_video(reel_id: str):
    candidates = list((DATA_DIR / "videos").glob(f"{reel_id}.*"))
    if candidates:
        return FileResponse(candidates[0], media_type="video/mp4")
    media_dir = DATA_DIR / "media" / reel_id
    if media_dir.exists():
        vids = sorted(media_dir.glob("*.mp4"))
        if vids:
            return FileResponse(vids[0], media_type="video/mp4")
    return JSONResponse({"error": "Video not found"}, status_code=404)


_MIME = {".mp4": "video/mp4", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
         ".png": "image/png", ".webp": "image/webp"}


@app.get("/api/media/{reel_id}/{filename}")
async def serve_media_file(reel_id: str, filename: str):
    filepath = DATA_DIR / "media" / reel_id / filename
    if not filepath.exists():
        return JSONResponse({"error": "Not found"}, status_code=404)
    return FileResponse(filepath, media_type=_MIME.get(filepath.suffix.lower(), "application/octet-stream"))


@app.get("/api/reels")
async def get_reels():
    return db.get_all()


@app.get("/api/status")
async def get_status():
    return {
        "session_exists": (DATA_DIR / "session.json").exists(),
        "reels_count": db.count(),
        "current_job": _current_job,
        "default_thread_url": THREAD_URL_DEFAULT,
    }


@app.delete("/api/session")
async def clear_session():
    session = DATA_DIR / "session.json"
    if session.exists():
        session.unlink()
    return {"cleared": True}


@app.delete("/api/source/{source_label}")
async def delete_source(source_label: str):
    import shutil
    deleted = db.delete_by_source_label(source_label)
    removed_files = 0
    for reel in deleted:
        shortcode = reel.get("shortcode") or ""
        if reel.get("video_path"):
            p = DATA_DIR / reel["video_path"]
            if p.exists():
                p.unlink()
                removed_files += 1
        if reel.get("image_paths"):
            for rel in reel["image_paths"]:
                p = DATA_DIR / rel
                if p.exists():
                    p.unlink()
                    removed_files += 1
        # Remove media directory for this reel
        if shortcode:
            media_dir = DATA_DIR / "media" / shortcode
            if media_dir.exists():
                shutil.rmtree(media_dir)
                removed_files += 1
            # Remove audio file(s)
            for mp3 in (DATA_DIR / "audio").glob(f"{shortcode}*.mp3"):
                mp3.unlink()
                removed_files += 1
    return {"deleted_reels": len(deleted), "removed_files": removed_files}


@app.get("/api/export/links")
async def export_links():
    reels = db.get_all()
    if not reels:
        return JSONResponse({"error": "No reels yet — scrape first"}, status_code=404)
    content = "\n".join(r["url"] for r in reels)
    from fastapi.responses import Response
    return Response(content=content, media_type="text/plain",
                    headers={"Content-Disposition": "attachment; filename=reel_links.txt"})


@app.get("/api/export/json")
async def export_json():
    reels = db.get_all()
    if not reels:
        return JSONResponse({"error": "No reels yet — scrape first"}, status_code=404)
    from fastapi.responses import Response
    return Response(
        content=json.dumps(reels, ensure_ascii=False, indent=2),
        media_type="application/json",
        headers={"Content-Disposition": "attachment; filename=reels.json"},
    )


@app.websocket("/ws/{job_id}")
async def ws_endpoint(ws: WebSocket, job_id: str):
    await ws.accept()
    queue = _jobs.get(job_id)
    if not queue:
        await ws.close(code=1008)
        return

    try:
        while True:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=20)
            except asyncio.TimeoutError:
                await ws.send_json({"type": "ping"})
                continue
            if event is None:
                break
            await ws.send_json(event)
    except (WebSocketDisconnect, Exception):
        pass
    finally:
        try:
            await ws.close()
        except Exception:
            pass
        _jobs.pop(job_id, None)
