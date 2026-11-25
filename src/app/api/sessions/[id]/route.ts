import { deleteSession, getSession } from "@/lib/db";
import { guard } from "@/lib/http";
import { deleteAudio } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const blocked = guard(req, { mutating: false });
  if (blocked) return blocked;
  const session = getSession((await params).id);
  if (!session) return Response.json({ error: "Session not found" }, { status: 404 });
  return Response.json({ session });
}

export async function DELETE(req: Request, { params }: Ctx) {
  const blocked = guard(req, { mutating: true });
  if (blocked) return blocked;
  const { id } = await params;
  const ok = deleteSession(id);
  deleteAudio(id);
  return ok ? Response.json({ ok: true }) : Response.json({ error: "Session not found" }, { status: 404 });
}
