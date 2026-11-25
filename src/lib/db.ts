import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config";
import type {
  ContextType,
  Sentence,
  SentenceAnalysis,
  Session,
  SessionFeedback,
  SessionStats,
  SessionStatus,
  SessionSummary,
  Span,
} from "./types";

// Local SQLite learning history. SERVER-ONLY.

type DB = Database.Database;
const g = globalThis as unknown as { __rsDb?: { db: DB; file: string } };

function migrate(db: DB) {
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version < 1) {
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        duration_sec REAL NOT NULL DEFAULT 0,
        context TEXT NOT NULL DEFAULT '',
        context_type TEXT NOT NULL DEFAULT 'general',
        status TEXT NOT NULL,
        error TEXT,
        parts INTEGER NOT NULL DEFAULT 0,
        feedback_json TEXT,
        feedback_error TEXT,
        stats_json TEXT,
        audio_files TEXT NOT NULL DEFAULT '[]',
        models_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE sentences (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        idx INTEGER NOT NULL,
        part INTEGER NOT NULL,
        text TEXT NOT NULL,
        uncertain_json TEXT NOT NULL DEFAULT '[]',
        analysis_json TEXT,
        PRIMARY KEY (session_id, idx)
      );
      -- denormalised copy of every mistake, for cross-session progress queries
      CREATE TABLE mistakes (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        sentence_idx INTEGER NOT NULL,
        category TEXT NOT NULL,
        kind TEXT NOT NULL,
        pattern TEXT NOT NULL,
        original TEXT NOT NULL,
        corrected TEXT NOT NULL
      );
      CREATE INDEX mistakes_session ON mistakes(session_id);
      CREATE INDEX sessions_created ON sessions(created_at);
      PRAGMA user_version = 1;
    `);
  }
}

export function getDb(): DB {
  const file = path.join(config.dataDir(), "recordspeech.db");
  if (g.__rsDb && g.__rsDb.file === file) return g.__rsDb.db;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  g.__rsDb = { db, file };
  return db;
}

interface SessionRow {
  id: string;
  created_at: string;
  updated_at: string;
  duration_sec: number;
  context: string;
  context_type: ContextType;
  status: SessionStatus;
  error: string | null;
  parts: number;
  feedback_json: string | null;
  feedback_error: string | null;
  stats_json: string | null;
  audio_files: string;
  models_json: string;
}
interface SentenceRow {
  idx: number;
  part: number;
  text: string;
  uncertain_json: string;
  analysis_json: string | null;
}

const parse = <T>(s: string | null, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

export function createSession(input: {
  context: string;
  contextType: ContextType;
  models: { transcribe: string; analysis: string };
}): string {
  const id = randomUUID();
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO sessions (id, created_at, updated_at, context, context_type, status, models_json)
       VALUES (?, ?, ?, ?, ?, 'transcribing', ?)`,
    )
    .run(id, now, now, input.context, input.contextType, JSON.stringify(input.models));
  return id;
}

export function getSession(id: string): Session | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as SessionRow | undefined;
  if (!row) return null;
  const rows = db.prepare(`SELECT * FROM sentences WHERE session_id = ? ORDER BY idx`).all(id) as SentenceRow[];
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    durationSec: row.duration_sec,
    context: row.context,
    contextType: row.context_type,
    status: row.status,
    error: row.error,
    parts: row.parts,
    sentences: rows.map((r) => ({
      idx: r.idx,
      part: r.part,
      text: r.text,
      uncertain: parse<Span[]>(r.uncertain_json, []),
      analysis: parse<SentenceAnalysis | null>(r.analysis_json, null),
    })),
    feedback: parse<SessionFeedback | null>(row.feedback_json, null),
    feedbackError: row.feedback_error,
    stats: parse<SessionStats | null>(row.stats_json, null),
    audioFiles: parse<string[]>(row.audio_files, []),
    models: parse(row.models_json, { transcribe: "", analysis: "" }),
  };
}

export function updateSession(
  id: string,
  patch: Partial<{
    status: SessionStatus;
    error: string | null;
    durationSec: number;
    parts: number;
    feedback: SessionFeedback | null;
    feedbackError: string | null;
    stats: SessionStats | null;
    audioFiles: string[];
  }>,
) {
  const cols: string[] = ["updated_at = @updated_at"];
  const params: Record<string, unknown> = { id, updated_at: new Date().toISOString() };
  const map: Record<string, [string, (v: never) => unknown]> = {
    status: ["status", (v) => v],
    error: ["error", (v) => v],
    durationSec: ["duration_sec", (v) => v],
    parts: ["parts", (v) => v],
    feedback: ["feedback_json", (v) => (v ? JSON.stringify(v) : null)],
    feedbackError: ["feedback_error", (v) => v],
    stats: ["stats_json", (v) => (v ? JSON.stringify(v) : null)],
    audioFiles: ["audio_files", (v) => JSON.stringify(v)],
  };
  for (const [k, v] of Object.entries(patch)) {
    const m = map[k];
    if (!m || v === undefined) continue;
    cols.push(`${m[0]} = @${m[0]}`);
    params[m[0]] = m[1](v as never);
  }
  getDb().prepare(`UPDATE sessions SET ${cols.join(", ")} WHERE id = @id`).run(params);
}

export function addSentences(sessionId: string, sentences: Sentence[]) {
  const db = getDb();
  const ins = db.prepare(
    `INSERT INTO sentences (session_id, idx, part, text, uncertain_json, analysis_json) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    for (const s of sentences)
      ins.run(sessionId, s.idx, s.part, s.text, JSON.stringify(s.uncertain), s.analysis ? JSON.stringify(s.analysis) : null);
  })();
}

export function setSentenceAnalyses(sessionId: string, analyses: Map<number, SentenceAnalysis>) {
  const db = getDb();
  const upd = db.prepare(`UPDATE sentences SET analysis_json = ? WHERE session_id = ? AND idx = ?`);
  const delM = db.prepare(`DELETE FROM mistakes WHERE session_id = ? AND sentence_idx = ?`);
  const insM = db.prepare(
    `INSERT INTO mistakes (session_id, sentence_idx, category, kind, pattern, original, corrected) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    for (const [idx, a] of analyses) {
      upd.run(JSON.stringify(a), sessionId, idx);
      delM.run(sessionId, idx);
      if (a.possibleMistranscription) continue;
      for (const m of a.mistakes) insM.run(sessionId, idx, m.category, m.kind, m.pattern, m.original, m.corrected);
    }
  })();
}

export function deleteSession(id: string): boolean {
  return getDb().prepare(`DELETE FROM sessions WHERE id = ?`).run(id).changes > 0;
}

export function listSessions(limit = 200): SessionSummary[] {
  const rows = getDb()
    .prepare(
      `SELECT s.id, s.created_at, s.duration_sec, s.context, s.status, s.stats_json,
              (SELECT COUNT(*) FROM sentences t WHERE t.session_id = s.id) AS n_sentences,
              (SELECT COUNT(*) FROM mistakes m WHERE m.session_id = s.id) AS n_mistakes,
              (SELECT text FROM sentences t WHERE t.session_id = s.id ORDER BY idx LIMIT 1) AS first_sentence
       FROM sessions s ORDER BY s.created_at DESC LIMIT ?`,
    )
    .all(limit) as (Pick<SessionRow, "id" | "created_at" | "duration_sec" | "context" | "status" | "stats_json"> & {
    n_sentences: number;
    n_mistakes: number;
    first_sentence: string | null;
  })[];
  return rows.map((r) => {
    const stats = parse<SessionStats | null>(r.stats_json, null);
    return {
      id: r.id,
      createdAt: r.created_at,
      durationSec: r.duration_sec,
      context: r.context,
      status: r.status,
      sentences: r.n_sentences,
      grammarOk: stats?.grammarOk ?? 0,
      analysedSentences: stats?.analysedSentences ?? 0,
      mistakes: r.n_mistakes,
      preview: (r.first_sentence ?? "").slice(0, 140),
    };
  });
}

/** Raw data for the progress page: per-session sentence counts and mistakes, oldest first. */
export function progressData() {
  const db = getDb();
  const sessions = db
    .prepare(
      `SELECT id, created_at, duration_sec, context, stats_json FROM sessions
       WHERE status IN ('complete', 'partial') ORDER BY created_at ASC`,
    )
    .all() as Pick<SessionRow, "id" | "created_at" | "duration_sec" | "context" | "stats_json">[];
  const mistakes = db.prepare(`SELECT session_id, category, kind, pattern, original, corrected FROM mistakes`).all() as {
    session_id: string;
    category: string;
    kind: string;
    pattern: string;
    original: string;
    corrected: string;
  }[];
  return {
    sessions: sessions.map((s) => ({
      id: s.id,
      createdAt: s.created_at,
      durationSec: s.duration_sec,
      context: s.context,
      stats: parse<SessionStats | null>(s.stats_json, null),
    })),
    mistakes,
  };
}
