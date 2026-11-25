import fs from "node:fs";
import { guard } from "@/lib/http";
import { audioPath } from "@/lib/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TYPES: Record<string, string> = { webm: "audio/webm", ogg: "audio/ogg", mp4: "audio/mp4", m4a: "audio/mp4", wav: "audio/wav", mp3: "audio/mpeg" };

/** Serves audio only for sessions where the user explicitly chose to keep it. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string; name: string }> }) {
  const blocked = guard(req, { mutating: false });
  if (blocked) return blocked;
  const { id, name } = await params;
  const file = audioPath(id, name);
  if (!file || !fs.existsSync(file)) return new Response("Not found", { status: 404 });
  const ext = name.split(".").pop()!.toLowerCase();
  return new Response(fs.readFileSync(file), { headers: { "Content-Type": TYPES[ext] ?? "application/octet-stream", "Cache-Control": "private, no-store" } });
}
