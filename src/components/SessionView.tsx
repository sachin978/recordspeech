"use client";

import { useMemo, useState } from "react";
import { wordDiff, type DiffPiece } from "@/lib/diff";
import { CATEGORY_LABELS, type Sentence, type SentenceAnalysis, type Session, type Span } from "@/lib/types";
import { fmtDuration } from "@/lib/format";

type Mode = "corrected" | "natural";

const VERDICT: Record<SentenceAnalysis["verdict"], { label: string; cls: string }> = {
  incorrect: { label: "Grammar mistake", cls: "badge bad" },
  unnatural: { label: "Could sound more natural", cls: "badge warn" },
  correct: { label: "Correct", cls: "badge ok" },
};

function improvedText(s: Sentence, mode: Mode): string | null {
  if (!s.analysis) return null;
  return mode === "natural" ? (s.analysis.natural ?? s.analysis.corrected) : s.analysis.corrected;
}

/** Render text split into diff pieces, additionally marking uncertain-transcription spans. */
function Marked({ pieces, spans, changedCls }: { pieces: DiffPiece[]; spans: Span[]; changedCls: string }) {
  const out: React.ReactNode[] = [];
  let pos = 0;
  pieces.forEach((p, pi) => {
    const start = pos;
    const end = pos + p.text.length;
    pos = end;
    const cuts = new Set<number>([start, end]);
    for (const [a, b] of spans) {
      if (a > start && a < end) cuts.add(a);
      if (b > start && b < end) cuts.add(b);
    }
    const pts = [...cuts].sort((x, y) => x - y);
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k];
      const b = pts[k + 1];
      const txt = p.text.slice(a - start, b - start);
      const unclear = spans.some(([s, e]) => a >= s && b <= e);
      const cls = [p.changed ? changedCls : "", unclear ? "unclear" : ""].filter(Boolean).join(" ");
      out.push(
        cls ? (
          <span key={`${pi}-${k}`} className={cls} title={unclear ? "Unclear audio — this word may have been mis-heard" : undefined}>
            {txt}
          </span>
        ) : (
          <span key={`${pi}-${k}`}>{txt}</span>
        ),
      );
    }
  });
  return <>{out}</>;
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn small"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard blocked */
        }
      }}
    >
      {done ? "Copied ✓" : label}
    </button>
  );
}

function Comparison({ session, live }: { session: Session; live: boolean }) {
  const [mode, setMode] = useState<Mode>("corrected");
  const rows = useMemo(
    () =>
      session.sentences.map((s) => {
        const imp = improvedText(s, mode);
        const d = imp ? wordDiff(s.text, imp) : null;
        return { s, imp, d };
      }),
    [session.sentences, mode],
  );
  const leftAll = session.sentences.map((s) => s.text).join(" ");
  const rightAll = rows.map((r) => r.imp ?? r.s.text).join(" ");
  let lastPart = 0;

  return (
    <section className="card" id="compare">
      <div className="row-between">
        <h2>Compare</h2>
        <div className="seg" role="group" aria-label="Improved version">
          <button type="button" className={mode === "corrected" ? "on" : ""} onClick={() => setMode("corrected")}>
            Grammar corrected
          </button>
          <button type="button" className={mode === "natural" ? "on" : ""} onClick={() => setMode("natural")}>
            More natural
          </button>
        </div>
      </div>
      <p className="muted small">
        <span className="del">Struck words</span> were changed or removed; <span className="ins">highlighted words</span> are the improvement.{" "}
        <span className="unclear">Dotted words</span> were unclear in the audio.
      </p>
      <div className="cmp-head">
        <div>
          <strong>What I said</strong> <CopyButton text={leftAll} label="Copy" />
        </div>
        <div>
          <strong>Improved English</strong> <CopyButton text={rightAll} label="Copy" />
        </div>
      </div>
      <ol className="cmp" data-testid="comparison">
        {rows.map(({ s, imp, d }) => {
          const showPart = session.parts > 1 && s.part !== lastPart;
          lastPart = s.part;
          const a = s.analysis;
          return (
            <li key={s.idx} className={`cmp-row ${a ? a.verdict : "pending"}`} data-idx={s.idx}>
              {showPart && <div className="part-label">Part {s.part}</div>}
              <div className="cmp-cell left">
                <span className="idx">{s.idx}</span>
                {d ? <Marked pieces={d.left} spans={s.uncertain} changedCls="del" /> : <Marked pieces={[{ text: s.text, changed: false }]} spans={s.uncertain} changedCls="" />}
              </div>
              <div className="cmp-cell right">
                {a && d ? (
                  <>
                    <Marked pieces={d.right} spans={[]} changedCls="ins" />
                    <div className="cmp-meta">
                      <span className={VERDICT[a.verdict].cls}>{VERDICT[a.verdict].label}</span>
                      {a.possibleMistranscription && <span className="badge info">Possibly mis-heard by speech-to-text</span>}
                      {a.note && <span className="note">{a.note}</span>}
                      {a.verdict !== "correct" && (
                        <a className="why" href={`#s-${s.idx}`}>
                          Why?
                        </a>
                      )}
                    </div>
                  </>
                ) : (
                  <span className="muted">{live && session.status === "analysing" ? "Analysing…" : "Not analysed yet"}</span>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function Version({ label, text, cls }: { label: string; text: string | null; cls?: string }) {
  if (!text) return null;
  return (
    <div className={`version ${cls ?? ""}`}>
      <span className="vlabel">{label}</span>
      <span>“{text}”</span>
    </div>
  );
}

function Mistakes({ session }: { session: Session }) {
  const items = session.sentences.filter((s) => s.analysis && s.analysis.verdict !== "correct");
  const repeated = session.stats?.repeatedMistakes ?? [];
  const [showStyle, setShowStyle] = useState(true);
  const visible = showStyle ? items : items.filter((s) => s.analysis!.verdict === "incorrect");
  return (
    <section className="card" id="mistakes">
      <div className="row-between">
        <h2>Understand Your Mistakes</h2>
        <label className="small">
          <input type="checkbox" checked={showStyle} onChange={(e) => setShowStyle(e.target.checked)} /> Include “more natural” tips
        </label>
      </div>
      {repeated.length > 0 && (
        <div className="repeated">
          <h3>Mistakes you made more than once</h3>
          <ul>
            {repeated.map((r, i) => (
              <li key={i}>
                <strong>{r.pattern || CATEGORY_LABELS[r.category]}</strong> <span className="muted">× {r.count}</span>
                {r.examples[0] && (
                  <span className="muted">
                    {" "}
                    — e.g. “{r.examples[0].original}” → “{r.examples[0].corrected}”
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {visible.length === 0 && <p className="muted">{items.length ? "No grammar mistakes — only style tips (tick the box above)." : "No mistakes found in the analysed sentences. Well done!"}</p>}
      <div className="mistake-list">
        {visible.map((s) => {
          const a = s.analysis!;
          return (
            <article key={s.idx} id={`s-${s.idx}`} className={`mcard ${a.verdict}`}>
              <div className="mcard-head">
                <span className="idx">{s.idx}</span>
                <span className={VERDICT[a.verdict].cls}>{VERDICT[a.verdict].label}</span>
                {a.possibleMistranscription && <span className="badge info">Possibly mis-heard — may not be your mistake</span>}
              </div>
              <Version label="What you said" text={s.text} cls="said" />
              {a.verdict === "incorrect" && <Version label="Correct version" text={a.corrected} cls="fixed" />}
              <Version label="More natural" text={a.natural} />
              <Version label="Professional" text={a.professional} />
              <Version label="Shorter / clearer" text={a.clearer} />
              {a.mistakes.length > 0 && (
                <div className="whys">
                  <strong>Why?</strong>
                  <ul>
                    {a.mistakes.map((m, i) => (
                      <li key={i}>
                        {m.original && m.corrected ? (
                          <>
                            <span className="del">{m.original}</span> → <span className="ins">{m.corrected}</span>:{" "}
                          </>
                        ) : null}
                        {m.explanation} <span className="tag">{CATEGORY_LABELS[m.category]}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function Feedback({ session }: { session: Session }) {
  const st = session.stats;
  const fb = session.feedback;
  if (!st) return null;
  const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : 0);
  const minutes = session.durationSec / 60;
  return (
    <section className="card" id="feedback">
      <h2>Speaking Feedback — English</h2>
      {fb ? <p className="lead">{fb.overall}</p> : <p className="muted">{session.feedbackError ? `Session feedback unavailable: ${session.feedbackError}` : "Generating feedback…"}</p>}
      <div className="tiles">
        <div className="tile">
          <div className="big">{st.analysedSentences ? `${pct(st.grammarOk, st.analysedSentences)}%` : "–"}</div>
          <div>Sentences without grammar mistakes</div>
          <div className="basis">
            {st.grammarOk} of {st.analysedSentences} analysed sentences
          </div>
        </div>
        <div className="tile">
          <div className="big">{st.analysedSentences ? `${pct(st.naturalOk, st.analysedSentences)}%` : "–"}</div>
          <div>Correct and natural</div>
          <div className="basis">
            {st.naturalOk} of {st.analysedSentences} needed no change at all
          </div>
        </div>
        <div className="tile">
          <div className="big">{st.fillerTotal}</div>
          <div>Filler words</div>
          <div className="basis">{st.words ? `${((100 * st.fillerTotal) / st.words).toFixed(1)} per 100 words` : ""}</div>
        </div>
        <div className="tile">
          <div className="big">{minutes >= 0.25 ? Math.round(st.words / minutes) : "–"}</div>
          <div>Words per minute</div>
          <div className="basis">
            {st.words} words in {fmtDuration(session.durationSec)}, pauses included
          </div>
        </div>
      </div>

      {fb && fb.strengths.length > 0 && (
        <>
          <h3>What you did well</h3>
          <ul>
            {fb.strengths.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </>
      )}

      {fb && fb.topAreas.length > 0 && (
        <>
          <h3>Top {fb.topAreas.length} areas to improve</h3>
          <ol className="areas">
            {fb.topAreas.map((a, i) => (
              <li key={i}>
                <strong>{a.area}</strong> — {a.why}
                {a.example && <div className="muted">You said: “{a.example}”</div>}
                <div>
                  <em>Tip:</em> {a.tip}
                </div>
              </li>
            ))}
          </ol>
        </>
      )}

      {st.categories.length > 0 && (
        <>
          <h3>Mistakes by type</h3>
          <ul className="inline-list">
            {st.categories.map((c) => (
              <li key={c.category}>
                {CATEGORY_LABELS[c.category]} <strong>{c.count}</strong>
              </li>
            ))}
          </ul>
        </>
      )}

      {(st.fillers.length > 0 || st.overused.length > 0 || st.repetitions.length > 0) && (
        <>
          <h3>Fillers and repetition</h3>
          {st.fillers.length > 0 && (
            <p>
              Fillers:{" "}
              {st.fillers.map((f, i) => (
                <span key={f.word}>
                  {i ? ", " : ""}“{f.word}” × {f.count}
                </span>
              ))}
            </p>
          )}
          {st.overused.length > 0 && (
            <p>
              Words you used a lot:{" "}
              {st.overused.map((f, i) => (
                <span key={f.word}>
                  {i ? ", " : ""}“{f.word}” × {f.count}
                </span>
              ))}
            </p>
          )}
          {st.repetitions.length > 0 && (
            <p>
              Repeated words (stumbles):{" "}
              {st.repetitions.map((f, i) => (
                <span key={f.text}>
                  {i ? ", " : ""}“{f.text}”{f.count > 1 ? ` × ${f.count}` : ""}
                </span>
              ))}
            </p>
          )}
          <p className="muted small">Counted directly from the transcript. “Um/uh” may be under-counted because speech-to-text often leaves them out.</p>
        </>
      )}

      {fb && fb.vocabulary.length > 0 && (
        <>
          <h3>Better vocabulary</h3>
          <ul>
            {fb.vocabulary.map((v, i) => (
              <li key={i}>
                Instead of <span className="del">{v.insteadOf}</span>, try <span className="ins">{v.tryInstead}</span>
                {v.example && <span className="muted"> — “{v.example}”</span>}
              </li>
            ))}
          </ul>
        </>
      )}

      {fb && fb.recommendations.length > 0 && (
        <>
          <h3>For your next session</h3>
          <ol>
            {fb.recommendations.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ol>
        </>
      )}
      <p className="muted small">Pronunciation, accent and confidence are not assessed — the analysis works from the transcript only.</p>
    </section>
  );
}

function Communication({ session }: { session: Session }) {
  const c = session.feedback?.communication;
  const better = session.sentences.filter((s) => s.analysis?.contextual);
  if (!c && !better.length) return null;
  return (
    <section className="card" id="communication">
      <h2>How Well You Explained It{session.context ? `: ${session.context}` : ""}</h2>
      <p className="muted small">This is about your explanation (ideas, order, terminology) — separate from English mistakes above.</p>
      {c && (
        <dl className="comm">
          <dt>Clarity</dt>
          <dd>{c.clarity}</dd>
          <dt>Main idea</dt>
          <dd>{c.mainIdea}</dd>
          {c.missingConnections.length > 0 && (
            <>
              <dt>Missing links</dt>
              <dd>
                <ul>
                  {c.missingConnections.map((m, i) => (
                    <li key={i}>{m}</li>
                  ))}
                </ul>
              </dd>
            </>
          )}
          <dt>Terminology</dt>
          <dd>{c.terminology}</dd>
          <dt>Structure</dt>
          <dd>{c.structure}</dd>
          <dt>Next time, try</dt>
          <dd className="say">{c.sayNextTime}</dd>
        </dl>
      )}
      {better.length > 0 && (
        <>
          <h3>Better ways to explain it</h3>
          <div className="mistake-list">
            {better.map((s) => (
              <article key={s.idx} className="mcard context">
                <Version label="What you said" text={s.text} cls="said" />
                <Version label="Better explanation" text={s.analysis!.contextual} cls="fixed" />
                {s.analysis!.contextualWhy.length > 0 && (
                  <ul>
                    {s.analysis!.contextualWhy.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                )}
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

export function SessionView({ session, live = false, onRetry, retrying }: { session: Session; live?: boolean; onRetry?: () => void; retrying?: boolean }) {
  // "analysing" while nobody is streaming it means the server stopped mid-way (e.g. restarted) → offer retry
  const needsRetry = session.status === "partial" || session.status === "failed" || (!live && (session.status === "analysing" || !session.feedback));
  return (
    <div className="session" data-testid="session-view" data-status={session.status}>
      <div className="session-head">
        <div>
          <strong>{new Date(session.createdAt).toLocaleString()}</strong> · {fmtDuration(session.durationSec)} · {session.sentences.length} sentences
          {session.context && (
            <div className="muted">
              Topic: {session.context} <span className="tag">{session.contextType}</span>
            </div>
          )}
        </div>
        <nav className="jump small">
          <a href="#compare">Compare</a> · <a href="#mistakes">Mistakes</a> · <a href="#feedback">Feedback</a>
          {session.feedback || session.sentences.some((s) => s.analysis?.contextual) ? (
            <>
              {" "}
              · <a href="#communication">Explanation</a>
            </>
          ) : null}
        </nav>
      </div>
      {session.error && session.status !== "analysing" && (
        <div className="banner warn" role="alert">
          Analysis incomplete: {session.error}. Your transcript is saved.
        </div>
      )}
      {needsRetry && onRetry && (
        <div className="banner">
          <button type="button" className="btn" onClick={onRetry} disabled={retrying}>
            {retrying ? "Retrying…" : "Retry analysis"}
          </button>{" "}
          <span className="muted small">Re-runs only the missing parts using the saved transcript (no audio needed).</span>
        </div>
      )}
      <Comparison session={session} live={live} />
      {session.status !== "analysing" || session.sentences.some((s) => s.analysis) ? <Mistakes session={session} /> : null}
      <Feedback session={session} />
      <Communication session={session} />
      {session.audioFiles.length > 0 && (
        <section className="card">
          <h2>Your recording</h2>
          {session.audioFiles.map((f) => (
            <audio key={f} controls preload="none" src={`/api/sessions/${session.id}/audio/${f}`} />
          ))}
        </section>
      )}
    </div>
  );
}
