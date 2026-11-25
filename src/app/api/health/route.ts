import { config, isConfigured } from "@/lib/config";
import { guard } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Tells the UI whether a key is configured — never returns the key itself. */
export async function GET(req: Request) {
  const blocked = guard(req, { mutating: false });
  if (blocked) return blocked;
  return Response.json({
    configured: isConfigured(),
    transcribeModel: config.transcribeModel(),
    analysisModel: config.analysisModel(),
  });
}
