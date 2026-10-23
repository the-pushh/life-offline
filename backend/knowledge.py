"""
Knowledge-base pipeline: dedupe reels, summarize the ones worth keeping, export markdown.

Dedup runs in 2 passes:
  1. Same shortcode  → /reel/X/ and /p/X/ are the same post shared twice.
  2. Same content    → reposts by other accounts. Compared on cleaned caption +
                       transcript with word 3-shingle Jaccard similarity.

Summaries use the Claude API only when ANTHROPIC_API_KEY is set (opt-in, sends
caption + transcript text). Otherwise a local extractive summary is used.
"""

import json
import os
import re
from collections import defaultdict
from datetime import datetime

from backend import db

SIMILARITY_THRESHOLD = float(os.getenv("DEDUPE_THRESHOLD", "0.8"))
MIN_SHINGLES = 8          # captions shorter than this are too generic to compare
COMMON_SHINGLE_CAP = 40   # shingles shared by more docs than this are boilerplate
SUMMARY_MODEL = os.getenv("SUMMARY_MODEL", "claude-opus-5-5")

# og:description looks like: 12K likes, 340 comments - someuser on March 3, 2024: "actual caption".
_OG_PREFIX = re.compile(
    r'^\s*[\d.,]+[KkMm]?\s+likes?,\s*[\d.,]+[KkMm]?\s+comments?\s*-\s*\S+\s+on\s+[^:]{3,40}:\s*"?',
)
_HASHTAG = re.compile(r"[#@]\w+(?:\.\w+)*")
_URL = re.compile(r"https?://\S+")
_WORD = re.compile(r"[a-z0-9']+")


def clean_caption(caption: str | None) -> str:
    if not caption:
        return ""
    text = _OG_PREFIX.sub("", caption).strip()
    if text.endswith('".'):
        text = text[:-2]
    elif text.endswith('"'):
        text = text[:-1]
    return text.strip()


def _shortcode(reel: dict) -> str:
    return reel.get("shortcode") or db._shortcode(reel.get("url", ""))


def _content_text(reel: dict) -> str:
    return f"{clean_caption(reel.get('caption'))} {reel.get('transcript') or ''}"


def _shingles(text: str) -> set[str]:
    text = _URL.sub(" ", _HASHTAG.sub(" ", text.lower()))
    words = _WORD.findall(text)
    return {" ".join(words[i:i + 3]) for i in range(len(words) - 2)}


def _richness(reel: dict) -> tuple:
    """Higher = better canonical pick. Ties go to the earliest scraped reel."""
    return (
        1 if reel.get("transcript") else 0,
        1 if (reel.get("video_path") or reel.get("image_paths")) else 0,
        len(clean_caption(reel.get("caption"))),
        -reel["id"],
    )


class _UnionFind:
    def __init__(self, items):
        self.parent = {i: i for i in items}

    def find(self, x):
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[rb] = ra


def find_duplicates(reels: list[dict]) -> list[list[dict]]:
    """Return groups of 2+ reels that are the same content."""
    by_id = {r["id"]: r for r in reels}
    uf = _UnionFind(by_id)

    # Pass 1: identical shortcode
    by_code: dict[str, int] = {}
    for r in reels:
        code = _shortcode(r)
        if not code:
            continue
        if code in by_code:
            uf.union(by_code[code], r["id"])
        else:
            by_code[code] = r["id"]

    # Pass 2: near-identical text, via an inverted index so we skip unrelated pairs
    shingles = {}
    for r in reels:
        s = _shingles(_content_text(r))
        if len(s) >= MIN_SHINGLES:
            shingles[r["id"]] = s

    index: dict[str, list[int]] = defaultdict(list)
    for rid, s in shingles.items():
        for sh in s:
            index[sh].append(rid)

    shared: dict[tuple[int, int], int] = defaultdict(int)
    for ids in index.values():
        if len(ids) < 2 or len(ids) > COMMON_SHINGLE_CAP:
            continue
        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                shared[(ids[i], ids[j])] += 1

    for (a, b), n in shared.items():
        jaccard = n / (len(shingles[a]) + len(shingles[b]) - n)
        if jaccard >= SIMILARITY_THRESHOLD:
            uf.union(a, b)

    groups: dict[int, list[dict]] = defaultdict(list)
    for rid in by_id:
        groups[uf.find(rid)].append(by_id[rid])
    return [g for g in groups.values() if len(g) > 1]


def dedupe() -> dict:
    """Mark duplicates in the DB. The richest reel in each group stays canonical
    and inherits any decision/notes a duplicate already had."""
    reels = db.get_all()
    groups = find_duplicates(reels)
    mapping: dict[str, str | None] = {r["url"]: None for r in reels}

    for group in groups:
        group.sort(key=_richness, reverse=True)
        canon = group[0]
        for dup in group[1:]:
            mapping[dup["url"]] = canon["url"]
        if not canon.get("decision"):
            donor = next((d for d in group[1:] if d.get("decision")), None)
            if donor:
                db.set_decision(canon["url"], donor["decision"], donor.get("notes") or canon.get("notes"))

    db.set_duplicates(mapping)
    n_dupes = sum(1 for v in mapping.values() if v)
    return {"groups": len(groups), "duplicates": n_dupes, "unique": len(reels) - n_dupes}


# ── summaries ──────────────────────────────────────────────────────────────────

_SUMMARY_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "key_points": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["summary", "key_points"],
    "additionalProperties": False,
}

_SUMMARY_PROMPT = """You turn short-form video posts into knowledge-base entries.

Below is the caption and the audio transcript of one Instagram reel. Write:
- summary: 2-4 plain sentences on what the reel teaches or claims. Skip hype, calls to follow, and promo codes.
- key_points: 3-7 short, concrete, standalone takeaways (steps, numbers, names, techniques). Empty list if the reel has no real information.

Author: @{sender}

<caption>
{caption}
</caption>

<transcript>
{transcript}
</transcript>"""


def llm_enabled() -> bool:
    return bool(os.getenv("ANTHROPIC_API_KEY"))


def _extractive(reel: dict) -> tuple[str, list[str]]:
    """Offline fallback: first sentences as the summary, the longest sentences as points."""
    text = f"{clean_caption(reel.get('caption'))}. {reel.get('transcript') or ''}"
    text = _URL.sub("", _HASHTAG.sub("", text))
    sentences = [s.strip(" .\n\t-•") for s in re.split(r"(?<=[.!?])\s+|\n+", text)]
    sentences = [s for s in sentences if len(s.split()) >= 4]
    seen, uniq = set(), []
    for s in sentences:
        key = s.lower()
        if key not in seen:
            seen.add(key)
            uniq.append(s)
    summary = ". ".join(uniq[:2]) + ("." if uniq else "")
    points = sorted(uniq[2:], key=len, reverse=True)[:5]
    return summary, points


async def summarize_one(client, reel: dict) -> tuple[str, list[str]]:
    caption = clean_caption(reel.get("caption"))
    transcript = reel.get("transcript") or ""
    if not caption and not transcript:
        return "", []
    if client is None:
        return _extractive(reel)

    response = await client.beta.messages.create(
        model=SUMMARY_MODEL,
        max_tokens=4000,
        output_config={"effort": "low", "format": {"type": "json_schema", "schema": _SUMMARY_SCHEMA}},
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        messages=[{
            "role": "user",
            "content": _SUMMARY_PROMPT.format(
                sender=reel.get("sender") or "unknown",
                caption=caption or "(none)",
                transcript=transcript or "(none)",
            ),
        }],
    )
    if response.stop_reason == "refusal":
        return _extractive(reel)
    text = next((b.text for b in response.content if b.type == "text"), "")
    data = json.loads(text)
    return data["summary"].strip(), [p.strip() for p in data["key_points"] if p.strip()]


async def summarize(on_event, urls: list[str] | None = None, force: bool = False) -> None:
    targets = db.get_decided({"keep", "summarize"})
    if urls:
        url_set = set(urls)
        targets = [r for r in targets if r["url"] in url_set]
    if not force:
        targets = [r for r in targets if not r.get("summary")]

    if not targets:
        on_event({"type": "log", "msg": "↩ nothing to summarize (mark reels Keep or Summarize first)"})
        on_event({"type": "done", "count": 0})
        return

    client = None
    if llm_enabled():
        import anthropic
        client = anthropic.AsyncAnthropic()
        on_event({"type": "log", "msg": f"── Summarizing {len(targets)} reels with {SUMMARY_MODEL}"})
    else:
        on_event({"type": "log", "msg": f"── Summarizing {len(targets)} reels locally (set ANTHROPIC_API_KEY for AI summaries)"})

    done = 0
    for i, reel in enumerate(targets):
        on_event({"type": "log_replace", "replace_id": "sum_progress",
                  "msg": f"[{i + 1}/{len(targets)}] {_shortcode(reel)}…"})
        try:
            summary, points = await summarize_one(client, reel)
        except Exception as exc:
            on_event({"type": "log", "msg": f"  ✗ {_shortcode(reel)}: {str(exc)[:100]} (using local summary)"})
            summary, points = _extractive(reel)
        db.set_summary(reel["url"], summary, points)
        on_event({"type": "kb_update", "url": reel["url"], "summary": summary, "key_points": points})
        done += 1

    on_event({"type": "log_replace", "replace_id": "sum_progress", "msg": f"✓ Summaries — {done}/{len(targets)}"})
    on_event({"type": "done", "count": done})


# ── export ─────────────────────────────────────────────────────────────────────

def _title(r: dict) -> str:
    text = _HASHTAG.sub("", clean_caption(r.get("caption"))).strip()
    first = re.split(r"(?<=[.!?])\s|\n", text, maxsplit=1)[0].strip()
    if len(first) > 80:
        first = first[:80].rsplit(" ", 1)[0] + "…"
    return first or _shortcode(r)


def _entry(r: dict, body: str) -> str:
    title = _title(r)
    meta = f"@{r.get('sender') or 'unknown'} · {r.get('timestamp') or ''} · [link]({r['url']})"
    notes = f"\n\n> **My notes:** {r['notes']}" if r.get("notes") else ""
    return f"### {title}\n\n{meta}\n\n{body.strip()}{notes}\n"


def _points(r: dict) -> str:
    pts = r.get("key_points") or []
    if pts:
        return "\n".join(f"- {p}" for p in pts)
    return r.get("summary") or clean_caption(r.get("caption"))


def export_markdown() -> str:
    reels = db.get_decided({"keep", "summarize", "full"})
    sections = [
        ("full", "Kept in full", lambda r: (
            (f"**Caption**\n\n{clean_caption(r.get('caption'))}\n\n" if r.get("caption") else "")
            + (f"**Transcript**\n\n{r['transcript']}" if r.get("transcript") else "")
        )),
        ("keep", "Key points", _points),
        ("summarize", "Summaries", lambda r: r.get("summary") or clean_caption(r.get("caption"))),
    ]
    out = [
        "# Knowledge base",
        "",
        f"_Exported {datetime.now().strftime('%b %d, %Y %H:%M')} · {len(reels)} entries_",
        "",
    ]
    for decision, heading, body in sections:
        rows = [r for r in reels if r["decision"] == decision]
        if not rows:
            continue
        out += [f"## {heading} ({len(rows)})", ""]
        out += [_entry(r, body(r)) for r in rows]
    return "\n".join(out)


def export_json() -> list[dict]:
    keep = ("url", "sender", "timestamp", "source_label", "decision", "notes", "summary", "key_points")
    out = []
    for r in db.get_decided({"keep", "summarize", "full"}):
        e = {k: r.get(k) for k in keep}
        e["caption"] = clean_caption(r.get("caption"))
        if r["decision"] == "full":
            e["transcript"] = r.get("transcript")
        out.append(e)
    return out
