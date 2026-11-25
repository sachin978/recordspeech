import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "RecordSpeech",
  description: "Personal AI English speaking coach — speak, pause, compare, understand your mistakes.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="top">
          {/* plain links (full page loads) so the "unsaved recording" warning always fires */}
          <a href="/" className="brand">
            RecordSpeech
          </a>
          <nav>
            <a href="/">Record</a>
            <a href="/history">History</a>
            <a href="/progress">Progress</a>
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
