"use client";

import { useEffect, useState } from "react";
import { Icon } from "./Icon";

// Tiny toast system: call toast("Copied") from anywhere on the client.

type Kind = "ok" | "bad" | "info";
interface T {
  id: number;
  msg: string;
  kind: Kind;
}
const EVT = "rs-toast";
let next = 1;

export function toast(msg: string, kind: Kind = "ok") {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<T>(EVT, { detail: { id: next++, msg, kind } }));
}

export function Toaster() {
  const [items, setItems] = useState<T[]>([]);
  useEffect(() => {
    const on = (e: Event) => {
      const t = (e as CustomEvent<T>).detail;
      setItems((xs) => [...xs.slice(-3), t]);
      setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== t.id)), t.kind === "bad" ? 6000 : 2600);
    };
    window.addEventListener(EVT, on);
    return () => window.removeEventListener(EVT, on);
  }, []);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <Icon name={t.kind === "ok" ? "check" : t.kind === "bad" ? "alert" : "info"} />
          <span>{t.msg}</span>
        </div>
      ))}
    </div>
  );
}
