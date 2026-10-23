export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";
export const WS_BASE =
  process.env.NEXT_PUBLIC_WS_BASE ?? "ws://localhost:8000";

export interface Reel {
  url: string;
  thumbnail: string;
  caption: string;
  sender: string;
  timestamp: string;
  transcript?: string;
  video_path?: string;
  image_paths?: string[];
  post_type?: "video" | "image" | "carousel_image" | "carousel_video";
  source?: "dm" | "saved";
  source_label?: string;
  id?: number;
  decision?: Decision | null;
  notes?: string | null;
  summary?: string | null;
  key_points?: string[] | null;
  duplicate_of?: string | null;
}

export type Decision = "keep" | "summarize" | "full" | "discard";

export interface Source {
  type: "dm" | "saved";
  url?: string;       // for dm
  username?: string;  // for saved
  name?: string;      // user-defined tab label → becomes source_label in reels
  fresh?: boolean;    // if true, purge existing reels for this source before scraping
}

export interface StoredSource {
  type: "dm" | "saved";
  url?: string;
  username?: string;
  name: string;       // always set (auto-generated if user left blank)
}

export interface WsEvent {
  type:
    | "log"
    | "log_replace"
    | "log_group_start"
    | "log_group_end"
    | "transcription_start"
    | "transcription_progress"
    | "transcribing_url"
    | "download_progress"
    | "reel"
    | "caption_update"
    | "transcript_update"
    | "reel_update"
    | "kb_update"
    | "done"
    | "error";
  msg?: string;
  replace_id?: string;
  label?: string;
  success?: boolean;
  current?: number;
  total?: number;
  data?: Reel;
  url?: string;
  caption?: string;
  id?: string;
  transcript?: string;
  media?: { video_path?: string; image_paths?: string[]; post_type?: string; thumbnail?: string };
  stage?: "scrape" | "captions" | "transcripts";
  count?: number;
  summary?: string;
  key_points?: string[];
}

export interface StatusResponse {
  session_exists: boolean;
  reels_count: number;
  current_job: string | null;
  default_thread_url: string;
}

export async function clearSession(): Promise<void> {
  await fetch(`${API_BASE}/api/session`, { method: "DELETE" });
}

export async function cancelJob(): Promise<{ cancelled: boolean }> {
  const r = await fetch(`${API_BASE}/api/job/cancel`, { method: "POST" });
  return r.json();
}

export async function deleteSource(sourceLabel: string): Promise<{ deleted_reels: number; removed_files: number }> {
  const r = await fetch(`${API_BASE}/api/source/${encodeURIComponent(sourceLabel)}`, { method: "DELETE" });
  return r.json();
}

export async function fetchStatus(): Promise<StatusResponse> {
  const r = await fetch(`${API_BASE}/api/status`);
  return r.json();
}

export async function fetchReels(): Promise<Reel[]> {
  const r = await fetch(`${API_BASE}/api/reels`);
  return r.json();
}

export async function startScrape(
  sources: Source[],
  downloadMedia = false,
  fullScan = false
): Promise<{ job_id?: string; error?: string }> {
  const r = await fetch(`${API_BASE}/api/scrape`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sources, download_media: downloadMedia, full_scan: fullScan }),
  });
  return r.json();
}

export async function startCaptions(urls?: string[]): Promise<{ job_id?: string; error?: string }> {
  const r = await fetch(`${API_BASE}/api/enrich/captions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ urls: urls ?? null }),
  });
  return r.json();
}

export async function startTranscripts(urls?: string[]): Promise<{ job_id?: string; error?: string }> {
  const r = await fetch(`${API_BASE}/api/enrich/transcripts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ urls: urls ?? null }),
  });
  return r.json();
}

export async function startDownloadAll(sourceLabel?: string, urls?: string[]): Promise<{ job_id?: string; error?: string }> {
  const r = await fetch(`${API_BASE}/api/enrich/download-all`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source_label: sourceLabel ?? null, urls: urls ?? null }),
  });
  return r.json();
}

export async function refetchCaption(
  url: string
): Promise<{ job_id?: string; error?: string }> {
  const r = await fetch(`${API_BASE}/api/reel/caption`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  return r.json();
}

export async function refetchTranscript(
  url: string
): Promise<{ job_id?: string; error?: string }> {
  const r = await fetch(`${API_BASE}/api/reel/transcript`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  return r.json();
}

export async function downloadVideo(url: string): Promise<{ job_id?: string; error?: string }> {
  const r = await fetch(`${API_BASE}/api/reel/download`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  return r.json();
}

export async function runDedupe(): Promise<{ groups: number; duplicates: number; unique: number }> {
  const r = await fetch(`${API_BASE}/api/kb/dedupe`, { method: "POST" });
  return r.json();
}

export async function setDecision(
  url: string,
  decision: Decision | null,
  notes?: string
): Promise<Reel & { error?: string }> {
  const r = await fetch(`${API_BASE}/api/kb/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, decision, notes: notes ?? null }),
  });
  return r.json();
}

export async function saveNotes(url: string, notes: string): Promise<void> {
  await fetch(`${API_BASE}/api/kb/notes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, notes }),
  });
}

export async function startSummarize(urls?: string[], force = false): Promise<{ job_id?: string; error?: string }> {
  const r = await fetch(`${API_BASE}/api/kb/summarize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ urls: urls ?? null, force }),
  });
  return r.json();
}

export async function fetchKbStatus(): Promise<{ llm: boolean; model: string | null }> {
  const r = await fetch(`${API_BASE}/api/kb/status`);
  return r.json();
}

/** Strip Instagram's og:description wrapper: `12K likes, 3 comments - user on Mar 3, 2024: "…".` */
export function cleanCaption(caption?: string | null): string {
  if (!caption) return "";
  return caption
    .replace(/^\s*[\d.,]+[KkMm]?\s+likes?,\s*[\d.,]+[KkMm]?\s+comments?\s*-\s*\S+\s+on\s+[^:]{3,40}:\s*"?/, "")
    .replace(/"\.?\s*$/, "")
    .trim();
}

export function videoUrl(reelId: string): string {
  return `${API_BASE}/api/videos/${reelId}`;
}

export function mediaFileUrl(relativePath: string): string {
  const clean = relativePath.replace(/^\//, "");
  if (clean.startsWith("videos/")) {
    const reelId = clean.slice("videos/".length).replace(/\.[^.]+$/, "");
    return `${API_BASE}/api/videos/${reelId}`;
  }
  return `${API_BASE}/api/${clean}`;
}

export function openJobSocket(jobId: string): WebSocket {
  return new WebSocket(`${WS_BASE}/ws/${jobId}`);
}
