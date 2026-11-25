import { notFound } from "next/navigation";
import { getSession } from "@/lib/db";
import { SessionPage } from "@/components/SessionPage";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const session = getSession((await params).id);
  if (!session) notFound();
  return <SessionPage initial={session} />;
}
