"""
SQLite persistence layer.
URL is the source of truth / unique key across all tables.
"""

import json
import sqlite3
from pathlib import Path
from urllib.parse import urlparse

_db_path: Path | None = None
_conn_cache: sqlite3.Connection | None = None


def init(data_dir: Path) -> None:
    global _db_path, _conn_cache
    _db_path = data_dir / "lifeoffline.db"
    _conn_cache = None  # force reconnect
    _apply_schema()
    _migrate_json(data_dir)


def _conn() -> sqlite3.Connection:
    global _conn_cache
    if _conn_cache is None:
        if not _db_path:
            raise RuntimeError("db.init() not called")
        c = sqlite3.connect(str(_db_path), check_same_thread=False)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("PRAGMA synchronous=NORMAL")
        c.execute("PRAGMA foreign_keys=ON")
        _conn_cache = c
    return _conn_cache


def _apply_schema() -> None:
    _conn().executescript("""
        CREATE TABLE IF NOT EXISTS reels (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            url          TEXT    UNIQUE NOT NULL,
            shortcode    TEXT,
            source       TEXT,
            source_label TEXT,
            sender       TEXT,
            timestamp    TEXT,
            post_type    TEXT,
            caption      TEXT,
            transcript   TEXT,
            thumbnail    TEXT,
            video_path   TEXT,
            image_paths  TEXT,
            scraped_at   TEXT    DEFAULT (datetime('now')),
            updated_at   TEXT    DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_url   ON reels(url);
        CREATE INDEX IF NOT EXISTS idx_label ON reels(source_label);
    """)
    _conn().commit()


def _migrate_json(data_dir: Path) -> None:
    json_path = data_dir / "reels.json"
    if not json_path.exists():
        return
    try:
        reels = json.loads(json_path.read_text())
        for r in reels:
            upsert(r)
        json_path.rename(json_path.with_suffix(".json.migrated"))
    except Exception as exc:
        print(f"[db] JSON migration failed: {exc}")


# ── helpers ────────────────────────────────────────────────────────────────────

def _shortcode(url: str) -> str:
    parts = [p for p in urlparse(url).path.split("/") if p]
    return parts[-1] if parts else ""


def _row_to_dict(row: sqlite3.Row) -> dict:
    d = dict(row)
    raw = d.get("image_paths")
    if isinstance(raw, str) and raw:
        try:
            d["image_paths"] = json.loads(raw)
        except Exception:
            d["image_paths"] = []
    elif not raw:
        d["image_paths"] = None
    return d


# ── write ops ──────────────────────────────────────────────────────────────────

def upsert(reel: dict) -> None:
    """Insert or update a reel by URL. COALESCE keeps existing values when new ones are NULL."""
    image_paths = reel.get("image_paths")
    if isinstance(image_paths, list):
        image_paths = json.dumps(image_paths)
    _conn().execute("""
        INSERT INTO reels
            (url, shortcode, source, source_label, sender, timestamp,
             post_type, caption, transcript, thumbnail, video_path, image_paths)
        VALUES
            (:url, :shortcode, :source, :source_label, :sender, :timestamp,
             :post_type, :caption, :transcript, :thumbnail, :video_path, :image_paths)
        ON CONFLICT(url) DO UPDATE SET
            source_label = COALESCE(excluded.source_label, source_label),
            sender       = COALESCE(excluded.sender,       sender),
            timestamp    = COALESCE(excluded.timestamp,    timestamp),
            post_type    = COALESCE(excluded.post_type,    post_type),
            caption      = COALESCE(excluded.caption,      caption),
            transcript   = COALESCE(excluded.transcript,   transcript),
            thumbnail    = COALESCE(excluded.thumbnail,    thumbnail),
            video_path   = COALESCE(excluded.video_path,   video_path),
            image_paths  = COALESCE(excluded.image_paths,  image_paths),
            updated_at   = datetime('now')
    """, {
        "url":          reel.get("url"),
        "shortcode":    reel.get("shortcode") or _shortcode(reel.get("url", "")),
        "source":       reel.get("source"),
        "source_label": reel.get("source_label"),
        "sender":       reel.get("sender"),
        "timestamp":    reel.get("timestamp"),
        "post_type":    reel.get("post_type"),
        "caption":      reel.get("caption") or None,
        "transcript":   reel.get("transcript") or None,
        "thumbnail":    reel.get("thumbnail"),
        "video_path":   reel.get("video_path") or None,
        "image_paths":  image_paths or None,
    })
    _conn().commit()


def update_caption(url: str, caption: str) -> None:
    _conn().execute(
        "UPDATE reels SET caption = ?, updated_at = datetime('now') WHERE url = ?",
        (caption, url),
    )
    _conn().commit()


def update_transcript(url: str, transcript: str) -> None:
    _conn().execute(
        "UPDATE reels SET transcript = ?, updated_at = datetime('now') WHERE url = ?",
        (transcript, url),
    )
    _conn().commit()


def update_media(url: str, *,
                 video_path: str | None = None,
                 image_paths: list[str] | None = None,
                 post_type: str | None = None,
                 thumbnail: str | None = None) -> None:
    parts, params = [], {"url": url}
    if video_path is not None:
        parts.append("video_path = :video_path"); params["video_path"] = video_path
    if image_paths is not None:
        parts.append("image_paths = :image_paths"); params["image_paths"] = json.dumps(image_paths)
    if post_type is not None:
        parts.append("post_type = :post_type"); params["post_type"] = post_type
    if thumbnail is not None:
        parts.append("thumbnail = :thumbnail"); params["thumbnail"] = thumbnail
    if parts:
        _conn().execute(
            f"UPDATE reels SET {', '.join(parts)}, updated_at = datetime('now') WHERE url = :url",
            params,
        )
        _conn().commit()


# ── read ops ───────────────────────────────────────────────────────────────────

def get_all() -> list[dict]:
    rows = _conn().execute("SELECT * FROM reels ORDER BY id").fetchall()
    return [_row_to_dict(r) for r in rows]


def get_by_url(url: str) -> dict | None:
    row = _conn().execute("SELECT * FROM reels WHERE url = ?", (url,)).fetchone()
    return _row_to_dict(row) if row else None


def get_urls() -> set[str]:
    return {r["url"] for r in _conn().execute("SELECT url FROM reels").fetchall()}


def get_pending_captions() -> list[dict]:
    rows = _conn().execute(
        "SELECT * FROM reels WHERE caption IS NULL ORDER BY id"
    ).fetchall()
    return [_row_to_dict(r) for r in rows]


def get_pending_transcripts() -> list[dict]:
    rows = _conn().execute(
        "SELECT * FROM reels WHERE transcript IS NULL ORDER BY id"
    ).fetchall()
    return [_row_to_dict(r) for r in rows]


def count() -> int:
    return _conn().execute("SELECT COUNT(*) FROM reels").fetchone()[0]


def count_with_captions() -> int:
    return _conn().execute("SELECT COUNT(*) FROM reels WHERE caption IS NOT NULL").fetchone()[0]


def delete_by_source_label(source_label: str) -> list[dict]:
    """Delete all reels for a source label. Returns deleted rows (for file cleanup)."""
    rows = _conn().execute(
        "SELECT * FROM reels WHERE source_label = ?", (source_label,)
    ).fetchall()
    deleted = [_row_to_dict(r) for r in rows]
    _conn().execute("DELETE FROM reels WHERE source_label = ?", (source_label,))
    _conn().commit()
    return deleted


def get_without_media(source_label: str | None = None) -> list[dict]:
    if source_label:
        rows = _conn().execute(
            "SELECT * FROM reels WHERE video_path IS NULL AND image_paths IS NULL AND source_label = ?",
            (source_label,),
        ).fetchall()
    else:
        rows = _conn().execute(
            "SELECT * FROM reels WHERE video_path IS NULL AND image_paths IS NULL"
        ).fetchall()
    return [_row_to_dict(r) for r in rows]
