import { listSessions } from "@/lib/db";
import { HistoryList } from "@/components/HistoryList";

export const dynamic = "force-dynamic";

export default function HistoryPage() {
  const sessions = listSessions();
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Session history</h1>
          <p>Every conversation you&apos;ve analysed, with the mistakes you made and how to fix them.</p>
        </div>
        <a href="/" className="btn primary">
          New session
        </a>
      </header>
      <HistoryList sessions={sessions} />
    </>
  );
}
