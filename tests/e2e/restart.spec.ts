import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { DATA_DIR, MOCK, TEST_KEY } from "./env";

// Learning history survives an app restart: start a second server process on the
// same data directory, create a session, kill the process, start it again, read it back.

const PORT = 3212;
const BASE = `http://127.0.0.1:${PORT}`;

function startServer(): ChildProcess {
  return spawn("npx", ["next", "start", "-H", "127.0.0.1", "-p", String(PORT)], {
    env: { ...process.env, OPENAI_API_KEY: TEST_KEY, OPENAI_BASE_URL: `${MOCK}/v1`, DATA_DIR },
    stdio: "ignore",
    detached: true,
  });
}

async function waitUp() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server did not start");
}

function kill(p: ChildProcess) {
  try {
    process.kill(-p.pid!, "SIGKILL"); // kill the whole process group, like a crash
  } catch {
    /* already gone */
  }
}

test("saved sessions survive a server restart", async () => {
  await fetch(`${MOCK}/__reset`, { method: "POST" });
  let server = startServer();
  try {
    await waitUp();
    const form = new FormData();
    form.append("audio", new Blob([new Uint8Array(4000)], { type: "audio/webm" }), "segment-1.webm");
    form.append("context", "Restart check topic");
    form.append("durationSec", "42");
    const text = await (await fetch(`${BASE}/api/analyse`, { method: "POST", body: form })).text();
    const result = text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .find((e) => e.type === "result");
    expect(result).toBeTruthy();
    const id = result.session.id as string;

    kill(server);
    await new Promise((r) => setTimeout(r, 500));
    server = startServer();
    await waitUp();

    const s = (await (await fetch(`${BASE}/api/sessions/${id}`)).json()).session;
    expect(s.context).toBe("Restart check topic");
    expect(s.durationSec).toBe(42);
    expect(s.sentences[0].text).toBe("I am working here since two years.");
    expect(s.sentences[0].analysis.corrected).toBe("I have been working here for two years.");
    expect(s.feedback.overall).toBeTruthy();
    const list = (await (await fetch(`${BASE}/api/sessions`)).json()).sessions;
    expect(list.some((x: { id: string }) => x.id === id)).toBe(true);
  } finally {
    kill(server);
  }
});
