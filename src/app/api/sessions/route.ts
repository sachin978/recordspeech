import { listSessions } from "@/lib/db";
import { guard } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const blocked = guard(req, { mutating: false });
  if (blocked) return blocked;
  return Response.json({ sessions: listSessions() });
}
