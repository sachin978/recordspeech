import fs from "node:fs";
import path from "node:path";
import { AnalysisError, analyseSentenceBatch, generateFeedback } from "./analysis/analyse";
import { config, isConfigured } from "./config";
import { classifyContext } from "./context";
import { addSentences, createSession, getSession, setSentenceAnalyses, updateSession } from "./db";
import { ApiError } from "./openai";
import { countWords, joinTranscripts, splitSentences } from "./sentences";
import { computeStats, countFillers } from "./stats";
import { transcribeSegment, type Transcript } from "./transcribe";
import type { PipelineEvent, Sentence, SessionFeedback } from "./types";

// Recording → transcription → analysis → saved session. SERVER-ONLY.

type Emit = (e: PipelineEvent) => void;

export interface AudioSegment {
  data: Blob;
  filename: string;
}

export interface AnalyseInput {
  sessionId?: string | null;
  context: string;
  contextType?: string | null;
  /** total recorded duration of the whole session so far, in seconds */
  durationSec: number;
  segments: AudioSegment[];
  keepAudio: boolean;
}

/** Run tasks with a concurrency limit, preserving result order. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

const message = (e: unknown) =>
  e instanceof ApiError || e instanceof AnalysisError ? e.message : "Unexpected error while processing.";

export async function runAnalysePipeline(input: AnalyseInput, emit: Emit): Promise<void> {
  if (!isConfigured()) {
    emit({ type: "error", stage: "config", message: "OPENAI_API_KEY is not set. Add it to .env.local and restart the app.", audioSafe: true });
    return;
  }
  const existing = input.sessionId ? getSession(input.sessionId) : null;
  if (input.sessionId && !existing) {
    emit({ type: "error", stage: "session", message: "That session no longer exists.", audioSafe: true });
    return;
  }
  if (!input.segments.length) {
    emit({ type: "error", stage: "upload", message: "No audio was received.", audioSafe: true });
    return;
  }

  const context = existing ? existing.context : input.context.trim().slice(0, 500);
  const contextType = existing ? existing.contextType : classifyContext(context, input.contextType);

  // 1. Transcribe all segments in parallel; any failure keeps the audio on the client for retry.
  let done = 0;
  const total = input.segments.length;
  emit({ type: "progress", stage: "transcribe", done: 0, total, message: "Converting your speech to text…" });
  let transcripts: Transcript[];
  try {
    transcripts = await pool(input.segments, config.maxConcurrency(), async (seg) => {
      const t = await transcribeSegment(seg.data, seg.filename, context);
      done++;
      emit({ type: "progress", stage: "transcribe", done, total, message: `Transcribed ${done} of ${total} audio parts` });
      return t;
    });
  } catch (e) {
    emit({ type: "error", stage: "transcribe", message: `Transcription failed: ${message(e)} Your recording is still saved in this browser — you can retry.`, sessionId: existing?.id, audioSafe: true });
    return;
  }

  const joined = joinTranscripts(transcripts);
  const split = splitSentences(joined.text, joined.uncertain);
  if (!split.length) {
    emit({ type: "error", stage: "transcribe", message: "No speech was detected in the recording. Check that the right microphone is selected and try again.", sessionId: existing?.id, audioSafe: true });
    return;
  }

  // 2. Save the transcript before analysis so it is never lost.
  const sessionId =
    existing?.id ?? createSession({ context, contextType, models: { transcribe: config.transcribeModel(), analysis: config.analysisModel() } });
  const part = (existing?.parts ?? 0) + 1;
  const offset = existing?.sentences.length ?? 0;
  const newSentences: Sentence[] = split.map((s, i) => ({ idx: offset + i + 1, part, text: s.text, uncertain: s.uncertain, analysis: null }));
  addSentences(sessionId, newSentences);

  let audioFiles = existing?.audioFiles ?? [];
  if (input.keepAudio) audioFiles = [...audioFiles, ...(await saveAudio(sessionId, part, input.segments))];
  updateSession(sessionId, { status: "analysing", parts: part, durationSec: Math.max(input.durationSec, existing?.durationSec ?? 0), error: null, audioFiles });
  emit({ type: "transcribed", session: getSession(sessionId)! });

  await analyseSession(sessionId, newSentences.map((s) => s.idx), emit);
}

/** Analyse the given sentences (or all unanalysed ones) and regenerate session feedback. */
export async function analyseSession(sessionId: string, only: number[] | null, emit: Emit): Promise<void> {
  if (!isConfigured()) {
    emit({ type: "error", stage: "config", message: "OPENAI_API_KEY is not set. Add it to .env.local and restart the app.", sessionId, audioSafe: true });
    return;
  }
  const session = getSession(sessionId);
  if (!session) {
    emit({ type: "error", stage: "session", message: "Session not found.", audioSafe: true });
    return;
  }
  updateSession(sessionId, { status: "analysing" });
  const all = session.sentences.map((s) => ({ idx: s.idx, text: s.text, uncertain: s.uncertain }));
  const targets = (only ?? session.sentences.filter((s) => !s.analysis).map((s) => s.idx)).filter((i) => all.some((s) => s.idx === i));

  const size = config.batchSize();
  const batches: number[][] = [];
  for (let i = 0; i < targets.length; i += size) batches.push(targets.slice(i, i + size));

  const transcriptText = session.sentences.map((s) => s.text).join(" ");
  let doneBatches = 0;
  const failures: string[] = [];
  emit({ type: "progress", stage: "analyse", done: 0, total: batches.length, message: "Checking grammar and finding better ways to say it…" });

  // The session-level feedback request runs in parallel with the sentence batches.
  const feedbackTask = (async (): Promise<{ feedback: SessionFeedback | null; error: string | null }> => {
    try {
      const feedback = await generateFeedback(session.context, session.contextType, all, {
        words: countWords(transcriptText),
        durationSec: session.durationSec,
        fillers: countFillers(transcriptText),
      });
      emit({ type: "progress", stage: "feedback", message: "Session feedback ready" });
      return { feedback, error: null };
    } catch (e) {
      return { feedback: null, error: message(e) };
    }
  })();

  await pool(batches, config.maxConcurrency(), async (batch) => {
    try {
      const result = await analyseSentenceBatch(session.context, session.contextType, all, batch);
      setSentenceAnalyses(sessionId, result);
      if (result.size < batch.length) failures.push(`${batch.length - result.size} sentence(s) were not analysed`);
    } catch (e) {
      failures.push(message(e));
    }
    doneBatches++;
    emit({ type: "progress", stage: "analyse", done: doneBatches, total: batches.length, message: `Analysed ${doneBatches} of ${batches.length} sentence groups` });
    emit({ type: "sentences", session: getSession(sessionId)! });
  });

  const fb = await feedbackTask;
  emit({ type: "progress", stage: "save", message: "Saving to your history…" });
  const latest = getSession(sessionId)!;
  const stats = computeStats(latest.sentences);
  const missing = latest.sentences.filter((s) => !s.analysis).length;
  const complete = missing === 0 && !!(fb.feedback ?? latest.feedback);
  const errorParts = [...new Set(failures)];
  if (missing) errorParts.unshift(`${missing} sentence(s) could not be analysed`);
  updateSession(sessionId, {
    stats,
    feedback: fb.feedback ?? latest.feedback,
    feedbackError: fb.error,
    status: complete ? "complete" : "partial",
    error: errorParts.length ? errorParts.join("; ") : null,
  });
  emit({ type: "result", session: getSession(sessionId)! });
}

const SAFE_EXT = /\.(webm|ogg|mp4|m4a|wav|mp3)$/i;

async function saveAudio(sessionId: string, part: number, segments: AudioSegment[]): Promise<string[]> {
  const dir = path.join(config.dataDir(), "audio", sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const names: string[] = [];
  for (const [i, seg] of segments.entries()) {
    const ext = seg.filename.match(SAFE_EXT)?.[0].toLowerCase() ?? ".webm";
    const name = `part${part}-${String(i + 1).padStart(2, "0")}${ext}`;
    fs.writeFileSync(path.join(dir, name), Buffer.from(await seg.data.arrayBuffer()));
    names.push(name);
  }
  return names;
}

export function audioPath(sessionId: string, name: string): string | null {
  if (!/^[\w-]+$/.test(sessionId) || !/^part\d+-\d+\.(webm|ogg|mp4|m4a|wav|mp3)$/.test(name)) return null;
  return path.join(config.dataDir(), "audio", sessionId, name);
}

export function deleteAudio(sessionId: string) {
  if (!/^[\w-]+$/.test(sessionId)) return;
  fs.rmSync(path.join(config.dataDir(), "audio", sessionId), { recursive: true, force: true });
}
