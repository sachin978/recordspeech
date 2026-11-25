"use client";

import type { PipelineEvent } from "@/lib/types";

/** POST and consume an NDJSON stream of pipeline events. */
export async function streamEvents(url: string, body: BodyInit | null, onEvent: (e: PipelineEvent) => void): Promise<void> {
  const res = await fetch(url, { method: "POST", body });
  if (!res.ok || !res.body) {
    let msg = `Request failed (${res.status}).`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) msg = j.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        onEvent(JSON.parse(line) as PipelineEvent);
      } catch {
        /* skip malformed line */
      }
    }
    if (done) break;
  }
}

export { fmtDuration } from "@/lib/format";
