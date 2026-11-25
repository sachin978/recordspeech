import { config } from "./config";
import { ApiError, isUnsupported, markUnsupportedFromError, openaiRequest } from "./openai";
import type { Span } from "./types";

// Speech-to-text for one recorded audio segment. SERVER-ONLY.

export interface Transcript {
  text: string;
  /** character spans of words the model was unsure about */
  uncertain: Span[];
}

/** Token probability below which a word is shown as "unclear". */
export const UNCERTAIN_PROB = 0.35;

const VERBATIM_INSTRUCTION =
  "The speaker is an English learner practising spoken English, often with an Indian accent. " +
  "Transcribe exactly what is said, word for word. Keep grammar mistakes, filler words " +
  "(um, uh, like, you know, actually, basically), repetitions and false starts. " +
  "Do not correct, complete or rephrase anything. If a word is unclear, transcribe what you hear; do not guess new content.";

// Whisper treats the prompt as preceding text, so it is steered by style, not instructions.
const WHISPER_STYLE_PROMPT = "Umm, so, like, I was, uh, I was going to the office and, you know, actually the meeting was, hmm, delayed.";

export function buildPrompt(model: string, topic: string): string {
  const t = topic.trim().slice(0, 300);
  if (model.startsWith("whisper")) return t ? `${WHISPER_STYLE_PROMPT} Topic: ${t}.` : WHISPER_STYLE_PROMPT;
  return t ? `${VERBATIM_INSTRUCTION} The speaker is talking about: ${t}.` : VERBATIM_INSTRUCTION;
}

interface TokenLogprob {
  token: string;
  logprob: number;
}
interface WhisperSegment {
  text: string;
  avg_logprob?: number;
  no_speech_prob?: number;
}
interface TranscriptionResponse {
  text?: string;
  logprobs?: TokenLogprob[];
  segments?: WhisperSegment[];
}

const isWordChar = (c: string) => /[\p{L}\p{N}'’-]/u.test(c);

/** Widen a span to whole words and merge overlapping/adjacent spans. */
export function normalizeSpans(text: string, spans: Span[]): Span[] {
  const widened = spans
    .map(([s, e]): Span => {
      let a = Math.max(0, s);
      let b = Math.min(text.length, e);
      while (a < b && /\s/.test(text[a])) a++;
      while (b > a && /\s/.test(text[b - 1])) b--;
      if (a >= b) return [a, a];
      while (a > 0 && isWordChar(text[a - 1])) a--;
      while (b < text.length && isWordChar(text[b])) b++;
      // trim trailing punctuation
      while (b > a && /[.,!?;:"]/.test(text[b - 1])) b--;
      return [a, b];
    })
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  const merged: Span[] = [];
  for (const sp of widened) {
    const last = merged[merged.length - 1];
    if (last && sp[0] <= last[1] + 1) last[1] = Math.max(last[1], sp[1]);
    else merged.push([sp[0], sp[1]]);
  }
  return merged;
}

/** Map token logprobs onto character spans in `text`. */
export function spansFromLogprobs(text: string, tokens: TokenLogprob[], threshold = UNCERTAIN_PROB): Span[] {
  const minLogprob = Math.log(threshold);
  const spans: Span[] = [];
  let cursor = 0;
  for (const t of tokens) {
    if (!t.token) continue;
    let pos = text.indexOf(t.token, cursor);
    if (pos === -1) {
      const trimmed = t.token.trim();
      if (!trimmed) continue;
      pos = text.indexOf(trimmed, cursor);
      if (pos === -1 || pos - cursor > 40) continue; // lost alignment for this token; skip it
      if (t.logprob < minLogprob) spans.push([pos, pos + trimmed.length]);
      cursor = pos + trimmed.length;
      continue;
    }
    if (t.logprob < minLogprob && t.token.trim()) spans.push([pos, pos + t.token.length]);
    cursor = pos + t.token.length;
  }
  return normalizeSpans(text, spans);
}

/** Whisper verbose_json: mark whole low-confidence segments. */
export function spansFromSegments(text: string, segments: WhisperSegment[]): Span[] {
  const spans: Span[] = [];
  let cursor = 0;
  for (const seg of segments) {
    const s = seg.text.trim();
    if (!s) continue;
    const pos = text.indexOf(s, cursor);
    if (pos === -1) continue;
    cursor = pos + s.length;
    const lowConf = (seg.avg_logprob ?? 0) < -1.0 || ((seg.no_speech_prob ?? 0) > 0.6 && (seg.avg_logprob ?? 0) < -0.5);
    if (lowConf) spans.push([pos, pos + s.length]);
  }
  return normalizeSpans(text, spans);
}

export function parseTranscription(body: TranscriptionResponse): Transcript {
  const raw = typeof body.text === "string" ? body.text : "";
  const lead = raw.length - raw.trimStart().length;
  const text = raw.trim();
  let uncertain: Span[] = [];
  if (Array.isArray(body.logprobs) && body.logprobs.length) {
    uncertain = spansFromLogprobs(raw, body.logprobs);
  } else if (Array.isArray(body.segments) && body.segments.length) {
    uncertain = spansFromSegments(raw, body.segments);
  }
  uncertain = uncertain
    .map(([a, b]): Span => [a - lead, b - lead])
    .filter(([a, b]) => a >= 0 && b <= text.length && b > a);
  return { text, uncertain };
}

const OPTIONAL_PARAMS = ["include", "logprobs", "languages", "language", "response_format", "temperature"];

export async function transcribeSegment(audio: Blob, filename: string, topic: string): Promise<Transcript> {
  const model = config.transcribeModel();
  const isWhisper = model.startsWith("whisper");
  const isGpt4o = model.startsWith("gpt-4o");

  // Each retry may drop optional parameters the model rejected.
  for (let attempt = 0; attempt < 6; attempt++) {
    const build = () => {
      const form = new FormData();
      form.append("file", audio, filename);
      form.append("model", model);
      form.append("prompt", buildPrompt(model, topic));
      if (isWhisper) {
        if (!isUnsupported(model, "response_format")) form.append("response_format", "verbose_json");
        if (!isUnsupported(model, "language")) form.append("language", "en");
      } else {
        if (!isUnsupported(model, "response_format")) form.append("response_format", "json");
        if (!isUnsupported(model, "include") && !isUnsupported(model, "logprobs")) form.append("include[]", "logprobs");
        if (isGpt4o) {
          if (!isUnsupported(model, "language")) form.append("language", "en");
        } else if (!isUnsupported(model, "languages")) {
          // gpt-transcribe takes a `languages` array instead of `language`
          form.append("languages[]", "en");
        }
      }
      if (!isUnsupported(model, "temperature")) form.append("temperature", "0");
      return form;
    };
    try {
      const body = await openaiRequest<TranscriptionResponse>("/audio/transcriptions", {
        timeoutMs: config.transcribeTimeoutMs(),
        body: build,
      });
      return parseTranscription(body);
    } catch (err) {
      if (attempt < 5 && markUnsupportedFromError(model, err, OPTIONAL_PARAMS)) continue;
      if (err instanceof ApiError) throw err;
      throw new ApiError("Transcription failed unexpectedly.", 0, false);
    }
  }
  throw new ApiError("Transcription failed.", 0, false);
}
