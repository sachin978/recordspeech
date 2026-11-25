import { z } from "zod";
import { MISTAKE_CATEGORIES } from "../types";

// One definition → (a) the strict JSON schema sent to OpenAI Structured Outputs,
// and (b) the runtime validator applied to every response before it is shown.
// Field order matters: the model writes mistakes before deciding the verdict.

export const MistakeSchema = z.object({
  category: z.enum(MISTAKE_CATEGORIES),
  kind: z.enum(["grammar", "style"]),
  original: z.string(),
  corrected: z.string(),
  explanation: z.string(),
  pattern: z.string(),
});

export const SentenceAnalysisSchema = z.object({
  index: z.number().int(),
  mistakes: z.array(MistakeSchema),
  verdict: z.enum(["incorrect", "unnatural", "correct"]),
  corrected: z.string(),
  natural: z.string().nullable(),
  professional: z.string().nullable(),
  clearer: z.string().nullable(),
  contextual: z.string().nullable(),
  contextual_why: z.array(z.string()),
  note: z.string().nullable(),
  possible_mistranscription: z.boolean(),
});

export const SentenceBatchSchema = z.object({
  sentences: z.array(SentenceAnalysisSchema),
});

export const FeedbackSchema = z.object({
  overall_assessment: z.string(),
  strengths: z.array(z.string()),
  top_areas: z.array(
    z.object({ area: z.string(), why: z.string(), example_from_speech: z.string(), tip: z.string() }),
  ),
  vocabulary_suggestions: z.array(z.object({ instead_of: z.string(), try_instead: z.string(), example: z.string() })),
  next_session_tips: z.array(z.string()),
  communication: z.object({
    clarity: z.string(),
    main_idea: z.string(),
    missing_connections: z.array(z.string()),
    terminology: z.string(),
    structure: z.string(),
    say_next_time: z.string(),
  }),
});

export type SentenceBatch = z.infer<typeof SentenceBatchSchema>;
export type RawSentenceAnalysis = z.infer<typeof SentenceAnalysisSchema>;
export type RawFeedback = z.infer<typeof FeedbackSchema>;

/** Convert to a JSON schema accepted by OpenAI strict mode. */
export function toStrictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: "draft-7", io: "output" }) as Record<string, unknown>;
  const clean = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(clean);
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) {
        if (k === "$schema") continue;
        if ((k === "minimum" || k === "maximum") && Math.abs(Number(v)) > 1e12) continue;
        out[k] = clean(v);
      }
      return out;
    }
    return node;
  };
  return clean(json) as Record<string, unknown>;
}
