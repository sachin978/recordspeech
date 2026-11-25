"use client";

import { useEffect, useMemo, useState } from "react";
import { getPrefs } from "@/client/prefs";
import { wordDiff, type DiffPiece } from "@/lib/diff";
import { fmtDuration } from "@/lib/format";
import { CATEGORY_LABELS, type MistakeCategory, type Sentence, type SentenceAnalysis, type Session, type Span } from "@/lib/types";
import { Icon, type IconName } from "./ui/Icon";
import { toast } from "./ui/Toast";

type Mode = "corrected" | "natural";

const VERDICT: Record<SentenceAnalysis["verdict"], { label: string; cls: string; icon: IconName }> = {
  incorrect: { label: "Grammar mistake", cls: "pill bad", icon: "x" },
  unnatural: { label: "Could sound more natural", cls: "pill warn", icon: "sparkles" },
  correct: { label: "Correct", cls: "pill ok", icon: "check" },
};

function improvedText(s: Sentence, mode: Mode): string | null {
  if (!s.analysis) return null;
  return mode === "natural" ? (s.analysis.natural ?? s.analysis.corrected) : s.analysis.corrected;
}

/** Text split into diff pieces, with unclear-transcription spans marked on top. */
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
        unclear ? (
          <span key={`${pi}-${k}`} className={cls} tabIndex={0} data-tip="Unclear audio — this word may have been mis-heard" aria-label={`${txt} (unclear audio)`}>
            {txt}
          </span>
        ) : cls ? (
          <span key={`${pi}-${k}`} className={cls}>
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

async function copyText(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied to clipboard`);
  } catch {
    toast("Your browser blocked clipboard access", "bad");
  }
}

const smooth = (): ScrollBehavior => (window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");

// ---------------------------------------------------------------- summary

function Summary({ session }: { session: Session }) {
  const analysed = session.sentences.filter((s) => s.analysis && !s.analysis.possibleMistranscription);
  const grammarMistakes = analysed.reduce((n, s) => n + s.analysis!.mistakes.filter((m) => m.kind === "grammar").length, 0);
  const tips = analysed.filter((s) => {
    const a = s.analysis!;
    return a.verdict === "unnatural" || !!(a.natural || a.clearer || a.professional || a.contextual);
  }).length;
  return (
    <div className="summary" data-testid="summary">
      <div>
        <div className="k">
          <Icon name="message" size={13} /> Topic
        </div>
        <div className="v topic-v">{session.context || <span className="muted">Free conversation</span>}</div>
        <div className="xs muted" style={{ marginTop: 4 }}>
          {new Date(session.createdAt).toLocaleString()}
          {session.context ? (
            <span className="tag" style={{ marginLeft: 8 }}>
              {session.contextType}
            </span>
          ) : null}
        </div>
      </div>
      <div>
        <div className="k">
          <Icon name="clock" size={13} /> Duration
        </div>
        <div className="v">{fmtDuration(session.durationSec)}</div>
      </div>
      <div>
        <div className="k">
          <Icon name="text" size={13} /> Sentences
        </div>
        <div className="v">{session.sentences.length}</div>
      </div>
      <div>
        <div className="k" tabIndex={0} data-tip="Individual grammar errors (tense, articles, prepositions…). Sentences that may have been mis-heard are not counted.">
          <Icon name="alert" size={13} /> Grammar mistakes
        </div>
        <div className={`v ${grammarMistakes ? "bad" : ""}`}>{analysed.length ? grammarMistakes : "–"}</div>
      </div>
      <div>
        <div className="k" tabIndex={0} data-tip="Sentences with a more natural, clearer, professional or better-explained alternative.">
          <Icon name="sparkles" size={13} /> Improvement tips
        </div>
        <div className={`v ${tips ? "warn" : ""}`}>{analysed.length ? tips : "–"}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- comparison

function Detail({ s, id }: { s: Sentence; id: string }) {
  const a = s.analysis!;
  return (
    <div className="detail" id={id}>
      {a.possibleMistranscription && (
        <div className="banner" style={{ margin: 0 }}>
          <Icon name="info" />
          <div className="grow">Speech-to-text may have mis-heard part of this sentence, so these suggestions may not reflect a real mistake. It isn&apos;t counted in your statistics.</div>
        </div>
      )}
      {a.verdict === "correct" && !a.professional && !a.contextual ? (
        <p className="row text-2">
          <Icon name="check" /> This sentence is correct and natural — nothing to change.
        </p>
      ) : null}
      {a.verdict === "incorrect" && (
        <div className="dblock">
          <div className="dlabel">
            <span className="tag grammar">Grammar</span>Correct version
          </div>
          <div className="quote strong">{a.corrected}</div>
        </div>
      )}
      {a.note && (
        <div className="dblock">
          <div className="dlabel">What was wrong</div>
          <div>{a.note}</div>
        </div>
      )}
      {a.mistakes.length > 0 && (
        <div className="dblock">
          <div className="dlabel">Why</div>
          <ul className="why-list">
            {a.mistakes.map((m, i) => (
              <li key={i}>
                <div className="fix">
                  {m.original && <span className="del">{m.original}</span>}
                  {m.original && m.corrected ? " → " : null}
                  {m.corrected && <span className="ins">{m.corrected}</span>} <span className={`tag ${m.kind === "grammar" ? "grammar" : "natural"}`}>{CATEGORY_LABELS[m.category]}</span>
                </div>
                <div className="ex">{m.explanation}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {(a.natural || a.clearer || a.professional) && <div className="detail-sep" />}
      {a.natural && (
        <div className="dblock">
          <div className="dlabel">
            <span className="tag natural">Natural English</span>How a fluent speaker says it
          </div>
          <div className="quote">“{a.natural}”</div>
        </div>
      )}
      {a.clearer && (
        <div className="dblock">
          <div className="dlabel">
            <span className="tag natural">Clearer</span>Shorter version
          </div>
          <div className="quote">“{a.clearer}”</div>
        </div>
      )}
      {a.professional && (
        <div className="dblock">
          <div className="dlabel">
            <span className="tag pro">Professional</span>At work or in an interview
          </div>
          <div className="quote">“{a.professional}”</div>
        </div>
      )}
      {a.contextual && (
        <>
          <div className="detail-sep" />
          <div className="dblock">
            <div className="dlabel">
              <span className="tag context">Context</span>Better way to explain it
            </div>
            <div>
              <div className="quote">“{a.contextual}”</div>
              {a.contextualWhy.length > 0 && (
                <ul className="small text-2" style={{ marginTop: 6 }}>
                  {a.contextualWhy.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Comparison({ session, live, open, toggle }: { session: Session; live: boolean; open: Set<number>; toggle: (idx: number) => void }) {
  const [mode, setMode] = useState<Mode>("corrected");
  useEffect(() => setMode(getPrefs().view), []);
  const rows = useMemo(
    () =>
      session.sentences.map((s) => {
        const imp = improvedText(s, mode);
        return { s, imp, d: imp ? wordDiff(s.text, imp) : null };
      }),
    [session.sentences, mode],
  );
  const leftAll = session.sentences.map((s) => s.text).join(" ");
  const rightAll = rows.map((r) => r.imp ?? r.s.text).join(" ");
  let lastPart = 0;

  return (
    <section className="card" id="compare">
      <div className="card-head">
        <h2>
          <Icon name="text" size={18} /> Original speech vs improved English
        </h2>
        <div className="seg" role="group" aria-label="Improved version">
          <button type="button" className={mode === "corrected" ? "on" : ""} aria-pressed={mode === "corrected"} onClick={() => setMode("corrected")}>
            Grammar corrected
          </button>
          <button type="button" className={mode === "natural" ? "on" : ""} aria-pressed={mode === "natural"} onClick={() => setMode("natural")}>
            More natural
          </button>
        </div>
      </div>
      <div className="legend">
        <span>
          <span className="del">struck</span> what you said
        </span>
        <span>
          <span className="ins">highlighted</span> what to say instead
        </span>
        <span>
          <span className="unclear">dotted</span> unclear audio
        </span>
        <span className="muted">Click any sentence to see why.</span>
      </div>
      <div className="cmp">
        <div className="cmp-head">
          <div className="said-h">
            <span>What you said</span>
            <button type="button" className="btn ghost sm" onClick={() => copyText(leftAll, "What you said")}>
              <Icon name="copy" size={14} /> Copy
            </button>
          </div>
          <div className="imp-h">
            <span>
              <Icon name="sparkles" /> Improved English
            </span>
            <button type="button" className="btn ghost sm" onClick={() => copyText(rightAll, "Improved English")}>
              <Icon name="copy" size={14} /> Copy
            </button>
          </div>
        </div>
        <ol className="cmp-list" data-testid="comparison">
          {rows.map(({ s, d }) => {
            const showPart = session.parts > 1 && s.part !== lastPart;
            lastPart = s.part;
            const a = s.analysis;
            const isOpen = open.has(s.idx);
            const detailId = `detail-${s.idx}`;
            const onRow = () => {
              if (!a || window.getSelection()?.toString()) return; // don't toggle while selecting text
              toggle(s.idx);
            };
            return (
              <li key={s.idx} id={`s-${s.idx}`} className={`cmp-row ${a ? a.verdict : "pending"} ${isOpen ? "open" : ""}`} data-idx={s.idx}>
                {showPart && <div className="part-label">Part {s.part}</div>}
                <div className="cmp-main" onClick={onRow}>
                  <div className="cmp-cell left">
                    <span className="idx">{s.idx}</span>
                    <div>
                      <span className="mobile-label">What you said</span>
                      {d ? <Marked pieces={d.left} spans={s.uncertain} changedCls="del" /> : <Marked pieces={[{ text: s.text, changed: false }]} spans={s.uncertain} changedCls="" />}
                    </div>
                  </div>
                  <div className="cmp-cell right">
                    <span className="mobile-label">Improved English</span>
                    {a && d ? (
                      <>
                        <Marked pieces={d.right} spans={[]} changedCls="ins" />
                        <div className="cmp-meta">
                          <span className={VERDICT[a.verdict].cls}>
                            <Icon name={VERDICT[a.verdict].icon} /> {VERDICT[a.verdict].label}
                          </span>
                          {a.contextual && (
                            <span className="pill info">
                              <Icon name="bulb" /> Explanation tip
                            </span>
                          )}
                          {a.possibleMistranscription && <span className="pill info">Possibly mis-heard</span>}
                          {a.note && !isOpen && <span className="note">{a.note}</span>}
                          <button
                            type="button"
                            className="expand-btn"
                            aria-expanded={isOpen}
                            aria-controls={detailId}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggle(s.idx);
                            }}
                          >
                            {isOpen ? "Hide" : a.verdict === "correct" ? "Details" : "Why?"} <Icon name="chevron" size={14} />
                          </button>
                        </div>
                      </>
                    ) : (
                      <div className="pending-line">
                        {live && session.status === "analysing" ? (
                          <>
                            <span className="spinner" /> Analysing…
                          </>
                        ) : (
                          "Not analysed yet"
                        )}
                      </div>
                    )}
                  </div>
                </div>
                {isOpen && a && <Detail s={s} id={detailId} />}
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- mistakes

function Mistakes({ session, reveal }: { session: Session; reveal: (idx: number) => void }) {
  const repeated = session.stats?.repeatedMistakes ?? [];
  const [showStyle, setShowStyle] = useState(true);
  const groups = useMemo(() => {
    const g = new Map<MistakeCategory, { idx: number; m: SentenceAnalysis["mistakes"][number] }[]>();
    for (const s of session.sentences) {
      const a = s.analysis;
      if (!a || a.possibleMistranscription) continue;
      for (const m of a.mistakes) {
        if (!showStyle && m.kind !== "grammar") continue;
        if (!g.has(m.category)) g.set(m.category, []);
        g.get(m.category)!.push({ idx: s.idx, m });
      }
    }
    return [...g.entries()].sort((x, y) => y[1].length - x[1].length);
  }, [session.sentences, showStyle]);
  const anyAnalysed = session.sentences.some((s) => s.analysis);
  const styleCount = session.sentences.reduce((n, s) => n + (s.analysis?.mistakes.filter((m) => m.kind === "style").length ?? 0), 0);

  return (
    <section className="card" id="mistakes">
      <div className="card-head">
        <h2>
          <Icon name="book" size={18} /> Understand Your Mistakes
        </h2>
        <label className="switch">
          <input type="checkbox" checked={showStyle} onChange={(e) => setShowStyle(e.target.checked)} />
          Include natural-English tips{styleCount ? ` (${styleCount})` : ""}
        </label>
      </div>
      {repeated.length > 0 && (
        <div className="repeat-box">
          <h3>
            <Icon name="repeat" /> Mistakes you made more than once
          </h3>
          <ul>
            {repeated.map((r, i) => (
              <li key={i}>
                <strong>{r.pattern || CATEGORY_LABELS[r.category]}</strong> <span className="muted">× {r.count}</span>
                {r.examples[0] && (
                  <span className="text-2">
                    {" "}
                    — e.g. <span className="del">{r.examples[0].original}</span> → <span className="ins">{r.examples[0].corrected}</span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {!anyAnalysed ? (
        <div className="stack">
          <div className="skeleton" style={{ width: "60%" }} />
          <div className="skeleton" style={{ width: "80%" }} />
          <div className="skeleton" style={{ width: "45%" }} />
        </div>
      ) : groups.length === 0 ? (
        <p className="row text-2">
          <Icon name="check" /> {styleCount && !showStyle ? "No grammar mistakes — switch on natural-English tips to see style suggestions." : "No mistakes found in the analysed sentences. Well done!"}
        </p>
      ) : (
        groups.map(([cat, items]) => (
          <div className="cat-group" key={cat}>
            <h3>
              {CATEGORY_LABELS[cat]} <span className="pill">{items.length}</span>
            </h3>
            <ul className="mlist">
              {items.map(({ idx, m }, i) => (
                <li key={i} className="mitem">
                  <div className="fix">
                    {m.original && <span className="del">{m.original}</span>}
                    {m.original && m.corrected ? " → " : null}
                    {m.corrected && <span className="ins">{m.corrected}</span>}
                    {m.kind === "style" && (
                      <span className="tag natural" style={{ marginLeft: 8 }}>
                        Natural English
                      </span>
                    )}
                  </div>
                  <div className="ex">{m.explanation}</div>
                  <button type="button" className="goto" onClick={() => reveal(idx)}>
                    Sentence {idx} →
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}

// ---------------------------------------------------------------- context / communication

function Communication({ session }: { session: Session }) {
  const c = session.feedback?.communication;
  const better = session.sentences.filter((s) => s.analysis?.contextual);
  if (!c && !better.length) return null;
  return (
    <section className="card context" id="communication">
      <div className="card-head">
        <h2>
          <Icon name="bulb" size={18} /> {session.context ? "How well you explained it" : "How clearly you communicated"}
        </h2>
        <span className="pill info">About your ideas — not your English</span>
      </div>
      {session.context && (
        <p className="text-2" style={{ marginBottom: 16 }}>
          Topic: <strong style={{ color: "var(--text)" }}>{session.context}</strong>
        </p>
      )}
      {better.length > 0 && (
        <>
          <h3 className="sub-h" style={{ marginTop: 0 }}>
            Better ways to explain it
          </h3>
          <div className="explain-list">
            {better.map((s) => (
              <div key={s.idx} className="explain">
                <div className="yours">
                  <div className="eyebrow">Your explanation · sentence {s.idx}</div>
                  <div className="q">“{s.text}”</div>
                </div>
                <div className="better">
                  <div className="eyebrow" style={{ color: "var(--cyan)" }}>
                    Better explanation
                  </div>
                  <div className="q">“{s.analysis!.contextual}”</div>
                </div>
                {s.analysis!.contextualWhy.length > 0 && (
                  <div className="whys">
                    <div className="eyebrow">Why this communicates better</div>
                    <ul className="plain-list small" style={{ marginTop: 6 }}>
                      {s.analysis!.contextualWhy.map((w, i) => (
                        <li key={i}>
                          <Icon name="check" size={14} /> {w}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
      {c && (
        <>
          <h3 className="sub-h">Your explanation overall</h3>
          <div className="comm">
            <div>
              <h3>Clarity</h3>
              <p>{c.clarity}</p>
            </div>
            <div>
              <h3>Main idea</h3>
              <p>{c.mainIdea}</p>
            </div>
            <div>
              <h3>Terminology</h3>
              <p>{c.terminology}</p>
            </div>
            <div>
              <h3>Structure</h3>
              <p>{c.structure}</p>
            </div>
            {c.missingConnections.length > 0 && (
              <div>
                <h3>Missing links</h3>
                <ul>
                  {c.missingConnections.map((m, i) => (
                    <li key={i}>{m}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          {c.sayNextTime && (
            <div className="say-next">
              <div className="eyebrow" style={{ color: "var(--cyan)" }}>
                Next time, try saying
              </div>
              <p>{c.sayNextTime}</p>
            </div>
          )}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- feedback

type Level = { label: string; cls: string; icon: IconName };
const STRONG: Level = { label: "Strong", cls: "pill ok", icon: "check" };
const DEVELOPING: Level = { label: "Developing", cls: "pill warn", icon: "trendUp" };
const FOCUS: Level = { label: "Focus area", cls: "pill bad", icon: "target" };

function Aspect({ name, level, value, basis, rule, children }: { name: string; level?: Level; value?: string; basis?: string; rule?: string; children?: React.ReactNode }) {
  return (
    <div className="aspect">
      <div className="aspect-top">
        <span className="aspect-name">{name}</span>
        {level && (
          <span className={level.cls} data-tip={rule} tabIndex={rule ? 0 : undefined}>
            <Icon name={level.icon} /> {level.label}
          </span>
        )}
      </div>
      {value && <div className="aspect-value">{value}</div>}
      {children}
      {basis && <div className="aspect-basis">{basis}</div>}
    </div>
  );
}

function Feedback({ session }: { session: Session }) {
  const st = session.stats;
  const fb = session.feedback;
  if (!st) {
    return (
      <section className="card" id="feedback">
        <div className="card-head">
          <h2>
            <Icon name="chart" size={18} /> Speaking feedback
          </h2>
        </div>
        <div className="stack">
          <div className="skeleton" style={{ width: "70%" }} />
          <div className="skeleton" style={{ width: "50%" }} />
        </div>
      </section>
    );
  }
  const n = st.analysedSentences;
  const pct = n ? Math.round((100 * st.grammarOk) / n) : 0;
  const cat = (c: MistakeCategory[]) => st.categories.filter((x) => c.includes(x.category)).reduce((a, x) => a + x.count, 0);
  const construction = cat(["sentence_structure", "word_order", "redundancy"]);
  const vocab = cat(["vocabulary", "awkward_expression"]);
  const per10 = (k: number) => (n ? (10 * k) / n : 0);
  const rate = (k: number) => (per10(k) <= 0.5 ? STRONG : per10(k) <= 1.5 ? DEVELOPING : FOCUS);
  const fillerRate = st.words ? (100 * st.fillerTotal) / st.words : 0;
  const minutes = session.durationSec / 60;
  const PER10 = "Per 10 sentences: ≤ 0.5 Strong · ≤ 1.5 Developing · more = Focus area";

  return (
    <section className="card" id="feedback">
      <div className="card-head">
        <h2>
          <Icon name="chart" size={18} /> Speaking feedback
        </h2>
        <span className="pill violet">English</span>
      </div>
      {fb ? (
        <p className="overall">{fb.overall}</p>
      ) : (
        <p className="muted">{session.feedbackError ? `Session feedback unavailable: ${session.feedbackError}` : "Preparing your feedback…"}</p>
      )}

      <div className="aspects">
        <Aspect
          name="Grammar"
          level={!n ? undefined : pct >= 85 ? STRONG : pct >= 60 ? DEVELOPING : FOCUS}
          rule="Strong ≥ 85% · Developing ≥ 60% · otherwise Focus area"
          value={n ? `${pct}%` : "–"}
          basis={`Sentences without grammar mistakes: ${st.grammarOk} of ${n}`}
        >
          <div className="meter" aria-hidden>
            <div style={{ width: `${pct}%` }} />
          </div>
        </Aspect>
        <Aspect name="Sentence construction" level={n ? rate(construction) : undefined} rule={PER10} value={String(construction)} basis={`Structure, word-order and wordiness issues in ${n} sentences`} />
        <Aspect name="Vocabulary" level={n ? rate(vocab) : undefined} rule={PER10} value={String(vocab)} basis="Word-choice and awkward-expression issues">
          {st.overused.length > 0 && <div className="aspect-text">Used a lot: {st.overused.map((o) => `“${o.word}” ×${o.count}`).join(", ")}</div>}
        </Aspect>
        <Aspect name="Clarity">
          <div className="aspect-text">{fb?.communication.clarity ?? "—"}</div>
          <div className="aspect-basis">Coach&apos;s note on how easy you were to follow</div>
        </Aspect>
        <Aspect
          name="Repeated mistakes"
          level={st.repeatedMistakes.length === 0 ? STRONG : st.repeatedMistakes.length <= 2 ? DEVELOPING : FOCUS}
          rule="0 Strong · 1–2 Developing · 3+ Focus area"
          value={String(st.repeatedMistakes.length)}
          basis="Mistake patterns that appeared 2 or more times"
        />
        <Aspect
          name="Filler words"
          level={!st.words ? undefined : fillerRate < 2 ? STRONG : fillerRate < 5 ? DEVELOPING : FOCUS}
          rule="Per 100 words: < 2 Strong · < 5 Developing · otherwise Focus area"
          value={String(st.fillerTotal)}
          basis={`${fillerRate.toFixed(1)} per 100 words · ${minutes >= 0.25 ? `${Math.round(st.words / minutes)} words/min` : `${st.words} words`}`}
        >
          {(st.fillers.length > 0 || st.repetitions.length > 0) && (
            <div className="kv-chips">
              {st.fillers.map((f) => (
                <span key={f.word} className="pill">
                  {f.word} ×{f.count}
                </span>
              ))}
              {st.repetitions.slice(0, 3).map((r) => (
                <span key={r.text} className="pill" tabIndex={0} data-tip="Repeated word (a stumble)">
                  “{r.text}”
                </span>
              ))}
            </div>
          )}
        </Aspect>
      </div>

      {fb && fb.topAreas.length > 0 && (
        <>
          <h3 className="sub-h">
            <Icon name="target" /> Top {fb.topAreas.length} areas to improve
          </h3>
          <ol className="areas">
            {fb.topAreas.map((a, i) => (
              <li key={i}>
                <strong>{a.area}</strong>
                <span className="text-2">{a.why}</span>
                {a.example && <span className="said">You said: “{a.example}”</span>}
                <span className="tip">
                  <b>Tip:</b> {a.tip}
                </span>
              </li>
            ))}
          </ol>
        </>
      )}

      {fb && (
        <div className="two-col" style={{ marginTop: 8 }}>
          {fb.strengths.length > 0 && (
            <div>
              <h3 className="sub-h">
                <Icon name="check" /> What you did well
              </h3>
              <ul className="plain-list">
                {fb.strengths.map((s, i) => (
                  <li key={i}>
                    <Icon name="check" size={14} /> {s}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {fb.recommendations.length > 0 && (
            <div>
              <h3 className="sub-h">
                <Icon name="flame" /> For your next session
              </h3>
              <ol style={{ display: "grid", gap: 6 }}>
                {fb.recommendations.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}

      {fb && fb.vocabulary.length > 0 && (
        <>
          <h3 className="sub-h">
            <Icon name="book" /> Better vocabulary
          </h3>
          <ul className="plain-list">
            {fb.vocabulary.map((v, i) => (
              <li key={i}>
                <span>
                  Instead of <span className="del">{v.insteadOf}</span>, try <span className="ins">{v.tryInstead}</span>
                  {v.example && <span className="text-2"> — “{v.example}”</span>}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="footnote">
        <Icon name="info" size={13} /> Ratings follow the rule shown when you hover them. Counts come straight from your transcript (“um/uh” may be under-counted). Pronunciation and accent are not assessed.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------- page

export function SessionView({ session, live = false, onRetry, retrying }: { session: Session; live?: boolean; onRetry?: () => void; retrying?: boolean }) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  const toggle = (idx: number) =>
    setOpen((o) => {
      const n = new Set(o);
      if (n.has(idx)) n.delete(idx);
      else n.add(idx);
      return n;
    });
  const reveal = (idx: number) => {
    setOpen((o) => new Set(o).add(idx));
    setTimeout(() => document.getElementById(`s-${idx}`)?.scrollIntoView({ behavior: smooth(), block: "center" }), 30);
  };
  // "analysing" while nobody is streaming it means the server stopped mid-way (e.g. restarted) → offer retry
  const needsRetry = session.status === "partial" || session.status === "failed" || (!live && (session.status === "analysing" || !session.feedback));
  const hasComm = !!session.feedback || session.sentences.some((s) => s.analysis?.contextual);

  return (
    <div className="session fade-in" data-testid="session-view" data-status={session.status}>
      <Summary session={session} />
      {session.error && session.status !== "analysing" && (
        <div className="banner warn" role="alert">
          <Icon name="alert" />
          <div className="grow">Analysis incomplete: {session.error}. Your transcript is saved.</div>
        </div>
      )}
      {needsRetry && onRetry && (
        <div className="banner">
          <Icon name="repeat" />
          <div className="grow row">
            <span className="grow">Some results are missing. Retry re-runs only the missing parts from your saved transcript — no audio needed.</span>
            <button type="button" className="btn primary sm" onClick={onRetry} disabled={retrying}>
              {retrying ? <span className="spinner" /> : <Icon name="repeat" size={14} />} {retrying ? "Retrying…" : "Retry analysis"}
            </button>
          </div>
        </div>
      )}
      <nav className="jump" aria-label="Sections">
        <a href="#compare">Comparison</a>
        <a href="#mistakes">Mistakes</a>
        {hasComm && <a href="#communication">Explanation</a>}
        <a href="#feedback">Feedback</a>
        {session.audioFiles.length > 0 && <a href="#audio">Recording</a>}
      </nav>
      <div className="stack" style={{ gap: 20 }}>
        <Comparison session={session} live={live} open={open} toggle={toggle} />
        <Mistakes session={session} reveal={reveal} />
        <Communication session={session} />
        <Feedback session={session} />
        {session.audioFiles.length > 0 && (
          <section className="card" id="audio">
            <div className="card-head">
              <h2>
                <Icon name="wave" size={18} /> Your recording
              </h2>
              <span className="muted small">Kept on this computer because you chose to</span>
            </div>
            {session.audioFiles.map((f) => (
              <audio key={f} controls preload="none" src={`/api/sessions/${session.id}/audio/${f}`} />
            ))}
          </section>
        )}
      </div>
    </div>
  );
}
