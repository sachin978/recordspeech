"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SegmentedRecorder, setOrderCounter, type CompletedSegment } from "@/client/recorder";
import { clearAll, deleteSegments, loadPending, saveChunk, saveMeta, saveSegment } from "@/client/audioStore";
import { getPrefs } from "@/client/prefs";
import { streamEvents } from "@/client/stream";
import { fmtDuration } from "@/lib/format";
import type { PipelineEvent, Session } from "@/lib/types";
import { applyEvent, initialStages, ProcessingPanel, type Stages } from "./Processing";
import { SessionView } from "./SessionView";
import { Icon } from "./ui/Icon";
import { toast } from "./ui/Toast";
import { Waveform } from "./ui/Waveform";

type Phase = "idle" | "starting" | "recording" | "stopped" | "analysing" | "results";

const CONTEXT_TYPES = [
  ["", "Auto-detect"],
  ["technical", "Technical explanation"],
  ["interview", "Interview"],
  ["professional", "Work / professional"],
  ["casual", "Casual conversation"],
] as const;

const EXAMPLES = ["Explaining URL Shortener system design", "Discussing a production bug with my manager", "A project in a job interview", "Talking about my weekend"];

/** Segments that are essentially silent are not sent (saves cost, avoids made-up text from silence). */
const isSilent = (s: CompletedSegment) => s.peak > 0 && s.peak < 0.01;

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function RecordStudio() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [context, setContext] = useState("");
  const [contextType, setContextType] = useState("");
  const [keepAudio, setKeepAudio] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [pendingCount, setPendingCount] = useState(0);
  const [session, setSession] = useState<Session | null>(null);
  const [stages, setStages] = useState<Stages | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [recoveredAt, setRecoveredAt] = useState<string | null>(null);
  const [health, setHealth] = useState<{ configured: boolean } | null>(null);
  const [retrying, setRetrying] = useState(false);

  const recorderRef = useRef<SegmentedRecorder | null>(null);
  const pendingRef = useRef<CompletedSegment[]>([]);
  const baseElapsed = useRef(0);
  const takeStart = useRef(0);
  const orbRef = useRef<HTMLDivElement | null>(null);
  const levelsRef = useRef<number[]>([]);
  const resultsRef = useRef<HTMLDivElement | null>(null);
  const startedAtRef = useRef(new Date().toISOString());
  const stateRef = useRef({ context, contextType, keepAudio, sessionId: null as string | null });
  stateRef.current = { context, contextType, keepAudio, sessionId: session?.id ?? null };

  const currentElapsed = useCallback(
    () => baseElapsed.current + (recorderRef.current?.isRecording ? (performance.now() - takeStart.current) / 1000 : 0),
    [],
  );

  const persistMeta = useCallback(() => {
    const s = stateRef.current;
    void saveMeta({
      sessionId: s.sessionId,
      context: s.context,
      contextType: s.contextType,
      keepAudio: s.keepAudio,
      durationSec: currentElapsed(),
      startedAt: startedAtRef.current,
      updatedAt: new Date().toISOString(),
    });
  }, [currentElapsed]);

  // --- mount: config check, preferences, recover audio left from a closed/crashed tab ---
  useEffect(() => {
    setKeepAudio(getPrefs().keepAudio);
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth(null));
    void (async () => {
      const { meta, segments } = await loadPending();
      if (!segments.length) {
        if (meta) await clearAll();
        return;
      }
      pendingRef.current = segments.map(({ info, blob }) => ({ segId: info.segId, order: info.order, mimeType: info.mimeType, ext: info.ext, blob, peak: info.complete ? info.peak : 0 }));
      setOrderCounter(Math.max(...segments.map((s) => s.info.order)));
      setPendingCount(segments.length);
      if (meta) {
        setContext(meta.context);
        setContextType(meta.contextType);
        setKeepAudio(meta.keepAudio);
        baseElapsed.current = meta.durationSec;
        setElapsed(meta.durationSec);
        startedAtRef.current = meta.startedAt;
        if (meta.sessionId) {
          const r = await fetch(`/api/sessions/${meta.sessionId}`).catch(() => null);
          if (r?.ok) setSession(((await r.json()) as { session: Session }).session);
        }
      }
      setRecoveredAt(meta?.updatedAt ?? new Date().toISOString());
      setPhase("stopped");
      toast("Recovered an unsaved recording", "info");
    })();
  }, []);

  // --- timer + periodic backup of the duration ---
  useEffect(() => {
    if (phase !== "recording") return;
    let ticks = 0;
    const id = setInterval(() => {
      setElapsed(currentElapsed());
      if (++ticks % 20 === 0) persistMeta();
    }, 250);
    return () => clearInterval(id);
  }, [phase, currentElapsed, persistMeta]);

  // --- protect against closing the tab with unsaved audio ---
  useEffect(() => {
    const risky = phase === "recording" || phase === "analysing" || (phase === "stopped" && pendingCount > 0);
    if (!risky) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [phase, pendingCount]);

  useEffect(() => () => void recorderRef.current?.stop(), []);

  const setLevel = (l: number) => {
    const buf = levelsRef.current;
    buf.push(l);
    if (buf.length > 240) buf.splice(0, buf.length - 240);
    orbRef.current?.style.setProperty("--level", String(Math.pow(l, 2)));
  };

  const stopTake = useCallback(async () => {
    const rec = recorderRef.current;
    if (!rec) return;
    const wasRecording = rec.isRecording;
    const now = performance.now();
    await rec.stop();
    if (wasRecording) baseElapsed.current += (now - takeStart.current) / 1000;
    recorderRef.current = null;
    setElapsed(baseElapsed.current);
    orbRef.current?.style.setProperty("--level", "0");
    setWarning(null);
    persistMeta();
  }, [persistMeta]);

  async function start() {
    setError(null);
    setRecoveredAt(null);
    const params = new URLSearchParams(window.location.search);
    const seg = Number(params.get("segmentSec")) || 60; // testing knob
    const rec = new SegmentedRecorder(
      {
        onChunk: (segId, seq, blob) => void saveChunk(segId, seq, blob),
        onSegmentStart: (info) => void saveSegment({ ...info, complete: false, peak: 0 }),
        onSegment: (s) => {
          pendingRef.current.push(s);
          setPendingCount(pendingRef.current.length);
          void saveSegment({ segId: s.segId, order: s.order, mimeType: s.mimeType, ext: s.ext, complete: true, peak: s.peak });
        },
        onLevel: setLevel,
        onSilence: (silent) => setWarning(silent ? "We can't hear anything. Check that your microphone is on and not muted." : null),
        onError: (_kind, message) => {
          baseElapsed.current += (performance.now() - takeStart.current) / 1000;
          recorderRef.current = null;
          setElapsed(baseElapsed.current);
          setError(message);
          setPhase("stopped");
          persistMeta();
        },
      },
      { targetSegmentSec: seg, maxSegmentSec: seg * 3 },
    );
    const prev = phase;
    setPhase("starting");
    try {
      await rec.start();
    } catch (e) {
      const msg = (e as { message?: string })?.message ?? "Could not start the microphone.";
      setError(msg);
      setPhase(prev === "starting" ? "idle" : prev);
      return;
    }
    recorderRef.current = rec;
    levelsRef.current = [];
    takeStart.current = performance.now();
    if (!session && pendingRef.current.length === 0) startedAtRef.current = new Date().toISOString();
    setPhase("recording");
    persistMeta();
  }

  function handleEvent(e: PipelineEvent, flags: { transcribed: boolean }, sent: CompletedSegment[]) {
    setStages((st) => (st ? applyEvent(st, e) : st));
    if (e.type === "transcribed") {
      flags.transcribed = true;
      setSession(e.session);
      stateRef.current.sessionId = e.session.id;
      // the transcript is saved on the server — the audio is no longer needed here
      const ids = new Set(sent.map((s) => s.segId));
      pendingRef.current = pendingRef.current.filter((s) => !ids.has(s.segId));
      setPendingCount(pendingRef.current.length);
      void deleteSegments([...ids]);
      persistMeta();
    } else if (e.type === "sentences") setSession(e.session);
    else if (e.type === "result") {
      setSession(e.session);
      setPhase("results");
      toast(e.session.status === "complete" ? "Your analysis is ready" : "Analysis finished with some gaps — you can retry", e.session.status === "complete" ? "ok" : "info");
      setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" }), 80);
    } else if (e.type === "error") {
      setError(e.message);
      setPhase(flags.transcribed ? "results" : "stopped");
    }
  }

  async function analyse() {
    setError(null);
    setRecoveredAt(null);
    const segs = [...pendingRef.current].sort((a, b) => a.order - b.order);
    const voiced = segs.filter((s) => !isSilent(s));
    if (!voiced.length) {
      setError(segs.length ? "No speech was detected in the recording, so nothing was sent. Check your microphone, then Resume or Discard." : "There is no new recording to analyse.");
      setPhase(session && !segs.length ? "results" : "stopped");
      return;
    }
    const form = new FormData();
    for (const s of voiced) form.append("audio", s.blob, `segment-${s.order}.${s.ext}`);
    form.append("context", context);
    form.append("contextType", contextType);
    form.append("durationSec", String(Math.round(currentElapsed())));
    form.append("keepAudio", String(keepAudio));
    if (session) form.append("sessionId", session.id);

    const mb = voiced.reduce((a, s) => a + s.blob.size, 0) / 1024 / 1024;
    setStages(initialStages("full", `Uploading ${mb < 0.1 ? "<0.1" : mb.toFixed(1)} MB`));
    setPhase("analysing");
    const flags = { transcribed: false };
    let finished = false;
    try {
      await streamEvents("/api/analyse", form, (e) => {
        if (e.type === "result" || e.type === "error") finished = true;
        handleEvent(e, flags, segs);
      });
    } catch (e) {
      setError(`${e instanceof Error ? e.message : "Could not reach the RecordSpeech server."} ${flags.transcribed ? "" : "Your recording is still saved in this browser — you can retry."}`);
      setStages((st) => (st ? applyEvent(st, { type: "error", stage: "network", message: "", audioSafe: true }) : st));
      finished = true;
      setPhase(flags.transcribed ? "results" : "stopped");
    }
    if (!finished) {
      setError("The connection to the server closed before analysis finished." + (flags.transcribed ? " Your transcript is saved — use Retry analysis." : " Your recording is still saved — you can retry."));
      setPhase(flags.transcribed ? "results" : "stopped");
    }
  }

  async function pauseAndAnalyse() {
    await stopTake();
    await analyse();
  }

  async function stopRecording() {
    await stopTake();
    setPhase("stopped");
  }

  async function discard() {
    const what = session ? "the recording made since your last analysis" : "this recording";
    if (!window.confirm(`Discard ${what}? It has not been analysed and cannot be recovered.`)) return;
    if (recorderRef.current) await stopTake();
    const ids = pendingRef.current.map((s) => s.segId);
    pendingRef.current = [];
    setPendingCount(0);
    await deleteSegments(ids);
    setError(null);
    setRecoveredAt(null);
    toast("Recording discarded", "info");
    if (session) {
      baseElapsed.current = session.durationSec;
      setElapsed(session.durationSec);
      setPhase("results");
      persistMeta();
    } else {
      await clearAll();
      baseElapsed.current = 0;
      setElapsed(0);
      setPhase("idle");
    }
  }

  async function newSession() {
    if (pendingRef.current.length && !window.confirm("Discard the recording that has not been analysed yet?")) return;
    await clearAll();
    pendingRef.current = [];
    setPendingCount(0);
    setSession(null);
    setStages(null);
    setContext("");
    setError(null);
    baseElapsed.current = 0;
    setElapsed(0);
    setPhase("idle");
    window.scrollTo({ top: 0, behavior: reducedMotion() ? "auto" : "smooth" });
  }

  async function retryAnalysis() {
    if (!session) return;
    setRetrying(true);
    setError(null);
    setStages(initialStages("retry"));
    try {
      await streamEvents(`/api/sessions/${session.id}/analyse`, null, (e) => {
        setStages((st) => (st ? applyEvent(st, e) : st));
        if (e.type === "sentences" || e.type === "result") setSession(e.session);
        if (e.type === "result") toast(e.session.status === "complete" ? "Analysis complete" : "Some parts are still missing", e.session.status === "complete" ? "ok" : "info");
        else if (e.type === "error") setError(e.message);
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Retry failed.");
    }
    setRetrying(false);
  }

  const locked = !!session; // the topic belongs to the session once analysis has started
  const recording = phase === "recording";
  const editableTopic = phase === "idle" || (phase === "stopped" && !locked && !recoveredAt);
  const showStages = stages && (phase === "analysing" || retrying);

  const statusText =
    phase === "recording"
      ? "Recording"
      : phase === "starting"
        ? "Waiting for microphone permission…"
        : phase === "stopped"
          ? "Recording stopped"
          : phase === "analysing"
            ? "Analysing…"
            : phase === "results"
              ? "Analysed"
              : "Ready";

  const hint =
    phase === "idle"
      ? "Talk for as long as you like — there's nothing to press between sentences. Nothing is sent until you press Pause & Analyse."
      : recording
        ? "Keep talking naturally. When you're ready, press Pause & Analyse."
        : phase === "stopped" && pendingCount > 0
          ? "Nothing has been sent yet. Your audio is kept safely in this browser until you analyse or discard it."
          : phase === "results"
            ? "Resume to keep talking — new speech is added to this session as a new part."
            : phase === "analysing"
              ? "Hang tight — results appear below as soon as each step finishes."
              : "";

  return (
    <div>
      <header className="page-head hero">
        <div>
          <h1>Improve your English, one conversation at a time.</h1>
          <p>Speak naturally. We&apos;ll help you understand your mistakes and express yourself better.</p>
        </div>
      </header>

      {health && !health.configured && (
        <div className="banner bad" role="alert">
          <Icon name="key" />
          <div className="grow">
            <strong>OpenAI API key missing.</strong> Recording works, but analysis needs a key: copy <code>.env.example</code> to <code>.env.local</code>, set{" "}
            <code>OPENAI_API_KEY</code>, and restart the app. <a href="/settings">Settings</a>
          </div>
        </div>
      )}

      <section className="card studio" data-testid="studio" data-phase={phase}>
        {editableTopic ? (
          <div className="topic">
            <label htmlFor="ctx" className="field-label">
              What are you going to talk about today? <span className="muted small">(optional)</span>
            </label>
            <textarea
              id="ctx"
              className="textarea"
              rows={2}
              maxLength={500}
              value={context}
              placeholder="e.g. Explaining URL Shortener system design, discussing a project, or talking about my day..."
              onChange={(e) => setContext(e.target.value)}
            />
            <div className="topic-chips" aria-label="Topic ideas">
              {EXAMPLES.map((ex) => (
                <button type="button" key={ex} className={`chip ${context === ex ? "on" : ""}`} onClick={() => setContext(context === ex ? "" : ex)}>
                  {ex}
                </button>
              ))}
            </div>
            <div className="topic-opts">
              <label className="row" style={{ gap: 8 }}>
                Setting
                <select className="select" value={contextType} onChange={(e) => setContextType(e.target.value)}>
                  {CONTEXT_TYPES.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
              <label className="switch" data-tip="Off by default: audio is deleted once it has been transcribed.">
                <input type="checkbox" checked={keepAudio} onChange={(e) => setKeepAudio(e.target.checked)} />
                Keep a copy of the audio on this computer
              </label>
            </div>
          </div>
        ) : (
          <div className="topic-fixed">
            <Icon name="message" />
            {context ? (
              <span>
                Topic: <strong>{context}</strong>
              </span>
            ) : (
              <span>Free conversation — no topic</span>
            )}
          </div>
        )}

        <div className="recorder" data-live={recording}>
          <div className="rec-head">
            <div ref={orbRef} className={`mic-orb ${recording ? "live" : ""}`}>
              <Icon name="mic" size={26} />
            </div>
            <div className="rec-meta">
              <div className={`rec-status ${recording ? "live" : ""}`} data-testid="rec-status">
                {recording && <span className="rec-dot" aria-hidden />}
                {phase === "starting" || phase === "analysing" ? <span className="spinner" aria-hidden /> : null}
                {statusText}
              </div>
              <div className="timer" data-testid="timer" aria-live="off">
                {fmtDuration(elapsed)}
              </div>
            </div>
          </div>

          <Waveform levels={levelsRef} active={recording} />

          <div className="controls">
            {phase === "idle" && (
              <button type="button" className="btn primary lg" onClick={start}>
                <Icon name="mic" size={18} /> Start Recording
              </button>
            )}
            {phase === "starting" && (
              <button type="button" className="btn primary lg" disabled>
                <span className="spinner" /> Starting…
              </button>
            )}
            {recording && (
              <>
                <button type="button" className="btn primary lg" onClick={pauseAndAnalyse}>
                  <Icon name="pause" size={18} /> Pause &amp; Analyse
                </button>
                <button type="button" className="btn lg" onClick={stopRecording}>
                  <Icon name="stop" size={14} /> Stop Recording
                </button>
                <button type="button" className="btn ghost danger lg" onClick={discard}>
                  <Icon name="trash" /> Discard Recording
                </button>
              </>
            )}
            {phase === "stopped" && (
              <>
                {pendingCount > 0 && (
                  <button type="button" className="btn primary lg" onClick={analyse}>
                    <Icon name="sparkles" size={18} /> Analyse
                  </button>
                )}
                <button type="button" className="btn lg" onClick={start}>
                  <Icon name="mic" /> Resume Recording
                </button>
                {pendingCount > 0 && (
                  <button type="button" className="btn ghost danger lg" onClick={discard}>
                    <Icon name="trash" /> Discard Recording
                  </button>
                )}
                {pendingCount === 0 && !session && (
                  <button type="button" className="btn ghost lg" onClick={newSession}>
                    Start over
                  </button>
                )}
                {pendingCount === 0 && session && (
                  <button type="button" className="btn ghost lg" onClick={() => setPhase("results")}>
                    Back to results
                  </button>
                )}
              </>
            )}
            {phase === "results" && (
              <>
                <button type="button" className="btn primary lg" onClick={start}>
                  <Icon name="mic" size={18} /> Resume Recording
                </button>
                <button type="button" className="btn lg" onClick={newSession}>
                  <Icon name="plus" /> New Session
                </button>
              </>
            )}
          </div>
          {hint && <p className="rec-hint">{hint}</p>}
        </div>

        <div className="studio-msgs">
          {warning && recording && (
            <div className="banner warn">
              <Icon name="mic" />
              <div className="grow">{warning}</div>
            </div>
          )}
          {recoveredAt && (
            <div className="banner warn" data-testid="recovered">
              <Icon name="info" />
              <div className="grow">
                We found a recording from {new Date(recoveredAt).toLocaleString()} that was not analysed ({fmtDuration(elapsed)}). Analyse it or discard it.
              </div>
            </div>
          )}
          {error && (
            <div className="banner bad" role="alert" data-testid="error">
              <Icon name="alert" />
              <div className="grow">{error}</div>
            </div>
          )}
        </div>

        {showStages && <ProcessingPanel stages={stages!} title={retrying ? "Re-running analysis" : "Analysing your speech"} />}
      </section>

      <div ref={resultsRef}>
        {session && <SessionView session={session} live={phase === "analysing" || retrying} onRetry={retryAnalysis} retrying={retrying} />}
      </div>
    </div>
  );
}
