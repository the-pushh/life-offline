"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Decision, Reel } from "@/lib/api";
import { API_BASE, cleanCaption, mediaFileUrl } from "@/lib/api";

type Filter = "pending" | Decision | "all";

const DECISIONS: { value: Decision; label: string; hint: string; key: string; cls: string; dot: string }[] = [
  { value: "keep", label: "Keep", hint: "Key points", key: "1",
    cls: "border-accent/40 text-accent hover:bg-accent hover:text-white", dot: "bg-accent" },
  { value: "summarize", label: "Summarize", hint: "Short summary", key: "2",
    cls: "border-blue-400/40 text-blue-500 hover:bg-blue-500 hover:text-white", dot: "bg-blue-500" },
  { value: "full", label: "Keep full", hint: "Caption + transcript", key: "3",
    cls: "border-purple-400/40 text-purple-500 hover:bg-purple-500 hover:text-white", dot: "bg-purple-500" },
  { value: "discard", label: "Discard", hint: "Leave out", key: "4",
    cls: "border-error/40 text-error hover:bg-error hover:text-white", dot: "bg-error" },
];
const DECISION_BY_VALUE = Object.fromEntries(DECISIONS.map((d) => [d.value, d]));

interface Props {
  reels: Reel[];        // reels in the active source tab
  allReels: Reel[];     // every reel, for duplicate lookups across tabs
  busy: boolean;
  llm: { llm: boolean; model: string | null };
  onDecision: (url: string, decision: Decision | null) => void;
  onNotes: (url: string, notes: string) => void;
  onSummarize: (urls?: string[], force?: boolean) => void;
  onDedupe: () => void;
  onOpen: (reel: Reel) => void;
  onTranscriptFetch: (url: string) => void;
  onDownload: (url: string) => void;
}

export default function ReviewPanel({
  reels, allReels, busy, llm, onDecision, onNotes, onSummarize, onDedupe, onOpen, onTranscriptFetch, onDownload,
}: Props) {
  const [filter, setFilter] = useState<Filter>("pending");
  const [currentUrl, setCurrentUrl] = useState<string | null>(null);
  const [history, setHistory] = useState<{ url: string; prev: Decision | null }[]>([]);
  const [notesDraft, setNotesDraft] = useState("");
  const notesRef = useRef<HTMLTextAreaElement>(null);

  const duplicatesOf = useMemo(() => {
    const m: Record<string, Reel[]> = {};
    for (const r of allReels) if (r.duplicate_of) (m[r.duplicate_of] ??= []).push(r);
    return m;
  }, [allReels]);

  const canonical = useMemo(() => reels.filter((r) => !r.duplicate_of), [reels]);
  const hiddenDupes = reels.length - canonical.length;

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { pending: 0, keep: 0, summarize: 0, full: 0, discard: 0, all: canonical.length };
    for (const r of canonical) c[r.decision ?? "pending"]++;
    return c;
  }, [canonical]);

  const queue = useMemo(
    () => (filter === "all" ? canonical : canonical.filter((r) => (r.decision ?? "pending") === filter)),
    [canonical, filter]
  );

  // Keep a valid selection as the queue changes
  useEffect(() => {
    if (!queue.length) { setCurrentUrl(null); return; }
    if (!currentUrl || !queue.some((r) => r.url === currentUrl)) setCurrentUrl(queue[0].url);
  }, [queue, currentUrl]);

  const idx = queue.findIndex((r) => r.url === currentUrl);
  const current = idx >= 0 ? queue[idx] : null;

  useEffect(() => { setNotesDraft(current?.notes ?? ""); }, [current?.url]); // eslint-disable-line react-hooks/exhaustive-deps

  const pendingSummaries = canonical.filter(
    (r) => (r.decision === "keep" || r.decision === "summarize") && !r.summary
  ).length;
  const reviewed = canonical.length - counts.pending;

  function commitNotes() {
    if (current && notesDraft !== (current.notes ?? "")) onNotes(current.url, notesDraft);
  }

  function decide(decision: Decision) {
    if (!current) return;
    commitNotes();
    setHistory((h) => [...h.slice(-49), { url: current.url, prev: current.decision ?? null }]);
    // In a filtered queue the item drops out, so the next one slides into place.
    // Pick it now so the selection doesn't jump back to the top.
    const leaves = filter !== "all" && filter !== decision;
    const next = leaves ? queue[idx + 1] ?? queue[idx - 1] : queue[idx + 1] ?? current;
    onDecision(current.url, decision);
    setCurrentUrl(next?.url ?? null);
  }

  function undo() {
    const last = history[history.length - 1];
    if (!last) return;
    setHistory((h) => h.slice(0, -1));
    onDecision(last.url, last.prev);
    setFilter((f) => (f === "all" || f === (last.prev ?? "pending") ? f : "all"));
    setCurrentUrl(last.url);
  }

  function move(delta: number) {
    if (!queue.length) return;
    commitNotes();
    const n = Math.min(queue.length - 1, Math.max(0, idx + delta));
    setCurrentUrl(queue[n].url);
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement;
      if (t.tagName === "TEXTAREA" || t.tagName === "INPUT") {
        if (e.key === "Escape") (t as HTMLElement).blur();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const d = DECISIONS.find((x) => x.key === e.key);
      if (d) { e.preventDefault(); decide(d.value); return; }
      if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); move(1); }
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); move(-1); }
      else if (e.key === "z" || e.key === "u") { e.preventDefault(); undo(); }
      else if (e.key === "n") { e.preventDefault(); notesRef.current?.focus(); }
      else if (e.key === "o" && current) { e.preventDefault(); onOpen(current); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const btn = "text-xs px-2.5 py-1 rounded-lg bg-surface border border-border text-muted hover:border-accent hover:text-accent disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-medium";

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-border bg-surface-2/40 flex-shrink-0">
        <div className="flex items-center gap-1 flex-wrap">
          {(["pending", "keep", "summarize", "full", "discard", "all"] as Filter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`text-xs px-2.5 py-1 rounded-full border transition-colors flex items-center gap-1.5 ${
                filter === f ? "bg-primary text-surface border-primary" : "border-border text-muted hover:text-primary"
              }`}
            >
              {f !== "pending" && f !== "all" && <span className={`w-1.5 h-1.5 rounded-full ${DECISION_BY_VALUE[f].dot}`} />}
              {f === "pending" ? "To review" : f === "all" ? "All" : DECISION_BY_VALUE[f].label}
              <span className="tabular-nums opacity-70">{counts[f]}</span>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 ml-auto">
          <button onClick={onDedupe} disabled={busy} className={btn} title="Fold reposts and re-shares into one entry">
            ⧉ Find duplicates
          </button>
          <button
            onClick={() => onSummarize()}
            disabled={busy || pendingSummaries === 0}
            className={btn}
            title={llm.llm ? `Uses ${llm.model}` : "Local summaries. Set ANTHROPIC_API_KEY for AI summaries."}
          >
            ✎ Summarize {pendingSummaries > 0 ? `(${pendingSummaries})` : ""}
          </button>
          <a href={`${API_BASE}/api/kb/export?format=md`} download="knowledge_base.md"
             className={`${btn} ${reviewed - counts.discard === 0 ? "opacity-40 pointer-events-none" : ""}`}>
            ↓ Export KB
          </a>
          <a href={`${API_BASE}/api/kb/export?format=json`} download="knowledge_base.json"
             className={`${btn} ${reviewed - counts.discard === 0 ? "opacity-40 pointer-events-none" : ""}`}>
            JSON
          </a>
        </div>
      </div>

      {/* Progress */}
      <div className="px-4 py-2 flex items-center gap-3 border-b border-border/60 flex-shrink-0">
        <div className="flex-1 h-1.5 rounded-full bg-surface-2 overflow-hidden flex">
          {DECISIONS.map((d) => (
            <div key={d.value} className={`${d.dot} h-full`}
                 style={{ width: `${canonical.length ? (counts[d.value] / canonical.length) * 100 : 0}%` }} />
          ))}
        </div>
        <span className="text-xs text-muted tabular-nums whitespace-nowrap">
          {reviewed}/{canonical.length} reviewed
          {hiddenDupes > 0 && <> · {hiddenDupes} duplicates folded</>}
        </span>
      </div>

      {canonical.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-sm text-muted p-10 text-center">
          No reels in this source yet. Sync it first, then come back to review.
        </div>
      ) : (
        <div className="flex flex-1 min-h-0">
          {/* Queue list */}
          <ul className="w-64 flex-shrink-0 border-r border-border overflow-auto hidden md:block">
            {queue.map((r, i) => {
              const dupes = duplicatesOf[r.url]?.length ?? 0;
              return (
                <li key={r.url}>
                  <button
                    onClick={() => { commitNotes(); setCurrentUrl(r.url); }}
                    className={`w-full text-left px-3 py-2.5 border-b border-border/50 flex gap-2 items-start transition-colors ${
                      r.url === currentUrl ? "bg-accent/10" : "hover:bg-surface-2/60"
                    }`}
                  >
                    <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${
                      r.decision ? DECISION_BY_VALUE[r.decision].dot : "border border-border-2"
                    }`} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5 text-xs text-muted">
                        <span className="tabular-nums">{i + 1}</span>
                        <span className="truncate">@{r.sender}</span>
                        {dupes > 0 && <span className="ml-auto text-[10px] px-1 rounded bg-surface-2">×{dupes + 1}</span>}
                      </span>
                      <span className="block text-xs text-primary line-clamp-2 leading-snug mt-0.5">
                        {cleanCaption(r.caption) || <span className="text-muted-2 italic">No caption</span>}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
            {queue.length === 0 && (
              <li className="p-6 text-xs text-muted text-center">
                {filter === "pending" ? "All caught up ✓" : "Nothing here"}
              </li>
            )}
          </ul>

          {/* Focused card */}
          <div className="flex-1 min-w-0 flex flex-col min-h-0">
            {current ? (
              <ReviewCard
                key={current.url}
                reel={current}
                position={`${idx + 1} / ${queue.length}`}
                duplicates={duplicatesOf[current.url] ?? []}
                busy={busy}
                notes={notesDraft}
                notesRef={notesRef}
                onNotesChange={setNotesDraft}
                onNotesBlur={commitNotes}
                onDecide={decide}
                onPrev={() => move(-1)}
                onNext={() => move(1)}
                onUndo={history.length ? undo : undefined}
                onOpen={() => onOpen(current)}
                onSummarize={() => onSummarize([current.url], true)}
                onTranscriptFetch={() => onTranscriptFetch(current.url)}
                onDownload={() => onDownload(current.url)}
              />
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center p-10">
                <p className="text-primary font-medium">
                  {filter === "pending" ? "Everything in this source is reviewed." : "No reels with this decision."}
                </p>
                <p className="text-sm text-muted">
                  {counts.keep + counts.summarize + counts.full} entries ready for the knowledge base.
                </p>
                {history.length > 0 && <button onClick={undo} className={btn}>↶ Undo last (Z)</button>}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface CardProps {
  reel: Reel;
  position: string;
  duplicates: Reel[];
  busy: boolean;
  notes: string;
  notesRef: React.RefObject<HTMLTextAreaElement>;
  onNotesChange: (v: string) => void;
  onNotesBlur: () => void;
  onDecide: (d: Decision) => void;
  onPrev: () => void;
  onNext: () => void;
  onUndo?: () => void;
  onOpen: () => void;
  onSummarize: () => void;
  onTranscriptFetch: () => void;
  onDownload: () => void;
}

function ReviewCard({
  reel, position, duplicates, busy, notes, notesRef, onNotesChange, onNotesBlur,
  onDecide, onPrev, onNext, onUndo, onOpen, onSummarize, onTranscriptFetch, onDownload,
}: CardProps) {
  const [showTranscript, setShowTranscript] = useState(false);
  const hasMedia = !!(reel.video_path || reel.image_paths?.length);
  const rawThumb = reel.thumbnail || reel.image_paths?.[0] || null;
  const thumb = rawThumb ? (rawThumb.startsWith("http") ? rawThumb : mediaFileUrl(rawThumb)) : null;
  const isImageOnly = reel.post_type === "image" || reel.post_type === "carousel_image";
  const caption = cleanCaption(reel.caption);
  const current = reel.decision ? DECISION_BY_VALUE[reel.decision] : null;

  return (
    <>
      <div className="flex-1 overflow-auto min-h-0 p-5">
        <div className="flex gap-5 flex-col sm:flex-row">
          {/* Media */}
          <button
            onClick={hasMedia ? onOpen : onDownload}
            disabled={!hasMedia && busy}
            className="relative w-full h-40 sm:h-auto sm:w-40 sm:aspect-[9/16] flex-shrink-0 rounded-xl overflow-hidden border border-border bg-surface-2 hover:border-accent transition-colors group"
            title={hasMedia ? "Play (O)" : "Download media"}
          >
            {thumb && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={thumb} alt="" className="w-full h-full object-cover"
                   onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
            )}
            <span className="absolute inset-0 flex items-center justify-center bg-black/20 text-white text-xs font-medium opacity-80 group-hover:opacity-100">
              {hasMedia ? "▶ Play" : "↓ Download"}
            </span>
          </button>

          {/* Meta + text */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap text-xs text-muted mb-2">
              <span className="text-sm text-primary font-medium">@{reel.sender}</span>
              <span>·</span>
              <span>{reel.timestamp}</span>
              {reel.source_label && <><span>·</span><span>{reel.source_label}</span></>}
              <a href={reel.url} target="_blank" rel="noreferrer" className="hover:text-accent underline-offset-2 hover:underline">
                Open on Instagram ↗
              </a>
              <span className="ml-auto tabular-nums">{position}</span>
            </div>

            {current && (
              <span className={`inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full border mb-3 ${current.cls.split(" hover:")[0]}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${current.dot}`} /> {current.label}
              </span>
            )}

            {duplicates.length > 0 && (
              <div className="text-xs text-muted mb-3 p-2 rounded-lg bg-surface-2/70 border border-border/60">
                ⧉ Shared {duplicates.length + 1}× · also from{" "}
                {duplicates.map((d, i) => (
                  <span key={d.url}>
                    {i > 0 && ", "}
                    <a href={d.url} target="_blank" rel="noreferrer" className="hover:text-accent underline">@{d.sender}</a>
                    {d.timestamp ? ` (${d.timestamp})` : ""}
                  </span>
                ))}
              </div>
            )}

            <Section title="Caption">
              {caption
                ? <p className="text-sm text-primary whitespace-pre-wrap leading-relaxed">{caption}</p>
                : <p className="text-sm text-muted-2 italic">No caption fetched</p>}
            </Section>

            {!isImageOnly && (
              <Section
                title="Transcript"
                action={reel.transcript ? (
                  <button onClick={() => setShowTranscript((s) => !s)} className="text-xs text-muted hover:text-accent">
                    {showTranscript ? "Collapse" : "Expand"}
                  </button>
                ) : (
                  <button
                    onClick={onTranscriptFetch}
                    disabled={busy || !reel.video_path}
                    title={!reel.video_path ? "Download media first" : undefined}
                    className="text-xs text-muted hover:text-accent disabled:opacity-40"
                  >
                    Transcribe
                  </button>
                )}
              >
                {reel.transcript
                  ? <p className={`text-sm text-muted whitespace-pre-wrap leading-relaxed ${showTranscript ? "" : "line-clamp-4"}`}>{reel.transcript}</p>
                  : <p className="text-sm text-muted-2 italic">No transcript yet</p>}
              </Section>
            )}

            {(reel.summary || reel.key_points?.length) ? (
              <Section
                title="Summary"
                action={<button onClick={onSummarize} disabled={busy} className="text-xs text-muted hover:text-accent disabled:opacity-40">Regenerate</button>}
              >
                {reel.summary && <p className="text-sm text-primary leading-relaxed mb-2">{reel.summary}</p>}
                {reel.key_points?.length ? (
                  <ul className="list-disc pl-5 text-sm text-primary space-y-0.5">
                    {reel.key_points.map((p, i) => <li key={i}>{p}</li>)}
                  </ul>
                ) : null}
              </Section>
            ) : (reel.decision === "keep" || reel.decision === "summarize") && (
              <Section title="Summary">
                <button onClick={onSummarize} disabled={busy} className="text-xs px-2.5 py-1 rounded-lg border border-border text-muted hover:border-accent hover:text-accent disabled:opacity-40">
                  ✎ Generate now
                </button>
              </Section>
            )}

            <Section title="My notes">
              <textarea
                ref={notesRef}
                value={notes}
                onChange={(e) => onNotesChange(e.target.value)}
                onBlur={onNotesBlur}
                placeholder="Why it matters, how you'll use it… (N to focus, Esc to leave)"
                rows={3}
                className="w-full text-sm bg-surface border border-border rounded-lg px-3 py-2 text-primary placeholder:text-muted-2 focus:outline-none focus:border-accent resize-y"
              />
            </Section>
          </div>
        </div>
      </div>

      {/* Decision bar */}
      <div className="flex-shrink-0 border-t border-border bg-surface-2/40 px-4 py-3 flex items-center gap-2 flex-wrap">
        <button onClick={onPrev} className="text-xs px-2 py-2 text-muted hover:text-primary" title="Previous (←)">←</button>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 flex-1">
          {DECISIONS.map((d) => (
            <button
              key={d.value}
              onClick={() => onDecide(d.value)}
              className={`rounded-xl border px-3 py-2 text-left transition-colors ${d.cls} ${
                reel.decision === d.value ? "ring-2 ring-offset-1 ring-current" : ""
              }`}
            >
              <span className="flex items-center justify-between text-sm font-medium">
                {d.label}
                <kbd className="text-[10px] font-mono opacity-60 border border-current rounded px-1">{d.key}</kbd>
              </span>
              <span className="block text-[11px] opacity-70">{d.hint}</span>
            </button>
          ))}
        </div>
        <button onClick={onNext} className="text-xs px-2 py-2 text-muted hover:text-primary" title="Skip (→)">→</button>
        {onUndo && (
          <button onClick={onUndo} className="text-xs px-2 py-2 text-muted hover:text-primary" title="Undo (Z)">↶</button>
        )}
      </div>
    </>
  );
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-[11px] uppercase tracking-wide text-muted-2 font-medium">{title}</h3>
        {action}
      </div>
      {children}
    </div>
  );
}
