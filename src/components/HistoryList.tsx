"use client";

import { useMemo, useState } from "react";
import { fmtDuration } from "@/lib/format";
import type { SessionSummary } from "@/lib/types";
import { EmptyState } from "./ui/Empty";
import { Icon } from "./ui/Icon";

type Filter = "all" | "topic" | "free" | "attention";

const STATUS: Record<string, { label: string; cls: string } | undefined> = {
  partial: { label: "Analysis incomplete", cls: "pill warn" },
  failed: { label: "Failed", cls: "pill bad" },
  analysing: { label: "Not finished", cls: "pill warn" },
  transcribing: { label: "Not finished", cls: "pill warn" },
};

function day(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date();
  y.setDate(today.getDate() - 1);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (same(d, today)) return `Today, ${time}`;
  if (same(d, y)) return `Yesterday, ${time}`;
  return `${d.toLocaleDateString([], { day: "numeric", month: "short", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" })}, ${time}`;
}

export function HistoryList({ sessions }: { sessions: SessionSummary[] }) {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return sessions.filter((s) => {
      if (filter === "topic" && !s.context) return false;
      if (filter === "free" && s.context) return false;
      if (filter === "attention" && !STATUS[s.status]) return false;
      if (!needle) return true;
      return `${s.context} ${s.preview} ${s.topMistake ?? ""}`.toLowerCase().includes(needle);
    });
  }, [sessions, q, filter]);

  if (!sessions.length)
    return (
      <div className="card">
        <EmptyState
          icon="mic"
          title="No sessions yet"
          action={
            <a href="/" className="btn primary">
              <Icon name="mic" /> Record your first session
            </a>
          }
        >
          Speak about anything for a minute or two, then press Pause &amp; Analyse. Your sessions will appear here.
        </EmptyState>
      </div>
    );

  const attention = sessions.filter((s) => STATUS[s.status]).length;
  return (
    <>
      <div className="toolbar">
        <div className="input-wrap">
          <Icon name="search" />
          <input className="input" type="search" placeholder="Search topics, sentences or mistakes…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search sessions" />
        </div>
        <div className="seg" role="group" aria-label="Filter sessions">
          {(
            [
              ["all", `All (${sessions.length})`],
              ["topic", "With a topic"],
              ["free", "Free talk"],
              ...(attention ? [["attention", `Needs attention (${attention})`]] : []),
            ] as [Filter, string][]
          ).map(([k, label]) => (
            <button key={k} type="button" className={filter === k ? "on" : ""} aria-pressed={filter === k} onClick={() => setFilter(k)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {shown.length === 0 ? (
        <div className="card">
          <EmptyState icon="search" title="No matching sessions">
            Try a different search or filter.
          </EmptyState>
        </div>
      ) : (
        <ul className="hlist" data-testid="history">
          {shown.map((s) => (
            <li key={s.id}>
              <a href={`/sessions/${s.id}`} className="hitem">
                <h3>{s.context || "Free conversation"}</h3>
                <div className="hmeta">
                  <span className="row" style={{ gap: 5 }}>
                    <Icon name="calendar" size={13} /> {day(s.createdAt)}
                  </span>
                  <span className="row" style={{ gap: 5 }}>
                    <Icon name="clock" size={13} /> {fmtDuration(s.durationSec)}
                  </span>
                  {s.topMistake && (
                    <span className="pill" title="Main recurring mistake">
                      <Icon name="repeat" /> {s.topMistake}
                    </span>
                  )}
                  {STATUS[s.status] && <span className={STATUS[s.status]!.cls}>{STATUS[s.status]!.label}</span>}
                </div>
                <div className="preview">“{s.preview}”</div>
                <div className="hstats">
                  <div className="hstat">
                    <div className="v">{s.sentences}</div>
                    <div className="k">sentences</div>
                  </div>
                  <div className="hstat">
                    <div className="v">{s.mistakes}</div>
                    <div className="k">corrections</div>
                  </div>
                  <div className="hstat">
                    <div className="v">{s.analysedSentences ? `${Math.round((100 * s.grammarOk) / s.analysedSentences)}%` : "–"}</div>
                    <div className="k">grammar OK</div>
                  </div>
                  <Icon name="chevron" className="muted" />
                </div>
              </a>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
