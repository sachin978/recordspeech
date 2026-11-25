"use client";

import { useEffect, useRef } from "react";

/**
 * Scrolling level bars drawn from REAL microphone levels (pushed by the recorder
 * ~20×/s into `levels`). When not recording it shows a flat, quiet baseline.
 */
export function Waveform({ levels, active }: { levels: React.MutableRefObject<number[]>; active: boolean }) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const bar = 3;
      const gap = 3;
      const n = Math.floor(w / (bar + gap));
      const data = levels.current;
      const mid = h / 2;
      for (let i = 0; i < n; i++) {
        const v = data[data.length - n + i] ?? 0;
        const amp = active ? Math.max(2, Math.pow(v, 1.6) * (h - 4)) : 2;
        const x = i * (bar + gap);
        // older bars fade out towards the left
        const age = i / n;
        ctx.fillStyle = active ? `rgba(139,124,255,${0.25 + 0.75 * age})` : "rgba(113,128,155,0.35)";
        const y = mid - amp / 2;
        ctx.beginPath();
        ctx.roundRect(x, y, bar, amp, 1.5);
        ctx.fill();
      }
      if (active) raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [active, levels]);

  return <canvas ref={ref} className="wave" aria-hidden="true" />;
}
