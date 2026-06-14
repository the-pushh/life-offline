"use client";

import { useEffect, useRef, useState } from "react";
import { downloadVideo, mediaFileUrl } from "@/lib/api";
import type { Reel } from "@/lib/api";

interface Props {
  reel: Reel;
  allReels: Reel[];
  onClose: () => void;
  onMediaReady: (url: string, result: { video_path?: string; image_paths?: string[] }) => void;
  onCaptionFetch: (url: string) => void;
  onTranscriptFetch: (url: string) => void;
  onDownload?: (url: string) => void;
}

export default function ReelModal({
  reel,
  allReels,
  onClose,
  onMediaReady,
  onCaptionFetch,
  onTranscriptFetch,
  onDownload,
}: Props) {
  const [currentIdx, setCurrentIdx] = useState(() =>
    Math.max(0, allReels.findIndex((r) => r.url === reel.url))
  );

  const currentReel = allReels[currentIdx] ?? reel;

  const [phase, setPhase] = useState<"idle" | "downloading" | "ready" | "error">(() =>
    currentReel.video_path || currentReel.image_paths?.length ? "ready" : "idle"
  );
  const [errorMsg, setErrorMsg] = useState("");
  const [imageIndex, setImageIndex] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const r = allReels[currentIdx];
    if (!r) return;
    setPhase(r.video_path || r.image_paths?.length ? "ready" : "idle");
    setImageIndex(0);
    setErrorMsg("");
  }, [currentIdx]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key === "ArrowLeft") {
        if (isCarousel && !e.altKey) setImageIndex((i) => Math.max(0, i - 1));
        else setCurrentIdx((i) => Math.max(0, i - 1));
      }
      if (e.key === "ArrowRight") {
        if (isCarousel && !e.altKey) setImageIndex((i) => Math.min((currentReel.image_paths?.length ?? 1) - 1, i + 1));
        else setCurrentIdx((i) => Math.min(allReels.length - 1, i + 1));
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, allReels.length, currentReel.image_paths?.length]);

  async function triggerDownload() {
    setPhase("downloading");
    if (onDownload) {
      onDownload(currentReel.url);
    } else {
      const res = await downloadVideo(currentReel.url);
      if (res.error) { setPhase("error"); setErrorMsg(res.error); }
    }
  }

  const imagePaths = currentReel.image_paths ?? [];
  const isCarousel = imagePaths.length > 0;
  const videoSrc = currentReel.video_path ? mediaFileUrl(currentReel.video_path) : "";

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />

      {/* Card row: left arrow — card — right arrow */}
      <div className="relative z-10 flex items-center gap-3 w-full max-w-5xl px-4">
        {/* Prev */}
        <div className="w-10 flex-shrink-0 flex justify-center">
          {currentIdx > 0 && (
            <button
              onClick={() => setCurrentIdx((i) => i - 1)}
              className="w-9 h-9 flex items-center justify-center rounded-full bg-white/15 hover:bg-white/30 text-white transition-all"
            >
              <svg width="8" height="14" viewBox="0 0 8 14" fill="none">
                <path d="M7 1L1 7l6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          )}
        </div>

        {/* Card */}
        <div className="flex overflow-hidden flex-1 max-h-[85vh] rounded-2xl shadow-modal bg-surface">

        {/* LEFT: Media */}
        <div className="w-[420px] flex-shrink-0 bg-black flex flex-col min-h-0">
          {/* Media area */}
          <div className="flex-1 relative flex items-center justify-center min-h-0">
            {phase === "idle" && (
              <div className="flex flex-col items-center gap-4 text-white/60">
                <svg width="44" height="44" viewBox="0 0 44 44" fill="none">
                  <path d="M22 6v22M13 19l9 9 9-9M6 36h32" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <p className="text-sm">Media not downloaded</p>
                <button
                  onClick={triggerDownload}
                  className="px-5 py-2 rounded-xl bg-white/10 hover:bg-white/20 text-sm text-white transition-colors"
                >
                  Download media
                </button>
              </div>
            )}

            {phase === "downloading" && (
              <div className="flex flex-col items-center gap-3 text-white/60">
                <svg className="animate-spin w-8 h-8" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                </svg>
                <span className="text-sm">Downloading…</span>
              </div>
            )}

            {phase === "error" && (
              <div className="flex flex-col items-center gap-3 text-white/60 px-8 text-center">
                <span className="text-3xl">⚠</span>
                <p className="text-sm">{errorMsg}</p>
                <button onClick={triggerDownload} className="text-xs bg-white/10 hover:bg-white/20 px-4 py-2 rounded-lg transition-colors text-white">
                  Retry
                </button>
              </div>
            )}

            {phase === "ready" && isCarousel && (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  key={imagePaths[imageIndex]}
                  src={mediaFileUrl(imagePaths[imageIndex])}
                  alt={`${imageIndex + 1} of ${imagePaths.length}`}
                  className="w-full h-full object-contain"
                />
                {imagePaths.length > 1 && (
                  <>
                    <button onClick={() => setImageIndex((i) => Math.max(0, i - 1))} disabled={imageIndex === 0}
                      className="absolute left-2 top-1/2 -translate-y-1/2 w-9 h-9 flex items-center justify-center rounded-full bg-black/40 hover:bg-black/70 text-white text-lg disabled:opacity-20 transition-colors">
                      ‹
                    </button>
                    <button onClick={() => setImageIndex((i) => Math.min(imagePaths.length - 1, i + 1))} disabled={imageIndex === imagePaths.length - 1}
                      className="absolute right-2 top-1/2 -translate-y-1/2 w-9 h-9 flex items-center justify-center rounded-full bg-black/40 hover:bg-black/70 text-white text-lg disabled:opacity-20 transition-colors">
                      ›
                    </button>
                    <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex gap-1">
                      {imagePaths.map((_, idx) => (
                        <button key={idx} onClick={() => setImageIndex(idx)}
                          className={`w-1.5 h-1.5 rounded-full transition-all ${idx === imageIndex ? "bg-white scale-125" : "bg-white/40"}`} />
                      ))}
                    </div>
                  </>
                )}
              </>
            )}

            {phase === "ready" && !isCarousel && (
              <video ref={videoRef} src={videoSrc} controls autoPlay className="w-full h-full object-contain" />
            )}
          </div>

        </div>

        {/* RIGHT: Details */}
        <div className="flex flex-col flex-1 min-w-0 min-h-0 max-h-[85vh]">
          {/* Header */}
          <div className="flex items-start justify-between px-5 py-4 border-b border-border flex-shrink-0">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-primary text-base">@{currentReel.sender}</span>
                {currentReel.source_label && (
                  <span className="text-xs px-1.5 py-0.5 rounded-full bg-surface-2 border border-border text-muted">
                    {currentReel.source_label}
                  </span>
                )}
                {currentReel.post_type && currentReel.post_type !== "video" && (
                  <span className="text-xs px-1.5 py-0.5 rounded-full bg-surface-2 border border-border text-muted">
                    {currentReel.post_type.replace(/_/g, " ")}
                  </span>
                )}
              </div>
              <p className="text-xs text-muted mt-0.5">{currentReel.timestamp}</p>
            </div>
            <button
              onClick={onClose}
              className="ml-3 flex-shrink-0 w-7 h-7 flex items-center justify-center rounded-full hover:bg-black/10 text-muted hover:text-primary transition-colors text-xl leading-none"
            >
              ×
            </button>
          </div>

          {/* Scrollable body */}
          <div className="flex-1 overflow-y-auto min-h-0 px-5 py-4 space-y-6">

            {/* Caption */}
            <section>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-semibold text-muted uppercase tracking-widest">Caption</h3>
                {!currentReel.caption && (
                  <button
                    onClick={() => onCaptionFetch(currentReel.url)}
                    className="text-xs px-2.5 py-1 rounded-lg bg-accent text-white hover:bg-accent/80 font-medium transition-colors"
                  >
                    Fetch
                  </button>
                )}
              </div>
              {currentReel.caption ? (
                <p className="text-sm text-primary leading-relaxed whitespace-pre-wrap">{currentReel.caption}</p>
              ) : (
                <p className="text-sm text-muted/40 italic">No caption yet</p>
              )}
            </section>

            {/* Transcript */}
            <section>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-semibold text-muted uppercase tracking-widest">Transcript</h3>
                <div className="flex items-center gap-2">
                  {currentReel.transcript && (
                    <ModalCopyButton text={currentReel.transcript} />
                  )}
                  {!currentReel.transcript && (
                    <button
                      onClick={() => onTranscriptFetch(currentReel.url)}
                      className="text-xs px-2.5 py-1 rounded-lg border border-border text-muted hover:border-accent hover:text-accent font-medium transition-colors"
                    >
                      Generate
                    </button>
                  )}
                </div>
              </div>
              {currentReel.transcript ? (
                <p className="text-sm text-muted leading-relaxed font-mono bg-surface-2 rounded-xl p-3 whitespace-pre-wrap">{currentReel.transcript}</p>
              ) : (
                <p className="text-sm text-muted/40 italic">No transcript yet</p>
              )}
            </section>

            {/* Meta */}
            <section>
              <h3 className="text-xs font-semibold text-muted uppercase tracking-widest mb-2">Details</h3>
              <div className="space-y-2">
                {currentReel.source && (
                  <MetaRow label="Source" value={currentReel.source === "saved" ? "Saved posts" : "Direct message"} />
                )}
                {currentReel.post_type && (
                  <MetaRow label="Type" value={currentReel.post_type.replace(/_/g, " ")} />
                )}
                <div className="flex items-start gap-3 text-sm">
                  <span className="text-muted w-20 flex-shrink-0">Link</span>
                  <a
                    href={currentReel.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="text-accent hover:underline break-all"
                  >
                    Open on Instagram ↗
                  </a>
                </div>
              </div>
            </section>
          </div>
        </div>

        </div>{/* /card */}

        {/* Next */}
        <div className="w-10 flex-shrink-0 flex justify-center">
          {currentIdx < allReels.length - 1 && (
            <button
              onClick={() => setCurrentIdx((i) => i + 1)}
              className="w-9 h-9 flex items-center justify-center rounded-full bg-white/15 hover:bg-white/30 text-white transition-all"
            >
              <svg width="8" height="14" viewBox="0 0 8 14" fill="none">
                <path d="M1 1l6 6-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          )}
        </div>
      </div>{/* /card row */}

      {/* Index pill below card */}
      <div className="relative z-10">
        <span className="text-white text-xs tabular-nums bg-black/50 rounded-full px-3 py-1">
          {currentIdx + 1} / {allReels.length}
        </span>
      </div>
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-3 text-sm">
      <span className="text-muted w-20 flex-shrink-0">{label}</span>
      <span className="text-primary capitalize">{value}</span>
    </div>
  );
}

function ModalCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }
  return (
    <button
      onClick={copy}
      className="flex items-center gap-1.5 text-xs text-muted hover:text-accent transition-colors"
      title="Copy transcript"
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
