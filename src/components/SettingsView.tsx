"use client";

import { useEffect, useState } from "react";
import { clearAll, loadPending } from "@/client/audioStore";
import { getPrefs, setPrefs, type Prefs } from "@/client/prefs";
import { Icon } from "./ui/Icon";
import { toast } from "./ui/Toast";

interface Health {
  configured: boolean;
  transcribeModel: string;
  analysisModel: string;
  dataDir: string;
}

export function SettingsView() {
  const [health, setHealth] = useState<Health | null>(null);
  const [prefs, setP] = useState<Prefs | null>(null);
  const [pending, setPending] = useState<number | null>(null);

  useEffect(() => {
    setP(getPrefs());
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth(null));
    loadPending().then((p) => setPending(p.segments.length));
  }, []);

  const update = (patch: Partial<Prefs>) => {
    setP(setPrefs(patch));
    toast("Preference saved");
  };

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Settings</h1>
          <p>Preferences are saved in this browser. API keys and models are configured on the server.</p>
        </div>
      </header>
      <div className="settings-grid">
        <section className="card">
          <div className="card-head">
            <h2>
              <Icon name="key" size={18} /> AI connection
            </h2>
            {health && (
              <span className={health.configured ? "pill ok" : "pill bad"}>
                <Icon name={health.configured ? "check" : "alert"} /> {health.configured ? "API key configured" : "API key missing"}
              </span>
            )}
          </div>
          {health ? (
            <dl className="kv">
              <dt>Speech-to-text model</dt>
              <dd>
                <code>{health.transcribeModel}</code>
              </dd>
              <dt>Analysis model</dt>
              <dd>
                <code>{health.analysisModel}</code>
              </dd>
              <dt>History stored in</dt>
              <dd>
                <code>{health.dataDir}</code>
              </dd>
            </dl>
          ) : (
            <div className="skeleton" style={{ width: "50%" }} />
          )}
          <p className="small muted" style={{ marginTop: 14 }}>
            To change these, edit <code>.env.local</code> in the project folder and restart the app. The key is only ever read by the server — it never reaches this page.
          </p>
        </section>

        <section className="card">
          <div className="card-head">
            <h2>
              <Icon name="settings" size={18} /> Preferences
            </h2>
          </div>
          {prefs && (
            <>
              <div className="setting">
                <strong>Keep a copy of my audio by default</strong>
                <span className="desc">Off: audio is deleted once it is transcribed. On: it is saved on this computer so you can listen back.</span>
                <label className="switch">
                  <input type="checkbox" checked={prefs.keepAudio} onChange={(e) => update({ keepAudio: e.target.checked })} aria-label="Keep audio by default" />
                </label>
              </div>
              <div className="setting">
                <strong>Improved English shows</strong>
                <span className="desc">Which version appears first in the comparison. You can always switch on the results page.</span>
                <div className="seg" role="group" aria-label="Default improved version">
                  <button type="button" className={prefs.view === "corrected" ? "on" : ""} onClick={() => update({ view: "corrected" })}>
                    Grammar corrected
                  </button>
                  <button type="button" className={prefs.view === "natural" ? "on" : ""} onClick={() => update({ view: "natural" })}>
                    More natural
                  </button>
                </div>
              </div>
              <div className="setting">
                <strong>Unsent recording in this browser</strong>
                <span className="desc">{pending ? `${pending} audio part(s) waiting to be analysed. Open Practice to analyse them, or clear them here.` : "Nothing waiting — no audio is stored in this browser."}</span>
                <button
                  type="button"
                  className="btn danger sm"
                  disabled={!pending}
                  onClick={async () => {
                    if (!window.confirm("Delete the unsent recording from this browser? It cannot be recovered.")) return;
                    await clearAll();
                    setPending(0);
                    toast("Unsent recording deleted", "info");
                  }}
                >
                  <Icon name="trash" size={14} /> Clear
                </button>
              </div>
            </>
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <h2>
              <Icon name="lock" size={18} /> Privacy
            </h2>
          </div>
          <ul className="plain-list">
            <li>
              <Icon name="mic" size={15} /> Audio is sent to OpenAI&apos;s speech-to-text service only when you press Pause &amp; Analyse — never while you are just recording.
            </li>
            <li>
              <Icon name="text" size={15} /> Your transcript and optional topic are sent to OpenAI&apos;s analysis model.
            </li>
            <li>
              <Icon name="folder" size={15} /> Your history lives in a local SQLite file on this computer. There are no accounts and no cloud database.
            </li>
            <li>
              <Icon name="trash" size={15} /> Audio is not kept unless you choose to keep it; sessions can be deleted from their page.
            </li>
          </ul>
        </section>
      </div>
    </>
  );
}
