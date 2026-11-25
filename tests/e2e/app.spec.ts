import { chromium, expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { APP_PORT, FIXTURES, MOCK, TEST_KEY } from "./env";

// Full workflow tests: real browser, real microphone pipeline (fake device), real
// Next.js server + SQLite; only the OpenAI API is replaced by tests/mock/openai-mock.mjs.

type LogEntry = { kind: string; model?: string; filename?: string; prompt?: string; languages?: string[]; include?: string[]; name?: string; strict?: boolean; reasoning_effort?: string; fields?: string[] };

const control = (body: object) => fetch(`${MOCK}/__control`, { method: "POST", body: JSON.stringify(body) });
const mockLog = async (): Promise<LogEntry[]> => (await fetch(`${MOCK}/__log`)).json();

test.beforeEach(async ({ page }) => {
  await fetch(`${MOCK}/__reset`, { method: "POST" });
  page.on("dialog", (d) => d.accept());
});

async function record(page: Page, seconds: number) {
  await page.getByRole("button", { name: /Start Recording|Resume Recording/ }).first().click();
  await expect(page.getByTestId("rec-status")).toHaveText(/Recording/);
  await page.waitForTimeout(seconds * 1000);
}

async function waitForResult(page: Page, status = "complete") {
  await expect(page.getByTestId("session-view")).toHaveAttribute("data-status", status, { timeout: 60_000 });
}

test("speak → pause & analyse → compare → resume adds a part → history", async ({ page }) => {
  await page.goto("/?segmentSec=4");
  await page.getByLabel(/What are you going to talk about today/).fill("Explaining URL Shortener system design");
  await record(page, 13);

  // timer keeps running without any interaction between sentences
  const t = await page.getByTestId("timer").textContent();
  expect(Number(t!.split(":")[1])).toBeGreaterThanOrEqual(12);

  await page.getByRole("button", { name: /Pause & Analyse/ }).click();
  await waitForResult(page);

  const log1 = await mockLog();
  const trans = log1.filter((l) => l.kind === "transcribe");
  expect(trans.length).toBeGreaterThanOrEqual(2); // recording was split into several parts at pauses
  expect(trans[0].model).toBe("gpt-transcribe");
  expect(trans[0].prompt).toContain("Explaining URL Shortener system design");
  expect(trans[0].languages).toEqual(["en"]);
  expect(trans[0].include).toEqual(["logprobs"]);
  const chats = log1.filter((l) => l.kind === "chat");
  expect(chats.every((c) => c.strict === true)).toBe(true);
  expect(chats.some((c) => c.name === "session_feedback")).toBe(true);
  expect(chats.filter((c) => c.name === "sentence_analysis").length).toBeGreaterThanOrEqual(2); // parallel batches

  // aligned comparison: original on the left, improvement on the right, same row
  const row1 = page.locator('[data-idx="1"]');
  await expect(row1.locator(".left")).toContainText("I am working here since two years.");
  await expect(row1.locator(".right")).toContainText("I have been working here for two years.");
  await expect(row1.locator(".right")).toContainText("Grammar mistake");
  await expect(row1.locator(".left .del")).toHaveText(["am", "since"]);
  await expect(row1.locator(".right .ins")).toHaveText(["have been", "for"]);
  const row2 = page.locator('[data-idx="2"]');
  await expect(row2.locator(".left")).toContainText("discussing about");

  // every row's left side is exactly the transcript sentence
  const rows = page.locator(".cmp-row");
  const n = await rows.count();
  expect(n).toBeGreaterThanOrEqual(4);
  for (let i = 0; i < n; i++) await expect(rows.nth(i).locator(".right")).not.toContainText("Not analysed");

  // uncertain word from logprobs is marked
  await expect(page.locator(".cmp .unclear", { hasText: "Redis" }).first()).toBeVisible();

  // natural toggle
  await page.getByRole("button", { name: "More natural" }).click();
  await expect(row1.locator(".right")).toContainText("I've been working here for two years.");

  // Understand your mistakes + feedback + separate explanation section
  const mistakes = page.locator("#mistakes");
  await expect(mistakes).toContainText("Use 'for' with a length of time");
  await expect(mistakes).toContainText("Mistakes you made more than once");
  await expect(page.locator("#feedback")).toContainText("Sentences without grammar mistakes");
  await expect(page.locator("#feedback")).toContainText("Top 3 areas to improve");
  await expect(page.locator("#communication")).toContainText("Better explanation");
  await expect(page.locator("#communication")).toContainText("short code");

  // Resume continues the same session as part 2
  await record(page, 5);
  await page.getByRole("button", { name: /Pause & Analyse/ }).click();
  await waitForResult(page);
  await expect(page.locator(".part-label", { hasText: "Part 2" })).toBeVisible();
  expect(await page.locator(".cmp-row").count()).toBeGreaterThan(n);

  // history: the session is saved and can be reopened
  await page.goto("/history");
  const item = page.getByTestId("history").locator("li").first();
  await expect(item).toContainText("Explaining URL Shortener system design");
  await item.locator("a").click();
  await expect(page.locator('[data-idx="1"] .right')).toContainText("I have been working here for two years.");

  await page.goto("/progress");
  await expect(page.locator("body")).toContainText("Recurring mistake types");
});

test("discard before analysis sends nothing", async ({ page }) => {
  await page.goto("/?segmentSec=4");
  await record(page, 3);
  await page.getByRole("button", { name: "Discard Recording" }).click();
  await expect(page.getByTestId("studio")).toHaveAttribute("data-phase", "idle");
  await expect(page.getByTestId("timer")).toHaveText("0:00");
  expect((await mockLog()).filter((l) => l.kind === "transcribe")).toHaveLength(0);
});

test("stop, reload the tab, recover the recording and analyse it", async ({ page }) => {
  await page.goto("/?segmentSec=4");
  await record(page, 6);
  await page.getByRole("button", { name: /Stop Recording/ }).click();
  await expect(page.getByTestId("studio")).toHaveAttribute("data-phase", "stopped");
  expect((await mockLog()).filter((l) => l.kind === "transcribe")).toHaveLength(0);
  await page.reload();
  await expect(page.getByTestId("recovered")).toBeVisible();
  await page.getByRole("button", { name: "Analyse", exact: true }).click();
  await waitForResult(page);
});

test("recovers audio after the tab dies mid-recording", async ({ page }) => {
  await page.goto("/?segmentSec=30");
  await record(page, 5);
  // simulate a crash: navigate away without stopping (beforeunload accepted)
  await page.goto("about:blank");
  await page.goto("/");
  await expect(page.getByTestId("recovered")).toBeVisible();
  await page.getByRole("button", { name: "Analyse", exact: true }).click();
  await waitForResult(page);
});

test("transcription failure keeps the audio; retry succeeds", async ({ page }) => {
  await control({ failTranscribe: 1000 });
  await page.goto("/?segmentSec=4");
  await record(page, 4);
  await page.getByRole("button", { name: /Pause & Analyse/ }).click();
  await expect(page.getByTestId("error")).toContainText("Transcription failed", { timeout: 60_000 });
  await expect(page.getByTestId("studio")).toHaveAttribute("data-phase", "stopped");
  await control({ failTranscribe: 0 });
  await page.getByRole("button", { name: "Analyse", exact: true }).click();
  await waitForResult(page);
});

test("analysis failure saves the transcript; Retry analysis completes it", async ({ page }) => {
  await control({ failAnalysis: 1000 });
  await page.goto("/?segmentSec=4");
  await record(page, 4);
  await page.getByRole("button", { name: /Pause & Analyse/ }).click();
  await waitForResult(page, "partial");
  await expect(page.getByText(/Analysis incomplete/)).toBeVisible();
  await expect(page.locator(".cmp-row").first().locator(".left")).not.toBeEmpty(); // transcript shown anyway
  await control({ failAnalysis: 0 });
  await page.getByRole("button", { name: "Retry analysis" }).click();
  await waitForResult(page);
});

test("malformed AI response is retried and validated", async ({ page }) => {
  await control({ malformedAnalysis: 1 });
  await page.goto("/?segmentSec=4");
  await record(page, 4);
  await page.getByRole("button", { name: /Pause & Analyse/ }).click();
  await waitForResult(page);
});

test("microphone disconnected mid-recording keeps the audio", async ({ page }) => {
  // capture the stream so the test can simulate the device being unplugged
  await page.addInitScript(() => {
    const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (c) => {
      const s = await orig(c);
      (window as unknown as { __rsStream: MediaStream }).__rsStream = s;
      return s;
    };
  });
  await page.goto("/?segmentSec=4");
  await record(page, 5);
  await page.evaluate(() => {
    const t = (window as unknown as { __rsStream: MediaStream }).__rsStream.getAudioTracks()[0];
    t.dispatchEvent(new Event("ended")); // what the browser fires when a mic is unplugged
  });
  await expect(page.getByTestId("error")).toContainText("microphone was disconnected");
  await expect(page.getByTestId("studio")).toHaveAttribute("data-phase", "stopped");
  await page.getByRole("button", { name: "Analyse", exact: true }).click();
  await waitForResult(page);
});

test("microphone permission denied is explained", async ({ browser }) => {
  const ctx = await browser.newContext({ permissions: [] });
  const page = await ctx.newPage();
  await page.goto("/");
  await page.getByRole("button", { name: /Start Recording/ }).click();
  await expect(page.getByTestId("error")).toContainText("Microphone access was blocked");
  await expect(page.getByTestId("studio")).toHaveAttribute("data-phase", "idle");
  await ctx.close();
});

test("silent microphone: nothing is sent and the user is told", async () => {
  const browser = await chromium.launch({
    channel: "chrome",
    args: ["--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${FIXTURES}/silence.wav`],
  });
  const ctx = await browser.newContext({ permissions: ["microphone"], baseURL: `http://127.0.0.1:${APP_PORT}` });
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.accept());
  await page.goto("/?segmentSec=4");
  await record(page, 9);
  await expect(page.getByText(/can't hear anything/)).toBeVisible();
  await page.getByRole("button", { name: /Pause & Analyse/ }).click();
  await expect(page.getByTestId("error")).toContainText("No speech was detected");
  expect((await mockLog()).filter((l) => l.kind === "transcribe")).toHaveLength(0);
  await browser.close();
});

test("API key is never exposed to the browser", async ({ request }) => {
  const health = await (await request.get("/api/health")).text();
  expect(health).not.toContain(TEST_KEY);
  expect(JSON.parse(health).configured).toBe(true);
  // scan every built client asset
  const files: string[] = [];
  const walk = (d: string) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : files.push(path.join(d, e.name))));
  walk(path.resolve(".next/static"));
  expect(files.length).toBeGreaterThan(5);
  for (const f of files) expect(fs.readFileSync(f, "utf8").includes(TEST_KEY), f).toBe(false);
  // and the rendered HTML
  const html = await (await request.get("/")).text();
  expect(html).not.toContain(TEST_KEY);
});

test("cross-site and foreign-host requests are blocked", async ({ request }) => {
  const r1 = await request.post("/api/analyse", { headers: { Origin: "https://evil.example" }, multipart: { context: "x" } });
  expect(r1.status()).toBe(403);
  const r2 = await request.get("/api/sessions", { headers: { Host: "evil.example" } });
  expect(r2.status()).toBe(403);
});

test("an OpenAI error message never leaks the key", async ({ request }) => {
  await control({ leakKey: true });
  const r = await request.post("/api/analyse", { multipart: { audio: { name: "segment-1.webm", mimeType: "audio/webm", buffer: Buffer.from("x".repeat(2000)) } } });
  const body = await r.text();
  expect(body).toContain("OpenAI rejected the API key");
  expect(body).not.toContain(TEST_KEY);
  expect(body).not.toContain("SECRET");
});

test("unsupported optional parameters are dropped automatically (runs last: changes server state)", async ({ page }) => {
  await control({ rejectParam: "languages[]" });
  await page.goto("/?segmentSec=4");
  await record(page, 4);
  await page.getByRole("button", { name: /Pause & Analyse/ }).click();
  await waitForResult(page);
  const trans = (await mockLog()).filter((l) => l.kind === "transcribe");
  expect(trans.some((l) => l.fields?.includes("languages[]"))).toBe(true); // first try had it
  expect(trans[trans.length - 1].fields).not.toContain("languages[]"); // later ones don't
});
