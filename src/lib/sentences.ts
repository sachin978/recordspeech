import type { Span } from "./types";

// Deterministic sentence splitting. The original sentence text always comes
// from the transcript itself (never from the AI), so "What I said" can't be
// rewritten by the analysis model.

const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc", "e.g", "i.e", "approx", "no", "fig", "inc", "ltd", "co",
]);

export interface SplitSentence {
  text: string;
  start: number;
  uncertain: Span[];
}

export function splitSentences(text: string, uncertain: Span[] = []): SplitSentence[] {
  const out: SplitSentence[] = [];
  const n = text.length;
  let start = 0;
  const push = (end: number) => {
    let a = start;
    let b = end;
    while (a < b && /\s/.test(text[a])) a++;
    while (b > a && /\s/.test(text[b - 1])) b--;
    if (b > a) {
      const spans = uncertain
        .filter(([s, e]) => e > a && s < b)
        .map(([s, e]): Span => [Math.max(s, a) - a, Math.min(e, b) - a]);
      out.push({ text: text.slice(a, b), start: a, uncertain: spans });
    }
    start = end;
  };

  for (let i = 0; i < n; i++) {
    const c = text[i];
    if (c !== "." && c !== "!" && c !== "?") continue;
    // consume runs like "?!" or "..." and closing quotes/brackets
    let j = i;
    while (j + 1 < n && /[.!?]/.test(text[j + 1])) j++;
    while (j + 1 < n && /["'”’)\]]/.test(text[j + 1])) j++;
    const next = j + 1;
    if (next < n && !/\s/.test(text[next])) {
      i = j;
      continue; // e.g. "3.5", "U.S.", "example.com"
    }
    if (c === ".") {
      const before = text.slice(start, i).match(/([A-Za-z.]+)$/)?.[1]?.toLowerCase() ?? "";
      const nextChar = text.slice(next).trimStart()[0] ?? "";
      const lowerNext = /[a-z]/.test(nextChar);
      // "Dr.", single initials, and dotted acronyms like "U.S." followed by a lowercase word
      if (ABBREVIATIONS.has(before) || /^[a-z]$/i.test(before) || (/^([a-z]\.)+[a-z]$/i.test(before) && lowerNext)) {
        i = j;
        continue;
      }
      // ellipsis followed by lowercase = the speaker trailed off mid-sentence
      if (j > i) {
        if (lowerNext) {
          i = j;
          continue;
        }
      }
    }
    push(next);
    i = j;
  }
  push(n);
  return out;
}

/** Join transcribed chunks in chronological order, shifting their uncertain spans. */
export function joinTranscripts(parts: { text: string; uncertain: Span[] }[]): { text: string; uncertain: Span[] } {
  let text = "";
  const uncertain: Span[] = [];
  for (const p of parts) {
    const t = p.text.trim();
    if (!t) continue;
    const offset = text ? text.length + 1 : 0;
    text = text ? `${text} ${t}` : t;
    const lead = p.text.length - p.text.trimStart().length;
    for (const [a, b] of p.uncertain) uncertain.push([a - lead + offset, b - lead + offset]);
  }
  return { text, uncertain };
}

export function countWords(text: string): number {
  return (text.match(/[\p{L}\p{N}'’-]+/gu) ?? []).length;
}
