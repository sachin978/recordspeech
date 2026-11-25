import { progressData } from "@/lib/db";
import { computeProgress } from "@/lib/progress";
import { ProgressView } from "@/components/ProgressView";

export const dynamic = "force-dynamic";

export default function ProgressPage() {
  const { sessions, mistakes } = progressData();
  return <ProgressView p={computeProgress(sessions, mistakes)} />;
}
