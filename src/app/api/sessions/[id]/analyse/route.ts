import { getSession } from "@/lib/db";
import { guard, ndjsonStream } from "@/lib/http";
import { analyseSession } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Retry analysis for a saved transcript: analyses any sentences without results and regenerates feedback. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const blocked = guard(req, { mutating: true });
  if (blocked) return blocked;
  const { id } = await params;
  if (!getSession(id)) return Response.json({ error: "Session not found" }, { status: 404 });
  return ndjsonStream((emit) => analyseSession(id, null, emit));
}
