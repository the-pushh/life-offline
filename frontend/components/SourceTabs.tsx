"use client";

import { useEffect, useRef, useState } from "react";
import type { StoredSource } from "@/lib/api";

interface Props {
  sources: StoredSource[];
  activeSource: string;
  onSelect: (name: string) => void;
  onRescrape: (name: string) => void;
  onDownloadMedia: (name: string) => void;
  onCaptions: (name: string) => void;
  onTranscripts: (name: string) => void;
  onRemove: (name: string) => void;
  onAdd: () => void;
  reelCounts: Record<string, number>;
  search: string;
  onSearchChange: (v: string) => void;
}

export default function SourceTabs({
  sources,
  activeSource,
  onSelect,
  onRescrape,
  onDownloadMedia,
  onCaptions,
  onTranscripts,
  onRemove,
  onAdd,
  reelCounts,
  search,
  onSearchChange,
}: Props) {
  return (
    <div className="flex items-stretch h-11 border-b border-border">
      {/* Tab strip */}
      <div className="flex items-stretch flex-1 min-w-0">
        {sources.map((source) => (
          <Tab
            key={source.name}
            label={source.name}
            count={reelCounts[source.name] ?? 0}
            active={activeSource === source.name}
            type={source.type}
            onSelect={() => onSelect(source.name)}
            onRescrape={() => onRescrape(source.name)}
            onDownloadMedia={() => onDownloadMedia(source.name)}
            onCaptions={() => onCaptions(source.name)}
            onTranscripts={() => onTranscripts(source.name)}
            onRemove={() => onRemove(source.name)}
          />
        ))}
      </div>

      {/* Right: search + new source */}
      <div className="flex items-center gap-2 px-3 flex-shrink-0">
        <input
          type="text"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Filter…"
          className="bg-transparent border border-border/60 rounded-lg px-2.5 py-1 text-xs text-primary placeholder-muted focus:outline-none focus:border-accent/50 w-36 transition-colors"
        />
        <button
          onClick={onAdd}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent text-white text-xs font-medium hover:bg-accent/85 transition-colors flex-shrink-0"
        >
          <span className="text-sm leading-none">+</span>
          <span>New source</span>
        </button>
      </div>
    </div>
  );
}

function Tab({
  label,
  count,
  active,
  type,
  onSelect,
  onRescrape,
  onDownloadMedia,
  onCaptions,
  onTranscripts,
  onRemove,
}: {
  label: string;
  count: number;
  active: boolean;
  type?: "dm" | "saved";
  onSelect: () => void;
  onRescrape: () => void;
  onDownloadMedia: () => void;
  onCaptions: () => void;
  onTranscripts: () => void;
  onRemove: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function handler(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  return (
    <div
      onClick={onSelect}
      className={[
        "relative h-full flex items-center gap-1.5 px-3 text-sm flex-shrink-0 cursor-pointer group select-none transition-colors border-r border-border",
        active ? "text-primary" : "text-muted hover:text-primary",
      ].join(" ")}
    >
      {/* Active underline */}
      {active && (
        <span className="absolute bottom-0 left-2 right-2 h-0.5 bg-accent rounded-full" />
      )}

      {type === "dm" && (
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none" className="flex-shrink-0 text-muted/60">
          <path d="M1.5 2.5a1 1 0 011-1h8a1 1 0 011 1v5a1 1 0 01-1 1H4.5L1.5 11V2.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
        </svg>
      )}
      {type === "saved" && (
        <svg width="12" height="13" viewBox="0 0 12 13" fill="none" className="flex-shrink-0 text-accent">
          <path d="M2 2a1 1 0 011-1h6a1 1 0 011 1v9.5L6 9.5 2 11.5V2z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
        </svg>
      )}

      <span className={active ? "font-medium" : ""}>{label}</span>

      {count > 0 && (
        <span className={`text-xs px-1.5 py-0.5 rounded-full tabular-nums ${
          active ? "bg-accent-light text-accent" : "bg-black/8 text-muted group-hover:bg-black/12"
        }`}>
          {count}
        </span>
      )}

      {/* Three-dot menu */}
      <div
        ref={menuRef}
        className="relative"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          aria-label={`Options for ${label}`}
          onClick={(e) => { e.stopPropagation(); setMenuOpen((o) => !o); }}
          className="flex items-center justify-center w-6 h-6 rounded text-current opacity-40 hover:opacity-100 hover:bg-black/10 transition-opacity"
        >
          <svg width="10" height="3" viewBox="0 0 10 3" fill="currentColor">
            <circle cx="1.5" cy="1.5" r="1" />
            <circle cx="5" cy="1.5" r="1" />
            <circle cx="8.5" cy="1.5" r="1" />
          </svg>
        </button>

        {menuOpen && (
          <div className="absolute top-full left-0 z-50 mt-1.5 bg-surface rounded-xl shadow-modal border border-border py-1 min-w-[195px]">
            <MenuItem onClick={() => { setMenuOpen(false); onRescrape(); }}>
              ↺ Sync latest
            </MenuItem>
            <MenuItem onClick={() => { setMenuOpen(false); onDownloadMedia(); }}>
              ↓ Download all media
            </MenuItem>
            <MenuItem onClick={() => { setMenuOpen(false); onTranscripts(); }}>
              ◎ Generate all transcripts
            </MenuItem>
            <MenuItem onClick={() => { setMenuOpen(false); onCaptions(); }}>
              ✦ Enrich all captions
            </MenuItem>
            <div className="my-1 border-t border-border" />
            <MenuItem danger onClick={() => { setMenuOpen(false); onRemove(); }}>
              ✕ Delete source
            </MenuItem>
          </div>
        )}
      </div>
    </div>
  );
}

function MenuItem({
  children,
  onClick,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-4 py-2 text-sm transition-colors ${
        danger ? "text-error hover:bg-red-50" : "text-primary hover:bg-black/5"
      }`}
    >
      {children}
    </button>
  );
}
