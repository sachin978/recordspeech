"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon, type IconName } from "./Icon";

// Plain <a> links (full page loads) so the "unsaved recording" warning always fires.

const ITEMS: { href: string; label: string; icon: IconName; short: string }[] = [
  { href: "/", label: "Practice", short: "Practice", icon: "mic" },
  { href: "/history", label: "Session History", short: "History", icon: "history" },
  { href: "/progress", label: "Progress", short: "Progress", icon: "chart" },
  { href: "/settings", label: "Settings", short: "Settings", icon: "settings" },
];

function isActive(path: string, href: string) {
  return href === "/" ? path === "/" : path.startsWith(href) || (href === "/history" && path.startsWith("/sessions"));
}

function Logo() {
  return (
    <a href="/" className="logo" aria-label="RecordSpeech home">
      <span className="logo-mark">
        <Icon name="logo" size={16} strokeWidth={2.4} />
      </span>
      RecordSpeech
    </a>
  );
}

export function Sidebar() {
  const path = usePathname() ?? "/";
  const [health, setHealth] = useState<{ configured: boolean } | null>(null);
  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);
  return (
    <>
      <aside className="sidebar">
        <Logo />
        <nav className="nav" aria-label="Main">
          <a href="/" className="btn primary" style={{ marginBottom: 12 }}>
            <Icon name="plus" /> New Session
          </a>
          {ITEMS.map((it) => (
            <a key={it.href} href={it.href} className={`nav-item ${isActive(path, it.href) ? "active" : ""}`} aria-current={isActive(path, it.href) ? "page" : undefined}>
              <Icon name={it.icon} size={17} /> {it.label}
            </a>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className={`conn ${health ? (health.configured ? "ok" : "bad") : ""}`}>
            <i /> {health ? (health.configured ? "AI connected" : "API key missing") : "Checking…"}
          </span>
          <span>Runs locally · your history stays on this computer</span>
          <span>RecordSpeech v0.2</span>
        </div>
      </aside>
      <div className="mobile-bar">
        <Logo />
        <a href="/" className="btn primary sm">
          <Icon name="plus" /> New
        </a>
      </div>
      <nav className="tabbar" aria-label="Main">
        {ITEMS.map((it) => (
          <a key={it.href} href={it.href} className={isActive(path, it.href) ? "active" : ""} aria-current={isActive(path, it.href) ? "page" : undefined}>
            <Icon name={it.icon} size={20} />
            {it.short}
          </a>
        ))}
      </nav>
    </>
  );
}
