"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { SegmentedRecorder, setOrderCounter, type CompletedSegment } from "@/client/recorder";
import { clearAll, deleteSegments, loadPending, saveChunk, saveMeta, saveSegment } from "@/client/audioStore";
import { fmtDuration, streamEvents } from "@/client/stream";
import type { PipelineEvent, Session } from "@/lib/types";
import { SessionView } from "./SessionView";

type Phase = "idle" | "starting" | "recording" | "stopped" | "analysing" | "results";

const CONTEXT_TYPES = [
  ["", "Auto-detect"],
  ["technical", "Technical explanation"],
  ["interview", "Interview"],
  ["professional", "Work / professional"],
  ["casual", "Casual conversation"],
] as const;

const EXAMPLES = ["Explaining URL shortener system design", "Discussing a production bug with my manager", "Talking about my weekend"];

/** Segments that are essentially silent are not sent (saves cost, avoids made-up text from silence). */
const isSilent = (s: CompletedSegment) => s.peak > 0 && s.peak < 0.01;

export function RecordStudio() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [context, setContext] = useState("");
  const [contextType, setContextType] = useState("");
  const [keepAudio, setKeepAudio] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [pendingCount, setPendingCount] = useState(0);
  const [session, setSession] = useState<Session | null>(null);
  const [progress, setProgress] = useState<{ message: string; done?: number; total?: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [recoveredAt, setRecoveredAt] = useState<string | null>(null);
  const [health, setHealth] = useState<{ configured: boolean } | null>(null);
  const [retrying, setRetrying] = useState(false);

  const recorderRef = useRef<SegmentedRecorder | null>(null);
  const pendingRef = useRef<CompletedSegment[]>([]);
  const baseElapsed = useRef(0);
  const takeStart = useRef(0);
  const meterRef = useRef<HTMLDivElement | null>(null);
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

  // --- mount: config check + recover audio left from a closed/crashed tab ---
  useEffect(() => {
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

  const stopTake = useCallback(async () => {
    const rec = recorderRef.current;
    if (!rec) return;
    const wasRecording = rec.isRecording;
    const now = performance.now();
    await rec.stop();
    if (wasRecording) baseElapsed.current += (now - takeStart.current) / 1000;
    recorderRef.current = null;
    setElapsed(baseElapsed.current);
    if (meterRef.current) meterRef.current.style.width = "0%";
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
        onLevel: (l) => {
          if (meterRef.current) meterRef.current.style.width = `${Math.round(l * 100)}%`;
        },
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
    takeStart.current = performance.now();
    if (!session && pendingRef.current.length === 0) startedAtRef.current = new Date().toISOString();
    setPhase("recording");
    persistMeta();
  }

  function handleEvent(e: PipelineEvent, flags: { transcribed: boolean }, sent: CompletedSegment[]) {
    if (e.type === "progress") setProgress({ message: e.message, done: e.done, total: e.total });
    else if (e.type === "transcribed") {
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

    setPhase("analysing");
    setProgress({ message: `Uploading ${(voiced.reduce((a, s) => a + s.blob.size, 0) / 1024 / 1024).toFixed(1)} MB of audio…` });
    const flags = { transcribed: false };
    let finished = false;
    try {
      await streamEvents("/api/analyse", form, (e) => {
        if (e.type === "result" || e.type === "error") finished = true;
        handleEvent(e, flags, segs);
      });
    } catch (e) {
      setError(`${e instanceof Error ? e.message : "Could not reach the RecordSpeech server."} ${flags.transcribed ? "" : "Your recording is still saved in this browser — you can retry."}`);
      finished = true;
      setPhase(flags.transcribed ? "results" : "stopped");
    }
    if (!finished) {
      setError("The connection to the server closed before analysis finished." + (flags.transcribed ? " Your transcript is saved — use Retry analysis." : " Your recording is still saved — you can retry."));
      setPhase(flags.transcribed ? "results" : "stopped");
    }
    setProgress(null);
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
    setContext("");
    setError(null);
    baseElapsed.current = 0;
    setElapsed(0);
    setPhase("idle");
    window.scrollTo({ top: 0 });
  }

  async function retryAnalysis() {
    if (!session) return;
    setRetrying(true);
    setError(null);
    try {
      await streamEvents(`/api/sessions/${session.id}/analyse`, null, (e) => {
        if (e.type === "progress") setProgress({ message: e.message, done: e.done, total: e.total });
        else if (e.type === "sentences" || e.type === "result") setSession(e.session);
        else if (e.type === "error") setError(e.message);
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Retry failed.");
    }
    setProgress(null);
    setRetrying(false);
  }

  const locked = !!session; // topic belongs to the session once analysis has started
  const recording = phase === "recording";

  return (
    <div>
      {health && !health.configured && (
        <div className="banner bad" role="alert">
          <strong>OpenAI API key missing.</strong> Recording works, but analysis needs a key: copy <code>.env.example</code> to <code>.env.local</code>, set{" "}
          <code>OPENAI_API_KEY</code>, and restart the app.
        </div>
      )}

      <section className="card studio" data-testid="studio" data-phase={phase}>
        {phase === "idle" || (phase === "stopped" && !locked && !recoveredAt) ? (
          <div className="context">
            <label htmlFor="ctx">
              <strong>What are you going to talk about today?</strong> <span className="muted small">(optional)</span>
            </label>
            <textarea
              id="ctx"
              rows={2}
              maxLength={500}
              value={context}
              placeholder={`e.g. ${EXAMPLES.join(" · ")}`}
              onChange={(e) => setContext(e.target.value)}
            />
            <div className="row">
              <label className="small">
                Setting{" "}
                <select value={contextType} onChange={(e) => setContextType(e.target.value)}>
                  {CONTEXT_TYPES.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
              <label className="small">
                <input type="checkbox" checked={keepAudio} onChange={(e) => setKeepAudio(e.target.checked)} /> Keep a copy of the audio on this computer
              </label>
            </div>
          </div>
        ) : (
          (context || locked) && (
            <p className="muted">
              Topic: <strong>{context || "none"}</strong>
            </p>
          )
        )}

        <div className="recbar">
          <div className={`status ${recording ? "live" : ""}`} data-testid="rec-status">
            {recording ? (
              <>
                <span className="dot" aria-hidden /> Recording
              </>
            ) : phase === "starting" ? (
              "Waiting for microphone permission…"
            ) : phase === "stopped" ? (
              "Recording stopped"
            ) : phase === "analysing" ? (
              "Analysing…"
            ) : phase === "results" ? (
              "Analysed"
            ) : (
              "Ready"
            )}
          </div>
          <div className="timer" data-testid="timer" aria-live="off">
            {fmtDuration(elapsed)}
          </div>
          <div className="meter" aria-hidden>
            <div ref={meterRef} className="meter-fill" />
          </div>
        </div>

        {warning && recording && <div className="banner warn">{warning}</div>}
        {recoveredAt && (
          <div className="banner warn" data-testid="recovered">
            We found a recording from {new Date(recoveredAt).toLocaleString()} that was not analysed ({fmtDuration(elapsed)}). Analyse it or discard it.
          </div>
        )}
        {error && (
          <div className="banner bad" role="alert" data-testid="error">
            {error}
          </div>
        )}

        <div className="controls">
          {phase === "idle" && (
            <button type="button" className="btn primary big" onClick={start}>
              ● Start Recording
            </button>
          )}
          {phase === "starting" && (
            <button type="button" className="btn primary big" disabled>
              Starting…
            </button>
          )}
          {recording && (
            <>
              <button type="button" className="btn primary big" onClick={pauseAndAnalyse}>
                ❚❚ Pause &amp; Analyse
              </button>
              <button type="button" className="btn" onClick={stopRecording}>
                ■ Stop Recording
              </button>
              <button type="button" className="btn danger" onClick={discard}>
                Discard Recording
              </button>
            </>
          )}
          {phase === "stopped" && (
            <>
              {pendingCount > 0 && (
                <button type="button" className="btn primary big" onClick={analyse}>
                  Analyse
                </button>
              )}
              <button type="button" className="btn" onClick={start}>
                ● Resume Recording
              </button>
              {pendingCount > 0 && (
                <button type="button" className="btn danger" onClick={discard}>
                  Discard Recording
                </button>
              )}
              {pendingCount === 0 && !session && (
                <button type="button" className="btn" onClick={newSession}>
                  Start over
                </button>
              )}
              {pendingCount === 0 && session && (
                <button type="button" className="btn" onClick={() => setPhase("results")}>
                  Back to results
                </button>
              )}
            </>
          )}
          {phase === "results" && (
            <>
              <button type="button" className="btn primary" onClick={start}>
                ● Resume Recording
              </button>
              <button type="button" className="btn" onClick={newSession}>
                New Session
              </button>
              {session && (
                <a className="btn" href={`/sessions/${session.id}`}>
                  Open in history
                </a>
              )}
            </>
          )}
        </div>

        {phase === "stopped" && pendingCount > 0 && (
          <p className="muted small">Nothing has been sent yet. Your audio is kept in this browser until it is analysed or discarded.</p>
        )}
        {phase === "results" && <p className="muted small">Resume to keep talking — new speech is added to this session as a new part.</p>}
        {(phase === "analysing" || retrying) && progress && (
          <div className="progress" data-testid="progress">
            <div>{progress.message}</div>
            {progress.total ? (
              <div className="bar">
                <div style={{ width: `${Math.round((100 * (progress.done ?? 0)) / progress.total)}%` }} />
              </div>
            ) : (
              <div className="bar indeterminate">
                <div />
              </div>
            )}
          </div>
        )}
      </section>

      {session && <SessionView session={session} live={phase === "analysing" || retrying} onRetry={retryAnalysis} retrying={retrying} />}
    </div>
  );
}
