"use client";

import type { PipelineEvent } from "@/lib/types";
import { Icon } from "./ui/Icon";

// Processing stages driven ONLY by real server events — a stage is marked done
// when the server reports it, never on a timer.

export type StageKey = "upload" | "transcribe" | "analyse" | "feedback" | "save";
export type StageState = "pending" | "active" | "done" | "failed" | "skipped";
export interface Stage {
  state: StageState;
  detail?: string;
  done?: number;
  total?: number;
}
export type Stages = Record<StageKey, Stage>;

const ORDER: { key: StageKey; label: string }[] = [
  { key: "upload", label: "Processing audio" },
  { key: "transcribe", label: "Converting speech to text" },
  { key: "analyse", label: "Analysing grammar & improving sentences" },
  { key: "feedback", label: "Preparing personalised feedback" },
  { key: "save", label: "Saving to your history" },
];

export function initialStages(kind: "full" | "retry", uploadDetail?: string): Stages {
  return kind === "full"
    ? {
        upload: { state: "active", detail: uploadDetail },
        transcribe: { state: "pending" },
        analyse: { state: "pending" },
        feedback: { state: "pending" },
        save: { state: "pending" },
      }
    : {
        upload: { state: "skipped", detail: "not needed" },
        transcribe: { state: "skipped", detail: "using your saved transcript" },
        analyse: { state: "active" },
        feedback: { state: "active", detail: "runs alongside the sentence analysis" },
        save: { state: "pending" },
      };
}

const finish = (s: Stage): Stage => (s.state === "active" || s.state === "pending" ? { ...s, state: "done" } : s);

/** Pure reducer: next stage states for a pipeline event. */
export function applyEvent(st: Stages, e: PipelineEvent): Stages {
  const s = { ...st };
  switch (e.type) {
    case "progress":
      if (e.stage === "transcribe") {
        s.upload = finish(s.upload);
        s.transcribe = { state: "active", done: e.done, total: e.total, detail: e.total ? `${e.done} of ${e.total} audio parts` : undefined };
      } else if (e.stage === "analyse") {
        const complete = !e.total || e.done === e.total;
        s.analyse = { state: complete ? "done" : "active", done: e.done, total: e.total, detail: e.total ? `${e.done} of ${e.total} sentence groups` : "nothing new to analyse" };
      } else if (e.stage === "feedback") {
        s.feedback = { state: "done" };
      } else if (e.stage === "save") {
        if (s.analyse.state === "active") s.analyse = { ...s.analyse, state: "done" };
        if (s.feedback.state === "active") s.feedback = { state: "failed", detail: "unavailable — you can retry" };
        s.save = { state: "active" };
      }
      return s;
    case "transcribed":
      s.upload = finish(s.upload);
      s.transcribe = { ...finish(s.transcribe), detail: `${e.session.sentences.length} sentences so far` };
      s.analyse = { state: "active" };
      s.feedback = { state: "active", detail: "runs alongside the sentence analysis" };
      return s;
    case "result": {
      s.save = { state: "done" };
      if (e.session.feedbackError) s.feedback = { state: "failed", detail: "unavailable — you can retry" };
      const missing = e.session.sentences.filter((x) => !x.analysis).length;
      if (missing) s.analyse = { ...s.analyse, state: "failed", detail: `${missing} sentence(s) not analysed — you can retry` };
      return s;
    }
    case "error":
      for (const k of Object.keys(s) as StageKey[]) if (s[k].state === "active") s[k] = { ...s[k], state: "failed" };
      return s;
    default:
      return s;
  }
}

export function ProcessingPanel({ stages, title }: { stages: Stages; title: string }) {
  return (
    <div className="processing fade-in" data-testid="progress" aria-live="polite">
      <div className="row-between">
        <h2 className="row" style={{ gap: 10 }}>
          <Icon name="sparkles" size={18} /> {title}
        </h2>
        <span className="muted small">Long recordings are processed in parallel</span>
      </div>
      <ol className="stages">
        {ORDER.map(({ key, label }) => {
          const st = stages[key];
          return (
            <li key={key} className={`stage ${st.state}`} data-stage={key} data-state={st.state}>
              <span className="stage-icon">
                {st.state === "active" ? (
                  <span className="spinner" />
                ) : st.state === "done" ? (
                  <Icon name="check" size={13} strokeWidth={2.4} />
                ) : st.state === "failed" ? (
                  <Icon name="x" size={12} strokeWidth={2.4} />
                ) : st.state === "skipped" ? (
                  <Icon name="minus" size={12} />
                ) : null}
              </span>
              <span>{label}</span>
              <span className="stage-detail">{st.detail}</span>
              {st.state === "active" && st.total ? (
                <div className="progressbar">
                  <div style={{ width: `${Math.round((100 * (st.done ?? 0)) / st.total)}%` }} />
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
