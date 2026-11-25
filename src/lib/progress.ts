import { normalizePattern } from "./stats";
import { CATEGORY_LABELS, type MistakeCategory, type SessionStats } from "./types";

// Cross-session progress. Everything here is computed from stored counts —
// rates are "mistakes per analysed sentence", so long and short sessions compare fairly.

export type Trend = "improving" | "worse" | "steady" | "not-enough-data";

export interface ProgressSession {
  id: string;
  createdAt: string;
  durationSec: number;
  context: string;
  stats: SessionStats | null;
}
export interface ProgressMistake {
  session_id: string;
  category: string;
  kind: string;
  pattern: string;
  original: string;
  corrected: string;
}

export interface CategoryProgress {
  category: MistakeCategory;
  label: string;
  total: number;
  sessionsWithIt: number;
  /** rate per session, oldest → newest (null = session had no analysed sentences) */
  rates: (number | null)[];
  earlierRate: number | null;
  recentRate: number | null;
  trend: Trend;
}

export interface Progress {
  sessionCount: number;
  totalSeconds: number;
  totalSentences: number;
  sessions: { id: string; createdAt: string; context: string; accuracyPct: number | null; sentences: number; fillersPer100: number | null }[];
  accuracyTrend: Trend;
  categories: CategoryProgress[];
  patterns: { pattern: string; count: number; sessions: number; lastSeen: string; example: { original: string; corrected: string } }[];
  insights: string[];
  /** sessions and minutes per week, oldest → newest, last 8 weeks (weeks start Monday) */
  weekly: { weekStart: string; sessions: number; minutes: number }[];
  /** consecutive days (ending today or yesterday) with at least one session */
  streakDays: number;
  thisWeekSessions: number;
  /** sentence-construction issues (structure + word order) per analysed sentence, per session */
  construction: { rates: number[]; trend: Trend; earlier: number | null; recent: number | null };
  fillerTrend: Trend;
}

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/** Practice frequency (local time): last `weeks` weeks and the current daily streak. */
export function practiceStats(dates: string[], now = new Date(), weeks = 8) {
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const starts = Array.from({ length: weeks }, (_, i) => {
    const d = new Date(monday);
    d.setDate(d.getDate() - 7 * (weeks - 1 - i));
    return d;
  });
  const weekly = starts.map((d) => ({ weekStart: d.toISOString(), sessions: 0, minutes: 0 }));
  const days = new Set<string>();
  for (const iso of dates) {
    const d = new Date(iso);
    days.add(dayKey(d));
    for (let i = weeks - 1; i >= 0; i--) {
      if (d >= starts[i]) {
        const end = new Date(starts[i]);
        end.setDate(end.getDate() + 7);
        if (d < end) weekly[i].sessions++;
        break;
      }
    }
  }
  let streak = 0;
  const cur = new Date(now);
  if (!days.has(dayKey(cur))) cur.setDate(cur.getDate() - 1); // a streak is still alive if you practised yesterday
  while (days.has(dayKey(cur))) {
    streak++;
    cur.setDate(cur.getDate() - 1);
  }
  return { weekly, streakDays: streak, thisWeekSessions: weekly[weeks - 1].sessions };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Compare the older half of sessions with the newer half. For mistake rates, lower is better. */
export function trendOf(values: (number | null)[], lowerIsBetter = true): { trend: Trend; earlier: number | null; recent: number | null } {
  const xs = values.filter((v): v is number => v !== null);
  if (xs.length < 4) return { trend: "not-enough-data", earlier: mean(xs.slice(0, 1)), recent: mean(xs.slice(-1)) };
  const half = Math.floor(xs.length / 2);
  const earlier = mean(xs.slice(0, half))!;
  const recent = mean(xs.slice(xs.length - half))!;
  const diff = recent - earlier;
  const scale = Math.max(Math.abs(earlier), 0.05);
  if (Math.abs(diff) < 0.03 || Math.abs(diff) / scale < 0.25) return { trend: "steady", earlier, recent };
  const better = lowerIsBetter ? diff < 0 : diff > 0;
  return { trend: better ? "improving" : "worse", earlier, recent };
}

export function computeProgress(sessions: ProgressSession[], mistakes: ProgressMistake[]): Progress {
  const withStats = sessions.filter((s) => s.stats && s.stats.analysedSentences > 0);
  const order = new Map(withStats.map((s, i) => [s.id, i]));
  const byCat = new Map<string, number[]>();
  for (const m of mistakes) {
    const i = order.get(m.session_id);
    if (i === undefined) continue;
    if (!byCat.has(m.category)) byCat.set(m.category, new Array(withStats.length).fill(0));
    byCat.get(m.category)![i]++;
  }

  const categories: CategoryProgress[] = [...byCat.entries()]
    .map(([cat, counts]) => {
      const rates = counts.map((c, i) => c / withStats[i].stats!.analysedSentences);
      const t = trendOf(rates);
      return {
        category: cat as MistakeCategory,
        label: CATEGORY_LABELS[cat as MistakeCategory] ?? cat,
        total: counts.reduce((a, b) => a + b, 0),
        sessionsWithIt: counts.filter((c) => c > 0).length,
        rates,
        earlierRate: t.earlier,
        recentRate: t.recent,
        trend: t.trend,
      };
    })
    .sort((a, b) => b.total - a.total);

  // Specific recurring patterns (e.g. "discuss about → discuss") across sessions.
  const created = new Map(sessions.map((s) => [s.id, s.createdAt]));
  const pat = new Map<string, { pattern: string; count: number; sessions: Set<string>; lastSeen: string; example: { original: string; corrected: string } }>();
  for (const m of mistakes) {
    if (!order.has(m.session_id)) continue;
    const key = normalizePattern(m.pattern);
    if (!key) continue;
    const when = created.get(m.session_id) ?? "";
    const p = pat.get(key) ?? { pattern: m.pattern, count: 0, sessions: new Set(), lastSeen: when, example: { original: m.original, corrected: m.corrected } };
    p.count++;
    p.sessions.add(m.session_id);
    if (when >= p.lastSeen) {
      p.lastSeen = when;
      p.example = { original: m.original, corrected: m.corrected };
    }
    pat.set(key, p);
  }
  const patterns = [...pat.values()]
    .filter((p) => p.count >= 2)
    .map((p) => ({ pattern: p.pattern, count: p.count, sessions: p.sessions.size, lastSeen: p.lastSeen, example: p.example }))
    .sort((a, b) => b.sessions - a.sessions || b.count - a.count)
    .slice(0, 15);

  const sessionRows = withStats.map((s) => {
    const st = s.stats!;
    return {
      id: s.id,
      createdAt: s.createdAt,
      context: s.context,
      accuracyPct: st.analysedSentences ? Math.round((100 * st.grammarOk) / st.analysedSentences) : null,
      sentences: st.sentences,
      fillersPer100: st.words ? Math.round((1000 * st.fillerTotal) / st.words) / 10 : null,
    };
  });
  const acc = trendOf(sessionRows.map((r) => r.accuracyPct), false);

  // Plain-language insights.
  const insights: string[] = [];
  const n = withStats.length;
  for (const c of categories.slice(0, 5)) {
    if (c.sessionsWithIt >= 2 && c.sessionsWithIt >= Math.ceil(n / 2))
      insights.push(`You frequently make mistakes with ${lower(c.label)} (in ${c.sessionsWithIt} of ${n} sessions).`);
    if (c.trend === "improving")
      insights.push(`Mistakes with ${lower(c.label)} are becoming less frequent: ${fmtRate(c.earlierRate)} → ${fmtRate(c.recentRate)} per 10 sentences.`);
    if (c.trend === "worse")
      insights.push(`Mistakes with ${lower(c.label)} have increased recently: ${fmtRate(c.earlierRate)} → ${fmtRate(c.recentRate)} per 10 sentences.`);
  }
  for (const p of patterns.slice(0, 3))
    if (p.sessions >= 2) insights.push(`You repeatedly say "${p.example.original}" — try "${p.example.corrected}" (${p.pattern}; seen in ${p.sessions} sessions).`);
  if (acc.trend === "improving") insights.push(`Your sentence accuracy is improving: ${Math.round(acc.earlier!)}% → ${Math.round(acc.recent!)}% of sentences without grammar mistakes.`);
  if (acc.trend === "worse") insights.push(`Your sentence accuracy dropped recently: ${Math.round(acc.earlier!)}% → ${Math.round(acc.recent!)}%. Longer or harder topics can cause this.`);

  const practice = practiceStats(sessions.map((s) => s.createdAt));
  for (const s of sessions) {
    const w = practice.weekly.findLast((x) => new Date(s.createdAt) >= new Date(x.weekStart));
    if (w) w.minutes += s.durationSec / 60;
  }
  const consCounts = new Array(withStats.length).fill(0);
  for (const m of mistakes) {
    const i = order.get(m.session_id);
    if (i !== undefined && (m.category === "sentence_structure" || m.category === "word_order")) consCounts[i]++;
  }
  const consRates = consCounts.map((c, i) => c / withStats[i].stats!.analysedSentences);
  const cons = trendOf(consRates);
  if (cons.trend === "improving")
    insights.push(`Your sentence construction is improving: ${fmtRate(cons.earlier)} → ${fmtRate(cons.recent)} structure issues per 10 sentences.`);
  const fill = trendOf(sessionRows.map((r) => r.fillersPer100));
  if (fill.trend === "improving") insights.push(`You're using fewer filler words: ${fill.earlier!.toFixed(1)} → ${fill.recent!.toFixed(1)} per 100 words.`);

  return {
    weekly: practice.weekly.map((w) => ({ ...w, minutes: Math.round(w.minutes) })),
    streakDays: practice.streakDays,
    thisWeekSessions: practice.thisWeekSessions,
    construction: { rates: consRates, trend: cons.trend, earlier: cons.earlier, recent: cons.recent },
    fillerTrend: fill.trend,
    sessionCount: sessions.length,
    totalSeconds: Math.round(sessions.reduce((a, s) => a + s.durationSec, 0)),
    totalSentences: withStats.reduce((a, s) => a + s.stats!.sentences, 0),
    sessions: sessionRows,
    accuracyTrend: acc.trend,
    categories,
    patterns,
    insights: insights.slice(0, 8),
  };
}

const lower = (label: string) => label.charAt(0).toLowerCase() + label.slice(1);

function fmtRate(r: number | null): string {
  return r === null ? "–" : (r * 10).toFixed(1);
}
