"use client";

import { useEffect, useRef, useState } from "react";

// Single-series bar chart (one hue — the title names the series, so no legend).
// Rendered at its real pixel width so text stays legible; 4px rounded data-ends on
// the baseline; recessive grid; hover tooltip on a full-column hit target; table view.

export interface Bar {
  label: string;
  value: number | null;
  tip: string;
}

interface Props {
  title: string;
  subtitle: string;
  data: Bar[];
  max?: number;
  format: (v: number) => string;
  emptyNote?: string;
  height?: number;
}

export function BarChart({ title, subtitle, data, max, format, emptyNote, height = 160 }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const wrap = useRef<HTMLDivElement | null>(null);
  const [W, setW] = useState(480);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(200, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [table]);

  const H = height;
  const padL = 40;
  const padB = 24;
  const padT = 10;
  const plotW = W - padL;
  const plotH = H - padB - padT;
  const vals = data.map((d) => d.value ?? 0);
  const top = max ?? Math.max(1, ...vals);
  const slot = plotW / Math.max(1, data.length);
  const bw = Math.max(6, Math.min(32, slot - 8));
  const y = (v: number) => padT + plotH - (v / top) * plotH;
  const allZero = vals.every((v) => v === 0);

  const barPath = (x: number, v: number) => {
    const h = Math.max(0, (v / top) * plotH);
    if (h <= 0) return "";
    const rr = Math.min(4, h, bw / 2);
    const yb = padT + plotH;
    const yt = yb - h;
    return `M${x},${yb} V${yt + rr} Q${x},${yt} ${x + rr},${yt} H${x + bw - rr} Q${x + bw},${yt} ${x + bw},${yt + rr} V${yb} Z`;
  };
  // label every bar when they fit, otherwise first / middle / last
  const showLabel = (i: number) => slot >= 48 || i === 0 || i === data.length - 1 || (data.length > 4 && i === Math.floor(data.length / 2));

  return (
    <>
      <div className="chart-head">
        <div>
          <h3>{title}</h3>
          <p className="small muted">{subtitle}</p>
        </div>
        <button type="button" className="btn ghost sm" onClick={() => setTable((t) => !t)} aria-pressed={table}>
          {table ? "Chart" : "Table"}
        </button>
      </div>
      {table ? (
        <div className="table-wrap" style={{ marginTop: 10 }}>
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {data.map((d, i) => (
                <tr key={i}>
                  <td>{d.tip}</td>
                  <td className="num">{d.value === null ? "–" : format(d.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div ref={wrap} className={`chart ${hover !== null ? "hovering" : ""}`} onMouseLeave={() => setHover(null)}>
          <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}: ${subtitle}`}>
            <line className="grid" x1={padL} x2={W} y1={y(top)} y2={y(top)} />
            <line className="grid" x1={padL} x2={W} y1={y(top / 2)} y2={y(top / 2)} />
            <text className="lbl" x={padL - 8} y={y(top) + 4} textAnchor="end">
              {format(top)}
            </text>
            <text className="lbl" x={padL - 8} y={y(0) + 4} textAnchor="end">
              {format(0)}
            </text>
            {data.map((d, i) => {
              const x = padL + i * slot + (slot - bw) / 2;
              return (
                <g key={i}>
                  {d.value !== null && <path className={`bar ${hover === i ? "on" : ""}`} d={barPath(x, d.value)} />}
                  {showLabel(i) && (
                    <text className="lbl" x={padL + (i + 0.5) * slot} y={H - 6} textAnchor="middle">
                      {d.label}
                    </text>
                  )}
                  <rect className="hit" x={padL + i * slot} y={padT} width={slot} height={plotH + padB} onMouseEnter={() => setHover(i)} />
                </g>
              );
            })}
            <line className="axis" x1={padL} x2={W} y1={y(0)} y2={y(0)} />
          </svg>
          {hover !== null && data[hover] && (
            <div className="chart-tip" style={{ left: padL + (hover + 0.5) * slot, top: Math.min(y(data[hover].value ?? 0), y(top * 0.3)) - 6 }}>
              <b>{data[hover].value === null ? "–" : format(data[hover].value!)}</b>
              <div className="muted">{data[hover].tip}</div>
            </div>
          )}
        </div>
      )}
      {allZero && emptyNote && !table && <p className="chart-note">{emptyNote}</p>}
    </>
  );
}
