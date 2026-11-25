// Shared types used by both the server pipeline and the UI.

/**
 * 1. incorrect  – has at least one grammar mistake
 * 2. unnatural  – grammatically fine, but a fluent speaker would say it differently
 * 3. correct    – correct and natural
 */
export type Verdict = "incorrect" | "unnatural" | "correct";

export const MISTAKE_CATEGORIES = [
  "tense",
  "article",
  "preposition",
  "subject_verb_agreement",
  "word_order",
  "singular_plural",
  "helping_verb",
  "redundancy",
  "sentence_structure",
  "awkward_expression",
  "vocabulary",
  "other",
] as const;
export type MistakeCategory = (typeof MISTAKE_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<MistakeCategory, string> = {
  tense: "Tense",
  article: "Articles (a / an / the)",
  preposition: "Prepositions",
  subject_verb_agreement: "Subject–verb agreement",
  word_order: "Word order",
  singular_plural: "Singular / plural",
  helping_verb: "Helping verbs",
  redundancy: "Repeated or unnecessary words",
  sentence_structure: "Sentence construction",
  awkward_expression: "Awkward expression",
  vocabulary: "Word choice",
  other: "Other",
};

export type ContextType = "technical" | "interview" | "professional" | "casual" | "general";

export interface Mistake {
  category: MistakeCategory;
  /** grammar = an actual error; style = correct but unnatural/unclear */
  kind: "grammar" | "style";
  /** the exact words from the sentence */
  original: string;
  /** what to say instead */
  corrected: string;
  /** short, simple explanation of why */
  explanation: string;
  /** short reusable label, e.g. "discuss about → discuss" — used to spot recurring mistakes */
  pattern: string;
}

export interface SentenceAnalysis {
  verdict: Verdict;
  /** minimal grammar fix; identical to the original when there are no grammar errors */
  corrected: string;
  /** how a fluent speaker would naturally say it (null when same as corrected) */
  natural: string | null;
  /** professional version, only when the setting calls for it */
  professional: string | null;
  /** shorter / clearer version, when the sentence could be tightened */
  clearer: string | null;
  /** topic-specific better explanation (subject matter, not English) */
  contextual: string | null;
  contextualWhy: string[];
  /** one-line summary of the problem */
  note: string | null;
  mistakes: Mistake[];
  /** the model suspects the transcription itself may be wrong here */
  possibleMistranscription: boolean;
}

/** [start, end) character offsets of words the speech-to-text model was unsure about */
export type Span = [number, number];

export interface Sentence {
  idx: number;
  /** which Pause & Analyse round produced it (1-based) */
  part: number;
  text: string;
  uncertain: Span[];
  analysis: SentenceAnalysis | null;
}

export interface FeedbackArea {
  area: string;
  why: string;
  example: string;
  tip: string;
}

export interface CommunicationFeedback {
  clarity: string;
  mainIdea: string;
  missingConnections: string[];
  terminology: string;
  structure: string;
  sayNextTime: string;
}

export interface SessionFeedback {
  overall: string;
  strengths: string[];
  topAreas: FeedbackArea[];
  vocabulary: { insteadOf: string; tryInstead: string; example: string }[];
  recommendations: string[];
  communication: CommunicationFeedback;
}

export interface RepeatedMistake {
  pattern: string;
  category: MistakeCategory;
  count: number;
  examples: { original: string; corrected: string }[];
}

export interface SessionStats {
  words: number;
  sentences: number;
  analysedSentences: number;
  /** sentences with no grammar mistakes (verdict correct or unnatural) */
  grammarOk: number;
  /** sentences that were both correct and natural */
  naturalOk: number;
  fillers: { word: string; count: number }[];
  fillerTotal: number;
  overused: { word: string; count: number }[];
  repetitions: { text: string; count: number }[];
  categories: { category: MistakeCategory; count: number }[];
  repeatedMistakes: RepeatedMistake[];
}

export type SessionStatus = "transcribing" | "analysing" | "complete" | "partial" | "failed";

export interface Session {
  id: string;
  createdAt: string;
  updatedAt: string;
  durationSec: number;
  context: string;
  contextType: ContextType;
  status: SessionStatus;
  error: string | null;
  parts: number;
  sentences: Sentence[];
  feedback: SessionFeedback | null;
  feedbackError: string | null;
  stats: SessionStats | null;
  audioFiles: string[];
  models: { transcribe: string; analysis: string };
}

export interface SessionSummary {
  id: string;
  createdAt: string;
  durationSec: number;
  context: string;
  status: SessionStatus;
  sentences: number;
  grammarOk: number;
  analysedSentences: number;
  mistakes: number;
  preview: string;
}

/** Events streamed (NDJSON) from the analyse endpoint to the UI. */
export type PipelineEvent =
  | { type: "progress"; stage: "upload" | "transcribe" | "analyse" | "feedback" | "save"; done?: number; total?: number; message: string }
  | { type: "transcribed"; session: Session }
  | { type: "sentences"; session: Session }
  | { type: "result"; session: Session }
  | { type: "error"; stage: string; message: string; sessionId?: string; audioSafe: boolean };
