import { guard, ndjsonStream } from "@/lib/http";
import { runAnalysePipeline, type AudioSegment } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_SEGMENT_BYTES = 25 * 1024 * 1024; // OpenAI transcription upload limit
const MAX_TOTAL_BYTES = 300 * 1024 * 1024;
const AUDIO_EXT = /\.(webm|ogg|mp4|m4a|wav|mp3|mpga|mpeg|flac)$/i;

/**
 * POST multipart/form-data:
 *   audio (repeated, in chronological order), context, contextType, durationSec, keepAudio, sessionId (to append a part)
 * Responds with an NDJSON stream of PipelineEvents.
 */
export async function POST(req: Request) {
  const blocked = guard(req, { mutating: true });
  if (blocked) return blocked;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "Expected multipart form data with audio." }, { status: 400 });
  }
  const segments: AudioSegment[] = [];
  let total = 0;
  for (const v of form.getAll("audio")) {
    if (typeof v === "string") continue;
    if (v.size === 0) continue;
    if (v.size > MAX_SEGMENT_BYTES) return Response.json({ error: "An audio part is larger than 25 MB." }, { status: 413 });
    total += v.size;
    const name = AUDIO_EXT.test(v.name) ? v.name : `segment-${segments.length + 1}.webm`;
    segments.push({ data: v, filename: name });
  }
  if (total > MAX_TOTAL_BYTES) return Response.json({ error: "Recording is too large." }, { status: 413 });

  const str = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v : "";
  };
  const sessionId = str("sessionId").trim() || null;
  if (sessionId && !/^[\w-]{8,64}$/.test(sessionId)) return Response.json({ error: "Bad session id." }, { status: 400 });
  const durationSec = Math.max(0, Math.min(6 * 3600, Number(str("durationSec")) || 0));

  return ndjsonStream((emit) =>
    runAnalysePipeline(
      { sessionId, context: str("context"), contextType: str("contextType") || null, durationSec, segments, keepAudio: str("keepAudio") === "true" },
      emit,
    ),
  );
}
