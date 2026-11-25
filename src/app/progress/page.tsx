import { progressData } from "@/lib/db";
import { computeProgress, type Trend } from "@/lib/progress";

export const dynamic = "force-dynamic";

const TREND: Record<Trend, { label: string; cls: string }> = {
  improving: { label: "↓ less frequent", cls: "badge ok" },
  worse: { label: "↑ more frequent", cls: "badge bad" },
  steady: { label: "→ about the same", cls: "badge" },
  "not-enough-data": { label: "need 3+ sessions", cls: "badge muted" },
};

/** Tiny inline bar chart: one bar per session, oldest → newest. */
function Bars({ values, max }: { values: (number | null)[]; max: number }) {
  const w = 8;
  const h = 24;
  return (
    <svg width={values.length * (w + 2)} height={h} role="img" aria-label="per-session trend">
      {values.map((v, i) => {
        const bh = v === null || max === 0 ? 0 : Math.max(1, (v / max) * h);
        return <rect key={i} x={i * (w + 2)} y={h - bh} width={w} height={bh} className="spark" />;
      })}
    </svg>
  );
}

export default function ProgressPage() {
  const { sessions, mistakes } = progressData();
  const p = computeProgress(sessions, mistakes);
  const maxRate = Math.max(0.0001, ...p.categories.flatMap((c) => c.rates.filter((r): r is number => r !== null)));
  const recent = p.sessions.slice(-12);
  return (
    <>
      <section className="card">
        <h1>Your progress</h1>
        <p className="muted">
          {p.sessionCount} sessions · {p.totalMinutes} minutes of speaking · {p.totalSentences} sentences analysed
        </p>
        {p.sessions.length === 0 ? (
          <p>Record and analyse a few sessions to see patterns here.</p>
        ) : (
          <>
            <h2>What we noticed</h2>
            {p.insights.length ? (
              <ul data-testid="insights">
                {p.insights.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ul>
            ) : (
              <p className="muted">No clear patterns yet — keep practising and check back after a few more sessions.</p>
            )}
          </>
        )}
      </section>

      {p.categories.length > 0 && (
        <section className="card">
          <h2>Recurring mistake types</h2>
          <p className="muted small">
            Rate = mistakes per 10 analysed sentences, so long and short sessions compare fairly. Trend compares your older sessions with your more recent ones.
          </p>
          <table className="table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Total</th>
                <th>Sessions</th>
                <th>Earlier → recent rate</th>
                <th>Trend</th>
                <th>Per session</th>
              </tr>
            </thead>
            <tbody>
              {p.categories.map((c) => (
                <tr key={c.category}>
                  <td>{c.label}</td>
                  <td>{c.total}</td>
                  <td>
                    {c.sessionsWithIt} / {p.sessions.length}
                  </td>
                  <td>
                    {c.earlierRate === null ? "–" : (c.earlierRate * 10).toFixed(1)} → {c.recentRate === null ? "–" : (c.recentRate * 10).toFixed(1)}
                  </td>
                  <td>
                    <span className={TREND[c.trend].cls}>{TREND[c.trend].label}</span>
                  </td>
                  <td>
                    <Bars values={c.rates} max={maxRate} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {p.patterns.length > 0 && (
        <section className="card">
          <h2>Specific mistakes you repeat</h2>
          <table className="table">
            <thead>
              <tr>
                <th>Pattern</th>
                <th>Latest example</th>
                <th>Times</th>
                <th>Sessions</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {p.patterns.map((x, i) => (
                <tr key={i}>
                  <td>{x.pattern}</td>
                  <td>
                    <span className="del">{x.example.original}</span> → <span className="ins">{x.example.corrected}</span>
                  </td>
                  <td>{x.count}</td>
                  <td>{x.sessions}</td>
                  <td>{new Date(x.lastSeen).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {recent.length > 0 && (
        <section className="card">
          <h2>Recent sessions</h2>
          <p className="muted small">
            Accuracy = share of analysed sentences with no grammar mistakes. Accuracy trend: <span className={TREND[p.accuracyTrend].cls}>{p.accuracyTrend === "improving" ? "↑ improving" : p.accuracyTrend === "worse" ? "↓ dropping" : TREND[p.accuracyTrend].label}</span>
          </p>
          <table className="table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Topic</th>
                <th>Sentences</th>
                <th>Accuracy</th>
                <th>Fillers / 100 words</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((s) => (
                <tr key={s.id}>
                  <td>
                    <a href={`/sessions/${s.id}`}>{new Date(s.createdAt).toLocaleDateString()}</a>
                  </td>
                  <td>{s.context || <span className="muted">—</span>}</td>
                  <td>{s.sentences}</td>
                  <td>{s.accuracyPct === null ? "–" : `${s.accuracyPct}%`}</td>
                  <td>{s.fillersPer100 ?? "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
