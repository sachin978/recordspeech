import type { Metadata, Viewport } from "next";
import "@fontsource-variable/inter";
import "./globals.css";
import { Sidebar } from "@/components/ui/Nav";
import { Toaster } from "@/components/ui/Toast";

export const metadata: Metadata = {
  title: "RecordSpeech — your English speaking coach",
  description: "Speak naturally. Understand your mistakes. Express yourself better.",
};

export const viewport: Viewport = { themeColor: "#0B1020", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <Sidebar />
          <main className="main">
            <div className="container">{children}</div>
          </main>
        </div>
        <Toaster />
      </body>
    </html>
  );
}
