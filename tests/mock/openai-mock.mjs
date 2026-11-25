// A small stand-in for the OpenAI API, used ONLY by automated tests (never by the app itself).
// It implements /v1/audio/transcriptions and /v1/chat/completions closely enough to exercise
// the real pipeline: multipart upload, logprobs, strict JSON-schema output, errors and retries.
//
// Control endpoints (test-only):
//   POST /__control  {failTranscribe, failAnalysis, failFeedback, malformedAnalysis, status, rejectParam, delayMs}
//   POST /__reset    clears state and the request log
//   GET  /__log      requests received so far
import http from "node:http";

const PORT = Number(process.env.MOCK_PORT || 3299);
const EXPECTED_KEY = process.env.MOCK_EXPECTED_KEY || "sk-test-e2e-SECRET-0123456789";

const TRANSCRIPTS = [
  "I am working here since two years. Yesterday I was discussing about this issue with my manager.",
  "First user will give the long URL and then we are generating one small URL which will redirect to original URL. It works well.",
  "Actually, um, the system is having a cache. We store the mapping in Redis.",
  "I am working here since two years. The team is very good.",
];

let state = {};
let log = [];
const reset = () => {
  state = { leakKey: false, failTranscribe: 0, failAnalysis: 0, failFeedback: 0, malformedAnalysis: 0, status: 500, rejectParam: null, delayMs: 0 };
  log = [];
};
reset();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (res, code, body) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });

function tokensFor(text) {
  // split into " word" style tokens; "Redis" is deliberately low-confidence
  const parts = text.match(/\s*[^\s]+/g) ?? [];
  return parts.map((t) => ({ token: t, logprob: /Redis/.test(t) ? -2.3 : -0.02, bytes: [] }));
}

const RULES = [
  {
    re: /I am working here since two years/i,
    from: "I am working here since two years",
    to: "I have been working here for two years",
    natural: "I've been working here for two years.",
    mistakes: [
      { category: "tense", kind: "grammar", original: "am working", corrected: "have been working", explanation: "Use 'have been working' for something that started in the past and continues now.", pattern: "present continuous for ongoing duration → present perfect continuous" },
      { category: "preposition", kind: "grammar", original: "since two years", corrected: "for two years", explanation: "Use 'for' with a length of time. Use 'since' with a starting point.", pattern: "since + duration → for + duration" },
    ],
  },
  {
    re: /discussing about/i,
    from: "Yesterday I was discussing about this issue",
    to: "Yesterday I discussed this issue",
    natural: "I spoke to my manager about this issue yesterday.",
    professional: "I discussed this issue with my manager yesterday.",
    mistakes: [{ category: "preposition", kind: "grammar", original: "discussing about", corrected: "discussed", explanation: "'Discuss' does not need 'about'. Use simple past for a finished action.", pattern: "discuss about → discuss" }],
  },
  {
    re: /First user will give the long URL/i,
    from: "First user will give the long URL and then we are generating one small URL which will redirect to original URL",
    to: "First, the user gives the long URL, and then we generate a short URL that redirects to the original URL",
    natural: "First, the user gives us a long URL, and we generate a short URL that redirects to it.",
    contextual: "First, the user submits a long URL. Our service generates a unique short code, stores the mapping, and returns the short URL. When someone opens it, we look up the code and redirect them.",
    contextual_why: ["Explains the sequence of operations", "Uses standard terms: short code, mapping", "Makes explicit: the mapping is stored"],
    mistakes: [
      { category: "article", kind: "grammar", original: "First user", corrected: "First, the user", explanation: "Use 'the' when you mean a specific user.", pattern: "missing 'the' before a specific noun" },
      { category: "tense", kind: "grammar", original: "are generating", corrected: "generate", explanation: "Use simple present to describe how a system works.", pattern: "present continuous for a general process → simple present" },
    ],
  },
  {
    re: /is having a cache/i,
    from: "the system is having a cache",
    to: "the system has a cache",
    mistakes: [{ category: "helping_verb", kind: "grammar", original: "is having", corrected: "has", explanation: "For owning or containing something, use 'has', not 'is having'.", pattern: "is having → has (possession)" }],
  },
];

function analyseSentence(index, text) {
  const clean = text.replace(/⟨\?([^⟩]*)⟩/g, "$1");
  const base = { index, mistakes: [], verdict: "correct", corrected: clean, natural: null, professional: null, clearer: null, contextual: null, contextual_why: [], note: null, possible_mistranscription: false };
  for (const r of RULES) {
    if (r.re.test(clean)) {
      return {
        ...base,
        mistakes: r.mistakes,
        verdict: "incorrect",
        corrected: clean.replace(r.from, r.to),
        natural: r.natural ?? null,
        professional: r.professional ?? null,
        contextual: r.contextual ?? null,
        contextual_why: r.contextual_why ?? [],
        note: r.mistakes[0].explanation,
      };
    }
  }
  if (/^Actually, um,/i.test(clean)) return { ...base, verdict: "unnatural", natural: clean.replace(/^Actually, um, /i, "").replace(/^./, (c) => c.toUpperCase()), mistakes: [{ category: "redundancy", kind: "style", original: "Actually, um,", corrected: "", explanation: "Starting with fillers weakens the sentence.", pattern: "filler at start → remove" }], note: "Filler words at the start." };
  return base;
}

const FEEDBACK = {
  overall_assessment: "You explained your ideas clearly and kept talking without long pauses. Most mistakes were with tenses and prepositions.",
  strengths: ["You kept a steady flow", "Good technical vocabulary"],
  top_areas: [
    { area: "Present perfect for ongoing actions", why: "It shows something started in the past and continues.", example_from_speech: "I am working here since two years", tip: "Say 'I have been … for …'." },
    { area: "Verbs that don't need 'about'", why: "'Discuss about' sounds wrong to fluent speakers.", example_from_speech: "discussing about this issue", tip: "Say 'discuss the issue'." },
    { area: "Simple present for how systems work", why: "Processes are described in simple present.", example_from_speech: "we are generating one small URL", tip: "Say 'we generate'." },
  ],
  vocabulary_suggestions: [{ instead_of: "small URL", try_instead: "short URL", example: "We generate a short URL." }],
  next_session_tips: ["Use 'for' with durations", "Pause instead of saying 'actually'", "Describe processes step by step"],
  communication: {
    clarity: "Easy to follow overall.",
    main_idea: "The main flow of the URL shortener came across.",
    missing_connections: ["How the short code maps back to the long URL"],
    terminology: "Say 'short code' and 'mapping'.",
    structure: "Describe create flow, then redirect flow.",
    say_next_time: "A URL shortener has two flows: creating a short link and redirecting.",
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const body = await readBody(req);

  if (url.pathname === "/__reset") {
    reset();
    return send(res, 200, { ok: true });
  }
  if (url.pathname === "/__control") {
    Object.assign(state, JSON.parse(body.toString() || "{}"));
    return send(res, 200, state);
  }
  if (url.pathname === "/__log") return send(res, 200, log);

  if (state.leakKey) // a hostile/buggy upstream echoing the full key back
    return send(res, 401, { error: { message: `Incorrect API key provided: ${req.headers.authorization?.slice(7)} (${req.headers.authorization})` } });
  if (req.headers.authorization !== `Bearer ${EXPECTED_KEY}`)
    return send(res, 401, { error: { message: "Incorrect API key provided: sk-test-***" } });
  if (state.delayMs) await sleep(state.delayMs);

  if (url.pathname === "/v1/audio/transcriptions") {
    const form = await new Request("http://x/", { method: "POST", headers: { "content-type": req.headers["content-type"] }, body }).formData();
    const file = form.get("file");
    const entry = { kind: "transcribe", model: form.get("model"), filename: file?.name, size: file?.size, fields: [...form.keys()], prompt: form.get("prompt"), languages: form.getAll("languages[]"), include: form.getAll("include[]") };
    log.push(entry);
    if (!file || !file.size) return send(res, 400, { error: { message: "No file" } });
    if (state.rejectParam && form.has(state.rejectParam)) return send(res, 400, { error: { message: `Unknown parameter: '${state.rejectParam}'.` } });
    if (state.failTranscribe > 0) {
      state.failTranscribe--;
      return send(res, state.status, { error: { message: "Simulated failure" } });
    }
    const n = Number(/segment-(\d+)/.exec(file.name)?.[1] ?? 1);
    const text = TRANSCRIPTS[(n - 1) % TRANSCRIPTS.length];
    return send(res, 200, { text, logprobs: form.getAll("include[]").includes("logprobs") ? tokensFor(text) : undefined });
  }

  if (url.pathname === "/v1/chat/completions") {
    const j = JSON.parse(body.toString());
    const name = j.response_format?.json_schema?.name;
    const user = j.messages?.find((m) => m.role === "user")?.content ?? "";
    log.push({ kind: "chat", name, model: j.model, strict: j.response_format?.json_schema?.strict, reasoning_effort: j.reasoning_effort, user });
    if (state.rejectParam && state.rejectParam in j) return send(res, 400, { error: { message: `Unsupported parameter: '${state.rejectParam}'.` } });
    if (name === "session_feedback") {
      if (state.failFeedback > 0) {
        state.failFeedback--;
        return send(res, state.status, { error: { message: "Simulated failure" } });
      }
      return send(res, 200, { choices: [{ finish_reason: "stop", message: { content: JSON.stringify(FEEDBACK) } }] });
    }
    if (state.failAnalysis > 0) {
      state.failAnalysis--;
      return send(res, state.status, { error: { message: "Simulated failure" } });
    }
    if (state.malformedAnalysis > 0) {
      state.malformedAnalysis--;
      return send(res, 200, { choices: [{ finish_reason: "stop", message: { content: '{"sentences": [ {"index": 1, "verdict": ' } }] });
    }
    const lines = new Map([...user.matchAll(/^\[(\d+)\] (.*)$/gm)].map((m) => [Number(m[1]), m[2]]));
    const requested = [.../\bAnalyse ONLY sentences ([^(]+)/.exec(user)[1].matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
    const sentences = requested.map((i) => analyseSentence(i, lines.get(i) ?? ""));
    return send(res, 200, { choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ sentences }) } }] });
  }
  send(res, 404, { error: { message: "Not found" } });
});

server.listen(PORT, "127.0.0.1", () => console.log(`openai-mock listening on ${PORT}`));
