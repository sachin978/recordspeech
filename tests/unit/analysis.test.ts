import { describe, expect, it } from "vitest";
import { normalizeFeedback, normalizeSentenceAnalysis, sameText } from "@/lib/analysis/analyse";
import { FeedbackSchema, SentenceBatchSchema, toStrictJsonSchema, type RawSentenceAnalysis } from "@/lib/analysis/schema";
import { computeProgress, trendOf } from "@/lib/progress";
import type { SessionStats } from "@/lib/types";

const raw = (over: Partial<RawSentenceAnalysis>): RawSentenceAnalysis => ({
  index: 1,
  mistakes: [],
  verdict: "correct",
  corrected: "",
  natural: null,
  professional: null,
  clearer: null,
  contextual: null,
  contextual_why: [],
  note: null,
  possible_mistranscription: false,
  ...over,
});

describe("strict JSON schema", () => {
  it("is valid for OpenAI strict mode (all required, no additional props)", () => {
    const check = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      const n = node as Record<string, unknown>;
      if (n.type === "object") {
        expect(n.additionalProperties).toBe(false);
        expect(Object.keys(n.properties as object).sort()).toEqual([...(n.required as string[])].sort());
      }
      expect(n.$schema).toBeUndefined();
      Object.values(n).forEach(check);
    };
    check(toStrictJsonSchema(SentenceBatchSchema));
    check(toStrictJsonSchema(FeedbackSchema));
  });
});

describe("normalizeSentenceAnalysis", () => {
  const original = "I am working here since two years.";
  it("keeps a real correction", () => {
    const a = normalizeSentenceAnalysis(
      raw({
        verdict: "incorrect",
        corrected: "I have been working here for two years.",
        natural: "I've been working here for two years.",
        mistakes: [
          { category: "tense", kind: "grammar", original: "am working", corrected: "have been working", explanation: "Started in the past and continues now.", pattern: "present continuous for ongoing duration → present perfect continuous" },
          { category: "preposition", kind: "grammar", original: "since two years", corrected: "for two years", explanation: "Use for with a duration.", pattern: "since + duration → for + duration" },
        ],
      }),
      original,
      false,
    );
    expect(a.verdict).toBe("incorrect");
    expect(a.mistakes).toHaveLength(2);
    expect(a.natural).toBe("I've been working here for two years.");
  });
  it("never 'corrects' a sentence marked correct", () => {
    const a = normalizeSentenceAnalysis(raw({ verdict: "correct", corrected: "Something else entirely.", natural: "Another version." }), "I like it.", false);
    expect(a.verdict).toBe("correct");
    expect(a.corrected).toBe("I like it.");
    expect(a.natural).toBeNull();
    expect(a.mistakes).toEqual([]);
  });
  it("downgrades 'incorrect' when nothing was actually changed", () => {
    const a = normalizeSentenceAnalysis(raw({ verdict: "incorrect", corrected: "i like it", mistakes: [] }), "I like it.", false);
    expect(a.verdict).toBe("correct");
  });
  it("keeps the original as 'corrected' for unnatural sentences", () => {
    const a = normalizeSentenceAnalysis(
      raw({
        verdict: "unnatural",
        corrected: "We discussed it.",
        natural: "We talked about it.",
        mistakes: [{ category: "awkward_expression", kind: "grammar", original: "x", corrected: "y", explanation: "e", pattern: "p" }],
      }),
      "We had a discussion on it.",
      false,
    );
    // grammar mistake + a changed correction means it is actually incorrect
    expect(a.verdict).toBe("incorrect");
    const b = normalizeSentenceAnalysis(
      raw({ verdict: "unnatural", corrected: "We had a discussion on it.", natural: "We talked about it.", mistakes: [] }),
      "We had a discussion on it.",
      false,
    );
    expect(b.verdict).toBe("unnatural");
    expect(b.corrected).toBe("We had a discussion on it.");
  });
  it("drops duplicate alternatives and contextual text when no topic was given", () => {
    const a = normalizeSentenceAnalysis(
      raw({ verdict: "unnatural", corrected: original, natural: "I've been here two years.", professional: "I've been here two years!", contextual: "x", contextual_why: ["y"] }),
      original,
      false,
    );
    expect(a.professional).toBeNull();
    expect(a.contextual).toBeNull();
    expect(a.contextualWhy).toEqual([]);
  });
  it("compares text ignoring case and punctuation", () => {
    expect(sameText("Hello, world!", "hello world")).toBe(true);
    expect(sameText("Hello world", "Hello there")).toBe(false);
  });
});

describe("normalizeFeedback", () => {
  it("caps list lengths", () => {
    const f = normalizeFeedback({
      overall_assessment: " Good. ",
      strengths: ["a", "b", "c", "d"],
      top_areas: Array.from({ length: 5 }, (_, i) => ({ area: `A${i}`, why: "w", example_from_speech: "e", tip: "t" })),
      vocabulary_suggestions: [],
      next_session_tips: ["1", "2", "3", "4"],
      communication: { clarity: "c", main_idea: "m", missing_connections: [], terminology: "t", structure: "s", say_next_time: "n" },
    });
    expect(f.overall).toBe("Good.");
    expect(f.strengths).toHaveLength(3);
    expect(f.topAreas).toHaveLength(3);
    expect(f.recommendations).toHaveLength(3);
  });
});

describe("progress", () => {
  it("detects improving and worsening trends", () => {
    expect(trendOf([0.5, 0.4, 0.1, 0.1]).trend).toBe("improving");
    expect(trendOf([0.1, 0.1, 0.4, 0.5]).trend).toBe("worse");
    expect(trendOf([0.2, 0.21, 0.2]).trend).toBe("steady");
    expect(trendOf([0.2, 0.1]).trend).toBe("not-enough-data");
  });
  it("builds insights from stored mistakes", () => {
    const stats = (n: number): SessionStats => ({
      words: 100, sentences: n, analysedSentences: n, grammarOk: n - 2, naturalOk: 1, fillers: [], fillerTotal: 3, overused: [], repetitions: [], categories: [], repeatedMistakes: [],
    });
    const sessions = [1, 2, 3, 4].map((i) => ({ id: `s${i}`, createdAt: `2026-11-0${i}T10:00:00Z`, durationSec: 120, context: "", stats: stats(10) }));
    const mistakes = [
      ...Array.from({ length: 5 }, () => ({ session_id: "s1", category: "article", kind: "grammar", pattern: "missing the", original: "go to office", corrected: "go to the office" })),
      ...Array.from({ length: 4 }, () => ({ session_id: "s2", category: "article", kind: "grammar", pattern: "missing the", original: "go to office", corrected: "go to the office" })),
      { session_id: "s3", category: "article", kind: "grammar", pattern: "missing the", original: "a", corrected: "b" },
      { session_id: "s2", category: "preposition", kind: "grammar", pattern: "discuss about → discuss", original: "discussing about", corrected: "discussing" },
      { session_id: "s4", category: "preposition", kind: "grammar", pattern: "Discuss about → discuss", original: "discussing about", corrected: "discussing" },
    ];
    const p = computeProgress(sessions, mistakes);
    const art = p.categories.find((c) => c.category === "article")!;
    expect(art.trend).toBe("improving");
    expect(p.patterns.find((x) => x.pattern.toLowerCase().startsWith("discuss"))?.sessions).toBe(2);
    expect(p.insights.some((i) => i.includes("less frequent"))).toBe(true);
    expect(p.insights.some((i) => i.includes("discussing about"))).toBe(true);
  });
});
