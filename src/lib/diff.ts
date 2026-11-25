// Word-level diff (LCS) used to highlight what changed between what was said
// and the improved sentence. Case and punctuation differences are not highlighted
// so the learner's eye goes to real word changes.

export interface DiffPiece {
  text: string;
  changed: boolean;
}

const key = (w: string) => w.toLowerCase().replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}']+/gu, "");

function tokenize(s: string): string[] {
  return s.split(/(\s+)/).filter((t) => t.length > 0);
}

export function wordDiff(original: string, improved: string): { left: DiffPiece[]; right: DiffPiece[] } {
  const a = tokenize(original);
  const b = tokenize(improved);
  const aw = a.map((t, i) => ({ t, i })).filter((x) => !/^\s+$/.test(x.t));
  const bw = b.map((t, i) => ({ t, i })).filter((x) => !/^\s+$/.test(x.t));
  const n = aw.length;
  const m = bw.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = key(aw[i].t) === key(bw[j].t) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);

  const keepA = new Set<number>();
  const keepB = new Set<number>();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (key(aw[i].t) === key(bw[j].t)) {
      keepA.add(aw[i].i);
      keepB.add(bw[j].i);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  const build = (tokens: string[], keep: Set<number>): DiffPiece[] => {
    const out: DiffPiece[] = [];
    tokens.forEach((t, idx) => {
      const ws = /^\s+$/.test(t);
      const changed = !ws && !keep.has(idx) && key(t) !== "";
      const last = out[out.length - 1];
      // whitespace between two changed words stays inside the highlight
      if (last && (last.changed === changed || (ws && last.changed))) last.text += t;
      else out.push({ text: t, changed });
    });
    // trailing whitespace should not be highlighted
    return out.flatMap((p) => {
      const m2 = p.changed ? p.text.match(/^(.*?)(\s+)$/s) : null;
      return m2 ? [{ text: m2[1], changed: true }, { text: m2[2], changed: false }] : [p];
    });
  };
  return { left: build(a, keepA), right: build(b, keepB) };
}
