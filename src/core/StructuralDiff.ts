// Diff strukturalny dwóch drzew XAML (port koncepcji ze StructuralDiff.cs).
//
// Dopasowuje elementy między baseline (zapisany plik) a bieżącym dokumentem przez
// keyed-LCS na liście rodzeństwa (klucz = tag + x:Name/Name). Produkuje listę zmian
// (atrybuty / dodane / usunięte) z danymi potrzebnymi do revertu per-hunk.

import type { XamlDocument } from "./XamlDocument.ts";
import type { XamlNode } from "./XamlParser.ts";

export interface AttrChange {
  name: string;
  baseline: string | null; // null = atrybut dodany (brak w baseline)
  current: string | null; // null = atrybut usunięty (brak w bieżącym)
}

export type Change =
  | { kind: "attrs"; id: number; tag: string; attrs: AttrChange[] }
  | { kind: "added"; id: number; tag: string }
  | { kind: "removed"; tag: string; parentId: number; index: number; xml: string };

function elementChildren(n: XamlNode): XamlNode[] {
  return n.children.filter((c) => c.kind === "element");
}
function nameOf(n: XamlNode): string | undefined {
  return n.attributes.find((a) => a.name === "x:Name" || a.name === "Name")?.value;
}
function keyOf(n: XamlNode): string {
  const nm = nameOf(n);
  return (n.tag ?? "") + (nm ? "#" + nm : "");
}

/** Najdłuższy wspólny podciąg kluczy → pary dopasowanych indeksów (w kolejności). */
function lcsMatch(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

function diffAttrs(base: XamlNode, cur: XamlNode): AttrChange[] {
  const out: AttrChange[] = [];
  const bMap = new Map(base.attributes.map((a) => [a.name, a.value]));
  const cMap = new Map(cur.attributes.map((a) => [a.name, a.value]));
  for (const [name, cv] of cMap) {
    const bv = bMap.has(name) ? bMap.get(name)! : null;
    if (bv !== cv) out.push({ name, baseline: bv, current: cv });
  }
  for (const [name, bv] of bMap) {
    if (!cMap.has(name)) out.push({ name, baseline: bv, current: null });
  }
  return out;
}

export function structuralDiff(base: XamlDocument, cur: XamlDocument): Change[] {
  const changes: Change[] = [];
  if (!base.root || !cur.root) return changes;
  walk(base, base.root, cur.root, changes);
  return changes;
}

function walk(baseDoc: XamlDocument, bNode: XamlNode, cNode: XamlNode, changes: Change[]) {
  const ac = diffAttrs(bNode, cNode);
  if (ac.length) changes.push({ kind: "attrs", id: cNode.id, tag: cNode.tag ?? "?", attrs: ac });

  const bch = elementChildren(bNode);
  const cch = elementChildren(cNode);
  const pairs = lcsMatch(bch.map(keyOf), cch.map(keyOf));
  const bMatched = new Set<number>();
  const cMatched = new Set<number>();
  for (const [bi, ci] of pairs) {
    bMatched.add(bi);
    cMatched.add(ci);
    walk(baseDoc, bch[bi], cch[ci], changes);
  }
  bch.forEach((bc, bi) => {
    if (!bMatched.has(bi)) {
      changes.push({
        kind: "removed",
        tag: bc.tag ?? "?",
        parentId: cNode.id,
        index: bi,
        xml: baseDoc.getElementSource(bc.id) ?? "",
      });
    }
  });
  cch.forEach((cc, ci) => {
    if (!cMatched.has(ci)) changes.push({ kind: "added", id: cc.id, tag: cc.tag ?? "?" });
  });
}
