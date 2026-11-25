import { countWords } from "./sentences";
import type { MistakeCategory, RepeatedMistake, Sentence, SessionStats } from "./types";

// Deterministic session statistics. Every number shown in the UI comes from
// here and has a plain, explainable basis (counts from the transcript or from
// the per-sentence analysis) — no opaque AI-generated scores.

/** Filler phrases; "like" is only counted in filler position (", like," etc.). */
const FILLERS: [string, RegExp][] = [
  ["um / uh", /\b(u+m+|u+h+|e+r+m*|hmm+|mm+)\b/gi],
  ["actually", /\bactually\b/gi],
  ["basically", /\bbasically\b/gi],
  ["you know", /\byou know\b(?!\s+(what|how|why|where|when|who|that|if|the|a|an|about|him|her|them|it)\b)/gi],
  ["I mean", /\bI mean\b(?!\s+(it|that|this)\b)/gi],
  ["like", /(?:^|[,.]\s*|\b(?:was|is|it's|and|so|just)\s+)like,/gi],
  ["kind of / sort of", /\b(kind|sort) of\b(?=\s+(like|um|uh)\b|,)/gi],
  ["so yeah", /\bso,? yeah\b/gi],
  ["literally", /\bliterally\b/gi],
  ["obviously", /\bobviously\b/gi],
];

const STOPWORDS = new Set(
  (
    "i me my we our you your he she it its they them their this that these those a an the and or but so if then " +
    "is am are was were be been being have has had do does did will would can could should shall may might must " +
    "to of in on at for with from by about as into over after before than too very just not no yes also there here " +
    "what which who when where why how all any some more most other such only own same one two up down out off again " +
    "um uh like actually basically know mean yeah okay ok well gonna wanna going get got go said say says thing things lot " +
    "don't i'm it's that's there's we're they're can't didn't doesn't isn't wasn't i've i'll you're let's"
  ).split(/\s+/),
);

export function countFillers(text: string): { word: string; count: number }[] {
  return FILLERS.map(([word, re]) => ({ word, count: (text.match(re) ?? []).length }))
    .filter((f) => f.count > 0)
    .sort((a, b) => b.count - a.count);
}

/** Immediate word/phrase repetitions such as "I I", "the the", "we are we are". */
export function findRepetitions(text: string): { text: string; count: number }[] {
  const counts = new Map<string, number>();
  const re = /\b([\p{L}'’]+(?:\s+[\p{L}'’]+){0,2})(?:[\s,]+\1\b)+/giu;
  for (const m of text.matchAll(re)) {
    const key = m[1].toLowerCase();
    if (key.length < 1) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([t, count]) => ({ text: `${t} ${t}`, count })).sort((a, b) => b.count - a.count);
}

/** Content words used noticeably often (≥4 times and ≥2% of words). */
export function findOverused(text: string): { word: string; count: number }[] {
  const words = (text.toLowerCase().match(/[\p{L}'’]+/gu) ?? []).map((w) => w.replace(/’/g, "'"));
  const total = words.length;
  if (total < 40) return [];
  const counts = new Map<string, number>();
  for (const w of words) {
    if (w.length < 3 || STOPWORDS.has(w)) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, c]) => c >= 4 && c / total >= 0.02)
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);
}

export function normalizePattern(p: string): string {
  return p.toLowerCase().replace(/[“”"']/g, "").replace(/\s*(->|→|=>)\s*/g, " → ").replace(/\s+/g, " ").trim();
}

export function computeRepeatedMistakes(sentences: Sentence[]): RepeatedMistake[] {
  const groups = new Map<string, RepeatedMistake>();
  for (const s of sentences) {
    for (const m of s.analysis?.mistakes ?? []) {
      const key = normalizePattern(m.pattern) || m.category;
      const g = groups.get(key) ?? { pattern: m.pattern, category: m.category, count: 0, examples: [] };
      g.count++;
      if (g.examples.length < 3) g.examples.push({ original: m.original, corrected: m.corrected });
      groups.set(key, g);
    }
  }
  const byPattern = [...groups.values()].filter((g) => g.count >= 2);
  // Also surface categories that repeat even when the specific pattern differs.
  const byCat = new Map<MistakeCategory, RepeatedMistake>();
  for (const g of groups.values()) {
    if (g.count >= 2) continue;
    const c = byCat.get(g.category) ?? { pattern: "", category: g.category, count: 0, examples: [] };
    c.count += g.count;
    if (c.examples.length < 3) c.examples.push(...g.examples.slice(0, 3 - c.examples.length));
    byCat.set(g.category, c);
  }
  const catRepeats = [...byCat.values()].filter((c) => c.count >= 2 && c.category !== "other");
  return [...byPattern, ...catRepeats].sort((a, b) => b.count - a.count).slice(0, 10);
}

export function computeStats(sentences: Sentence[]): SessionStats {
  const text = sentences.map((s) => s.text).join(" ");
  // Sentences the model suspects were mis-heard by speech-to-text are not counted for or against the speaker.
  const analysed = sentences.filter((s) => s.analysis && !s.analysis.possibleMistranscription);
  const catCounts = new Map<MistakeCategory, number>();
  for (const s of analysed)
    for (const m of s.analysis!.mistakes) catCounts.set(m.category, (catCounts.get(m.category) ?? 0) + 1);
  const fillers = countFillers(text);
  return {
    words: countWords(text),
    sentences: sentences.length,
    analysedSentences: analysed.length,
    grammarOk: analysed.filter((s) => s.analysis!.verdict !== "incorrect").length,
    naturalOk: analysed.filter((s) => s.analysis!.verdict === "correct").length,
    fillers,
    fillerTotal: fillers.reduce((a, f) => a + f.count, 0),
    overused: findOverused(text),
    repetitions: findRepetitions(text),
    categories: [...catCounts.entries()].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count),
    repeatedMistakes: computeRepeatedMistakes(analysed),
  };
}
