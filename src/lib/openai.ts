import { config } from "./config";

// Minimal OpenAI HTTP client: fetch + timeout + retry. SERVER-ONLY.

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public retryable: boolean,
    /** raw (sanitised) message from the provider, used to detect unsupported params */
    public providerMessage = "",
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Remove anything that looks like a secret before it reaches logs or the UI. */
export function sanitize(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_\-*]{4,}/g, "sk-…")
    .replace(/Bearer\s+[A-Za-z0-9_\-.]+/gi, "Bearer …")
    .slice(0, 500);
}

function friendlyMessage(status: number, providerMessage: string): string {
  if (status === 401) return "OpenAI rejected the API key. Check OPENAI_API_KEY in .env.local and restart the app.";
  if (status === 403) return "This OpenAI key/project does not have access to the requested model.";
  if (status === 404) return "The configured OpenAI model was not found. Check the model names in .env.local.";
  if (status === 429)
    return /quota|billing/i.test(providerMessage)
      ? "OpenAI says the account is out of quota or billing is not set up."
      : "OpenAI rate limit reached. Please wait a moment and retry.";
  if (status === 413) return "The audio chunk was too large for the transcription service.";
  if (status >= 500) return "OpenAI is having problems right now (server error). Please retry shortly.";
  return `OpenAI request failed (${status}): ${providerMessage || "unknown error"}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RequestOptions {
  timeoutMs: number;
  retries?: number;
  /** builds a fresh body each attempt (FormData streams cannot be reused) */
  body: () => BodyInit;
  json?: boolean;
}

export async function openaiRequest<T = unknown>(path: string, opts: RequestOptions): Promise<T> {
  const key = config.apiKey();
  if (!key) throw new ApiError("OPENAI_API_KEY is not set. Add it to .env.local and restart the app.", 0, false);
  const retries = opts.retries ?? 2;
  let lastErr: ApiError | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(Math.min(8000, 800 * 2 ** (attempt - 1)) + Math.random() * 300);
    let res: Response;
    try {
      res = await fetch(`${config.baseUrl()}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          ...(opts.json ? { "Content-Type": "application/json" } : {}),
        },
        body: opts.body(),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      lastErr = new ApiError(
        timedOut
          ? `OpenAI did not respond within ${Math.round(opts.timeoutMs / 1000)}s.`
          : "Could not reach OpenAI (network error). Check your internet connection.",
        0,
        true,
      );
      continue;
    }

    if (res.ok) {
      try {
        return (await res.json()) as T;
      } catch {
        lastErr = new ApiError("OpenAI returned an unreadable response.", res.status, true);
        continue;
      }
    }

    let providerMessage = "";
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      providerMessage = sanitize(body?.error?.message ?? "");
    } catch {
      /* ignore */
    }
    const retryable = res.status === 429 ? !/quota|billing/i.test(providerMessage) : res.status >= 500 || res.status === 408;
    lastErr = new ApiError(friendlyMessage(res.status, providerMessage), res.status, retryable, providerMessage);
    if (!retryable) break;
    const retryAfter = Number(res.headers.get("retry-after"));
    if (Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter < 20) await sleep(retryAfter * 1000);
  }
  throw lastErr ?? new ApiError("OpenAI request failed.", 0, false);
}

/**
 * Optional request parameters that a model might not support. When OpenAI
 * returns 400 naming one of them we drop it and retry, and remember that for
 * the rest of the process so later requests skip it immediately.
 */
const unsupported = new Map<string, Set<string>>();

export function isUnsupported(model: string, param: string): boolean {
  return unsupported.get(model)?.has(param) ?? false;
}

export function markUnsupportedFromError(model: string, err: unknown, candidates: string[]): boolean {
  if (!(err instanceof ApiError) || err.status !== 400) return false;
  const msg = err.providerMessage.toLowerCase();
  let found = false;
  for (const p of candidates) {
    if (!isUnsupported(model, p) && msg.includes(p.toLowerCase())) {
      if (!unsupported.has(model)) unsupported.set(model, new Set());
      unsupported.get(model)!.add(p);
      found = true;
    }
  }
  return found;
}
