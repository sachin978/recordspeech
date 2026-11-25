import type { PipelineEvent } from "./types";

// Request guards and streaming helpers for API routes. SERVER-ONLY.

const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

/**
 * This app runs locally and spends the owner's OpenAI credit, so only accept
 * requests addressed to localhost (blocks DNS-rebinding) and, when the browser
 * sends an Origin, only from this same origin (blocks cross-site requests).
 */
export function guard(req: Request, opts: { mutating: boolean }): Response | null {
  const host = req.headers.get("host") ?? "";
  if (!LOCAL_HOSTS.test(host)) return Response.json({ error: "Forbidden host" }, { status: 403 });
  if (opts.mutating) {
    const origin = req.headers.get("origin");
    if (origin && origin !== `http://${host}` && origin !== `https://${host}`)
      return Response.json({ error: "Cross-origin request blocked" }, { status: 403 });
  }
  return null;
}

/** Stream pipeline events as newline-delimited JSON. The work continues even if the client disconnects. */
export function ndjsonStream(run: (emit: (e: PipelineEvent) => void) => Promise<void>): Response {
  const enc = new TextEncoder();
  let open = true;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (e: PipelineEvent) => {
        if (!open) return;
        try {
          controller.enqueue(enc.encode(JSON.stringify(e) + "\n"));
        } catch {
          open = false;
        }
      };
      try {
        await run(emit);
      } catch (err) {
        console.error("[pipeline] unexpected error", err instanceof Error ? err.message : err);
        emit({ type: "error", stage: "server", message: "Unexpected server error. Your recording is still saved in this browser.", audioSafe: true });
      } finally {
        if (open) {
          open = false;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      }
    },
    cancel() {
      open = false;
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" },
  });
}
