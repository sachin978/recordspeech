"use client";

import { useState } from "react";
import { streamEvents } from "@/client/stream";
import type { Session } from "@/lib/types";
import { applyEvent, initialStages, ProcessingPanel, type Stages } from "./Processing";
import { SessionView } from "./SessionView";
import { Icon } from "./ui/Icon";
import { toast } from "./ui/Toast";

export function SessionPage({ initial }: { initial: Session }) {
  const [session, setSession] = useState(initial);
  const [retrying, setRetrying] = useState(false);
  const [stages, setStages] = useState<Stages | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function retry() {
    setRetrying(true);
    setError(null);
    setStages(initialStages("retry"));
    try {
      await streamEvents(`/api/sessions/${session.id}/analyse`, null, (e) => {
        setStages((st) => (st ? applyEvent(st, e) : st));
        if (e.type === "sentences" || e.type === "result") setSession(e.session);
        if (e.type === "result") toast(e.session.status === "complete" ? "Analysis complete" : "Some parts are still missing", e.session.status === "complete" ? "ok" : "info");
        else if (e.type === "error") setError(e.message);
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Retry failed.");
    }
    setRetrying(false);
  }

  async function remove() {
    if (!window.confirm("Delete this session from your history? This cannot be undone.")) return;
    const r = await fetch(`/api/sessions/${session.id}`, { method: "DELETE" });
    if (r.ok) window.location.href = "/history";
    else toast("Could not delete the session", "bad");
  }

  return (
    <>
      <header className="page-head">
        <div>
          <a href="/history" className="row small" style={{ gap: 6, color: "var(--text-2)" }}>
            ← All sessions
          </a>
          <h1 style={{ marginTop: 8 }}>{session.context || "Free conversation"}</h1>
        </div>
        <div className="row">
          <a href="/" className="btn">
            <Icon name="mic" /> Practise again
          </a>
          <button type="button" className="btn ghost danger" onClick={remove}>
            <Icon name="trash" /> Delete
          </button>
        </div>
      </header>
      {error && (
        <div className="banner bad">
          <Icon name="alert" />
          <div className="grow">{error}</div>
        </div>
      )}
      {retrying && stages && (
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <ProcessingPanel stages={stages} title="Re-running analysis" />
        </div>
      )}
      <div className="session-page">
        <SessionView session={session} live={retrying} onRetry={retry} retrying={retrying} />
      </div>
    </>
  );
}
