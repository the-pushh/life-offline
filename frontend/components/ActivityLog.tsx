"use client";

import { useEffect, useRef, useState } from "react";

type LineKind = "info" | "success" | "error" | "reel" | "skip" | "section";

export interface LogLine {
  type: "line";
  id: number;
  text: string;
  kind: LineKind;
}

export interface LogGroup {
  type: "group";
  id: number;
  label: string;
  lines: Array<{ id: number; text: string; kind: LineKind }>;
  done: boolean;
  success?: boolean;
  error?: boolean;
}

export interface LogStatus {
  type: "status";
  id: number;
  replaceId: string;
  text: string;
  kind: LineKind;
}

export type LogItem = LogLine | LogGroup | LogStatus;

interface Props {
  lines: LogItem[];
  isActive: boolean;
  progress?: number;
  statusLabel?: string;
  onCancel?: () => void;
}

export default function ActivityLog({ lines, isActive, progress = 0, statusLabel, onCancel }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [openGroups, setOpenGroups] = useState<Set<number>>(new Set());
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (expanded) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines, expanded]);

  useEffect(() => {
    if (isActive && lines.length > 0) setExpanded(true);
  }, [isActive, lines.length]);

  function toggleGroup(id: number) {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const totalCount = lines.reduce(
    (n, item) => n + (item.type === "group" ? item.lines.length : 1),
    0
  );

  return (
    <div className="fixed bottom-4 right-4 z-40 flex flex-col items-end gap-2 pointer-events-none">
      {expanded && (
        <div className="pointer-events-auto w-[680px] bg-surface border border-border rounded-xl shadow-modal overflow-hidden">
          {/* Header */}
          <div className="relative flex items-center justify-between px-4 py-2.5 border-b border-border bg-surface-2">
            <div className="flex items-center gap-2.5">
              {isActive
                ? <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
                : <span className="w-1.5 h-1.5 rounded-full bg-border-2" />
              }
              <span className="text-sm font-medium text-primary tracking-tight">Activity</span>
              <span className="text-[11px] text-muted bg-black/5 rounded px-1.5 py-0.5">{totalCount} events</span>
            </div>
            <button
              onClick={() => setExpanded(false)}
              className="text-muted hover:text-primary text-lg leading-none transition-colors"
              aria-label="Collapse"
            >
              ×
            </button>
            {progress > 0 && (
              <div
                className="absolute bottom-0 left-0 h-[2px] bg-accent transition-[width] duration-300 ease-out rounded-r-full"
                style={{ width: `${progress}%` }}
              />
            )}
          </div>

          {/* Log body */}
          <div className="h-[440px] overflow-y-auto py-2 font-mono text-xs">
            {lines.length === 0 ? (
              <p className="text-muted px-4 py-2 italic">Waiting to start…</p>
            ) : (
              lines.map((item, idx) => {
                if (item.type === "group") {
                  const isOpen = openGroups.has(item.id);
                  const prevIsGroup = idx > 0 && lines[idx - 1].type === "group";
                  return (
                    <div key={item.id} className={prevIsGroup ? "mt-1" : "mt-2"}>
                      <button
                        onClick={() => toggleGroup(item.id)}
                        className="w-full text-left flex items-center gap-2 px-4 py-1 hover:bg-black/[0.03] transition-colors group"
                      >
                        <span className="text-muted-2 select-none text-[10px] w-3 shrink-0">
                          {isOpen ? "▾" : "▸"}
                        </span>
                        <span className="flex-1 text-muted font-medium">{item.label}</span>
                        <span className="shrink-0">
                          {!item.done
                            ? <span className="w-2 h-2 rounded-full border border-accent/50 animate-pulse inline-block" />
                            : item.error
                            ? <span className="text-error">✗</span>
                            : <span className="text-success">✓</span>
                          }
                        </span>
                      </button>
                      {isOpen && (
                        <div className="ml-7 mr-4 mb-1 border-l-2 border-border/30 pl-3">
                          {item.lines.map((line) => (
                            <LogLineRow key={line.id} text={line.text} kind={line.kind} />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                }

                if (item.type === "status") {
                  return <StatusRow key={item.id} text={item.text} kind={item.kind} />;
                }

                if (item.kind === "section") {
                  return <SectionRow key={item.id} text={item.text} />;
                }

                return <LogLineRow key={item.id} text={item.text} kind={item.kind} />;
              })
            )}
            <div ref={bottomRef} />
          </div>
        </div>
      )}

      <div className="pointer-events-auto flex items-center gap-2">
        {isActive && onCancel && (
          <button
            onClick={onCancel}
            title="Stop job"
            className="flex items-center gap-1.5 bg-surface border border-error/40 text-error rounded-full px-3 py-2 shadow-panel hover:bg-error/10 transition-colors text-sm"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
              <rect x="1" y="1" width="8" height="8" rx="1.5" />
            </svg>
            Stop
          </button>
        )}
        <button
          onClick={() => setExpanded((e) => !e)}
          className="flex items-center gap-2 bg-surface border border-border rounded-full px-4 py-2 shadow-panel hover:border-border-2 transition-colors"
        >
          {isActive
            ? <span className="w-2 h-2 rounded-full bg-accent animate-pulse" />
            : <span className="w-2 h-2 rounded-full bg-border-2" />
          }
          <span className="text-sm text-muted">
            {isActive ? (statusLabel ?? "Running…") : lines.length > 0 ? `${totalCount} events` : "Activity"}
          </span>
          <span className="text-muted text-xs">{expanded ? "▼" : "▲"}</span>
        </button>
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function LogLineRow({ text, kind }: { text: string; kind: LineKind }) {
  return (
    <div className={`flex items-start gap-2 px-4 py-[1px] ${kind === "skip" ? "opacity-60" : ""}`}>
      <span className={`shrink-0 mt-[2px] w-3 text-center select-none ${iconColor(kind)}`}>
        {lineIcon(kind)}
      </span>
      <span className={`leading-5 ${textColor(kind)} ${kind === "skip" ? "italic" : ""}`}>
        {text.replace(/^\s*(↩|✓|✗|·)\s*/, "")}
      </span>
    </div>
  );
}

function StatusRow({ text, kind }: { text: string; kind: LineKind }) {
  return (
    <div className="flex items-center gap-0 mx-3 my-1 rounded-md bg-black/[0.03] border border-border/40 overflow-hidden">
      <div className={`w-[3px] self-stretch shrink-0 ${statusBarColor(kind)}`} />
      <div className="flex items-center gap-2 px-3 py-1.5 min-w-0">
        <span className={`shrink-0 ${iconColor(kind)}`}>{lineIcon(kind)}</span>
        <span className={`leading-4 truncate ${textColor(kind)}`}>{text.replace(/^\s*(↩|✓|✗|·)\s*/, "")}</span>
      </div>
    </div>
  );
}

function SectionRow({ text }: { text: string }) {
  const label = text.replace(/^─+\s*/, "");
  return (
    <div className="flex items-center gap-2 px-4 mt-3 mb-1">
      <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-2 shrink-0">
        {label}
      </span>
      <div className="flex-1 h-px bg-border/50" />
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function lineIcon(kind: LineKind): string {
  switch (kind) {
    case "success": return "✓";
    case "error":   return "✗";
    case "reel":    return "◆";
    case "skip":    return "↩";
    case "section": return "—";
    default:        return "·";
  }
}

function textColor(kind: LineKind): string {
  switch (kind) {
    case "success": return "text-success";
    case "error":   return "text-error";
    case "reel":    return "text-accent";
    case "skip":    return "text-muted-2";
    default:        return "text-muted";
  }
}

function iconColor(kind: LineKind): string {
  switch (kind) {
    case "success": return "text-success";
    case "error":   return "text-error";
    case "reel":    return "text-accent";
    case "skip":    return "text-muted-2";
    default:        return "text-border-2";
  }
}

function statusBarColor(kind: LineKind): string {
  switch (kind) {
    case "success": return "bg-success";
    case "error":   return "bg-error";
    case "reel":    return "bg-accent";
    default:        return "bg-accent/40";
  }
}

export function classifyLine(text: string): LineKind {
  const t = text.trim();
  if (t.startsWith("──") || t.startsWith("──")) return "section";
  if (t.startsWith("✓") || t.startsWith("✔")) return "success";
  if (t.startsWith("✗") || t.toLowerCase().includes("error")) return "error";
  if (t.startsWith("↩")) return "skip";
  if (t.includes("reel") || t.startsWith("+ @") || t.startsWith("◆")) return "reel";
  return "info";
}
