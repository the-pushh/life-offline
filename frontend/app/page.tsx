"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import TopBar from "@/components/TopBar";
import ActivityLog, { classifyLine, type LogItem, type LogGroup, type LogStatus } from "@/components/ActivityLog";
import ReelsTable from "@/components/ReelsTable";
import VideoModal from "@/components/VideoModal";
import SourceTabs from "@/components/SourceTabs";
import AddSourceModal from "@/components/AddSourceModal";
import SkyBackground from "@/components/SkyBackground";
import StatsBar from "@/components/StatsBar";
import TranscriptionBubble from "@/components/TranscriptionBubble";
import {
  fetchStatus,
  fetchReels,
  startScrape,
  startCaptions,
  startTranscripts,
  startDownloadAll,
  refetchCaption,
  refetchTranscript,
  downloadVideo,
  clearSession,
  deleteSource,
  cancelJob,
  openJobSocket,
  API_BASE,
  type Reel,
  type Source,
  type StoredSource,
  type WsEvent,
} from "@/lib/api";

type Status = "idle" | "scraping" | "captions" | "transcripts" | "downloading";

let _lineId = 0;
function nextId() { return ++_lineId; }

function loadStoredSources(): StoredSource[] {
  try {
    const raw = localStorage.getItem("lo_sources");
    if (raw) return JSON.parse(raw) as StoredSource[];
  } catch {}
  return [];
}

function saveStoredSources(sources: StoredSource[]) {
  localStorage.setItem("lo_sources", JSON.stringify(sources));
}

export default function Home() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [reels, setReels] = useState<Reel[]>([]);
  const [logs, setLogs] = useState<LogItem[]>([]);
  const activeGroupIdRef = useRef<number | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [sessionExists, setSessionExists] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showAddSource, setShowAddSource] = useState(false);
  const [videoModal, setVideoModal] = useState<Reel | null>(null);
  const [fullWidth, setFullWidth] = useState(false);
  const [configuredSources, setConfiguredSources] = useState<StoredSource[]>([]);
  const [activeSource, setActiveSource] = useState<string>("all");
  const [rescrapeTarget, setRescrapeTarget] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [transcriptionProgress, setTranscriptionProgress] = useState({ current: 0, total: 0 });
  const [downloadProgress, setDownloadProgress] = useState({ current: 0, total: 0 });
  const [transcribingUrls, setTranscribingUrls] = useState<Set<string>>(new Set());
  const [downloadingUrls, setDownloadingUrls] = useState<Set<string>>(new Set());
  const socketRef = useRef<WebSocket | null>(null);
  const stallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const captionsCount = reels.filter((r) => r.caption).length;
  const isActive = status !== "idle";

  const overallProgress = useMemo(() => {
    if (status === "transcripts" && transcriptionProgress.total > 0) {
      return Math.round((transcriptionProgress.current / transcriptionProgress.total) * 100);
    }
    if (status === "downloading" && downloadProgress.total > 0) {
      return Math.round((downloadProgress.current / downloadProgress.total) * 100);
    }
    if (status === "scraping" || status === "captions") {
      const capStatus = logs.find(
        (item): item is LogStatus =>
          item.type === "status" &&
          ["cap_progress", "caption_progress"].includes((item as LogStatus).replaceId)
      );
      if (capStatus) {
        const m = capStatus.text.match(/\[(\d+)\/(\d+)\]/);
        if (m) return Math.min(100, Math.round((parseInt(m[1]) / parseInt(m[2])) * 100));
      }
    }
    return 0;
  }, [status, transcriptionProgress, downloadProgress, logs]);

  // Derived: per-source reel counts and filtered reels
  const reelCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const s of configuredSources) {
      counts[s.name] = reels.filter((r) => r.source_label === s.name).length;
    }
    return counts;
  }, [reels, configuredSources]);

  const filteredReels = useMemo(
    () =>
      configuredSources.length === 0
        ? []
        : !activeSource
        ? reels
        : reels.filter((r) => r.source_label === activeSource),
    [reels, activeSource, configuredSources.length]
  );

  // Reset search when switching tabs
  useEffect(() => { setSearch(""); }, [activeSource]);

  // Persist + apply theme
  useEffect(() => {
    const saved = localStorage.getItem("lo_theme") as "light" | "dark" | null;
    if (saved) setTheme(saved);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("lo_theme", theme);
  }, [theme]);

  // Bootstrap: load existing reels + check session
  useEffect(() => {
    fetchStatus().then((s) => setSessionExists(s.session_exists));
    fetchReels().then((r) => { if (r.length > 0) setReels(r); });

    const stored = loadStoredSources();
    setConfiguredSources(stored);
    if (stored.length > 0) setActiveSource(stored[0].name);

    const configured =
      stored.length > 0 || localStorage.getItem("lo_sources_configured");
    if (!configured) setShowOnboarding(true);
  }, []);

  const addLog = useCallback((text: string, kind?: "info" | "success" | "error" | "reel") => {
    const lineKind = kind ?? classifyLine(text);
    const gid = activeGroupIdRef.current;
    if (gid !== null) {
      setLogs((prev) =>
        prev.map((item) =>
          item.type === "group" && item.id === gid
            ? { ...item, lines: [...item.lines, { id: nextId(), text, kind: lineKind }] }
            : item
        )
      );
    } else {
      setLogs((prev) => [...prev, { type: "line", id: nextId(), text, kind: lineKind }]);
    }
  }, []);

  const startGroup = useCallback((label: string) => {
    const id = nextId();
    activeGroupIdRef.current = id;
    setLogs((prev) => [
      ...prev,
      { type: "group", id, label, lines: [], done: false },
    ]);
  }, []);

  const replaceLog = useCallback((replaceId: string, text: string, kind?: "info" | "success" | "error" | "reel") => {
    const lineKind = kind ?? classifyLine(text);
    setLogs((prev) => {
      const idx = prev.findIndex((item) => item.type === "status" && (item as LogStatus).replaceId === replaceId);
      const updated: LogItem = { type: "status", id: idx >= 0 ? prev[idx].id : nextId(), replaceId, text, kind: lineKind };
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = updated;
        return next;
      }
      return [...prev, updated];
    });
  }, []);

  const endGroup = useCallback((success?: boolean) => {
    const gid = activeGroupIdRef.current;
    if (gid === null) return;
    activeGroupIdRef.current = null;
    setLogs((prev) =>
      prev.map((item) =>
        item.type === "group" && item.id === gid
          ? { ...item, done: true, success, error: success === false }
          : item
      )
    );
  }, []);

  function connectJob(jobId: string, jobStatus: Status) {
    socketRef.current?.close();
    if (stallTimerRef.current) clearTimeout(stallTimerRef.current);

    const ws = openJobSocket(jobId);
    socketRef.current = ws;
    setStatus(jobStatus);

    const resetStall = () => {
      if (stallTimerRef.current) clearTimeout(stallTimerRef.current);
      stallTimerRef.current = setTimeout(async () => {
        addLog("⚠ No activity for 90s — job stalled (computer may have slept). Cancelling. Re-run to resume from where it left off.", "error");
        await cancelJob();
        setStatus("idle");
        setDownloadProgress({ current: 0, total: 0 });
      }, 90_000);
    };
    resetStall();

    ws.onmessage = (ev) => {
      resetStall();
      const event: WsEvent = JSON.parse(ev.data);

      switch (event.type) {
        case "log_group_start":
          startGroup(event.label ?? "Processing…");
          break;

        case "log_group_end":
          endGroup(event.success !== false);
          break;

        case "transcription_start":
          setTranscriptionProgress({ current: 0, total: event.total ?? 0 });
          break;

        case "transcription_progress":
          setTranscriptionProgress({ current: event.current ?? 0, total: event.total ?? 0 });
          break;

        case "download_progress":
          setDownloadProgress({ current: event.current ?? 0, total: event.total ?? 0 });
          break;

        case "transcribing_url":
          if (event.url) setTranscribingUrls((s) => new Set(s).add(event.url!));
          break;

        case "log_replace":
          replaceLog(event.replace_id ?? "status", event.msg ?? "");
          break;

        case "log":
          addLog(event.msg ?? "");
          break;

        case "reel":
          if (event.data) {
            setReels((prev) => {
              const idx = prev.findIndex((r) => r.url === event.data!.url);
              if (idx >= 0) {
                // Update source_label in state — handles re-scrape after source delete+re-add
                const next = [...prev];
                next[idx] = { ...next[idx], source_label: event.data!.source_label };
                return next;
              }
              return [...prev, event.data!];
            });
          }
          break;

        case "caption_update":
          if (event.url && event.caption !== undefined) {
            setReels((prev) =>
              prev.map((r) =>
                r.url === event.url ? { ...r, caption: event.caption! } : r
              )
            );
          }
          break;

        case "transcript_update":
          if (event.transcript !== undefined) {
            const matchUrl = event.url;
            const matchId = event.id;
            setReels((prev) =>
              prev.map((r) => {
                const hit = matchUrl
                  ? r.url === matchUrl
                  : new URL(r.url).pathname.split("/").filter(Boolean).pop() === matchId;
                if (hit) return { ...r, transcript: event.transcript };
                return r;
              })
            );
            if (matchUrl) setTranscribingUrls((s) => { const n = new Set(s); n.delete(matchUrl); return n; });
          }
          break;

        case "reel_update":
          if (event.url && event.media) {
            setReels((prev) =>
              prev.map((r) => r.url === event.url ? { ...r, ...event.media } as Reel : r)
            );
            setDownloadingUrls((prev) => { const s = new Set(prev); s.delete(event.url!); return s; });
          }
          break;

        case "done":
          if (stallTimerRef.current) clearTimeout(stallTimerRef.current);
          addLog(`✓ Done — ${event.count ?? 0} items`, "success");
          setStatus("idle");
          setSessionExists(true);
          setTranscribingUrls(new Set());
          setDownloadProgress({ current: 0, total: 0 });
          if (jobStatus === "scraping" || jobStatus === "downloading") {
            fetchReels().then((r) => { if (r.length > 0) setReels(r); });
          }
          break;

        case "error":
          addLog(`✗ ${event.msg ?? "Unknown error"}`, "error");
          setStatus("idle");
          break;
      }
    };

    ws.onerror = () => {
      if (stallTimerRef.current) clearTimeout(stallTimerRef.current);
      addLog("✗ WebSocket error — check backend is running", "error");
      setStatus("idle");
    };

    ws.onclose = () => {
      if (stallTimerRef.current) clearTimeout(stallTimerRef.current);
      if (status !== "idle") setStatus("idle");
    };
  }

  async function handleRelogin() {
    await clearSession();
    setSessionExists(false);
    addLog("Session cleared — login window will open on next scrape.");
  }

  async function handleScrape(sources: Source[], downloadMedia = false) {
    setReels([]);  // clear so only this run's reels appear
    addLog(
      `Starting scrape (${sources.length} source${sources.length > 1 ? "s" : ""}${downloadMedia ? " + media download" : ""})…`
    );
    const res = await startScrape(sources, downloadMedia);
    if (res.error) { addLog(`✗ ${res.error}`, "error"); return; }
    connectJob(res.job_id!, "scraping");
  }

  async function handleCaptions() {
    addLog("Fetching captions for all reels…");
    const res = await startCaptions();
    if (res.error) { addLog(`✗ ${res.error}`, "error"); return; }
    connectJob(res.job_id!, "captions");
  }

  async function handleTranscripts() {
    setTranscriptionProgress({ current: 0, total: 0 });
    addLog("Starting audio transcript pipeline…");
    const res = await startTranscripts();
    if (res.error) { addLog(`✗ ${res.error}`, "error"); return; }
    connectJob(res.job_id!, "transcripts");
  }

  async function handleCaptionRefetch(url: string) {
    addLog(`Re-fetching caption for ${url.slice(0, 50)}…`);
    const res = await refetchCaption(url);
    if (res.error) { addLog(`✗ ${res.error}`, "error"); return; }
    connectJob(res.job_id!, "captions");
  }

  async function handleTranscriptRefetch(url: string) {
    setTranscriptionProgress({ current: 0, total: 0 });
    setTranscribingUrls((prev) => new Set([...prev, url]));
    addLog(`Generating transcript for ${url.slice(0, 50)}…`);
    const res = await refetchTranscript(url);
    if (res.error) {
      addLog(`✗ ${res.error}`, "error");
      setTranscribingUrls((prev) => { const s = new Set(prev); s.delete(url); return s; });
      return;
    }
    connectJob(res.job_id!, "transcripts");
  }

  async function handleDownloadReel(url: string) {
    setDownloadingUrls((prev) => new Set(prev).add(url));
    try {
      const res = await downloadVideo(url);
      if (res.error) {
        toast.error(res.error, { duration: 6000 });
        setDownloadingUrls((prev) => { const s = new Set(prev); s.delete(url); return s; });
      } else if (res.job_id) {
        connectJob(res.job_id, "downloading");
      }
    } catch {
      toast.error("Download failed — check backend connection");
      setDownloadingUrls((prev) => { const s = new Set(prev); s.delete(url); return s; });
    }
  }

  function handleMediaReady(
    url: string,
    result: { video_path?: string; image_paths?: string[] }
  ) {
    setReels((prev) =>
      prev.map((r) => (r.url === url ? { ...r, ...result } : r))
    );
    setVideoModal((prev) =>
      prev && prev.url === url ? { ...prev, ...result } : prev
    );
  }

  function handleAddSource(source: StoredSource, downloadMedia: boolean) {
    const updated = [...configuredSources, source];
    setConfiguredSources(updated);
    saveStoredSources(updated);
    localStorage.setItem("lo_sources_configured", "1");
    setActiveSource(source.name);
    setShowOnboarding(false);
    setShowAddSource(false);
    handleScrape([source], downloadMedia);
  }

  async function handleRescrapeSource(name: string, downloadMedia = false) {
    const source = configuredSources.find((s) => s.name === name);
    if (!source) return;
    addLog(`Syncing latest for ${name}…`);
    const res = await startScrape([source], downloadMedia);
    if (res.error) { addLog(`✗ ${res.error}`, "error"); return; }
    connectJob(res.job_id!, "scraping");
  }

  async function handleDownloadAllMedia(name: string) {
    addLog(`Downloading all media for ${name}…`);
    const res = await startDownloadAll(name);
    if (res.error) { addLog(`✗ ${res.error}`, "error"); return; }
    connectJob(res.job_id!, "downloading");
  }

  async function handleRunOnSelected(action: "download" | "captions" | "transcripts", urls: string[]) {
    if (!urls.length) return;
    if (action === "download") {
      addLog(`Downloading media for ${urls.length} selected reel(s)…`);
      const res = await startDownloadAll(undefined, urls);
      if (res.error) { addLog(`✗ ${res.error}`, "error"); return; }
      connectJob(res.job_id!, "downloading");
    } else if (action === "captions") {
      addLog(`Fetching captions for ${urls.length} selected reel(s)…`);
      const res = await startCaptions(urls);
      if (res.error) { addLog(`✗ ${res.error}`, "error"); return; }
      connectJob(res.job_id!, "captions");
    } else {
      setTranscriptionProgress({ current: 0, total: 0 });
      addLog(`Transcribing ${urls.length} selected reel(s)…`);
      const res = await startTranscripts(urls);
      if (res.error) { addLog(`✗ ${res.error}`, "error"); return; }
      connectJob(res.job_id!, "transcripts");
    }
  }

  async function handleRemoveSource(name: string) {
    await deleteSource(name);
    const remaining = configuredSources.filter((s) => s.name !== name);
    saveStoredSources(remaining);
    if (remaining.length === 0) {
      setReels([]);
      setActiveSource("");
      localStorage.removeItem("lo_sources_configured");
      setShowOnboarding(true);
    } else {
      setReels((prev) => prev.filter((r) => r.source_label !== name));
      if (activeSource === name) setActiveSource(remaining[0].name);
    }
    setConfiguredSources(remaining);
  }

  const innerClass = fullWidth
    ? "flex flex-col flex-1 overflow-hidden px-6 pt-5 min-h-0"
    : "flex flex-col flex-1 overflow-hidden max-w-[1100px] w-full mx-auto px-6 pt-5 min-h-0";

  return (
    <div className="h-screen flex flex-col overflow-hidden text-primary">
      <SkyBackground theme={theme} />

      <TopBar
        theme={theme}
        onThemeToggle={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
        fullWidth={fullWidth}
      />

      <main className="flex-1 overflow-hidden flex flex-col min-h-0">
        <div className={innerClass}>
          {/* Export row */}
          <div className="flex items-center justify-between gap-2 mb-4 flex-shrink-0">
            <StatsBar reels={filteredReels} />
            <div className="flex items-center gap-2 flex-shrink-0">
              <a
                href={`${API_BASE}/api/export/json`}
                download="reels.json"
                className={`text-xs text-muted hover:text-primary border border-border/70 bg-surface/60 hover:bg-surface/90 rounded-lg px-3 py-1.5 transition-colors backdrop-blur-sm ${
                  reels.length === 0 ? "opacity-40 pointer-events-none" : ""
                }`}
              >
                ↓ Export data (JSON)
              </a>
              <a
                href={`${API_BASE}/api/export/links`}
                download="reel_links.txt"
                className={`text-xs text-muted hover:text-primary border border-border/70 bg-surface/60 hover:bg-surface/90 rounded-lg px-3 py-1.5 transition-colors backdrop-blur-sm ${
                  reels.length === 0 ? "opacity-40 pointer-events-none" : ""
                }`}
              >
                ↓ Export URL list
              </a>
              <button
                onClick={() => setFullWidth((f) => !f)}
                className="text-xs text-muted hover:text-primary border border-border/70 bg-surface/60 hover:bg-surface/90 rounded-lg px-3 py-1.5 transition-colors backdrop-blur-sm"
                title={fullWidth ? "Switch to focused layout" : "Switch to wide layout"}
              >
                {fullWidth ? "⊡ Focused view" : "⤢ Wide view"}
              </button>
            </div>
          </div>

          <div className="glass-surface rounded-2xl overflow-hidden shadow-panel flex flex-col flex-1 min-h-0 mb-5">
            {configuredSources.length > 0 && (
              <SourceTabs
                sources={configuredSources}
                activeSource={activeSource}
                onSelect={setActiveSource}
                onRescrape={(name) => setRescrapeTarget(name)}
                onDownloadMedia={handleDownloadAllMedia}
                onCaptions={() => handleCaptions()}
                onTranscripts={() => handleTranscripts()}
                onRemove={handleRemoveSource}
                onAdd={() => setShowAddSource(true)}
                reelCounts={reelCounts}
                search={search}
                onSearchChange={setSearch}
              />
            )}
            <ReelsTable
              reels={filteredReels}
              status={status}
              search={search}
              transcribingUrls={transcribingUrls}
              onCaptionFetch={handleCaptionRefetch}
              onTranscriptFetch={handleTranscriptRefetch}
              onDownload={handleDownloadReel}
              onOpen={setVideoModal}
              downloadingUrls={downloadingUrls}
              noSources={configuredSources.length === 0}
              onAddSource={() => setShowAddSource(true)}
              onRunOnSelected={handleRunOnSelected}
            />
          </div>
        </div>
      </main>

      {/* Floating activity log */}
      <ActivityLog
        lines={logs}
        isActive={isActive}
        progress={overallProgress}
        statusLabel={
          status === "downloading" && downloadProgress.total > 0
            ? `Downloading ${downloadProgress.current}/${downloadProgress.total}…`
            : undefined
        }
        onCancel={async () => {
          await cancelJob();
          setStatus("idle");
          addLog("✗ Job cancelled", "error");
        }}
      />

      {/* Transcription progress bubble */}
      <TranscriptionBubble
        isActive={status === "transcripts"}
        current={transcriptionProgress.current}
        total={transcriptionProgress.total}
      />

      {/* Add source modal (also used as onboarding) */}
      {(showOnboarding || showAddSource) && (
        <AddSourceModal
          onAdd={handleAddSource}
          onClose={() => { setShowOnboarding(false); setShowAddSource(false); }}
          savedExists={configuredSources.some((s) => s.type === "saved")}
        />
      )}

      {/* Re-scrape confirm dialog */}
      {rescrapeTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/30 backdrop-blur-sm"
            onClick={() => setRescrapeTarget(null)}
          />
          <div className="relative bg-surface rounded-2xl shadow-modal w-full max-w-sm overflow-hidden">
            <div className="px-7 pt-7 pb-5 border-b border-border">
              <h2 className="font-serif text-xl text-primary font-semibold mb-1">Sync {rescrapeTarget}</h2>
              <p className="text-muted text-sm">Fetch new reels added since last sync. Existing reels are kept. Download media too?</p>
            </div>
            <div className="px-7 py-5 flex flex-col gap-3">
              <button
                className="w-full py-2.5 rounded-xl bg-accent text-white font-medium text-sm hover:bg-accent/90 transition-colors"
                onClick={() => { const t = rescrapeTarget; setRescrapeTarget(null); handleRescrapeSource(t!, true); }}
              >
                Sync + Download new media
              </button>
              <button
                className="w-full py-2.5 rounded-xl bg-black/10 text-primary font-medium text-sm hover:bg-black/15 transition-colors"
                onClick={() => { const t = rescrapeTarget; setRescrapeTarget(null); handleRescrapeSource(t!, false); }}
              >
                Sync only
              </button>
              <button
                className="w-full py-2 text-muted text-sm hover:text-primary transition-colors"
                onClick={() => setRescrapeTarget(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reel modal */}
      {videoModal && (
        <VideoModal
          reel={videoModal}
          allReels={filteredReels}
          onClose={() => setVideoModal(null)}
          onMediaReady={handleMediaReady}
          onCaptionFetch={handleCaptionRefetch}
          onTranscriptFetch={handleTranscriptRefetch}
          onDownload={handleDownloadReel}
        />
      )}
    </div>
  );
}
