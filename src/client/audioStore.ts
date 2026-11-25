"use client";

// Temporary, browser-local backup of the recording (IndexedDB) so audio is not
// lost if the tab is closed, reloaded or crashes before analysis. Audio is
// deleted from here as soon as the server has transcribed it, or when discarded.
// Every call fails soft: if IndexedDB is unavailable, recording still works in memory.

const DB_NAME = "recordspeech";
const VERSION = 1;

export interface SegmentInfo {
  segId: string;
  order: number;
  mimeType: string;
  ext: string;
  complete: boolean;
  /** loudest RMS level seen in this segment — used to skip pure silence */
  peak: number;
}

export interface PendingMeta {
  sessionId: string | null;
  context: string;
  contextType: string;
  keepAudio: boolean;
  durationSec: number;
  startedAt: string;
  updatedAt: string;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB unavailable"));
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("chunks")) db.createObjectStore("chunks", { keyPath: ["segId", "seq"] });
      if (!db.objectStoreNames.contains("segments")) db.createObjectStore("segments", { keyPath: "segId" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  dbPromise.catch(() => (dbPromise = null));
  return dbPromise;
}

function tx<T>(stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => T): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(stores, mode);
        const out = fn(t);
        t.oncomplete = () => resolve(out);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

const reqP = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

export async function saveChunk(segId: string, seq: number, blob: Blob): Promise<void> {
  try {
    await tx(["chunks"], "readwrite", (t) => t.objectStore("chunks").put({ segId, seq, blob }));
  } catch {
    /* in-memory copy still exists */
  }
}

export async function saveSegment(info: SegmentInfo): Promise<void> {
  try {
    await tx(["segments"], "readwrite", (t) => t.objectStore("segments").put(info));
  } catch {
    /* ignore */
  }
}

export async function saveMeta(meta: PendingMeta): Promise<void> {
  try {
    await tx(["meta"], "readwrite", (t) => t.objectStore("meta").put(meta, "pending"));
  } catch {
    /* ignore */
  }
}

export async function loadPending(): Promise<{ meta: PendingMeta | null; segments: { info: SegmentInfo; blob: Blob }[] }> {
  try {
    const db = await open();
    const t = db.transaction(["chunks", "segments", "meta"], "readonly");
    const [meta, infos, chunks] = await Promise.all([
      reqP(t.objectStore("meta").get("pending")) as Promise<PendingMeta | undefined>,
      reqP(t.objectStore("segments").getAll()) as Promise<SegmentInfo[]>,
      reqP(t.objectStore("chunks").getAll()) as Promise<{ segId: string; seq: number; blob: Blob }[]>,
    ]);
    const bySeg = new Map<string, { seq: number; blob: Blob }[]>();
    for (const c of chunks) {
      if (!bySeg.has(c.segId)) bySeg.set(c.segId, []);
      bySeg.get(c.segId)!.push(c);
    }
    const segments = infos
      .filter((i) => bySeg.has(i.segId))
      .sort((a, b) => a.order - b.order)
      .map((info) => {
        const parts = bySeg.get(info.segId)!.sort((a, b) => a.seq - b.seq).map((c) => c.blob);
        return { info, blob: new Blob(parts, { type: info.mimeType }) };
      })
      .filter((s) => s.blob.size > 0);
    return { meta: meta ?? null, segments };
  } catch {
    return { meta: null, segments: [] };
  }
}

export async function deleteSegments(segIds: string[]): Promise<void> {
  if (!segIds.length) return;
  try {
    await tx(["chunks", "segments"], "readwrite", (t) => {
      const chunks = t.objectStore("chunks");
      for (const id of segIds) {
        t.objectStore("segments").delete(id);
        chunks.delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]));
      }
    });
  } catch {
    /* ignore */
  }
}

export async function clearAll(): Promise<void> {
  try {
    await tx(["chunks", "segments", "meta"], "readwrite", (t) => {
      t.objectStore("chunks").clear();
      t.objectStore("segments").clear();
      t.objectStore("meta").clear();
    });
  } catch {
    /* ignore */
  }
}
