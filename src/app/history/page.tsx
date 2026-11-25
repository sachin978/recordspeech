import { listSessions } from "@/lib/db";
import { fmtDuration } from "@/lib/format";

export const dynamic = "force-dynamic";

const STATUS: Record<string, string> = { complete: "", partial: "Analysis incomplete", failed: "Failed", analysing: "Analysing…", transcribing: "Transcribing…" };

export default function HistoryPage() {
  const sessions = listSessions();
  return (
    <section className="card">
      <h1>Your sessions</h1>
      {sessions.length === 0 && (
        <p className="muted">
          No sessions yet. <a href="/">Record your first one.</a>
        </p>
      )}
      <ul className="history" data-testid="history">
        {sessions.map((s) => (
          <li key={s.id}>
            <a href={`/sessions/${s.id}`}>
              <div className="row-between">
                <strong>{new Date(s.createdAt).toLocaleString()}</strong>
                <span className="muted small">
                  {fmtDuration(s.durationSec)} · {s.sentences} sentences
                  {s.analysedSentences ? ` · ${Math.round((100 * s.grammarOk) / s.analysedSentences)}% without grammar mistakes` : ""}
                  {STATUS[s.status] ? ` · ${STATUS[s.status]}` : ""}
                </span>
              </div>
              {s.context && <div>Topic: {s.context}</div>}
              <div className="muted small">“{s.preview}…”</div>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
