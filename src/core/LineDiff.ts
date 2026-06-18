// Diff liniowy oparty na LCS (port koncepcji z LineDiff.cs aplikacji WPF).
// Używany do podświetlania zmienionych linii w edytorze tekstu (dekoracje).

export type LineOp = { t: "eq" | "add" | "del"; a?: string; b?: string };

/** Sekwencja operacji przekształcających `a` w `b` (najdłuższy wspólny podciąg linii). */
export function lineDiff(a: string[], b: string[]): LineOp[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: LineOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: "eq", a: a[i], b: b[j] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ t: "del", a: a[i] });
      i++;
    } else {
      ops.push({ t: "add", b: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ t: "del", a: a[i++] });
  while (j < m) ops.push({ t: "add", b: b[j++] });
  return ops;
}

/** Indeksy linii w `b` (0-based), które są nowe/zmienione względem `a`. */
export function changedLinesInB(a: string[], b: string[]): number[] {
  const ops = lineDiff(a, b);
  const res: number[] = [];
  let bi = 0;
  for (const op of ops) {
    if (op.t === "eq") bi++;
    else if (op.t === "add") {
      res.push(bi);
      bi++;
    }
  }
  return res;
}
