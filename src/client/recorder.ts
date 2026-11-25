"use client";

// Continuous microphone recorder that produces independent, self-contained audio
// segments. A new segment starts at a natural pause (silence) once the current one
// is ~1 minute long, so a long session can be transcribed in parallel chunks without
// cutting words in half. The next MediaRecorder starts *before* the previous one
// stops, so there is no gap in the audio.

export interface CompletedSegment {
  segId: string;
  order: number;
  mimeType: string;
  ext: string;
  blob: Blob;
  peak: number;
}

export type RecorderErrorKind = "permission" | "no-mic" | "busy" | "unsupported" | "disconnected" | "recorder";

export interface RecorderEvents {
  onChunk?: (segId: string, seq: number, blob: Blob) => void;
  onSegmentStart?: (info: { segId: string; order: number; mimeType: string; ext: string }) => void;
  onSegment: (seg: CompletedSegment) => void;
  onLevel?: (level: number) => void;
  onSilence?: (silent: boolean) => void;
  /** Fatal problems; whatever was recorded so far has already been delivered. */
  onError: (kind: RecorderErrorKind, message: string) => void;
}

export interface RecorderOptions {
  /** start looking for a pause after this many seconds */
  targetSegmentSec?: number;
  /** force a new segment after this many seconds even without a pause */
  maxSegmentSec?: number;
}

const MIME_CANDIDATES: [string, string][] = [
  ["audio/webm;codecs=opus", "webm"],
  ["audio/ogg;codecs=opus", "ogg"],
  ["audio/webm", "webm"],
  ["audio/mp4", "mp4"],
];

export function pickMimeType(): { mimeType: string; ext: string } | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const [m, ext] of MIME_CANDIDATES) if (MediaRecorder.isTypeSupported(m)) return { mimeType: m, ext };
  return { mimeType: "", ext: "webm" };
}

export function describeMicError(err: unknown): { kind: RecorderErrorKind; message: string } {
  const name = err instanceof Error || err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return {
      kind: "permission",
      message:
        "Microphone access was blocked. Click the microphone/lock icon in the address bar, allow the microphone for this site, then press Start Recording again.",
    };
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return { kind: "no-mic", message: "No microphone was found. Connect a microphone and try again." };
  if (name === "NotReadableError" || name === "AbortError")
    return { kind: "busy", message: "The microphone is in use by another app or could not be started. Close other apps using it and try again." };
  return { kind: "recorder", message: "Could not start the microphone." };
}

let orderCounter = 0;
export function setOrderCounter(n: number) {
  orderCounter = Math.max(orderCounter, n);
}

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

interface Active {
  rec: MediaRecorder;
  segId: string;
  order: number;
  mimeType: string;
  ext: string;
  chunks: Blob[];
  seq: number;
  startedAt: number;
  peak: number;
  done: Promise<void>;
}

export class SegmentedRecorder {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private active: Active | null = null;
  private finishing: Promise<void>[] = [];
  private noiseFloor = 0.01;
  private silentMs = 0;
  private lastVoiceAt = 0;
  private silenceWarned = false;
  private stopped = true;
  private format = { mimeType: "", ext: "webm" };
  private readonly target: number;
  private readonly max: number;

  constructor(private events: RecorderEvents, opts: RecorderOptions = {}) {
    this.target = (opts.targetSegmentSec ?? 60) * 1000;
    this.max = (opts.maxSegmentSec ?? 180) * 1000;
  }

  get isRecording() {
    return !this.stopped;
  }

  /** Ask for the microphone and start recording. Throws {kind,message} on failure. */
  async start(): Promise<void> {
    const fmt = pickMimeType();
    if (!fmt || !navigator.mediaDevices?.getUserMedia)
      throw { kind: "unsupported", message: "This browser cannot record audio. Please use a recent Chrome, Edge or Firefox." };
    this.format = fmt;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
    } catch (e) {
      throw describeMicError(e);
    }
    const track = this.stream.getAudioTracks()[0];
    if (track) track.onended = () => this.fail("disconnected", "The microphone was disconnected. Everything recorded up to now is saved.");

    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctx();
      const src = this.ctx.createMediaStreamSource(this.stream);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      src.connect(this.analyser);
      if (this.ctx.state === "suspended") await this.ctx.resume().catch(() => undefined);
    } catch {
      this.analyser = null; // level meter / pause detection unavailable; fixed-length segments instead
    }

    this.stopped = false;
    this.silentMs = 0;
    this.lastVoiceAt = performance.now();
    this.silenceWarned = false;
    this.startSegment();
    this.timer = setInterval(() => this.tick(), 50);
  }

  private startSegment() {
    if (!this.stream) return;
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(this.stream, { ...(this.format.mimeType ? { mimeType: this.format.mimeType } : {}), audioBitsPerSecond: 32000 });
    } catch {
      rec = new MediaRecorder(this.stream);
    }
    const mimeType = rec.mimeType || this.format.mimeType || "audio/webm";
    // the file extension must match the real container — OpenAI detects the format from it
    const ext = /ogg/.test(mimeType) ? "ogg" : /mp4|aac/.test(mimeType) ? "mp4" : "webm";
    let resolveDone!: () => void;
    const seg: Active = {
      rec,
      segId: uid(),
      order: ++orderCounter,
      mimeType,
      ext,
      chunks: [],
      seq: 0,
      startedAt: performance.now(),
      peak: 0,
      done: new Promise<void>((r) => (resolveDone = r)),
    };
    rec.ondataavailable = (e) => {
      if (!e.data || e.data.size === 0) return;
      seg.chunks.push(e.data);
      this.events.onChunk?.(seg.segId, seg.seq++, e.data);
    };
    rec.onstop = () => {
      const blob = new Blob(seg.chunks, { type: seg.mimeType });
      if (blob.size > 0)
        this.events.onSegment({ segId: seg.segId, order: seg.order, mimeType: seg.mimeType, ext: seg.ext, blob, peak: seg.peak });
      resolveDone();
    };
    rec.onerror = () => this.fail("recorder", "The recording stopped unexpectedly. Everything recorded up to now is saved.");
    this.events.onSegmentStart?.({ segId: seg.segId, order: seg.order, mimeType: seg.mimeType, ext: seg.ext });
    rec.start(1000); // flush to the backup store every second
    const prev = this.active;
    this.active = seg;
    if (prev) this.finishSegment(prev);
  }

  private finishSegment(seg: Active) {
    this.finishing.push(seg.done);
    try {
      if (seg.rec.state !== "inactive") seg.rec.stop();
      else seg.rec.onstop?.(new Event("stop"));
    } catch {
      seg.rec.onstop?.(new Event("stop"));
    }
  }

  private tick() {
    if (this.stopped || !this.active) return;
    const now = performance.now();
    const segMs = now - this.active.startedAt;
    if (this.analyser) {
      const buf = new Float32Array(this.analyser.fftSize);
      this.analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      this.active.peak = Math.max(this.active.peak, rms);
      // noise floor falls quickly and rises slowly
      this.noiseFloor = rms < this.noiseFloor ? rms : this.noiseFloor + (rms - this.noiseFloor) * 0.002;
      const voiced = rms > Math.max(0.006, this.noiseFloor * 3);
      this.silentMs = voiced ? 0 : this.silentMs + 50;
      if (voiced) this.lastVoiceAt = now;
      // perceptual (dB) scale: -60 dBFS → 0, -6 dBFS → 1, so quiet and loud speech look different
      this.events.onLevel?.(Math.max(0, Math.min(1, (20 * Math.log10(rms + 1e-7) + 60) / 54)));
      const silentLong = now - this.lastVoiceAt > 8000;
      if (silentLong !== this.silenceWarned) {
        this.silenceWarned = silentLong;
        this.events.onSilence?.(silentLong);
      }
      if (segMs >= this.target && this.silentMs >= 500) return this.startSegment();
    }
    if (segMs >= this.max) this.startSegment();
  }

  /** Stop recording, release the microphone and wait until all audio is delivered. */
  async stop(): Promise<void> {
    if (this.stopped) {
      await Promise.all(this.finishing);
      return;
    }
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const seg = this.active;
    this.active = null;
    if (seg) this.finishSegment(seg);
    await Promise.all(this.finishing);
    this.finishing = [];
    this.release();
  }

  private release() {
    this.stream?.getTracks().forEach((t) => {
      t.onended = null;
      t.stop();
    });
    this.stream = null;
    this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.analyser = null;
  }

  private fail(kind: RecorderErrorKind, message: string) {
    if (this.stopped) return;
    void this.stop().then(() => this.events.onError(kind, message));
  }
}
