// Deduplikacja x:Name/Name i walidacja fragmentu przy wklejaniu ze schowka systemowego.
//
// Schowek systemowy może zawierać dowolny tekst (XAML z innego okna XVE albo z edytora
// tekstu) — `validXamlFragment` przepuszcza tylko pojedynczy element XAML. Deduplikacja
// dotyczy WYŁĄCZNIE wklejanej kopii: źródło/oryginalne okno nigdy nie jest modyfikowane.

import { XamlParser } from "./XamlParser.ts";
import type { XamlNode } from "./XamlParser.ts";

export type DedupMode = "off" | "rename" | "renameAndReferences";

/** Czy nazwa atrybutu identyfikuje element (x:Name lub Name). */
function isNameAttr(name: string): boolean {
  return name === "x:Name" || name === "Name";
}

/** Zbiera wszystkie wartości x:Name/Name z drzewa (np. dokumentu docelowego). */
export function collectNames(roots: XamlNode[]): Set<string> {
  const names = new Set<string>();
  const visit = (n: XamlNode) => {
    if (n.kind !== "element") return;
    for (const a of n.attributes) if (isNameAttr(a.name) && a.value) names.add(a.value);
    for (const c of n.children) visit(c);
  };
  for (const r of roots) visit(r);
  return names;
}

/**
 * Waliduje, że `text` to dokładnie jeden element XAML (z ewentualnym otaczającym
 * whitespace/komentarzami). Zwraca przycięty fragment albo null — wtedy wklejenie jest no-op.
 */
export function validXamlFragment(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed[0] !== "<") return null;
  const { roots } = new XamlParser(trimmed).parse();
  const elements = roots.filter((r) => r.kind === "element");
  if (elements.length !== 1) return null;
  return trimmed;
}

/** Skrót opisu fragmentu do menu: znacznik korzenia + liczba pod-elementów (descendant). */
export function fragmentSummary(xml: string): { tag: string; count: number } | null {
  const { root } = new XamlParser(xml).parse();
  if (!root || root.kind !== "element") return null;
  let count = 0;
  const walk = (n: XamlNode) => {
    for (const c of n.children)
      if (c.kind === "element") {
        count++;
        walk(c);
      }
  };
  walk(root);
  return { tag: root.tag ?? "", count };
}

/** Generuje nazwę nieobecną w `taken`: base_Copy, base_Copy1, base_Copy2… */
function uniqueName(base: string, taken: Set<string>): string {
  let candidate = base + "_Copy";
  let i = 1;
  while (taken.has(candidate)) candidate = base + "_Copy" + i++;
  return candidate;
}

/** Przepisuje wewnętrzne odwołania (ElementName=, x:Reference) w surowej wartości atrybutu wg mapy. */
function rewriteRefs(raw: string, map: Map<string, string>): string {
  let v = raw.replace(/\bElementName=([A-Za-z_]\w*)/g, (m, n) =>
    map.has(n) ? "ElementName=" + map.get(n) : m
  );
  v = v.replace(/\bx:Reference\s+Name=([A-Za-z_]\w*)/g, (m, n) =>
    map.has(n) ? "x:Reference Name=" + map.get(n) : m
  );
  v = v.replace(/\bx:Reference\s+([A-Za-z_]\w*)(?!\s*=)/g, (m, n) =>
    map.has(n) ? "x:Reference " + map.get(n) : m
  );
  return v;
}

/**
 * Zmienia w `fragment` te x:Name/Name, które kolidują z `existing`, na unikalne.
 *  - "off": fragment bez zmian,
 *  - "rename": podmienia tylko wartości atrybutów nazw,
 *  - "renameAndReferences": dodatkowo aktualizuje wewnętrzne odwołania (ElementName, x:Reference)
 *    w obrębie wklejanego poddrzewa, by kopia pozostała spójna.
 */
export function deduplicateNames(
  fragment: string,
  existing: Set<string>,
  mode: DedupMode
): string {
  if (mode === "off") return fragment;
  const { roots } = new XamlParser(fragment).parse();

  // 1) mapa rename dla nazw kolidujących z dokumentem docelowym
  const taken = new Set(existing);
  const rename = new Map<string, string>();
  const nameEdits: { start: number; end: number; text: string }[] = [];
  const refAttrs: { start: number; end: number; raw: string }[] = [];

  const visit = (n: XamlNode) => {
    if (n.kind !== "element") return;
    for (const a of n.attributes) {
      if (isNameAttr(a.name) && a.value && existing.has(a.value)) {
        let nv = rename.get(a.value);
        if (!nv) {
          nv = uniqueName(a.value, taken);
          taken.add(nv);
          rename.set(a.value, nv);
        }
        nameEdits.push({ start: a.valueSpan.start, end: a.valueSpan.end, text: nv });
      } else if (mode === "renameAndReferences") {
        // surowy wycinek (zachowuje encje); nazwy w odwołaniach nie zawierają encji
        refAttrs.push({
          start: a.valueSpan.start,
          end: a.valueSpan.end,
          raw: fragment.slice(a.valueSpan.start, a.valueSpan.end),
        });
      }
    }
    for (const c of n.children) visit(c);
  };
  for (const r of roots) visit(r);

  if (rename.size === 0) return fragment;

  // 2) zbierz edycje: nazwy + (opcjonalnie) odwołania
  const edits = [...nameEdits];
  if (mode === "renameAndReferences") {
    for (const a of refAttrs) {
      const nv = rewriteRefs(a.raw, rename);
      if (nv !== a.raw) edits.push({ start: a.start, end: a.end, text: nv });
    }
  }

  // 3) aplikuj od końca (offsety pozostają poprawne)
  edits.sort((x, y) => y.start - x.start);
  let out = fragment;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}
