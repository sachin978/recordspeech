"use client";

import { useState } from "react";
import { streamEvents } from "@/client/stream";
import type { Session } from "@/lib/types";
import { SessionView } from "./SessionView";

export function SessionPage({ initial }: { initial: Session }) {
  const [session, setSession] = useState(initial);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  async function retry() {
    setRetrying(true);
    setError(null);
    try {
      await streamEvents(`/api/sessions/${session.id}/analyse`, null, (e) => {
        if (e.type === "progress") setProgress(e.message);
        else if (e.type === "sentences" || e.type === "result") setSession(e.session);
        else if (e.type === "error") setError(e.message);
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Retry failed.");
    }
    setProgress(null);
    setRetrying(false);
  }

  async function remove() {
    if (!window.confirm("Delete this session from your history? This cannot be undone.")) return;
    const r = await fetch(`/api/sessions/${session.id}`, { method: "DELETE" });
    if (r.ok) window.location.href = "/history";
    else setError("Could not delete the session.");
  }

  return (
    <>
      <div className="row-between page-head">
        <a href="/history">← All sessions</a>
        <button type="button" className="btn danger small" onClick={remove}>
          Delete session
        </button>
      </div>
      {error && <div className="banner bad">{error}</div>}
      {progress && <div className="banner">{progress}</div>}
      <SessionView session={session} live={retrying} onRetry={retry} retrying={retrying} />
    </>
  );
}
