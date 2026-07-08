// Diff strukturalny dwóch drzew XAML (port StructuralDiff.cs / StructuralMatcher z aplikacji WPF).
//
// Wyznacza globalne dopasowanie baseline↔bieżący (kotwica po x:Name/Name, sygnatura, fallback po
// tagu), niezależne od pozycji — dzięki temu PRZENIESIENIE elementu (zmiana rodzica lub kolejności
// rodzeństwa) jest osobnym eventem „moved", a nie parą removed+added. Każdy event niesie dane do
// bogatej karty zmian (numer linii, pełne atrybuty obu stron, treść) i do revertu per-hunk.

import type { XamlDocument } from "./XamlDocument.ts";
import type { XamlNode } from "./XamlParser.ts";

export interface AttrChange {
  name: string;
  baseline: string | null; // null = atrybut dodany (brak w baseline)
  current: string | null; // null = atrybut usunięty (brak w bieżącym)
}

/** Para nazwa/wartość atrybutu (do renderu otwierającego znacznika w karcie zmiany). */
export interface NV {
  name: string;
  value: string;
}

export type Change =
  | {
      kind: "attrs";
      id: number;
      tag: string;
      line: number;
      attrs: AttrChange[];
      baselineAttrs: NV[];
      currentAttrs: NV[];
      baselineContent: string | null;
      currentContent: string | null;
    }
  | { kind: "added"; id: number; tag: string; line: number; attrs: NV[]; content: string | null }
  | {
      kind: "removed";
      tag: string;
      parentId: number;
      index: number;
      xml: string;
      line: number;
      attrs: NV[];
      content: string | null;
    }
  | {
      kind: "moved";
      id: number;
      tag: string;
      line: number;
      baseLine: number;
      attrs: NV[];
      content: string | null;
      revertParentId: number;
      revertBeforeId: number | null;
    };

// ---------- pomocnicze (na drzewie XamlNode) ----------

function elementChildren(n: XamlNode): XamlNode[] {
  return n.children.filter((c) => c.kind === "element");
}

/** Wszyscy potomkowie-elementy (bez samego korzenia), w kolejności dokumentu. */
function* descendants(root: XamlNode): Generator<XamlNode> {
  for (const c of elementChildren(root)) {
    yield c;
    yield* descendants(c);
  }
}

/** Atrybuty bez deklaracji przestrzeni nazw (xmlns / xmlns:*) — do sygnatury i renderu tagu. */
function realAttrs(n: XamlNode): NV[] {
  return n.attributes
    .filter((a) => a.name !== "xmlns" && !a.name.startsWith("xmlns:"))
    .map((a) => ({ name: a.name, value: a.value }));
}

function nameOf(n: XamlNode): string | undefined {
  const v = n.attributes.find((a) => a.name === "x:Name" || a.name === "Name")?.value;
  return v ? v : undefined;
}

// Atrybuty identyfikujące element (priorytet od najpewniejszego). x:Name/Name są najtrwalsze;
// Content/Header/Title/Text rozróżniają rodzeństwo tego samego typu bez nazwy (np. dwa CheckBoxy
// „one/two"), więc zmiana trafia na właściwy element nawet po wstawieniu/usunięciu sąsiada.
const IDENT_ATTRS = ["x:Name", "Name", "Content", "Header", "Title", "Text"];
function identOf(n: XamlNode): string | undefined {
  for (const name of IDENT_ATTRS) {
    const v = n.attributes.find((a) => a.name === name)?.value;
    if (v) return v;
  }
  return undefined;
}

/** Treść tekstowa elementu (np. <Button>OK</Button>); whitespace-only → null. */
function contentText(n: XamlNode): string | null {
  const t = n.children
    .filter((c) => c.kind === "text")
    .map((c) => c.raw ?? "")
    .join("")
    .trim();
  return t === "" ? null : t;
}

/** Sygnatura strukturalna: tag + posortowane atrybuty + tagi dzieci — rozróżnia rodzeństwo po treści. */
function signature(n: XamlNode): string {
  const attrs = realAttrs(n)
    .slice()
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((a) => a.name + "=" + a.value)
    .join("|");
  const kids = elementChildren(n)
    .map((c) => c.tag ?? "")
    .join(",");
  return (n.tag ?? "") + "{" + attrs + "}[" + kids + "]";
}

function lineAt(text: string, offset: number): number {
  let line = 1;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i++) if (text[i] === "\n") line++;
  return line;
}

// ---------- globalne dopasowanie (port StructuralMatcher.Match) ----------

class TreeMatch {
  c2b = new Map<XamlNode, XamlNode>(); // current → baseline
  b2c = new Map<XamlNode, XamlNode>(); // baseline → current

  baseline(cur: XamlNode | undefined): XamlNode | undefined {
    return cur ? this.c2b.get(cur) : undefined;
  }
  current(bas: XamlNode | undefined): XamlNode | undefined {
    return bas ? this.b2c.get(bas) : undefined;
  }
  link(b: XamlNode, c: XamlNode) {
    this.c2b.set(c, b);
    this.b2c.set(b, c);
  }
}

// mapa nazwa→element; duplikaty zapisane jako null (niejednoznaczne → pomijane)
function uniqueByName(root: XamlNode): Map<string, XamlNode | null> {
  const map = new Map<string, XamlNode | null>();
  for (const e of descendants(root)) {
    const nm = nameOf(e);
    if (!nm) continue;
    map.set(nm, map.has(nm) ? null : e);
  }
  return map;
}

function anchorByName(baseRoot: XamlNode, curRoot: XamlNode, m: TreeMatch) {
  const baseByName = uniqueByName(baseRoot);
  const curByName = uniqueByName(curRoot);
  for (const [name, be] of baseByName) {
    const ce = curByName.get(name);
    if (be && ce && be.tag === ce.tag && !m.b2c.has(be) && !m.c2b.has(ce)) m.link(be, ce);
  }
}

// Dopasowuje dzieci dwóch już sparowanych kontenerów, potem schodzi w sparowane pary.
function matchChildren(baseEl: XamlNode, curEl: XamlNode, m: TreeMatch) {
  const baseKids = elementChildren(baseEl);
  const curKids = elementChildren(curEl);

  // Pass 1: identyczna sygnatura — zwykłe przestawienie identycznych elementów wykrywamy jako ruch.
  const curBySig = new Map<string, XamlNode[]>();
  for (const c of curKids) {
    if (m.c2b.has(c)) continue;
    const sig = signature(c);
    (curBySig.get(sig) ?? curBySig.set(sig, []).get(sig)!).push(c);
  }
  for (const b of baseKids) {
    if (m.b2c.has(b)) continue;
    const q = curBySig.get(signature(b));
    if (q && q.length) m.link(b, q.shift()!);
  }

  // Pass 2: po kluczu identyfikującym (tag + x:Name/Name/Content/…) — wiąże element ze zmienionym
  // atrybutem z właściwym sąsiadem mimo wstawienia/usunięcia innych (np. CheckBox „two" → „two”).
  const curByIdent = new Map<string, XamlNode[]>();
  for (const c of curKids) {
    if (m.c2b.has(c)) continue;
    const id = identOf(c);
    if (!id) continue;
    const key = (c.tag ?? "") + "#" + id;
    (curByIdent.get(key) ?? curByIdent.set(key, []).get(key)!).push(c);
  }
  for (const b of baseKids) {
    if (m.b2c.has(b)) continue;
    const id = identOf(b);
    if (!id) continue;
    const key = (b.tag ?? "") + "#" + id;
    const q = curByIdent.get(key);
    if (q && q.length) m.link(b, q.shift()!);
  }

  // Pass 3: pozostałe (np. element bez identyfikatora) — po nazwie taga w kolejności dokumentu.
  const curByTag = new Map<string, XamlNode[]>();
  for (const c of curKids) {
    if (m.c2b.has(c)) continue;
    const tag = c.tag ?? "";
    (curByTag.get(tag) ?? curByTag.set(tag, []).get(tag)!).push(c);
  }
  for (const b of baseKids) {
    if (m.b2c.has(b)) continue;
    const q = curByTag.get(b.tag ?? "");
    if (q && q.length) m.link(b, q.shift()!);
  }

  // rekurencja po sparowanych dzieciach (także dopasowanych globalnie po nazwie)
  for (const b of baseKids) {
    const c = m.b2c.get(b);
    if (c) matchChildren(b, c, m);
  }
}

function matchBySignature(baseRoot: XamlNode, curRoot: XamlNode, m: TreeMatch) {
  const curLeft = [...descendants(curRoot)].filter((e) => !m.c2b.has(e));
  if (curLeft.length === 0) return;
  const curBySig = new Map<string, XamlNode[]>();
  for (const c of curLeft) {
    const sig = signature(c);
    (curBySig.get(sig) ?? curBySig.set(sig, []).get(sig)!).push(c);
  }
  for (const b of descendants(baseRoot)) {
    if (m.b2c.has(b)) continue;
    const q = curBySig.get(signature(b));
    if (q && q.length) {
      const c = q.shift()!;
      if (!m.c2b.has(c)) {
        m.link(b, c);
        matchChildren(b, c, m);
      }
    }
  }
}

function matchTrees(baseRoot: XamlNode, curRoot: XamlNode): TreeMatch {
  const m = new TreeMatch();
  anchorByName(baseRoot, curRoot, m);
  if (baseRoot.tag === curRoot.tag) {
    m.link(baseRoot, curRoot);
    matchChildren(baseRoot, curRoot, m);
  }
  matchBySignature(baseRoot, curRoot, m);
  return m;
}

// ---------- wykrywanie przeniesień (port ComputeMoved / MarkOutOfOrder) ----------

function computeMoved(curRoot: XamlNode, m: TreeMatch): Set<XamlNode> {
  const moved = new Set<XamlNode>();

  const walk = (curEl: XamlNode) => {
    const bas = m.baseline(curEl);
    if (bas) {
      const sameParent: XamlNode[] = [];
      for (const c of elementChildren(curEl)) {
        const bc = m.baseline(c);
        if (!bc) continue; // dodany — nie liczymy jako ruch
        if (bc.parent !== bas) moved.add(c); // zmiana rodzica
        else sameParent.push(c);
      }
      // wśród tego samego rodzica: elementy poza najdłuższym wspólnym podciągiem = przeniesione
      const basOrder = elementChildren(bas).filter((b) => {
        const c = m.current(b);
        return !!c && sameParent.includes(c);
      });
      markOutOfOrder(sameParent, basOrder, m, moved);
    }
    for (const c of elementChildren(curEl)) walk(c);
  };

  walk(curRoot);
  return moved;
}

function markOutOfOrder(curOrder: XamlNode[], basOrder: XamlNode[], m: TreeMatch, moved: Set<XamlNode>) {
  const nC = curOrder.length;
  const nB = basOrder.length;
  if (nC === 0 || nB === 0) return;
  const curBase = curOrder.map((c) => m.baseline(c)!);

  const dp: number[][] = Array.from({ length: nC + 1 }, () => new Array(nB + 1).fill(0));
  for (let i = nC - 1; i >= 0; i--)
    for (let j = nB - 1; j >= 0; j--)
      dp[i][j] = curBase[i] === basOrder[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);

  const keep = new Set<XamlNode>();
  let x = 0;
  let y = 0;
  while (x < nC && y < nB) {
    if (curBase[x] === basOrder[y]) {
      keep.add(curOrder[x]);
      x++;
      y++;
    } else if (dp[x + 1][y] >= dp[x][y + 1]) x++;
    else y++;
  }
  for (const c of curOrder) if (!keep.has(c)) moved.add(c);
}

// ---------- diff atrybutów/treści ----------

function diffAttrs(base: XamlNode, cur: XamlNode): AttrChange[] {
  const out: AttrChange[] = [];
  const bMap = new Map(realAttrs(base).map((a) => [a.name, a.value]));
  const cMap = new Map(realAttrs(cur).map((a) => [a.name, a.value]));
  for (const [name, cv] of cMap) {
    const bv = bMap.has(name) ? bMap.get(name)! : null;
    if (bv !== cv) out.push({ name, baseline: bv, current: cv });
  }
  for (const [name, bv] of bMap) {
    if (!cMap.has(name)) out.push({ name, baseline: bv, current: null });
  }
  // treść tekstowa elementu jako pseudo-atrybut "(content)"
  const bc = contentText(base);
  const cc = contentText(cur);
  if (bc !== cc) out.push({ name: "(content)", baseline: bc, current: cc });
  return out;
}

// ---------- lista zmian (port Diff) ----------

export function structuralDiff(base: XamlDocument, cur: XamlDocument): Change[] {
  const changes: Change[] = [];
  if (!base.root || !cur.root) return changes;

  const baseText = base.getText();
  const curText = cur.getText();
  const curLine = (n: XamlNode) => lineAt(curText, n.span.start);
  const baseLine = (n: XamlNode) => lineAt(baseText, n.span.start);

  const m = matchTrees(base.root, cur.root);
  const moved = computeMoved(cur.root, m);

  // korzeń: nie może być przeniesiony/dodany/usunięty, ale jego atrybuty mogą się zmienić
  const rootBase = m.baseline(cur.root);
  if (rootBase) {
    const ac = diffAttrs(rootBase, cur.root);
    if (ac.length)
      changes.push({
        kind: "attrs",
        id: cur.root.id,
        tag: cur.root.tag ?? "?",
        line: curLine(cur.root),
        attrs: ac,
        baselineAttrs: realAttrs(rootBase),
        currentAttrs: realAttrs(cur.root),
        baselineContent: contentText(rootBase),
        currentContent: contentText(cur.root),
      });
  }

  for (const c of descendants(cur.root)) {
    const bas = m.baseline(c);
    if (!bas) {
      // Dodany element: pokazujemy tylko korzeń dodanego poddrzewa (rodzic ma odpowiednik).
      const p = c.parent;
      if (p && (p === cur.root || m.baseline(p))) {
        changes.push({
          kind: "added",
          id: c.id,
          tag: c.tag ?? "?",
          line: curLine(c),
          attrs: realAttrs(c),
          content: contentText(c),
        });
      }
      continue;
    }
    if (moved.has(c)) {
      const { parentId, beforeId } = revertPosition(c, bas, m, cur.root);
      changes.push({
        kind: "moved",
        id: c.id,
        tag: c.tag ?? "?",
        line: curLine(c),
        baseLine: baseLine(bas),
        attrs: realAttrs(c),
        content: contentText(c),
        revertParentId: parentId,
        revertBeforeId: beforeId,
      });
    }
    const ac = diffAttrs(bas, c);
    if (ac.length)
      changes.push({
        kind: "attrs",
        id: c.id,
        tag: c.tag ?? "?",
        line: curLine(c),
        attrs: ac,
        baselineAttrs: realAttrs(bas),
        currentAttrs: realAttrs(c),
        baselineContent: contentText(bas),
        currentContent: contentText(c),
      });
  }

  for (const bas of descendants(base.root)) {
    if (m.current(bas)) continue;
    const p = bas.parent;
    if (!p || !(p === base.root || m.current(p))) continue;
    const curParent = p === base.root ? cur.root : m.current(p)!;
    const index = elementChildren(p).indexOf(bas);
    changes.push({
      kind: "removed",
      tag: bas.tag ?? "?",
      parentId: curParent.id,
      index,
      xml: base.getElementSource(bas.id) ?? "",
      line: baseLine(bas),
      attrs: realAttrs(bas),
      content: contentText(bas),
    });
  }

  // kolejność jak w aplikacji: wg numeru linii (removed wg linii bazowej, już w `line`)
  changes.sort((a, b) => a.line - b.line);
  return changes;
}

// Pozycja bazowa elementu w BIEŻĄCYM drzewie (do revertu przeniesienia przez moveElement):
// rodzic bazowy → jego odpowiednik bieżący; pierwszy następny brat bazowy mający odpowiednik → before.
function revertPosition(
  cur: XamlNode,
  bas: XamlNode,
  m: TreeMatch,
  curRoot: XamlNode
): { parentId: number; beforeId: number | null } {
  const basParent = bas.parent;
  // korzeń jest sparowany w dopasowaniu, więc m.current(baseRoot) === curRoot — bez specjalnego przypadku
  const targetContainer = basParent ? m.current(basParent) : undefined;
  if (!targetContainer) {
    // brak odpowiednika rodzica — degraduj do bieżącego rodzica (revert no-op zamiast błędu)
    return { parentId: cur.parent?.id ?? curRoot.id, beforeId: null };
  }
  let beforeCur: XamlNode | null = null;
  if (basParent) {
    const sibs = elementChildren(basParent);
    for (let k = sibs.indexOf(bas) + 1; k < sibs.length; k++) {
      const c = m.current(sibs[k]);
      if (c && c !== cur) {
        beforeCur = c;
        break;
      }
    }
  }
  return {
    parentId: targetContainer.id,
    beforeId: beforeCur && beforeCur.parent === targetContainer ? beforeCur.id : null,
  };
}
