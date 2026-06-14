"use client";

import { useState } from "react";
import type { Reel } from "@/lib/api";
import { mediaFileUrl } from "@/lib/api";

type Status = "idle" | "scraping" | "captions" | "transcripts" | "downloading";
type Filter = "all" | "no_media" | "no_caption" | "no_transcript";

interface Props {
  reels: Reel[];
  status: Status;
  search: string;
  transcribingUrls: Set<string>;
  downloadingUrls: Set<string>;
  onCaptionFetch: (url: string) => void;
  onTranscriptFetch: (url: string) => void;
  onDownload: (url: string) => void;
  onOpen: (reel: Reel) => void;
  onRunOnSelected: (action: "download" | "captions" | "transcripts", urls: string[]) => void;
  noSources?: boolean;
  onAddSource?: () => void;
}

export default function ReelsTable({
  reels,
  status,
  search,
  transcribingUrls,
  downloadingUrls,
  onCaptionFetch,
  onTranscriptFetch,
  onDownload,
  onOpen,
  onRunOnSelected,
  noSources = false,
  onAddSource,
}: Props) {
  const busy = status !== "idle";
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const counts = {
    no_media: reels.filter((r) => !(r.video_path || r.image_paths?.length)).length,
    no_caption: reels.filter((r) => !r.caption).length,
    no_transcript: reels.filter((r) => !r.transcript && r.post_type !== "image" && r.post_type !== "carousel_image").length,
  };

  const visible = reels.filter((r) => {
    const matchSearch =
      !search ||
      r.sender.toLowerCase().includes(search.toLowerCase()) ||
      r.caption?.toLowerCase().includes(search.toLowerCase());
    if (!matchSearch) return false;
    if (filter === "no_media") return !(r.video_path || r.image_paths?.length);
    if (filter === "no_caption") return !r.caption;
    if (filter === "no_transcript") return !r.transcript && r.post_type !== "image" && r.post_type !== "carousel_image";
    return true;
  });

  const allVisibleSelected = visible.length > 0 && visible.every((r) => selected.has(r.url));
  const someVisibleSelected = visible.some((r) => selected.has(r.url));

  function toggleAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) visible.forEach((r) => next.delete(r.url));
      else visible.forEach((r) => next.add(r.url));
      return next;
    });
  }

  function toggleRow(url: string, e: React.MouseEvent) {
    e.stopPropagation();
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url); else next.add(url);
      return next;
    });
  }

  function clearSelection() { setSelected(new Set()); }

  const selectionUrls = [...selected];
  const selectionHasVideo = selectionUrls.some((u) => reels.find((r) => r.url === u)?.video_path);

  return (
    <div className="bg-surface flex flex-col flex-1 min-h-0 overflow-hidden">
      {reels.length === 0 ? (
        <EmptyState noSources={noSources} onAddSource={onAddSource} />
      ) : (
        <>
          {/* Filter + selection bar */}
          <div className="flex items-center justify-between gap-3 px-4 py-2 border-b border-border/60 flex-shrink-0 bg-surface-2/40">
            {/* Filter chips */}
            <div className="flex items-center gap-1">
              {(["all", "no_media", "no_caption", "no_transcript"] as Filter[]).map((f) => {
                const labels: Record<Filter, string> = {
                  all: "All",
                  no_media: `No media${counts.no_media ? ` (${counts.no_media})` : ""}`,
                  no_caption: `No caption${counts.no_caption ? ` (${counts.no_caption})` : ""}`,
                  no_transcript: `No transcript${counts.no_transcript ? ` (${counts.no_transcript})` : ""}`,
                };
                const active = filter === f;
                return (
                  <button
                    key={f}
                    onClick={() => { setFilter(f); clearSelection(); }}
                    className={`text-xs px-2.5 py-1 rounded-full transition-colors font-medium ${
                      active
                        ? "bg-accent text-white"
                        : "bg-surface border border-border text-muted hover:border-accent/60 hover:text-primary"
                    }`}
                  >
                    {labels[f]}
                  </button>
                );
              })}
            </div>

            {/* Selection actions */}
            {selected.size > 0 && (
              <div className="flex items-center gap-2 flex-shrink-0">
                <span className="text-xs text-muted tabular-nums">{selected.size} selected</span>
                <button
                  onClick={() => { onRunOnSelected("download", selectionUrls); clearSelection(); }}
                  disabled={busy}
                  className="text-xs px-2.5 py-1 rounded-lg bg-surface border border-border text-muted hover:border-accent hover:text-accent disabled:opacity-40 transition-colors font-medium flex items-center gap-1"
                >
                  <svg width="11" height="11" viewBox="0 0 9 9" fill="none">
                    <path d="M4.5 1v5M2 4l2.5 2.5L7 4M1 8h7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  Download
                </button>
                <button
                  onClick={() => { onRunOnSelected("captions", selectionUrls); clearSelection(); }}
                  disabled={busy}
                  className="text-xs px-2.5 py-1 rounded-lg bg-surface border border-border text-muted hover:border-accent hover:text-accent disabled:opacity-40 transition-colors font-medium"
                >
                  Captions
                </button>
                <button
                  onClick={() => { onRunOnSelected("transcripts", selectionUrls); clearSelection(); }}
                  disabled={busy || !selectionHasVideo}
                  title={!selectionHasVideo ? "Download media first to enable transcription" : undefined}
                  className="text-xs px-2.5 py-1 rounded-lg bg-surface border border-border text-muted hover:border-accent hover:text-accent disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-medium"
                >
                  Transcripts
                </button>
                <button
                  onClick={clearSelection}
                  className="text-xs px-2 py-1 rounded-lg text-muted hover:text-primary transition-colors"
                  title="Clear selection"
                >
                  ×
                </button>
              </div>
            )}
          </div>

          <div className="flex-1 overflow-auto min-h-0">
            <table className="w-full border-collapse">
              <thead className="sticky top-0 z-10 bg-surface-2">
                <tr className="border-b border-border">
                  <th className="px-3 py-3 w-8">
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      ref={(el) => { if (el) el.indeterminate = someVisibleSelected && !allVisibleSelected; }}
                      onChange={toggleAll}
                      onClick={(e) => e.stopPropagation()}
                      className="w-3.5 h-3.5 accent-accent cursor-pointer"
                    />
                  </th>
                  <th className="text-left px-3 py-3 text-xs text-muted font-medium w-8">#</th>
                  <th className="px-3 py-3 text-xs text-muted font-medium w-14">Media</th>
                  <th className="text-left px-3 py-3 text-xs text-muted font-medium">Author</th>
                  <th className="text-left px-3 py-3 text-xs text-muted font-medium w-20">Source</th>
                  <th className="text-left px-3 py-3 text-xs text-muted font-medium whitespace-nowrap">Date</th>
                  <th className="text-left px-3 py-3 text-xs text-muted font-medium">Caption</th>
                  <th className="text-left px-3 py-3 text-xs text-muted font-medium w-32">Transcript</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((reel, i) => {
                  const isSelected = selected.has(reel.url);
                  return (
                    <tr
                      key={reel.url}
                      onClick={() => onOpen(reel)}
                      className={`border-b border-border/60 hover:bg-surface-2/60 transition-colors cursor-pointer group ${
                        isSelected ? "bg-accent/5" : ""
                      }`}
                    >
                      {/* Checkbox */}
                      <td className="px-3 py-3" onClick={(e) => toggleRow(reel.url, e)}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => {}}
                          className="w-3.5 h-3.5 accent-accent cursor-pointer"
                        />
                      </td>

                      {/* # */}
                      <td className="px-3 py-3 text-sm text-muted tabular-nums">{i + 1}</td>

                      {/* Media */}
                      <td className="px-3 py-3">
                        {(() => {
                          const hasMedia = !!(reel.video_path || reel.image_paths?.length);
                          const rawThumb = reel.thumbnail || (reel.image_paths?.[0] ?? null);
                          const thumbSrc = rawThumb
                            ? rawThumb.startsWith("http")
                              ? rawThumb
                              : mediaFileUrl(rawThumb)
                            : null;
                          const btnBase = "w-10 h-10 flex-shrink-0 rounded-lg border border-border hover:border-accent hover:scale-105 transition-transform";
                          if (hasMedia && thumbSrc) {
                            return (
                              <button
                                onClick={(e) => { e.stopPropagation(); onOpen(reel); }}
                                title="Play"
                                className={`relative overflow-hidden hover:text-accent text-white ${btnBase}`}
                              >
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={thumbSrc} alt={reel.sender} className="w-full h-full object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                                <span className="absolute inset-0 flex items-center justify-center bg-black/25">
                                  <svg width="15" height="15" viewBox="0 0 8 8" fill="currentColor" className="drop-shadow">
                                    <path d="M1.5 1.5l5 2.5-5 2.5V1.5z" />
                                  </svg>
                                </span>
                              </button>
                            );
                          }
                          const isDownloading = downloadingUrls.has(reel.url);
                          return (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                if (hasMedia) onOpen(reel);
                                else if (!isDownloading) onDownload(reel.url);
                              }}
                              title={hasMedia ? "Play" : isDownloading ? "Downloading…" : "Download media"}
                              disabled={isDownloading}
                              className={`flex items-center justify-center bg-surface-2 text-muted hover:text-accent disabled:cursor-default ${btnBase}`}
                            >
                              {isDownloading ? (
                                <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none">
                                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeOpacity="0.25" />
                                  <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                                </svg>
                              ) : hasMedia ? (
                                <svg width="15" height="15" viewBox="0 0 8 8" fill="currentColor">
                                  <path d="M1.5 1.5l5 2.5-5 2.5V1.5z" />
                                </svg>
                              ) : (
                                <svg width="14" height="14" viewBox="0 0 9 9" fill="none">
                                  <path d="M4.5 1v5M2 4l2.5 2.5L7 4M1 8h7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                              )}
                            </button>
                          );
                        })()}
                      </td>

                      {/* Sender */}
                      <td className="px-3 py-3">
                        <span className="text-sm text-primary">@{reel.sender}</span>
                      </td>

                      {/* Source */}
                      <td className="px-3 py-3">
                        <SourceBadge source={reel.source} label={reel.source_label} />
                      </td>

                      {/* Date */}
                      <td className="px-3 py-3 text-sm text-muted whitespace-nowrap">{reel.timestamp}</td>

                      {/* Caption */}
                      <td className="px-3 py-3 max-w-sm">
                        {reel.caption ? (
                          <span className="text-sm text-muted leading-relaxed line-clamp-2">{reel.caption}</span>
                        ) : (
                          <button
                            onClick={(e) => { e.stopPropagation(); onCaptionFetch(reel.url); }}
                            disabled={busy}
                            className="text-xs px-2 py-0.5 rounded-md bg-accent text-white hover:bg-accent/80 disabled:opacity-30 transition-colors font-medium"
                          >
                            Fetch
                          </button>
                        )}
                      </td>

                      {/* Transcript */}
                      <td className="px-3 py-3">
                        {(() => {
                          const isImageOnly = reel.post_type === "carousel_image" || reel.post_type === "image";
                          if (isImageOnly) return <span className="text-xs text-muted-2">—</span>;
                          if (reel.transcript) return <CopyButton text={reel.transcript} />;
                          if (transcribingUrls.has(reel.url)) return <TranscribingIndicator />;
                          const hasVideo = !!reel.video_path;
                          return (
                            <button
                              onClick={(e) => { e.stopPropagation(); if (hasVideo) onTranscriptFetch(reel.url); }}
                              disabled={busy || !hasVideo}
                              title={!hasVideo ? "Download media first to enable transcription" : undefined}
                              className="text-xs px-2 py-0.5 rounded-md border border-border text-muted hover:border-accent hover:text-accent disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                            >
                              Transcribe
                            </button>
                          );
                        })()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}


function SourceBadge({ source, label }: { source?: "dm" | "saved"; label?: string }) {
  const text = label ?? (source === "saved" ? "Saved" : "DM");
  const isSaved = source === "saved" || text === "Saved";
  const dmIdx = text.match(/^DM\s*(\d+)$/)?.[1];
  const dmColors = [
    "bg-surface-2 border-border text-muted",
    "bg-blue-50 border-blue-200 text-blue-600",
    "bg-purple-50 border-purple-200 text-purple-600",
    "bg-orange-50 border-orange-200 text-orange-600",
  ];
  let cls = "bg-surface-2 border-border text-muted";
  if (isSaved) cls = "bg-accent-light border-accent/20 text-accent";
  else if (dmIdx) cls = dmColors[parseInt(dmIdx) % dmColors.length] ?? dmColors[0];
  return (
    <span className={`inline-flex text-xs px-1.5 py-0.5 rounded border font-medium whitespace-nowrap ${cls}`}>
      {text}
    </span>
  );
}

function TranscribingIndicator() {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted">
      <svg className="animate-spin w-3 h-3 text-accent flex-shrink-0" viewBox="0 0 12 12" fill="none">
        <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.5" strokeOpacity="0.25" />
        <path d="M10.5 6A4.5 4.5 0 016 1.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <span>···</span>
    </span>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  function copy(e: React.MouseEvent) {
    e.stopPropagation();
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }
  return (
    <button
      onClick={copy}
      title="Copy transcript"
      className="flex items-center gap-1 text-xs text-success font-medium hover:text-accent transition-colors"
    >
      {copied ? (
        <>
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
            <path d="M1.5 5.5l3 3 5-5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Copied
        </>
      ) : (
        <>
          <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
            <rect x="1" y="3.5" width="6.5" height="7" rx="1" stroke="currentColor" strokeWidth="1.1" />
            <path d="M3.5 3.5V2a1 1 0 011-1h5a1 1 0 011 1v6.5a1 1 0 01-1 1H8" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
          </svg>
          Copy
        </>
      )}
    </button>
  );
}

function EmptyState({ noSources, onAddSource }: { noSources?: boolean; onAddSource?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 px-8 text-center">
      <div className="mb-5 opacity-20">
        <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
          <path d="M24 4C13 4 4 13 4 24s9 20 20 20 20-9 20-20S35 4 24 4z" stroke="var(--fg-muted)" strokeWidth="2" />
          <path d="M20 18l8 6-8 6V18z" fill="var(--fg-muted)" />
        </svg>
      </div>
      {noSources ? (
        <>
          <p className="text-primary font-medium mb-1">No sources yet</p>
          <p className="text-muted text-sm mb-5">Add a DM thread or saved posts to start scraping</p>
          {onAddSource && (
            <button
              onClick={onAddSource}
              className="flex items-center gap-2 bg-accent hover:bg-accent-dim text-white text-sm font-medium rounded-lg px-5 py-2.5 transition-colors"
            >
              + Add source
            </button>
          )}
        </>
      ) : (
        <>
          <p className="text-primary font-medium mb-1">No reels yet</p>
          <p className="text-muted text-sm">Sync a source to load reels</p>
        </>
      )}
    </div>
  );
}
