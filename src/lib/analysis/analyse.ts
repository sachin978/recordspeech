import { z } from "zod";
import { config } from "../config";
import { ApiError, isUnsupported, markUnsupportedFromError, openaiRequest } from "../openai";
import type { ContextType, Mistake, SentenceAnalysis, SessionFeedback, Span } from "../types";
import { FEEDBACK_SYSTEM, SENTENCE_SYSTEM, feedbackUserPrompt, sentenceUserPrompt } from "./prompts";
import {
  FeedbackSchema,
  SentenceBatchSchema,
  toStrictJsonSchema,
  type RawFeedback,
  type RawSentenceAnalysis,
} from "./schema";

// Structured-output calls to the analysis model + validation/normalisation. SERVER-ONLY.

export class AnalysisError extends Error {
  constructor(message: string, public retryable = true) {
    super(message);
    this.name = "AnalysisError";
  }
}

interface ChatResponse {
  choices?: { finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }[];
}

const sentenceJsonSchema = toStrictJsonSchema(SentenceBatchSchema);
const feedbackJsonSchema = toStrictJsonSchema(FeedbackSchema);

async function structuredCall<T>(
  system: string,
  user: string,
  name: string,
  jsonSchema: Record<string, unknown>,
  validator: z.ZodType<T>,
): Promise<T> {
  const model = config.analysisModel();
  for (let attempt = 0; attempt < 3; attempt++) {
    const effort = config.reasoningEffort();
    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_schema", json_schema: { name, strict: true, schema: jsonSchema } },
    };
    if (effort && !isUnsupported(model, "reasoning_effort")) body.reasoning_effort = effort;

    let res: ChatResponse;
    try {
      res = await openaiRequest<ChatResponse>("/chat/completions", {
        timeoutMs: config.analysisTimeoutMs(),
        json: true,
        body: () => JSON.stringify(body),
      });
    } catch (err) {
      if (markUnsupportedFromError(model, err, ["reasoning_effort"])) continue;
      if (err instanceof ApiError) throw new AnalysisError(err.message, err.retryable);
      throw new AnalysisError("Analysis request failed.");
    }

    const choice = res.choices?.[0];
    if (choice?.message?.refusal) throw new AnalysisError("The analysis model declined to analyse this text.", false);
    if (choice?.finish_reason === "length") {
      if (attempt < 1) continue;
      throw new AnalysisError("The analysis response was cut off (too long).");
    }
    const content = choice?.message?.content;
    if (!content) {
      if (attempt < 1) continue;
      throw new AnalysisError("The analysis model returned an empty response.");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      if (attempt < 1) continue;
      throw new AnalysisError("The analysis model returned malformed JSON.");
    }
    const result = validator.safeParse(parsed);
    if (!result.success) {
      if (attempt < 1) continue;
      throw new AnalysisError("The analysis response did not match the expected structure.");
    }
    return result.data;
  }
  throw new AnalysisError("Analysis failed after retries.");
}

// ---------- normalisation (enforces the coaching rules on whatever the model returns) ----------

/** Compare sentences ignoring case, punctuation and spacing. */
export function sameText(a: string | null | undefined, b: string | null | undefined): boolean {
  const n = (s: string) =>
    s
      .toLowerCase()
      .replace(/[’‘]/g, "'")
      .replace(/[^\p{L}\p{N}' ]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  return n(a ?? "") === n(b ?? "");
}

const clean = (s: string | null | undefined): string | null => {
  const t = (s ?? "").trim();
  return t ? t : null;
};

export function normalizeSentenceAnalysis(raw: RawSentenceAnalysis, original: string, hasTopic: boolean): SentenceAnalysis {
  let mistakes: Mistake[] = raw.mistakes
    .map((m) => ({
      category: m.category,
      kind: m.kind,
      original: m.original.trim(),
      corrected: m.corrected.trim(),
      explanation: m.explanation.trim(),
      pattern: m.pattern.trim().toLowerCase(),
    }))
    .filter((m) => m.explanation && (m.original || m.corrected) && !(m.original && m.original === m.corrected))
    .slice(0, 8);

  let verdict = raw.verdict;
  let corrected = clean(raw.corrected) ?? original;
  const changed = !sameText(corrected, original);
  const hasGrammar = mistakes.some((m) => m.kind === "grammar");

  if (verdict === "correct") {
    if (changed && hasGrammar) verdict = "incorrect";
    else if (mistakes.length) verdict = "unnatural";
  }
  if (verdict === "incorrect" && (!changed || !hasGrammar)) {
    // claimed a grammar error but changed nothing (or listed none): don't mark a correct sentence wrong
    verdict = mistakes.length || clean(raw.natural) ? "unnatural" : "correct";
  }
  if (verdict === "unnatural") {
    if (changed && hasGrammar) verdict = "incorrect";
    else {
      corrected = original; // rule: no grammar fix ⇒ keep exactly what was said
      mistakes = mistakes.map((m) => ({ ...m, kind: "style" as const }));
    }
  }
  if (verdict === "correct") {
    corrected = original;
    mistakes = [];
  }

  // Drop alternative versions that just repeat something already shown.
  const shown: string[] = [original, corrected];
  const unique = (s: string | null) => {
    const v = clean(s);
    if (!v || shown.some((x) => sameText(x, v))) return null;
    shown.push(v);
    return v;
  };
  let natural = unique(raw.natural);
  const professional = unique(raw.professional);
  let clearer = unique(raw.clearer);
  const contextual = hasTopic ? unique(raw.contextual) : null;
  if (verdict === "unnatural" && !natural && !clearer && !mistakes.length) verdict = "correct";
  if (verdict === "correct") {
    // never "improve" a sentence that is already correct and natural
    natural = null;
    clearer = null;
  }

  return {
    verdict,
    corrected,
    natural,
    professional,
    clearer,
    contextual,
    contextualWhy: contextual ? raw.contextual_why.map((s) => s.trim()).filter(Boolean).slice(0, 3) : [],
    note: verdict === "correct" ? null : clean(raw.note),
    mistakes,
    possibleMistranscription: raw.possible_mistranscription,
  };
}

export function normalizeFeedback(raw: RawFeedback): SessionFeedback {
  const list = (a: string[], n: number) => a.map((s) => s.trim()).filter(Boolean).slice(0, n);
  return {
    overall: raw.overall_assessment.trim(),
    strengths: list(raw.strengths, 3),
    topAreas: raw.top_areas
      .filter((a) => a.area.trim())
      .slice(0, 3)
      .map((a) => ({ area: a.area.trim(), why: a.why.trim(), example: a.example_from_speech.trim(), tip: a.tip.trim() })),
    vocabulary: raw.vocabulary_suggestions
      .filter((v) => v.instead_of.trim() && v.try_instead.trim())
      .slice(0, 5)
      .map((v) => ({ insteadOf: v.instead_of.trim(), tryInstead: v.try_instead.trim(), example: v.example.trim() })),
    recommendations: list(raw.next_session_tips, 3),
    communication: {
      clarity: raw.communication.clarity.trim(),
      mainIdea: raw.communication.main_idea.trim(),
      missingConnections: list(raw.communication.missing_connections, 5),
      terminology: raw.communication.terminology.trim(),
      structure: raw.communication.structure.trim(),
      sayNextTime: raw.communication.say_next_time.trim(),
    },
  };
}

// ---------- public API ----------

export interface SentenceInput {
  idx: number;
  text: string;
  uncertain: Span[];
}

/**
 * Analyse the requested sentences (with the whole transcript as context).
 * Returns a map idx → analysis; indexes the model skipped are retried once on their own.
 */
export async function analyseSentenceBatch(
  topic: string,
  type: ContextType,
  all: SentenceInput[],
  requested: number[],
): Promise<Map<number, SentenceAnalysis>> {
  const byIdx = new Map(all.map((s) => [s.idx, s]));
  const out = new Map<number, SentenceAnalysis>();
  let pending = requested;
  for (let round = 0; round < 2 && pending.length; round++) {
    const batch = await structuredCall(
      SENTENCE_SYSTEM,
      sentenceUserPrompt(topic, type, all, pending),
      "sentence_analysis",
      sentenceJsonSchema,
      SentenceBatchSchema,
    );
    for (const item of batch.sentences) {
      const s = byIdx.get(item.index);
      if (!s || !pending.includes(item.index) || out.has(item.index)) continue; // ignore unrequested/duplicate indexes
      out.set(item.index, normalizeSentenceAnalysis(item, s.text, topic.trim().length > 0));
    }
    pending = pending.filter((i) => !out.has(i));
  }
  return out;
}

export async function generateFeedback(
  topic: string,
  type: ContextType,
  all: SentenceInput[],
  measured: { words: number; durationSec: number; fillers: { word: string; count: number }[] },
): Promise<SessionFeedback> {
  const raw = await structuredCall(
    FEEDBACK_SYSTEM,
    feedbackUserPrompt(topic, type, all, measured),
    "session_feedback",
    feedbackJsonSchema,
    FeedbackSchema,
  );
  return normalizeFeedback(raw);
}
