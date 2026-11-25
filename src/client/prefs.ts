"use client";

// Per-browser preferences (localStorage). Everything works with defaults if storage is unavailable.

export interface Prefs {
  /** default for "Keep a copy of the audio on this computer" */
  keepAudio: boolean;
  /** which improved version the comparison shows first */
  view: "corrected" | "natural";
}

const KEY = "rs.prefs.v1";
const DEFAULTS: Prefs = { keepAudio: false, view: "corrected" };

export function getPrefs(): Prefs {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const p = JSON.parse(raw) as Partial<Prefs>;
    return { keepAudio: p.keepAudio === true, view: p.view === "natural" ? "natural" : "corrected" };
  } catch {
    return DEFAULTS;
  }
}

export function setPrefs(patch: Partial<Prefs>): Prefs {
  const next = { ...getPrefs(), ...patch };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  return next;
}
