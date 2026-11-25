import { progressData } from "@/lib/db";
import { guard } from "@/lib/http";
import { computeProgress } from "@/lib/progress";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const blocked = guard(req, { mutating: false });
  if (blocked) return blocked;
  const { sessions, mistakes } = progressData();
  return Response.json(computeProgress(sessions, mistakes));
}
