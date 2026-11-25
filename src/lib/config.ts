import path from "node:path";

// All settings are read at call time so tests can change process.env.
// SERVER-ONLY: never import this file from client components.

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const v = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

export const config = {
  apiKey: () => (process.env.OPENAI_API_KEY ?? "").trim(),
  baseUrl: () => (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, ""),
  transcribeModel: () => process.env.OPENAI_TRANSCRIBE_MODEL?.trim() || "gpt-transcribe",
  analysisModel: () => process.env.OPENAI_ANALYSIS_MODEL?.trim() || "gpt-6.2-sol",
  reasoningEffort: () => {
    const v = process.env.OPENAI_REASONING_EFFORT;
    if (v === undefined) return "low";
    return v.trim() || null;
  },
  batchSize: () => intEnv("ANALYSIS_BATCH_SIZE", 8, 2, 40),
  maxConcurrency: () => intEnv("OPENAI_MAX_CONCURRENCY", 6, 1, 16),
  transcribeTimeoutMs: () => intEnv("TRANSCRIBE_TIMEOUT_MS", 120_000, 5_000, 600_000),
  analysisTimeoutMs: () => intEnv("ANALYSIS_TIMEOUT_MS", 120_000, 5_000, 600_000),
  dataDir: () => path.resolve(/*turbopackIgnore: true*/ process.env.DATA_DIR || path.join(/*turbopackIgnore: true*/ process.cwd(), "data")),
};

export function isConfigured(): boolean {
  return config.apiKey().length > 0;
}
