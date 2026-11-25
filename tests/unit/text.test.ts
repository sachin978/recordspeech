import { describe, expect, it } from "vitest";
import { joinTranscripts, splitSentences } from "@/lib/sentences";
import { wordDiff } from "@/lib/diff";
import { countFillers, findRepetitions, computeStats } from "@/lib/stats";
import { classifyContext, matchedContextTypes } from "@/lib/context";
import { parseTranscription, spansFromLogprobs, normalizeSpans } from "@/lib/transcribe";
import { markUncertain } from "@/lib/analysis/prompts";
import type { Sentence } from "@/lib/types";

describe("splitSentences", () => {
  it("splits on sentence punctuation and keeps exact text", () => {
    const t = "I am working here since two years. Is it okay? Yes! We went to the U.S. office.";
    expect(splitSentences(t).map((s) => s.text)).toEqual([
      "I am working here since two years.",
      "Is it okay?",
      "Yes!",
      "We went to the U.S. office.",
    ]);
  });
  it("does not split on abbreviations, decimals or trailing-off ellipsis", () => {
    const t = "Dr. Rao said version 3.5 is fine... but not great. Then e.g. this one.";
    expect(splitSentences(t).map((s) => s.text)).toEqual(["Dr. Rao said version 3.5 is fine... but not great.", "Then e.g. this one."]);
  });
  it("keeps text without final punctuation", () => {
    expect(splitSentences("so we generate a short url and").map((s) => s.text)).toEqual(["so we generate a short url and"]);
  });
  it("maps uncertain spans into sentence-relative offsets", () => {
    const t = "Hello there. I use Kafka daily.";
    const start = t.indexOf("Kafka");
    const s = splitSentences(t, [[start, start + 5]]);
    expect(s[1].text.slice(...s[1].uncertain[0])).toBe("Kafka");
  });
});

describe("joinTranscripts", () => {
  it("joins chunks in order and shifts spans", () => {
    const j = joinTranscripts([
      { text: "First part.", uncertain: [[0, 5]] },
      { text: "", uncertain: [] },
      { text: "Second bit.", uncertain: [[7, 10]] },
    ]);
    expect(j.text).toBe("First part. Second bit.");
    expect(j.text.slice(...j.uncertain[0])).toBe("First");
    expect(j.text.slice(...j.uncertain[1])).toBe("bit");
  });
});

describe("transcription uncertainty", () => {
  it("marks low-probability tokens as whole words", () => {
    const text = " We store it in Redis cache.";
    const tokens = [
      { token: " We", logprob: -0.01 },
      { token: " store", logprob: -0.02 },
      { token: " it", logprob: -0.01 },
      { token: " in", logprob: -0.01 },
      { token: " Red", logprob: -2.5 },
      { token: "is", logprob: -0.3 },
      { token: " cache", logprob: -0.05 },
      { token: ".", logprob: -0.01 },
    ];
    const spans = spansFromLogprobs(text, tokens);
    expect(spans.map(([a, b]) => text.slice(a, b))).toEqual(["Redis"]);
    const parsed = parseTranscription({ text, logprobs: tokens });
    expect(parsed.text).toBe("We store it in Redis cache.");
    expect(parsed.text.slice(...parsed.uncertain[0])).toBe("Redis");
  });
  it("merges adjacent spans", () => {
    expect(normalizeSpans("aa bb cc", [[0, 1], [3, 4]])).toEqual([[0, 5]]);
  });
  it("marks uncertain words for the model", () => {
    expect(markUncertain("we use Kafka now", [[7, 12]])).toBe("we use ⟨?Kafka⟩ now");
  });
});

describe("wordDiff", () => {
  it("highlights only changed words", () => {
    const d = wordDiff("I am working here since two years.", "I have been working here for two years.");
    expect(d.left.filter((p) => p.changed).map((p) => p.text)).toEqual(["am", "since"]);
    expect(d.right.filter((p) => p.changed).map((p) => p.text)).toEqual(["have been", "for"]);
    expect(d.left.map((p) => p.text).join("")).toBe("I am working here since two years.");
  });
  it("ignores case and punctuation-only changes", () => {
    const d = wordDiff("first user will give the long url", "First, the user will give the long URL.");
    expect(d.right.filter((p) => p.changed).map((p) => p.text)).toEqual(["the"]);
  });
});

describe("stats", () => {
  it("counts filler words without counting normal uses of 'like' or 'you know what'", () => {
    const f = countFillers("Actually, um, I like coffee. It was, like, basically fine. You know what I mean? You know, it works.");
    const get = (w: string) => f.find((x) => x.word === w)?.count ?? 0;
    expect(get("actually")).toBe(1);
    expect(get("um / uh")).toBe(1);
    expect(get("basically")).toBe(1);
    expect(get("like")).toBe(1);
    expect(get("you know")).toBe(1);
  });
  it("finds immediate repetitions", () => {
    expect(findRepetitions("I I think the the server is down")).toEqual([
      { text: "i i", count: 1 },
      { text: "the the", count: 1 },
    ]);
  });
  it("computes grammar accuracy and repeated mistakes from sentence analyses", () => {
    const mk = (idx: number, verdict: "correct" | "incorrect" | "unnatural", patterns: string[], mistranscribed = false): Sentence => ({
      idx,
      part: 1,
      text: `Sentence ${idx}.`,
      uncertain: [],
      analysis: {
        verdict,
        corrected: "",
        natural: null,
        professional: null,
        clearer: null,
        contextual: null,
        contextualWhy: [],
        note: null,
        possibleMistranscription: mistranscribed,
        mistakes: patterns.map((p) => ({ category: "preposition", kind: "grammar", original: "discuss about", corrected: "discuss", explanation: "x", pattern: p })),
      },
    });
    const st = computeStats([
      mk(1, "incorrect", ["discuss about → discuss"]),
      mk(2, "incorrect", ["Discuss about -> discuss"]),
      mk(3, "correct", []),
      mk(4, "unnatural", []),
      mk(5, "incorrect", ["x → y"], true),
    ]);
    expect(st.analysedSentences).toBe(4);
    expect(st.grammarOk).toBe(2);
    expect(st.naturalOk).toBe(1);
    expect(st.repeatedMistakes[0]).toMatchObject({ count: 2, category: "preposition" });
  });
});

describe("context classification", () => {
  it("detects the setting from the topic", () => {
    expect(classifyContext("Explaining URL Shortener system design")).toBe("technical");
    expect(classifyContext("Explaining a project in a software engineering interview")).toBe("interview");
    expect(classifyContext("Talking about my weekend")).toBe("casual");
    expect(classifyContext("Discussing a production bug")).toBe("technical");
    expect(classifyContext("")).toBe("general");
    expect(classifyContext("anything", "casual")).toBe("casual");
    expect(matchedContextTypes("Discussing a technical issue with my manager", "technical")).toEqual(["technical", "professional"]);
  });
});

import { sanitize } from "@/lib/openai";
describe("sanitize", () => {
  it("removes API keys and bearer tokens", () => {
    const s = sanitize("Incorrect API key provided: sk-proj-abcDEF123_456-xyz. Header Bearer sk-abc.def");
    expect(s).not.toMatch(/abcDEF123|sk-abc\.def/);
  });
});
