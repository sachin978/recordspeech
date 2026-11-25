"use client";

import { fmtDuration } from "@/lib/format";
import type { Progress, Trend } from "@/lib/progress";
import { BarChart } from "./ui/BarChart";
import { EmptyState } from "./ui/Empty";
import { Icon, type IconName } from "./ui/Icon";

const TREND: Record<Trend, { label: string; cls: string; icon: IconName }> = {
  improving: { label: "Less frequent", cls: "pill ok", icon: "trendDown" },
  worse: { label: "More frequent", cls: "pill bad", icon: "trendUp" },
  steady: { label: "About the same", cls: "pill", icon: "minus" },
  "not-enough-data": { label: "Need 4+ sessions", cls: "pill", icon: "clock" },
};

const shortDate = (iso: string) => new Date(iso).toLocaleDateString([], { day: "numeric", month: "short" });

function Spark({ values }: { values: (number | null)[] }) {
  const max = Math.max(0.0001, ...values.filter((v): v is number => v !== null));
  const w = 6;
  const h = 22;
  return (
    <svg className="spark" width={values.length * (w + 2)} height={h} role="img" aria-label="per-session rate, oldest to newest">
      {values.map((v, i) => {
        const bh = v === null ? 0 : Math.max(v > 0 ? 2 : 0, (v / max) * h);
        return <rect key={i} x={i * (w + 2)} y={h - bh} width={w} height={bh} rx={1.5} />;
      })}
    </svg>
  );
}

export function ProgressView({ p }: { p: Progress }) {
  const recent = p.sessions.slice(-12);
  const improving = p.categories.filter((c) => c.trend === "improving");

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Your progress</h1>
          <p>Which mistakes keep coming back — and which ones are fading away.</p>
        </div>
      </header>

      <div className="tiles" style={{ marginBottom: 20 }}>
        <div className="tile">
          <div className="v">{p.sessionCount}</div>
          <div className="k">Sessions</div>
          <div className="b">{p.thisWeekSessions} this week</div>
        </div>
        <div className="tile">
          <div className="v">{fmtDuration(p.totalSeconds)}</div>
          <div className="k">Time spent speaking</div>
          <div className="b">{p.totalSentences} sentences analysed</div>
        </div>
        <div className="tile">
          <div className="v">
            {p.streakDays} <span className="small muted">day{p.streakDays === 1 ? "" : "s"}</span>
          </div>
          <div className="k">Practice streak</div>
          <div className="b">Days in a row with a session</div>
        </div>
        <div className="tile">
          <div className="v">{recent.length ? `${recent[recent.length - 1].accuracyPct ?? "–"}%` : "–"}</div>
          <div className="k">Latest grammar accuracy</div>
          <div className="b">Sentences with no grammar mistakes</div>
        </div>
      </div>

      {p.sessions.length === 0 ? (
        <div className="card">
          <EmptyState
            icon="chart"
            title="Your progress will appear here"
            action={
              <a href="/" className="btn primary">
                <Icon name="mic" /> Start practising
              </a>
            }
          >
            Analyse a few sessions and we&apos;ll show your recurring mistakes and whether they&apos;re becoming less frequent.
          </EmptyState>
        </div>
      ) : (
        <div className="stack" style={{ gap: 20 }}>
          <section className="card">
            <div className="card-head">
              <h2>
                <Icon name="sparkles" size={18} /> What we noticed
              </h2>
            </div>
            {p.insights.length ? (
              <ul className="insights" data-testid="insights">
                {p.insights.map((t, i) => (
                  <li key={i}>
                    <Icon name={/less frequent|improving|fewer/.test(t) ? "trendDown" : /increased|dropped/.test(t) ? "trendUp" : "repeat"} />
                    <span>{t}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-2">No clear patterns yet — keep practising and check back after a few more sessions.</p>
            )}
            {improving.length > 0 && (
              <div className="row" style={{ marginTop: 14 }}>
                <span className="small muted">Becoming less frequent:</span>
                {improving.map((c) => (
                  <span key={c.category} className="pill ok">
                    <Icon name="trendDown" /> {c.label}
                  </span>
                ))}
              </div>
            )}
          </section>

          <div className="charts">
            <section className="card chart-card">
              <BarChart
                title="Practice frequency"
                subtitle="Sessions per week, last 8 weeks"
                data={p.weekly.map((w) => ({ label: shortDate(w.weekStart), value: w.sessions, tip: `Week of ${shortDate(w.weekStart)} · ${w.minutes} min` }))}
                format={(v) => String(Math.round(v))}
              />
            </section>
            <section className="card chart-card">
              <BarChart
                title="Grammar accuracy"
                subtitle={`Sentences without grammar mistakes · last ${recent.length} sessions`}
                max={100}
                data={recent.map((s) => ({ label: shortDate(s.createdAt), value: s.accuracyPct, tip: `${shortDate(s.createdAt)} · ${s.sentences} sentences${s.context ? ` · ${s.context}` : ""}` }))}
                format={(v) => `${Math.round(v)}%`}
              />
            </section>
            <section className="card chart-card">
              <BarChart
                title="Filler words"
                subtitle={`Per 100 words · last ${recent.length} sessions · lower is better`}
                data={recent.map((s) => ({ label: shortDate(s.createdAt), value: s.fillersPer100, tip: `${shortDate(s.createdAt)}${s.context ? ` · ${s.context}` : ""}` }))}
                format={(v) => v.toFixed(1)}
                emptyNote="No filler words counted in these sessions."
              />
            </section>
            <section className="card chart-card">
              <BarChart
                title="Sentence construction"
                subtitle="Structure & word-order issues per 10 sentences · lower is better"
                data={p.construction.rates.slice(-12).map((r, i) => {
                  const s = p.sessions.slice(-12)[i];
                  return { label: shortDate(s.createdAt), value: r * 10, tip: `${shortDate(s.createdAt)}${s.context ? ` · ${s.context}` : ""}` };
                })}
                format={(v) => v.toFixed(1)}
                emptyNote="No sentence-construction issues in these sessions."
              />
              <div className="row" style={{ marginTop: 10 }}>
                <span className={TREND[p.construction.trend].cls}>
                  <Icon name={TREND[p.construction.trend].icon} /> {p.construction.trend === "improving" ? "Improving" : TREND[p.construction.trend].label}
                </span>
              </div>
            </section>
          </div>

          {p.categories.length > 0 && (
            <section className="card">
              <div className="card-head">
                <h2>
                  <Icon name="target" size={18} /> Recurring mistake types
                </h2>
              </div>
              <p className="small muted" style={{ marginBottom: 10 }}>
                Rate = mistakes per 10 analysed sentences, so long and short sessions compare fairly. The trend compares your older sessions with your newer ones.
              </p>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Mistake type</th>
                      <th>Total</th>
                      <th>Sessions</th>
                      <th>Earlier → recent</th>
                      <th>Trend</th>
                      <th>Per session</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.categories.map((c) => (
                      <tr key={c.category}>
                        <td>{c.label}</td>
                        <td className="num">{c.total}</td>
                        <td className="num">
                          {c.sessionsWithIt} / {p.sessions.length}
                        </td>
                        <td className="num">
                          {c.earlierRate === null ? "–" : (c.earlierRate * 10).toFixed(1)} → {c.recentRate === null ? "–" : (c.recentRate * 10).toFixed(1)}
                        </td>
                        <td>
                          <span className={TREND[c.trend].cls}>
                            <Icon name={TREND[c.trend].icon} /> {TREND[c.trend].label}
                          </span>
                        </td>
                        <td>
                          <Spark values={c.rates} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {p.patterns.length > 0 && (
            <section className="card">
              <div className="card-head">
                <h2>
                  <Icon name="repeat" size={18} /> Specific mistakes you repeat
                </h2>
              </div>
              <div className="table-wrap">
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
                        <td className="num">{x.count}</td>
                        <td className="num">{x.sessions}</td>
                        <td>{shortDate(x.lastSeen)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <section className="card">
            <div className="card-head">
              <h2>
                <Icon name="history" size={18} /> Recent sessions
              </h2>
              <a href="/history" className="small">
                View all →
              </a>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Topic</th>
                    <th>Sentences</th>
                    <th>Grammar accuracy</th>
                    <th>Fillers / 100 words</th>
                  </tr>
                </thead>
                <tbody>
                  {[...recent].reverse().map((s) => (
                    <tr key={s.id}>
                      <td>
                        <a href={`/sessions/${s.id}`}>{shortDate(s.createdAt)}</a>
                      </td>
                      <td>{s.context || <span className="muted">Free conversation</span>}</td>
                      <td className="num">{s.sentences}</td>
                      <td className="num">{s.accuracyPct === null ? "–" : `${s.accuracyPct}%`}</td>
                      <td className="num">{s.fillersPer100 ?? "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
