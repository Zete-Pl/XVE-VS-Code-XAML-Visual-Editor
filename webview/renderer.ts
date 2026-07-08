// Web renderer subsetu XAML → DOM (Etap 1, cross-platform backend podglądu).
//
// Mapuje drzewo elementów na pozycjonowane elementy HTML. Każdy węzeł dostaje
// `data-xve-id`, dzięki czemu klik w podglądzie ↔ zaznaczenie w drzewie. To nie jest
// wierny silnik WPF — to dobrze udokumentowany subset; nieznane typy renderują się jako
// opisany placeholder (do pełnej wierności służy backend WPF host na Windows — Etap 5).

import {
  setResources,
  effectiveAttrs,
  resolveBrushRef,
  lookupBrushColor,
  resolveText,
  resourceKey,
} from "./styleResolver.ts";
import type { ResourceModel } from "../src/core/ResourceModel.ts";

export interface RenderNode {
  id: number;
  tag: string;
  attributes: { name: string; value: string }[];
  /** bezpośrednia treść tekstowa (np. <ComboBoxItem>800×600</ComboBoxItem>) */
  text?: string;
  /** uporządkowana treść inline (tekst + elementy) dla mieszanej zawartości — patrz TreeNodeDto.inlines */
  inlines?: ({ text: string } | { node: RenderNode })[];
  children: RenderNode[];
}

type Layout =
  | "grid"
  | "grid-cell"
  | "canvas"
  | "stack-v"
  | "stack-h"
  | "flow"
  | "block"
  | "content" // pojedyncze dziecko wrappera (Border/ContentControl…) — wrapper sizuje się do treści
  | "dock" // zadokowane dziecko DockPanela (flex 0 0 auto)
  | "dock-fill"; // wypełniające dziecko DockPanela (flex 1 1 auto)

function attrOf(n: RenderNode, name: string): string | undefined {
  return n.attributes.find((a) => a.name === name)?.value;
}

function localName(tag: string): string {
  const i = tag.indexOf(":");
  return i >= 0 ? tag.slice(i + 1) : tag;
}

/** Czy węzeł to element-właściwość (np. Grid.RowDefinitions, Button.Content) — nie renderujemy go wizualnie. */
function isPropertyElement(tag: string): boolean {
  return localName(tag).includes(".");
}

// ---------- auto-podgląd menu/list (port RevealForSelection) ----------
// Kontrolki, których zaznaczenie (lub zaznaczenie ich pozycji) rozwija „fałszywy" podgląd listy/menu.
const REVEAL_TAGS = new Set(["ComboBox", "Menu", "ContextMenu", "TabControl"]);
let renderSelectedId: number | null = null;
let renderRevealPath = new Set<number>();
// mapa „surowa wartość Source z XAML" → webview-URI (rozwiązane przez extension); render obrazków w trybie web
let renderImageUris: Record<string, string> = {};
// kultura podglądu (jak parametr `culture` hosta WPF); undefined → locale przeglądarki (kultura OS)
let renderCulture: string | undefined;
// pamięć aktywnej zakładki per TabControl (id TabControl → id wybranej TabItem) — trwa między zaznaczeniami
let renderTabSelection: Map<number, number> | null = null;
// uporządkowana ścieżka korzeń→zaznaczenie (do kaskady menu) — ustawiana razem z renderRevealPath
let renderRevealChain: RenderNode[] = [];
// Popupy (lista/menu) rysujemy na nakładce korzenia, nie wewnątrz kontrolki — inaczej overflow:hidden
// kontenerów (StackPanel/DockPanel/Grid) by je przyciął. Zbieramy je w trakcie i pozycjonujemy po layoucie.
let pendingPopups: { owner: HTMLElement; popup: HTMLElement }[] = [];
// Pamięć przewinięć ScrollViewerów (per id) — przeżywa przebudowę DOM (zaznaczenie/edycja), żeby
// pozycja scrolla nie resetowała się przy każdym re-renderze (parność z WPF).
const scrollMemory = new Map<number, { top: number; left: number }>();
// Pamięć przewinięć popupów listy/menu (klucz "combo:id"/"menu:id") — popupy są przebudowywane przy
// każdym renderze, więc bez tego wybór pozycji z przewiniętej listy resetowałby scroll do początku.
const popupScroll = new Map<string, number>();

/** Ścieżka id (korzeń→zaznaczenie) — ale tylko gdy auto-podgląd włączony i na ścieżce jest ComboBox/Menu. */
function computeRevealPath(root: RenderNode, selectedId: number | null, autoReveal: boolean): Set<number> {
  const out = new Set<number>();
  renderRevealChain = [];
  if (!autoReveal || selectedId === null) return out;
  const path: RenderNode[] = [];
  const dfs = (n: RenderNode): boolean => {
    path.push(n);
    if (n.id === selectedId) return true;
    for (const c of n.children) if (dfs(c)) return true;
    path.pop();
    return false;
  };
  if (!dfs(root)) return out;
  if (!path.some((n) => REVEAL_TAGS.has(localName(n.tag)))) return out;
  for (const n of path) out.add(n.id);
  renderRevealChain = path.slice(); // korzeń→zaznaczenie
  return out;
}

/** Dzieci menu istotne wizualnie: MenuItem + Separator (w kolejności dokumentu). */
function menuChildren(n: RenderNode): RenderNode[] {
  return n.children.filter((c) => {
    const t = localName(c.tag);
    return t === "MenuItem" || t === "Separator";
  });
}

/** Wpisuje tekst z obsługą access-key WPF: pierwszy `_` znika i podkreśla następną literę (`__`→`_`). */
function setAccelText(el: HTMLElement, s: string) {
  el.textContent = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === "_" && i + 1 < s.length) {
      if (s[i + 1] === "_") {
        el.append(document.createTextNode("_")); // `__` = dosłowny podkreślnik
        i += 2;
        continue;
      }
      const u = document.createElement("u");
      u.textContent = s[i + 1];
      // WPF pokazuje podkreślenie akceleratora dopiero po wciśnięciu Alt — w podglądzie
      // statycznym litera jest bez podkreślenia (klasa zostaje dla ewentualnych motywów)
      u.style.textDecoration = "none";
      el.append(u); // litera akceleratora — bez `_`
      // reszta dosłownie
      el.append(document.createTextNode(s.slice(i + 2)));
      return;
    }
    el.append(document.createTextNode(s[i]));
    i++;
  }
}

/** Tekst pozycji listy/menu: Content/Header (atrybut) lub bezpośrednia treść tekstowa. */
function itemText(n: RenderNode): string {
  const c = attrOf(n, "Content");
  if (c !== undefined) {
    const t = resolveText(c); // {Binding …} → "" → spróbuj dalej
    if (t) return t;
  }
  const h = attrOf(n, "Header");
  if (h !== undefined) {
    const t = resolveText(h);
    if (t) return t;
  }
  return n.text ?? localName(n.tag);
}

/** Wybrany indeks ComboBox: IsSelected na pozycji, potem SelectedIndex, w ostateczności 0. */
function comboSelectedIndex(combo: RenderNode, items: RenderNode[]): number {
  const sel = items.findIndex((it) => /true/i.test(attrOf(it, "IsSelected") || ""));
  if (sel >= 0) return sel;
  const si = num(attrOf(combo, "SelectedIndex"));
  if (si !== undefined && si >= 0 && si < items.length) return si;
  return -1; // WPF: brak IsSelected/SelectedIndex = puste pole (nie pierwsza pozycja)
}

/** Aktywna zakładka TabControl: zaznaczenie wewnątrz zakładki (auto-podgląd) → IsSelected → SelectedIndex → 0. */
function tabActiveIndex(tc: RenderNode, items: RenderNode[]): number {
  if (!items.length) return -1;
  // auto-podgląd: jeśli zaznaczenie (lub jego ścieżka) wpada w którąś zakładkę — pokaż właśnie ją
  const revealed = items.findIndex((it) => renderRevealPath.has(it.id));
  if (revealed >= 0) return revealed;
  // pamięć: ostatnio wybrana zakładka tego TabControl trwa przy zaznaczaniu elementów spoza niego
  const remembered = renderTabSelection?.get(tc.id);
  if (remembered != null) {
    const idx = items.findIndex((it) => it.id === remembered);
    if (idx >= 0) return idx;
  }
  const sel = items.findIndex((it) => /true/i.test(attrOf(it, "IsSelected") || ""));
  if (sel >= 0) return sel;
  const si = num(attrOf(tc, "SelectedIndex"));
  if (si !== undefined && si >= 0 && si < items.length) return si;
  return 0;
}

/** Separator listy/menu jako klikalny pasek (data-xve-id) z cienką linią — selektowalny i edytowalny. */
function buildSeparator(it: RenderNode): HTMLElement {
  const sep = document.createElement("div");
  sep.className = "xve-menu-sep";
  sep.dataset.xveId = String(it.id);
  if (it.id === renderSelectedId) sep.classList.add("xve-item-selected");
  const line = document.createElement("div");
  line.className = "xve-menu-sep-line";
  sep.appendChild(line);
  return sep;
}

/** Lista pozycji jako popup. `currentId` = bieżąca wartość ComboBox (IsSelected); honoruje Margin pozycji. */
function buildItemList(items: RenderNode[], cls: string, currentId?: number): HTMLElement {
  const pop = document.createElement("div");
  pop.className = "xve-popup " + cls;
  for (const it of items) {
    if (localName(it.tag) === "Separator") {
      pop.appendChild(buildSeparator(it));
      continue;
    }
    const row = document.createElement("div");
    row.className = "xve-popup-item";
    row.dataset.xveId = String(it.id);
    row.textContent = itemText(it);
    const mar = attrOf(it, "Margin");
    if (mar) {
      const [l, t, r, b] = thickness(mar);
      row.style.margin = `${t}px ${r}px ${b}px ${l}px`;
    }
    if (it.id === currentId) row.classList.add("xve-item-current"); // bieżąca wartość (IsSelected/SelectedIndex)
    if (it.id === renderSelectedId) row.classList.add("xve-item-selected"); // zaznaczenie w edytorze
    pop.appendChild(row);
  }
  return pop;
}

/** Wybrany indeks listy (ListBox/ListView): IsSelected na pozycji → SelectedIndex → brak (-1). */
function listSelectedIndex(host: RenderNode, items: RenderNode[]): number {
  const sel = items.findIndex((it) => /true/i.test(attrOf(it, "IsSelected") || ""));
  if (sel >= 0) return sel;
  const si = num(attrOf(host, "SelectedIndex"));
  if (si !== undefined && si >= 0 && si < items.length) return si;
  return -1;
}

/** Rekurencyjnie renderuje TreeViewItem z wcięciem wg głębokości; rozwija dzieci wg IsExpanded. */
function renderTreeItem(n: RenderNode, depth: number): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "xve-treeitem";
  const head = document.createElement("div");
  head.className = "xve-treeitem-head";
  head.dataset.xveId = String(n.id);
  head.style.paddingLeft = depth * 14 + 6 + "px";
  if (n.id === renderSelectedId) head.classList.add("xve-item-selected");
  const kids = n.children.filter((c) => localName(c.tag) === "TreeViewItem");
  // domyślnie rozwinięte w podglądzie (IsExpanded nieobecny → pokaż dzieci); jawne "False" zwija
  const expanded = !/false/i.test(attrOf(n, "IsExpanded") ?? "true");
  if (kids.length) {
    const chev = document.createElement("span");
    chev.className = "xve-treeitem-chevron";
    chev.textContent = expanded ? "▾" : "▸";
    head.appendChild(chev);
  }
  const label = document.createElement("span");
  label.textContent = resolveText(attrOf(n, "Header") ?? n.text ?? "");
  head.appendChild(label);
  wrap.appendChild(head);
  if (kids.length && expanded) for (const c of kids) wrap.appendChild(renderTreeItem(c, depth + 1));
  return wrap;
}

/** Rozmiar elementu-hosta kształtu (Line/Polygon/Polyline) wyliczony z geometrii, gdy brak jawnego Width/Height. */
function ensureShapeSize(el: HTMLElement, a: Map<string, string>, maxX: number, maxY: number) {
  if (a.get("Width") === undefined && maxX > 0) el.style.width = maxX + "px";
  if (a.get("Height") === undefined && maxY > 0) el.style.height = maxY + "px";
}

/** Parsuje listę punktów WPF "x,y x,y …" (lub przecinki/spacje mieszane) na pary [x,y]. */
export function parsePoints(s: string | undefined): [number, number][] {
  if (!s) return [];
  const nums = s.trim().split(/[\s,]+/).map((t) => parseFloat(t)).filter((v) => !isNaN(v));
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) out.push([nums[i], nums[i + 1]]);
  return out;
}

/** Mapuje widoczność paska przewijania WPF na CSS overflow. */
function sbOverflow(v: string): string {
  switch (v) {
    case "Visible":
      return "scroll";
    case "Hidden":
    case "Disabled":
      return "hidden";
    default:
      return "auto"; // Auto
  }
}

/** Konwersja jednostki Row/ColumnDefinition (Height/Width) na ścieżkę CSS grid: `*`→fr, `Auto`→auto, liczba→px. */
export function gridTrack(def: string | undefined): string {
  if (def === undefined) return "1fr";
  const s = def.trim();
  if (s === "" || /^auto$/i.test(s)) return s === "" ? "1fr" : "auto";
  if (s.endsWith("*")) {
    const n = parseFloat(s.slice(0, -1));
    return (isNaN(n) || n <= 0 ? 1 : n) + "fr"; // "*"→1fr, "2*"→2fr
  }
  const n = parseFloat(s);
  return isNaN(n) ? "auto" : n + "px";
}

/** Definicje wierszy/kolumn Grida z elementu-właściwości `*.RowDefinitions`/`*.ColumnDefinitions`. */
function gridDefs(n: RenderNode, kind: "Row" | "Column"): RenderNode[] {
  const holderSuffix = "." + kind + "Definitions";
  const holder = n.children.find((c) => localName(c.tag).endsWith(holderSuffix));
  if (!holder) return [];
  return holder.children.filter((c) => localName(c.tag) === kind + "Definition");
}

/** Ustawia CSS grid na elemencie Grid wg Row/ColumnDefinitions (brak → pojedyncza komórka 1fr). */
function setupGrid(el: HTMLElement, n: RenderNode) {
  const cols = gridDefs(n, "Column");
  const rows = gridDefs(n, "Row");
  el.style.display = "grid";
  const colTokens = cols.map((c) => gridTrack(attrOf(c, "Width")));
  const rowTokens = rows.map((r) => gridTrack(attrOf(r, "Height")));
  el.style.gridTemplateColumns = colTokens.length ? colTokens.join(" ") : "1fr";
  el.style.gridTemplateRows = rowTokens.length ? rowTokens.join(" ") : "1fr";
  // SharedSizeGroup: zapamiętaj oryginalne tokeny i indeksy ścieżek w grupie — wyrównanie po layoucie.
  recordShared(el, cols, "Col", colTokens);
  recordShared(el, rows, "Row", rowTokens);
}

/** Zapisuje na elemencie Grid mapę „indeks ścieżki → SharedSizeGroup" + oryginalne tokeny (dla osi). */
function recordShared(el: HTMLElement, defs: RenderNode[], axis: "Col" | "Row", tokens: string[]) {
  const shared = defs
    .map((d, i) => [i, attrOf(d, "SharedSizeGroup")] as const)
    .filter(([, g]) => g);
  if (!shared.length) return;
  el.dataset[`xveTokens${axis}`] = tokens.join("|");
  el.dataset[`xveShared${axis}`] = shared.map(([i, g]) => `${i}:${g}`).join(";");
}

/** Parsuje Margin/Thickness "l,t,r,b" lub "x" lub "h,v". */
function thickness(v: string | undefined): [number, number, number, number] {
  if (!v) return [0, 0, 0, 0];
  const p = v.split(",").map((s) => parseFloat(s.trim()) || 0);
  if (p.length === 1) return [p[0], p[0], p[0], p[0]];
  if (p.length === 2) return [p[0], p[1], p[0], p[1]];
  return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 0];
}

/** Konwersja pędzla/koloru WPF na CSS (#AARRGGBB → rgba, nazwy zwykle zgodne). */
export function cssColor(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const s = v.trim();
  if (s.startsWith("{")) {
    // markup-extension: {Static/DynamicResource K} → kolor z zasobów; inne ({Binding}…) → brak
    const key = resourceKey(s);
    return key ? lookupBrushColor(key) : undefined;
  }
  if (s.startsWith("#")) {
    const h = s.slice(1);
    if (h.length === 8) {
      const a = parseInt(h.slice(0, 2), 16) / 255;
      const r = parseInt(h.slice(2, 4), 16);
      const g = parseInt(h.slice(4, 6), 16);
      const b = parseInt(h.slice(6, 8), 16);
      return `rgba(${r},${g},${b},${a.toFixed(3)})`;
    }
    if (h.length === 4) {
      const a = parseInt(h[0] + h[0], 16) / 255;
      const r = parseInt(h[1] + h[1], 16);
      const g = parseInt(h[2] + h[2], 16);
      const b = parseInt(h[3] + h[3], 16);
      return `rgba(${r},${g},${b},${a.toFixed(3)})`;
    }
    return s; // #RGB lub #RRGGBB — CSS rozumie
  }
  return s;
}

function num(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = parseFloat(v);
  return isNaN(n) ? undefined : n;
}

// WPF FontFamily.LineSpacing popularnych czcionek Windows (wysokość linii / FontSize).
// Wartości z metryk hhea czcionek systemowych — zgodne z tym, co mierzy host WPF.
const FONT_LINE_SPACING: Record<string, number> = {
  "segoe ui": 1.33008,
  "segoe ui light": 1.33008,
  "segoe ui semibold": 1.33008,
  "segoe ui semilight": 1.33008,
  "segoe ui black": 1.33008,
  consolas: 1.16992,
  calibri: 1.22071,
  cambria: 1.17188,
  "courier new": 1.13281,
  arial: 1.1499,
  "times new roman": 1.1499,
  tahoma: 1.20703,
  verdana: 1.21582,
  georgia: 1.13623,
  "trebuchet ms": 1.16357,
  "comic sans ms": 1.39404,
  "lucida console": 1.00098,
  "microsoft sans serif": 1.13281,
  // czcionki ikon: glify zajmują cały firet — WPF mierzy wysokość linii = FontSize
  "segoe mdl2 assets": 1.0,
  "segoe fluent icons": 1.0,
  marlett: 1.0,
};

function applyCommon(el: HTMLElement, a: Map<string, string>) {
  const name = a.get("Name") || a.get("x:Name");
  if (name) el.dataset.name = name;
  const tt = a.get("ToolTip");
  if (tt) el.title = tt;
  const fs = num(a.get("FontSize"));
  if (fs) el.style.fontSize = fs + "px";
  const fw = a.get("FontWeight");
  if (fw) el.style.fontWeight = /bold/i.test(fw) ? "bold" : fw.toLowerCase();
  const fst = a.get("FontStyle");
  if (fst && /italic/i.test(fst)) el.style.fontStyle = "italic";
  const ff = a.get("FontFamily");
  if (ff) {
    el.style.fontFamily = ff;
    // WPF liczy wysokość linii z metryk czcionki (FontFamily.LineSpacing), a web ma stałe
    // 1.333333 (= Segoe UI). Dla innych popularnych czcionek Windows bez korekty auto-wysokość
    // TextBlocków rozjeżdża się z hostem (np. Consolas: 1.17, nie 1.33).
    const lh = FONT_LINE_SPACING[ff.split(",")[0].trim().replace(/^["']|["']$/g, "").toLowerCase()];
    if (lh !== undefined) el.style.lineHeight = String(lh);
  }
  const fg = cssColor(a.get("Foreground"));
  if (fg) el.style.color = fg;
  const op = num(a.get("Opacity"));
  if (op !== undefined) el.style.opacity = String(op);
  const ta = a.get("TextAlignment") || a.get("HorizontalContentAlignment");
  if (ta) {
    el.style.textAlign = ta.toLowerCase();
    el.style.justifyContent = mapAlign(ta);
  }
  const va = a.get("VerticalContentAlignment");
  if (va) el.style.alignItems = mapAlign(va);
  // klasą (nie style.display) — gałęzie kontenerów niżej ustawiają własne display:flex/grid
  // i nadpisywały inline "none": Collapsed element był widoczny i zajmował miejsce w układzie
  if (a.get("Visibility") === "Collapsed") el.classList.add("xve-collapsed");
  if (a.get("Visibility") === "Hidden") el.style.visibility = "hidden";
  if (/false/i.test(a.get("IsEnabled") || "")) {
    el.setAttribute("disabled", "true");
    el.classList.add("xve-disabled");
  }
  const pad = a.get("Padding");
  if (pad) {
    const [pl, pt, pr, pb] = thickness(pad);
    el.style.padding = `${pt}px ${pr}px ${pb}px ${pl}px`;
  }
}

/** Pozycjonuje wrapper w kontekście layoutu rodzica (Margin / alignment / Canvas.*). */
function positionInParent(el: HTMLElement, a: Map<string, string>, parent: Layout) {
  const [ml, mt, mr, mb] = thickness(a.get("Margin"));
  const w = num(a.get("Width"));
  const h = num(a.get("Height"));
  const minW = num(a.get("MinWidth"));
  const minH = num(a.get("MinHeight"));
  const maxW = num(a.get("MaxWidth"));
  const maxH = num(a.get("MaxHeight"));
  if (w !== undefined) el.style.width = w + "px";
  if (h !== undefined) el.style.height = h + "px";
  // WPF: rozmiar użyty = clamp(value, min, max). Jawny Width/Height musi wygrać z domyślnym
  // min-* motywu (reguły .xve-control/.xve-button), bo w CSS min-* normalnie bije height.
  // Dlatego gdy jest jawny rozmiar bez jawnego min — wymuszamy inline min-* = 0.
  el.style.minWidth = minW !== undefined ? minW + "px" : w !== undefined ? "0" : "";
  el.style.minHeight = minH !== undefined ? minH + "px" : h !== undefined ? "0" : "";
  if (maxW !== undefined) el.style.maxWidth = maxW + "px";
  if (maxH !== undefined) el.style.maxHeight = maxH + "px";

  // zawartość ScrollViewer: normalny przepływ blokowy (pozycja statyczna) → dziecko rośnie do swojej
  // naturalnej wysokości i może przekroczyć viewport, co dopiero uruchamia przewijanie (jak w WPF).
  if (parent === "block") {
    el.style.margin = `${mt}px ${mr}px ${mb}px ${ml}px`;
    return;
  }

  // pojedyncze dziecko wrappera treści (Border/ContentControl/…): flow w kolumnie rodzica.
  // flex 1 1 auto → bez Height rodzic = wysokość dziecka; z Height dziecko wypełnia (dwukierunkowo).
  if (parent === "content") {
    el.style.margin = `${mt}px ${mr}px ${mb}px ${ml}px`;
    el.style.flex = "1 1 auto";
    const ha = a.get("HorizontalAlignment");
    if (ha && ha !== "Stretch") el.style.alignSelf = mapAlign(ha);
    else if (w !== undefined) el.style.alignSelf = "flex-start"; // jawna szerokość → nie rozciągaj
    else el.style.alignSelf = "stretch";
    // VerticalAlignment ≠ Stretch: nie rozciągaj w pionie — naturalna wysokość, wyrównana (jak WPF,
    // np. TextBlock VerticalAlignment="Center" w Borderze). Stretch (domyślnie) zostaje flex 1 1 auto.
    const va = a.get("VerticalAlignment");
    if (va && va !== "Stretch") {
      el.style.flex = "0 0 auto";
      if (va === "Center") {
        el.style.marginTop = "auto";
        el.style.marginBottom = "auto";
      } else if (va === "Bottom") el.style.marginTop = "auto";
      else if (va === "Top") el.style.marginBottom = "auto";
    }
    return;
  }

  // dziecko DockPanela: zadokowane (rozmiar wg treści/jawny) lub wypełniające (reszta miejsca).
  if (parent === "dock" || parent === "dock-fill") {
    el.style.margin = `${mt}px ${mr}px ${mb}px ${ml}px`;
    el.style.flex = parent === "dock-fill" ? "1 1 auto" : "0 0 auto";
    el.style.alignSelf = "stretch"; // wypełnij oś poprzeczną (jak DockPanel WPF)
    if (parent === "dock-fill") {
      if (!el.style.minWidth) el.style.minWidth = "0";
      if (!el.style.minHeight) el.style.minHeight = "0";
    }
    return;
  }

  if (parent === "stack-v" || parent === "stack-h" || parent === "flow") {
    el.style.margin = `${mt}px ${mr}px ${mb}px ${ml}px`;
    const ha = a.get("HorizontalAlignment");
    const va = a.get("VerticalAlignment");
    if (parent === "stack-v") {
      if (ha && ha !== "Stretch") el.style.alignSelf = mapAlign(ha);
      else if (w !== undefined) el.style.alignSelf = "center";
      else el.style.alignSelf = "stretch";
    }
    if (parent === "stack-h") {
      if (va && va !== "Stretch") el.style.alignSelf = mapAlign(va);
      else if (h !== undefined) el.style.alignSelf = "center";
      else el.style.alignSelf = "stretch";
    }
    return;
  }

  if (parent === "grid-cell") {
    // dziecko Grida: umieszczenie w komórce (Grid.Row/Column + spany), wyrównanie wewnątrz komórki.
    el.style.margin = `${mt}px ${mr}px ${mb}px ${ml}px`;
    const col = num(a.get("Grid.Column")) ?? 0;
    const row = num(a.get("Grid.Row")) ?? 0;
    const cs = num(a.get("Grid.ColumnSpan"));
    const rs = num(a.get("Grid.RowSpan"));
    el.style.gridColumn = `${col + 1}${cs && cs > 1 ? " / span " + cs : ""}`;
    el.style.gridRow = `${row + 1}${rs && rs > 1 ? " / span " + rs : ""}`;
    // Stretch (domyślne) wypełnia komórkę; z jawnym Width/Height CSS i tak użyje rozmiaru (start).
    el.style.justifySelf = mapAlign(a.get("HorizontalAlignment") || "Stretch");
    el.style.alignSelf = mapAlign(a.get("VerticalAlignment") || "Stretch");
    return;
  }

  // grid / canvas / content → absolutne pozycjonowanie
  el.style.position = "absolute";
  if (parent === "canvas") {
    const cl = num(a.get("Canvas.Left"));
    const ct = num(a.get("Canvas.Top"));
    const cr = num(a.get("Canvas.Right"));
    const cb = num(a.get("Canvas.Bottom"));
    if (cl !== undefined) el.style.left = cl + "px";
    if (ct !== undefined) el.style.top = ct + "px";
    if (cr !== undefined) el.style.right = cr + "px";
    if (cb !== undefined) el.style.bottom = cb + "px";
    return;
  }

  const ha = a.get("HorizontalAlignment") || "Stretch";
  const va = a.get("VerticalAlignment") || "Stretch";
  if (ha === "Left") el.style.left = ml + "px";
  else if (ha === "Right") el.style.right = mr + "px";
  else if (ha === "Center") {
    el.style.left = "50%";
    el.style.transform = (el.style.transform || "") + " translateX(-50%)";
  } else {
    el.style.left = ml + "px";
    el.style.right = mr + "px";
  }
  if (va === "Top") el.style.top = mt + "px";
  else if (va === "Bottom") el.style.bottom = mb + "px";
  else if (va === "Center") {
    el.style.top = "50%";
    el.style.transform = (el.style.transform || "") + " translateY(-50%)";
  } else {
    el.style.top = mt + "px";
    el.style.bottom = mb + "px";
  }
}

function mapAlign(a: string): string {
  switch (a) {
    case "Left":
    case "Top":
      return "flex-start";
    case "Right":
    case "Bottom":
      return "flex-end";
    case "Center":
      return "center";
    default:
      return "stretch";
  }
}

function childLayout(tag: string, a: Map<string, string>): Layout {
  switch (localName(tag)) {
    case "Canvas":
      return "canvas";
    case "StackPanel":
      return /horizontal/i.test(a.get("Orientation") || "") ? "stack-h" : "stack-v";
    case "WrapPanel":
      return "flow";
    case "ToolBarTray":
      return /vertical/i.test(a.get("Orientation") || "") ? "stack-v" : "stack-h";
    default:
      return "grid";
  }
}

/** Dzieci-elementy istotne wizualnie (bez property-elementów typu Button.Style). */
function visualChildren(n: RenderNode): RenderNode[] {
  return n.children.filter((c) => !isPropertyElement(c.tag));
}

/** Dorysowuje jeden element inline (Run/Bold/Italic/Underline/Hyperlink/LineBreak/…) do TextBlocka. */
function appendInline(parent: HTMLElement, c: RenderNode): void {
  const t = localName(c.tag);
  if (t === "LineBreak") {
    parent.appendChild(document.createElement("br"));
    return;
  }
  const seg = resolveText(attrOf(c, "Text") ?? c.text ?? "");
  if (t === "Bold" || t === "Italic" || t === "Underline" || t === "Hyperlink") {
    const span = document.createElement("span");
    if (t === "Bold") span.style.fontWeight = "bold";
    else if (t === "Italic") span.style.fontStyle = "italic";
    else span.style.textDecoration = "underline";
    span.textContent = seg;
    parent.appendChild(span);
  } else {
    parent.appendChild(document.createTextNode(seg));
  }
}

/**
 * Treść kontrolki zawartości (Button/RadioButton/…): gdy ma dzieci-elementy (np. ikona `TextBlock`),
 * renderuje je wyśrodkowane; w przeciwnym razie tekst z `Content`/treści. Dzięki temu ikony w przyciskach
 * działają, a kontrolka z własną treścią nie pokazuje natywnego kółka/boxa (zwykle ma własny szablon).
 */
function renderControlContent(el: HTMLElement, n: RenderNode, a: Map<string, string>): boolean {
  const kids = visualChildren(n);
  if (kids.length) {
    el.style.display = "flex";
    el.style.alignItems = "center";
    el.style.justifyContent = "center";
    for (const c of kids) {
      const ce = renderNode(c, "stack-h");
      ce.style.alignSelf = "center"; // wyśrodkuj ikonę w pionie (nie rozciągaj)
      el.appendChild(ce);
    }
    return true;
  }
  el.textContent = resolveText(a.get("Content") ?? n.text ?? "");
  return false;
}

/** Renderuje pojedynczy węzeł; zwraca wrapper z `data-xve-id`. */
function renderNode(n: RenderNode, parent: Layout): HTMLElement {
  const a = effectiveAttrs(n); // atrybuty inline + settery stylów (implicit / StaticResource / BasedOn)
  const name = localName(n.tag);
  const el = document.createElement("div");
  el.className = "xve-el";
  el.dataset.xveId = String(n.id);
  if (/true/i.test(a.get("Grid.IsSharedSizeScope") || "")) el.dataset.xveSharedscope = "";
  positionInParent(el, a, parent);
  applyCommon(el, a);

  // tło / obramowanie wspólne dla kontenerów i kontrolek
  const bgRaw = a.get("Background");
  const bg = cssColor(bgRaw);
  const bgImg = resolveBrushRef(bgRaw).image; // ImageBrush z zasobu (np. {DynamicResource WindowBackgroundBrush})
  if (bgImg) {
    el.style.backgroundImage = `url("${bgImg}")`;
    el.style.backgroundSize = "cover";
    el.style.backgroundPosition = "center";
  } else if (bg) {
    el.style.background = bg;
  }
  const bb = cssColor(a.get("BorderBrush"));
  const bt = thickness(a.get("BorderThickness"));
  if (bb && (bt[0] || bt[1] || bt[2] || bt[3])) {
    el.style.borderStyle = "solid";
    el.style.borderColor = bb;
    el.style.borderWidth = `${bt[1]}px ${bt[2]}px ${bt[3]}px ${bt[0]}px`;
  }
  const cr = num(a.get("CornerRadius"));
  if (cr !== undefined) el.style.borderRadius = cr + "px";

  const mine = childLayout(n.tag, a);

  switch (name) {
    case "Window":
    case "UserControl":
    case "Page": {
      const w = num(a.get("Width"));
      const h = num(a.get("Height"));
      el.classList.add("xve-window");
      el.style.position = "relative";
      el.style.width = (w ?? 640) + "px";
      el.style.height = (h ?? 480) + "px";
      // tło/kolor: jawne z XAML wygrywają (inline); brak → domyślne z motywu (CSS .xve-window)
      if (bg) el.style.background = bg;
      renderChildren(el, n, "grid");
      return el;
    }
    case "Grid": {
      el.style.overflow = "hidden";
      setupGrid(el, n); // display:grid + szablon wg Row/ColumnDefinitions (brak → 1 komórka)
      renderChildren(el, n, "grid-cell");
      return el;
    }
    case "Border":
      el.style.overflow = "hidden";
      if (!el.style.position) el.style.position = "relative";
      // wrapper treści: pojedyncze dziecko w przepływie → Border bez Height rośnie do zawartości (jak WPF)
      el.style.display = "flex";
      el.style.flexDirection = "column";
      renderChildren(el, n, "content");
      return el;
    case "Viewbox": {
      // Viewbox skaluje pojedyncze dziecko do dostępnego miejsca. Skalę liczymy po layoucie
      // (znamy wtedy rozmiar treści i kontenera) w scaleViewboxes() — tu tylko centrowanie + znaczniki.
      el.style.overflow = "hidden";
      if (!el.style.position) el.style.position = "relative";
      el.style.display = "flex";
      el.style.alignItems = "center";
      el.style.justifyContent = "center";
      el.dataset.xveViewbox = "";
      el.dataset.xveStretch = a.get("Stretch") || "Uniform";
      renderChildren(el, n, "content");
      // dziecko Viewboxa renderujemy w NATURALNYM rozmiarze i centrujemy; skalę narzuca scaleViewboxes.
      const vbChild = el.firstElementChild as HTMLElement | null;
      if (vbChild) {
        vbChild.style.flex = "0 0 auto";
        vbChild.style.alignSelf = "center";
        vbChild.style.marginTop = "";
        vbChild.style.marginBottom = "";
      }
      return el;
    }
    case "ScrollViewer": {
      el.classList.add("xve-scrollviewer"); // styl paska przewijania wg motywu
      // overflow wg widoczności pasków → natywne kółko przewija obszar pod kursorem (oba osie).
      // Domyślnie pionowo Auto (pasek tylko gdy treść wyższa niż viewport — bez „czarnego" paska na pełnej).
      const ox = sbOverflow(a.get("HorizontalScrollBarVisibility") ?? "Disabled");
      const oy = sbOverflow(a.get("VerticalScrollBarVisibility") ?? "Auto");
      el.style.overflowX = ox;
      el.style.overflowY = oy;
      if (!el.style.position) el.style.position = "relative";
      // dziecko w normalnym przepływie (block), nie absolutnie rozpięte — inaczej miałoby wysokość
      // viewportu i nigdy by nie przewijało.
      renderChildren(el, n, "block");
      const child = el.firstElementChild as HTMLElement | null;
      // poziomy scroll włączony → dziecko rośnie do szerokości treści (może przekroczyć viewport);
      // inaczej blok wypełnia tylko szerokość kontenera i poziomy pasek nigdy się nie pojawia.
      if (ox === "auto" || ox === "scroll") {
        if (child && !child.style.width) {
          child.style.width = "max-content";
          child.style.minWidth = "100%";
        }
      }
      // pionowy scroll: treść mniejsza niż viewport WYPEŁNIA go (parytet z WPF, który rozciąga
      // zawartość gdy się mieści), a większa rośnie i włącza przewijanie. Marginesy dziecka
      // odejmujemy — inaczej dziecko z Margin miałoby 100% + margines i sztucznie przewijało.
      if ((oy === "auto" || oy === "scroll") && child && !child.style.minHeight) {
        const my = (parseFloat(child.style.marginTop) || 0) + (parseFloat(child.style.marginBottom) || 0);
        child.style.minHeight = my ? `calc(100% - ${my}px)` : "100%";
      }
      return el;
    }
    case "Canvas":
      if (!el.style.position) el.style.position = "relative";
      renderChildren(el, n, "canvas");
      return el;
    case "StackPanel":
    case "WrapPanel":
      el.style.overflow = "hidden";
      el.style.display = "flex";
      if (mine === "flow") {
        // WrapPanel: domyślnie Orientation=Horizontal → elementy płyną w PRAWO i zawijają do
        // następnego WIERSZA (flex-direction:row + wrap). Vertical → w DÓŁ, zawijanie do kolumny.
        const vertical = /vertical/i.test(a.get("Orientation") || "");
        el.style.flexDirection = vertical ? "column" : "row";
        el.style.flexWrap = "wrap";
        el.style.alignContent = "flex-start"; // wiersze upakowane od góry (jak WPF), bez rozpychania
        el.style.alignItems = "center"; // WPF centruje elementy w poprzek wiersza (niższe wyśrodkowane)
      } else {
        el.style.flexDirection = mine === "stack-h" ? "row" : "column";
      }
      renderChildren(el, n, mine);
      return el;
    case "DockPanel":
      renderDockPanel(el, n);
      return el;
    case "TextBlock":
    case "Label": {
      el.classList.add("xve-text");
      // Label ma w WPF domyślny Padding=5 (TextBlock nie) — jawny Padding nadpisze to inline'em.
      if (name === "Label") el.classList.add("xve-label");
      // TextWrapping: domyślnie NoWrap (white-space:pre w CSS). Wrap/WrapWithOverflow → zawijanie,
      // żeby wysokość/szerokość zgadzały się z WPF (inaczej tekst zostaje jedną linią).
      const wrap = a.get("TextWrapping");
      if (wrap === "Wrap" || wrap === "WrapWithOverflow") {
        el.style.whiteSpace = "pre-wrap";
        // Wrap łamie też długie wyrazy; WrapWithOverflow pozwala im wystawać poza szerokość.
        el.style.overflowWrap = wrap === "Wrap" ? "break-word" : "normal";
      } else if (a.get("Width") !== undefined) {
        // NoWrap z jawną szerokością: WPF przycina tekst do granic TextBlocka (web domyślnie by go pokazał).
        el.style.overflow = "hidden";
      }
      const direct = a.get("Text") ?? a.get("Content");
      if (direct !== undefined) {
        el.textContent = resolveText(direct);
        return el;
      }
      // Mieszana treść inline (tekst + <Run>/<LineBreak>/<Bold>…) z zachowaną KOLEJNOŚCIĄ — patrz
      // XamlDocument.toTree (inlines). Bez tego tekst wokół <LineBreak/> ginął (była tylko lista elementów).
      if (n.inlines?.length) {
        for (const part of n.inlines) {
          if ("text" in part) el.appendChild(document.createTextNode(resolveText(part.text)));
          else appendInline(el, part.node);
        }
        return el;
      }
      // inline tylko z elementów: <Run>/<Span>/<LineBreak>/<Bold>… (Loc rozwiązywany jak w atrybucie)
      const inlines = visualChildren(n);
      if (inlines.length) {
        for (const c of inlines) appendInline(el, c);
        return el;
      }
      el.textContent = resolveText(n.text ?? "");
      return el;
    }
    case "Button": {
      el.classList.add("xve-control", "xve-button");
      renderControlContent(el, n, a);
      return el;
    }
    case "TextBox": {
      el.classList.add("xve-control", "xve-textbox");
      el.textContent = resolveText(a.get("Text") ?? n.text ?? "");
      return el;
    }
    case "CheckBox":
    case "RadioButton": {
      el.classList.add("xve-control");
      // własna treść (np. ikona) → kontrolka jak przycisk z szablonu (bez natywnego kółka/boxa)
      if (visualChildren(n).length) {
        el.classList.add("xve-button");
        // IsChecked=True → stan „wciśnięty" jak ToggleButton (WPF: trigger szablonu podświetla tło)
        if (/true/i.test(a.get("IsChecked") || "")) el.classList.add("xve-toggled");
        renderControlContent(el, n, a);
        return el;
      }
      el.classList.add("xve-check");
      const box = document.createElement("span");
      box.className = "xve-checkbox";
      if (/true/i.test(a.get("IsChecked") || "")) box.classList.add("checked");
      if (name === "RadioButton") box.classList.add("radio");
      const lbl = document.createElement("span");
      lbl.textContent = resolveText(a.get("Content") ?? n.text ?? "");
      el.appendChild(box);
      el.appendChild(lbl);
      return el;
    }
    case "Slider": {
      el.classList.add("xve-control", "xve-slider");
      const min = num(a.get("Minimum")) ?? 0;
      const max = num(a.get("Maximum")) ?? 100;
      const val = num(a.get("Value")) ?? min;
      const pct = max > min ? ((val - min) / (max - min)) * 100 : 0;
      const track = document.createElement("div");
      track.className = "xve-slider-track";
      const fill = document.createElement("div");
      fill.className = "xve-slider-fill";
      fill.style.width = pct + "%";
      const thumb = document.createElement("div");
      thumb.className = "xve-slider-thumb";
      thumb.style.left = pct + "%";
      track.appendChild(fill);
      track.appendChild(thumb);
      el.appendChild(track);
      return el;
    }
    case "ProgressBar": {
      el.classList.add("xve-control", "xve-progress");
      const min = num(a.get("Minimum")) ?? 0;
      const max = num(a.get("Maximum")) ?? 100;
      const val = num(a.get("Value")) ?? 0;
      const pct = max > min ? ((val - min) / (max - min)) * 100 : 0;
      const fill = document.createElement("div");
      fill.className = "xve-progress-fill";
      fill.style.width = pct + "%";
      el.appendChild(fill);
      return el;
    }
    case "Image": {
      el.classList.add("xve-control");
      const src = a.get("Source");
      // Stretch WPF Image: domyślnie Uniform. Fill=rozciągnij (ignoruj proporcje), UniformToFill=wypełnij
      // z przycięciem, None=natywny rozmiar. Mapujemy na object-fit.
      const stretch = a.get("Stretch") ?? "Uniform";
      const objectFit =
        stretch === "Fill" ? "fill" : stretch === "UniformToFill" ? "cover" : stretch === "None" ? "none" : "contain";
      // ścieżki z dysku rozwiązuje extension na webview-URI (renderImageUris); przy błędzie ładowania
      // pokazujemy placeholder z nazwą pliku (parność z trybem WPF).
      if (src) {
        const img = document.createElement("img");
        img.style.width = "100%";
        img.style.height = "100%";
        img.style.objectFit = objectFit;
        img.onerror = () => {
          img.remove();
          el.classList.add("xve-placeholder");
          el.textContent = src.replace(/^.*[\\/]/, "") || "Image";
        };
        // Uniform: WPF KURCZY element do wpisanego (letterbox) rozmiaru obrazu — nie zostawia pustego
        // pudełka Width×Height. Po załadowaniu znamy proporcje → dociągamy wymiar jak ActualW/H hosta:
        //  • Width i Height jawne → wpisz obraz w pudełko (krótsza oś maleje),
        //  • tylko jedna oś jawna → drugą wylicz z proporcji,
        //  • żadna → rozmiar natywny (element sam się dopasuje do <img>).
        if (stretch === "Uniform") {
          img.addEventListener("load", () => {
            const na = img.naturalWidth / img.naturalHeight;
            if (!(na > 0)) return;
            const w = num(a.get("Width"));
            const h = num(a.get("Height"));
            if (w !== undefined && h !== undefined) {
              if (na > w / h) el.style.height = w / na + "px";
              else el.style.width = h * na + "px";
            } else if (w !== undefined) {
              el.style.height = w / na + "px";
            } else if (h !== undefined) {
              el.style.width = h * na + "px";
            } else {
              el.style.width = img.naturalWidth + "px";
              el.style.height = img.naturalHeight + "px";
            }
          });
        }
        img.src = renderImageUris[src] ?? src;
        el.appendChild(img);
      } else {
        el.classList.add("xve-placeholder");
        el.textContent = "Image";
      }
      return el;
    }
    case "Ellipse":
    case "Rectangle": {
      el.classList.add("xve-shape");
      const fill = cssColor(a.get("Fill"));
      if (fill) el.style.background = fill;
      const stroke = cssColor(a.get("Stroke"));
      const sw = num(a.get("StrokeThickness"));
      if (stroke && sw) {
        el.style.borderStyle = "solid";
        el.style.borderColor = stroke;
        el.style.borderWidth = sw + "px";
      }
      if (name === "Ellipse") el.style.borderRadius = "50%";
      else if (cr === undefined) el.style.borderRadius = "0";
      return el;
    }
    case "ComboBox": {
      el.classList.add("xve-control", "xve-combobox");
      if (!el.style.position) el.style.position = "relative";
      const items = n.children.filter((c) => localName(c.tag) === "ComboBoxItem");
      const selIdx = comboSelectedIndex(n, items);
      const head = document.createElement("div");
      head.className = "xve-combobox-head";
      const txt = document.createElement("span");
      txt.className = "xve-combobox-text";
      txt.textContent = selIdx >= 0 ? itemText(items[selIdx]) : a.get("Text") ?? "";
      const arrow = document.createElement("span");
      arrow.className = "xve-combobox-arrow";
      arrow.textContent = "▾";
      head.append(txt, arrow);
      el.appendChild(head);
      // auto-podgląd: rozwiń listę pozycji (port ShowFakeListPreview) — na nakładce korzenia;
      // bieżąca wartość (selIdx) podświetlona, marginesy pozycji honorowane
      if (renderRevealPath.has(n.id) && items.length) {
        const popup = buildItemList(items, "xve-combo-popup", items[selIdx]?.id);
        popup.dataset.xvePopupKey = "combo:" + n.id; // stabilny klucz pamięci scrolla
        pendingPopups.push({ owner: el, popup });
      }
      return el;
    }
    case "Menu":
      el.classList.add("xve-menu");
      el.style.display = "flex";
      el.style.flexDirection = "row";
      renderChildren(el, n, "stack-h");
      return el;
    case "ContextMenu":
      el.classList.add("xve-menu-popup");
      if (!el.style.position) el.style.position = "relative";
      renderChildren(el, n, "stack-v");
      return el;
    case "MenuItem": {
      // pozycja paska menu (poziom górny) — sam nagłówek; podmenu rysuje kaskada (placeMenuCascade)
      el.classList.add("xve-menuitem");
      if (n.id === renderSelectedId) el.classList.add("xve-item-selected");
      const head = document.createElement("span");
      head.className = "xve-menuitem-head";
      setAccelText(head, resolveText(attrOf(n, "Header") ?? ""));
      el.appendChild(head);
      return el;
    }
    case "TabControl": {
      el.classList.add("xve-control", "xve-tabcontrol");
      el.style.overflow = "hidden";
      if (!el.style.position) el.style.position = "relative";
      el.style.display = "flex";
      el.style.flexDirection = "column";
      const items = n.children.filter((c) => localName(c.tag) === "TabItem");
      const activeIdx = tabActiveIndex(n, items);
      const strip = document.createElement("div");
      strip.className = "xve-tab-strip";
      items.forEach((it, i) => {
        const tab = document.createElement("div");
        tab.className = "xve-tab";
        if (i === activeIdx) tab.classList.add("xve-tab-active");
        if (it.id === renderSelectedId) tab.classList.add("xve-item-selected");
        tab.dataset.xveId = String(it.id); // klik = zaznaczenie TabItem → auto-podgląd przełącza zakładkę
        tab.textContent = itemText(it); // Header
        strip.appendChild(tab);
      });
      el.appendChild(strip);
      const body = document.createElement("div");
      body.className = "xve-tab-body";
      const active = items[activeIdx];
      if (active)
        for (const c of active.children) {
          if (isPropertyElement(c.tag)) continue; // TabItem.Header itp. — nie treść
          body.appendChild(renderNode(c, "grid"));
        }
      el.appendChild(body);
      return el;
    }
    case "UniformGrid": {
      el.style.overflow = "hidden";
      const visible = n.children.filter((c) => !isPropertyElement(c.tag));
      let cols = num(a.get("Columns"));
      let rows = num(a.get("Rows"));
      if (!cols && !rows) cols = Math.max(1, Math.ceil(Math.sqrt(visible.length || 1)));
      if (cols && !rows) rows = Math.max(1, Math.ceil(visible.length / cols));
      if (rows && !cols) cols = Math.max(1, Math.ceil(visible.length / rows));
      el.style.display = "grid";
      el.style.gridTemplateColumns = `repeat(${cols || 1}, 1fr)`;
      el.style.gridTemplateRows = `repeat(${rows || 1}, 1fr)`;
      renderChildren(el, n, "block"); // dzieci jako elementy grida (auto-flow), nie absolutne
      return el;
    }
    case "GroupBox": {
      el.classList.add("xve-groupbox");
      if (!el.style.position) el.style.position = "relative";
      const header = document.createElement("div");
      header.className = "xve-groupbox-header";
      header.textContent = a.get("Header") ?? "";
      el.appendChild(header);
      const body = document.createElement("div");
      body.className = "xve-groupbox-body";
      body.style.position = "relative";
      body.style.display = "flex";
      body.style.flexDirection = "column";
      for (const c of n.children) {
        if (isPropertyElement(c.tag)) continue;
        body.appendChild(renderNode(c, "content"));
      }
      el.appendChild(body);
      return el;
    }
    case "Expander": {
      el.classList.add("xve-expander");
      el.style.overflow = "hidden";
      el.style.display = "flex";
      el.style.flexDirection = "column";
      const expanded = /true/i.test(a.get("IsExpanded") ?? "");
      const header = document.createElement("div");
      header.className = "xve-expander-header";
      const chev = document.createElement("span");
      chev.className = "xve-expander-chevron";
      chev.textContent = expanded ? "▾" : "▸";
      const lbl = document.createElement("span");
      lbl.textContent = a.get("Header") ?? "";
      header.append(chev, lbl);
      el.appendChild(header);
      if (expanded) {
        const body = document.createElement("div");
        body.className = "xve-expander-body";
        body.style.position = "relative";
        body.style.flex = "1";
        body.style.display = "flex";
        body.style.flexDirection = "column";
        for (const c of n.children) {
          if (isPropertyElement(c.tag)) continue;
          body.appendChild(renderNode(c, "content"));
        }
        el.appendChild(body);
      }
      return el;
    }
    case "ListBox":
    case "ListView": {
      el.classList.add("xve-control", "xve-listbox");
      el.style.overflow = "auto";
      const itemTag = name === "ListView" ? "ListViewItem" : "ListBoxItem";
      const items = n.children.filter((c) => localName(c.tag) === itemTag);
      const cur = listSelectedIndex(n, items);
      items.forEach((it, i) => {
        const row = document.createElement("div");
        row.className = "xve-listitem";
        row.dataset.xveId = String(it.id);
        if (i === cur) row.classList.add("xve-item-current");
        if (it.id === renderSelectedId) row.classList.add("xve-item-selected");
        row.textContent = itemText(it);
        el.appendChild(row);
      });
      return el;
    }
    case "TreeView": {
      el.classList.add("xve-control", "xve-treeview");
      el.style.overflow = "auto";
      for (const c of n.children) {
        if (localName(c.tag) === "TreeViewItem") el.appendChild(renderTreeItem(c, 0));
      }
      return el;
    }
    case "TreeViewItem":
      // standalone (np. zaznaczony poza TreeView) — renderuj jako poddrzewo
      return renderTreeItem(n, 0);
    case "ToolBar": {
      el.classList.add("xve-toolbar");
      el.style.overflow = "hidden";
      el.style.display = "flex";
      el.style.flexDirection = "row";
      el.style.alignItems = "center";
      // Grip (rączka) i przycisk overflow to CZĘŚCI SZABLONU ToolBaru WPF — istnieją niezależnie
      // od Padding (np. Padding="0"); razem dają chrom 10px + 14px, jak zmierzony w hoście.
      const grip = document.createElement("div");
      grip.className = "xve-toolbar-grip";
      el.appendChild(grip);
      // ToolBarPanel WPF centruje pozycje w pionie (nie rozciąga) — inaczej combo/textbox rosłyby
      // na całą wysokość paska. Stąd align-self:center zamiast stretch z layoutu stack-h.
      // Wyjątki: Menu i Separator rozciągają się na wysokość paska (jak w WPF).
      for (const c of n.children) {
        if (isPropertyElement(c.tag)) continue;
        const ce = renderNode(c, "stack-h");
        const tag = localName(c.tag);
        if (tag !== "Menu" && tag !== "Separator") ce.style.alignSelf = "center";
        // ComboBox bez jawnego Margin: zdejmij inline'owy margines, żeby CSS motywu mógł dodać
        // 1px odstęp jak ToolBar.ComboBoxStyleKey w WPF classic
        if (tag === "ComboBox" && !attrOf(c, "Margin")) ce.style.margin = "";
        el.appendChild(ce);
      }
      const overflow = document.createElement("div");
      overflow.className = "xve-toolbar-overflow";
      el.appendChild(overflow);
      return el;
    }
    case "StatusBar": {
      // panel pozycji StatusBar to DockPanel → DockPanel.Dock="Right"/itd. działa
      el.classList.add("xve-statusbar");
      renderDockPanel(el, n);
      return el;
    }
    case "StatusBarItem": {
      // StatusBarItem to ContentControl — często zawiera StackPanel/kontrolki, nie sam tekst.
      // Padding 3px (domyślny WPF) nadaje klasa; jawny Padding z XAML nadpisuje inline'em.
      el.classList.add("xve-statusbaritem");
      if (visualChildren(n).length) {
        el.style.display = "flex";
        el.style.alignItems = "center";
        renderChildren(el, n, "stack-h");
        // VerticalContentAlignment=Center (domyślne w StatusBarItem WPF): treść ma naturalną
        // wysokość, wyśrodkowana — stack-h dawał stretch i np. TextBlock rósł na cały pasek
        for (const ch of el.children) (ch as HTMLElement).style.alignSelf = "center";
        return el;
      }
      el.classList.add("xve-text");
      el.textContent = resolveText(a.get("Content") ?? n.text ?? "");
      return el;
    }
    case "ListBoxItem":
    case "ListViewItem":
    case "ComboBoxItem": {
      el.classList.add("xve-text");
      el.textContent = resolveText(a.get("Content") ?? n.text ?? "");
      return el;
    }
    case "ToggleButton":
    case "RepeatButton": {
      el.classList.add("xve-control", "xve-button");
      if (name === "ToggleButton" && /true/i.test(a.get("IsChecked") || "")) el.classList.add("xve-toggled");
      renderControlContent(el, n, a);
      return el;
    }
    case "PasswordBox": {
      el.classList.add("xve-control", "xve-textbox");
      el.textContent = "••••••••";
      return el;
    }
    case "DatePicker": {
      el.classList.add("xve-control", "xve-datepicker");
      const txt = document.createElement("span");
      txt.className = "xve-datepicker-text";
      txt.textContent = a.get("SelectedDate") ?? a.get("Text") ?? "";
      const ico = document.createElement("span");
      ico.className = "xve-datepicker-icon";
      ico.textContent = "📅";
      el.append(txt, ico);
      return el;
    }
    case "Calendar": {
      el.classList.add("xve-control", "xve-calendar");
      // Pełny widok miesiąca jak WPF: nagłówek z nawigacją ◀ miesiąc rok ▶, wiersz dni tygodnia,
      // 6 tygodni z dopełnieniem dniami sąsiednich miesięcy (przygaszone). Kultura = locale
      // przeglądarki (host WPF używa kultury OS — na tej samej maszynie zwykle zgodne).
      const parsed = new Date(a.get("DisplayDate") ?? a.get("SelectedDate") ?? "");
      const today = isNaN(parsed.getTime()) ? new Date() : parsed;
      const selDate = new Date(a.get("SelectedDate") ?? "");
      // WIDOCZNY chrom żyje w wewnętrznym boxie: WPF classic rysuje kompaktowy kalendarz (~160px)
      // u góry slotu układu (179×265), Fluent wypełnia slot w całości (--xve-calendar-boxh)
      const box = document.createElement("div");
      box.className = "xve-calendar-box";
      const head = document.createElement("div");
      head.className = "xve-calendar-head";
      const mkNav = (cls: string) => {
        const s = document.createElement("span");
        s.className = "xve-calendar-nav " + cls; // glif z CSS (◀▶ classic, ▲▼ Fluent)
        return s;
      };
      // Quirk WPF: Calendar/DatePicker przy kulturze NEUTRALNEJ (bez regionu, np. "en"/"pl" —
      // typowa wartość vscode.env.language) formatuje wg InvariantCulture: tytuł "yyyy MMMM"
      // po angielsku, dni "Su Mo Tu We Th Fr Sa", tydzień od niedzieli. Kultura specyficzna
      // ("pl-PL") działa normalnie; undefined (brak parametru) = locale przeglądarki.
      const invariantLike = renderCulture !== undefined && !renderCulture.includes("-");
      const locale = invariantLike || !renderCulture ? undefined : renderCulture;
      const title = document.createElement("span");
      title.className = "xve-calendar-title";
      title.textContent = invariantLike
        ? `${today.getFullYear()} ${today.toLocaleDateString("en-US", { month: "long" })}`
        : today.toLocaleDateString(locale, { month: "long", year: "numeric" });
      head.append(mkNav("xve-calendar-prev"), title, mkNav("xve-calendar-next"));
      box.appendChild(head);
      const grid = document.createElement("div");
      grid.className = "xve-calendar-grid";
      // pierwszy dzień tygodnia wg kultury (Chromium: Intl.Locale.weekInfo; fallback poniedziałek);
      // invariant → niedziela i angielskie 2-literowe skróty jak ShortestDayNames WPF
      let firstDow = invariantLike ? 0 : 1;
      if (!invariantLike)
        try {
          const wi = (new Intl.Locale(locale ?? navigator.language) as unknown as { weekInfo?: { firstDay?: number } }).weekInfo;
          if (wi?.firstDay) firstDow = wi.firstDay % 7; // Intl: 1=pn…7=nd → JS: 0=nd
        } catch { /* stary silnik — zostaje poniedziałek */ }
      const INVARIANT_DOW = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
      const dowFmt = new Intl.DateTimeFormat(locale, { weekday: "narrow" });
      for (let i = 0; i < 7; i++) {
        const dow = document.createElement("div");
        dow.className = "xve-calendar-cell xve-calendar-dow";
        // 2024-09-01 to niedziela (dzień 0) — baza do wyznaczenia etykiet kolejnych dni tygodnia
        const idx = (firstDow + i) % 7;
        dow.textContent = invariantLike ? INVARIANT_DOW[idx] : dowFmt.format(new Date(2024, 8, idx + 1));
        grid.appendChild(dow);
      }
      const first = new Date(today.getFullYear(), today.getMonth(), 1);
      const lead = (first.getDay() - firstDow + 7) % 7 || 7; // WPF zawsze pokazuje ≥1 dzień poprzedniego miesiąca
      const start = new Date(first.getFullYear(), first.getMonth(), 1 - lead);
      for (let i = 0; i < 42; i++) {
        const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
        const cell = document.createElement("div");
        cell.className = "xve-calendar-cell";
        if (day.getMonth() !== today.getMonth()) cell.classList.add("xve-calendar-adjacent");
        if (!isNaN(selDate.getTime()) && day.toDateString() === selDate.toDateString())
          cell.classList.add("xve-calendar-selected");
        cell.textContent = String(day.getDate());
        grid.appendChild(cell);
      }
      box.appendChild(grid);
      el.appendChild(box);
      return el;
    }
    case "GridSplitter": {
      el.classList.add("xve-gridsplitter");
      return el;
    }
    case "Separator": {
      el.classList.add("xve-separator");
      // W poziomym przepływie (ToolBar/StatusBar[dock]/poziomy StackPanel) Separator WPF to PIONOWA
      // kreska rozciągnięta na wysokość rzędu; w pionowym — pozioma linia (dotychczasowe zachowanie).
      const dock = a.get("DockPanel.Dock");
      if (parent === "stack-h" || parent === "flow" || (parent === "dock" && dock !== "Top" && dock !== "Bottom")) {
        el.classList.add("xve-separator-v");
        el.style.alignSelf = "stretch";
        // bez jawnego Margin: zdejmij inline'owy margines z positionInParent, żeby zadziałały
        // marginesy motywu z CSS (inne w ToolBarze, inne w StatusBarze)
        if (!a.get("Margin")) el.style.margin = "";
      }
      return el;
    }
    case "MediaElement": {
      el.classList.add("xve-control", "xve-placeholder");
      el.textContent = a.get("Source") ? "▶ " + a.get("Source") : "MediaElement";
      return el;
    }
    case "Line":
    case "Polygon":
    case "Polyline": {
      el.classList.add("xve-shape-svg");
      const ns = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(ns, "svg");
      svg.setAttribute("width", "100%");
      svg.setAttribute("height", "100%");
      svg.style.overflow = "visible";
      const stroke = cssColor(a.get("Stroke")) ?? "var(--vscode-foreground, #888)";
      const sw = a.get("StrokeThickness") ?? "1";
      let shape: SVGElement;
      if (name === "Line") {
        const x1 = num(a.get("X1")) ?? 0;
        const y1 = num(a.get("Y1")) ?? 0;
        const x2 = num(a.get("X2")) ?? 0;
        const y2 = num(a.get("Y2")) ?? 0;
        shape = document.createElementNS(ns, "line");
        shape.setAttribute("x1", String(x1));
        shape.setAttribute("y1", String(y1));
        shape.setAttribute("x2", String(x2));
        shape.setAttribute("y2", String(y2));
        ensureShapeSize(el, a, Math.max(x1, x2), Math.max(y1, y2));
      } else {
        const pts = parsePoints(a.get("Points"));
        shape = document.createElementNS(ns, name.toLowerCase());
        shape.setAttribute("points", pts.map((p) => p.join(",")).join(" "));
        const fill = cssColor(a.get("Fill"));
        shape.setAttribute("fill", name === "Polyline" ? "none" : fill ?? "none");
        ensureShapeSize(el, a, Math.max(0, ...pts.map((p) => p[0])), Math.max(0, ...pts.map((p) => p[1])));
      }
      shape.setAttribute("stroke", stroke);
      shape.setAttribute("stroke-width", sw);
      svg.appendChild(shape);
      el.appendChild(svg);
      return el;
    }
    case "ToolBarTray": {
      el.classList.add("xve-toolbartray");
      el.style.overflow = "hidden";
      el.style.display = "flex";
      el.style.flexDirection = mine === "stack-v" ? "column" : "row";
      el.style.alignItems = "center";
      el.style.flexWrap = "wrap";
      renderChildren(el, n, mine);
      return el;
    }
    case "ItemsControl": {
      // bez ItemsSource (brak danych w web) zwykle pusty; bezpośrednie dzieci układamy pionowo
      // (domyślny ItemsPanel WPF to pionowy StackPanel)
      el.style.overflow = "hidden";
      el.style.display = "flex";
      el.style.flexDirection = "column";
      renderChildren(el, n, "stack-v");
      return el;
    }
    case "AdornerDecorator":
    case "Decorator":
    case "ContentControl":
    case "ContentPresenter": {
      // przezroczyste opakowania — pojedyncze dziecko w przepływie (sizują się do treści)
      if (!el.style.position) el.style.position = "relative";
      el.style.display = "flex";
      el.style.flexDirection = "column";
      renderChildren(el, n, "content");
      return el;
    }
    default: {
      // nieznany typ → placeholder, ale renderuj dzieci (mógł być kontenerem)
      el.classList.add("xve-placeholder");
      if (n.children.some((c) => !isPropertyElement(c.tag))) {
        if (!el.style.position) el.style.position = "relative";
        renderChildren(el, n, mine);
      } else el.textContent = name;
      return el;
    }
  }
}

function renderChildren(host: HTMLElement, n: RenderNode, layout: Layout) {
  for (const c of n.children) {
    if (isPropertyElement(c.tag)) continue; // np. Grid.RowDefinitions, *.Resources — nie wizualne
    host.appendChild(renderNode(c, layout));
  }
}

/**
 * DockPanel: dokowanie wg `DockPanel.Dock` + wypełnienie ostatnim dzieckiem (LastChildFill).
 * Wierna emulacja sekwencyjnego dokowania WPF przez zagnieżdżone flex-boksy — jeden poziom na każde
 * zadokowane dziecko; ostatnie (gdy LastChildFill) wypełnia pozostałe miejsce. Wrappery „rest" nie
 * mają data-xve-id, więc klik/zaznaczenie nadal trafiają w realne dzieci.
 */
function renderDockPanel(host: HTMLElement, n: RenderNode) {
  host.style.overflow = "hidden";
  host.style.display = "flex";
  if (!host.style.position) host.style.position = "relative";
  const kids = n.children.filter((c) => !isPropertyElement(c.tag));
  const lastFill = !/false/i.test(attrOf(n, "LastChildFill") ?? "true");
  let cur = host;
  for (let i = 0; i < kids.length; i++) {
    const child = kids[i];
    if (i === kids.length - 1 && lastFill) {
      cur.appendChild(renderNode(child, "dock-fill"));
      return;
    }
    const dock = attrOf(child, "DockPanel.Dock") || "Left"; // domyślny Dock WPF = Left
    cur.style.flexDirection = /^(top|bottom)$/i.test(dock) ? "column" : "row";
    const childEl = renderNode(child, "dock");
    const rest = document.createElement("div");
    rest.style.flex = "1 1 auto";
    rest.style.display = "flex";
    rest.style.position = "relative";
    rest.style.minWidth = "0";
    rest.style.minHeight = "0";
    rest.style.overflow = "hidden";
    if (/^(bottom|right)$/i.test(dock)) cur.append(rest, childEl);
    else cur.append(childEl, rest);
    cur = rest;
  }
}

/** Pozycjonuje zebrane popupy na nakładce korzenia (poza overflow:hidden kontenerów). Gdy lista jest
 *  wyższa niż miejsce w oknie podglądu — ogranicza wysokość i włącza pasek przewijania (jak prawdziwy
 *  WPF: dropdown mieści się na ekranie, a nadmiar pozycji jest dostępny przez scroll). */
function placePopups(rootEl: HTMLElement, zoom: number) {
  if (!pendingPopups.length) return;
  const rr = rootEl.getBoundingClientRect();
  // skala wprost z geometrii (rr to rozmiar po transformacie #zoom) — niezależna od momentu wywołania
  const z = rootEl.offsetWidth > 0 ? rr.width / rootEl.offsetWidth : zoom > 0 ? zoom : 1;
  const H = rootEl.offsetHeight; // wysokość okna podglądu (jednostki projektu)
  const PAD = 2; // mały oddech od krawędzi okna
  for (const { owner, popup } of pendingPopups) {
    const orr = owner.getBoundingClientRect();
    const belowTop = (orr.bottom - rr.top) / z; // krawędź pod kontrolką
    const aboveBottom = (orr.top - rr.top) / z; // górna krawędź kontrolki (gdy rozwijamy w górę)
    popup.style.position = "absolute";
    popup.style.left = (orr.left - rr.left) / z + "px";
    popup.style.minWidth = orr.width / z + "px";
    popup.style.visibility = "hidden";
    rootEl.appendChild(popup);
    const ph = popup.offsetHeight;
    const spaceBelow = H - belowTop;
    const spaceAbove = aboveBottom;
    // mieści się w dół, albo niżej jest więcej miejsca → rozwiń w dół; inaczej w górę (jak WPF)
    let top: number;
    let maxH: number;
    if (ph <= spaceBelow - PAD || spaceBelow >= spaceAbove) {
      top = belowTop;
      maxH = Math.max(0, spaceBelow - PAD);
    } else {
      maxH = Math.max(0, spaceAbove - PAD);
      top = aboveBottom - Math.min(ph, maxH);
    }
    popup.style.top = Math.max(0, top) + "px";
    if (ph > maxH) {
      popup.style.maxHeight = maxH + "px";
      popup.style.overflowY = "auto";
      const key = popup.dataset.xvePopupKey; // przywróć scroll z poprzedniego renderu (wybór nie resetuje)
      if (key && popupScroll.has(key)) popup.scrollTop = popupScroll.get(key)!;
    }
    popup.style.visibility = "";
  }
  pendingPopups = [];
}

/** Wiersz menu w popupie: ikona(wcięcie) | nagłówek (accel) | gest/▸. nextId = otwarta pod-pozycja. */
function buildMenuPopup(items: RenderNode[], nextId: number | null): HTMLElement {
  const pop = document.createElement("div");
  pop.className = "xve-popup xve-menu-popup";
  // panel z pozycją IsCheckable rezerwuje prawą przestrzeń na ✓ (Fluent inaczej jest węższy — CSS)
  const checkable = (it: RenderNode) => /^true$/i.test(attrOf(it, "IsCheckable") ?? "");
  if (items.some(checkable)) pop.classList.add("has-checkable");
  for (const it of items) {
    if (localName(it.tag) === "Separator") {
      pop.appendChild(buildSeparator(it));
      continue;
    }
    const row = document.createElement("div");
    row.className = "xve-menu-row";
    row.dataset.xveId = String(it.id);
    if (it.id === renderSelectedId) row.classList.add("xve-item-selected");
    if (nextId !== null && it.id === nextId) row.classList.add("xve-item-open"); // otwarta ścieżka
    const chk = document.createElement("span"); // lewa kolumna ikony/✓
    chk.className = "xve-menu-check";
    const isChecked = checkable(it) && /^true$/i.test(attrOf(it, "IsChecked") ?? "");
    chk.textContent = isChecked ? "✓" : "";
    const head = document.createElement("span");
    head.className = "xve-menu-head";
    setAccelText(head, resolveText(attrOf(it, "Header")) || itemText(it));
    const gest = document.createElement("span");
    gest.className = "xve-menu-gest";
    const hasSubs = it.children.some((c) => localName(c.tag) === "MenuItem");
    gest.textContent = hasSubs ? "▸" : attrOf(it, "InputGestureText") ?? "";
    row.append(chk, head, gest);
    pop.appendChild(row);
  }
  return pop;
}

/** Kaskada paneli menu (port ShowFakeMenuCascade): poziom 0 pod paskiem, podmenu w prawo od rodzica. */
function placeMenuCascade(rootEl: HTMLElement) {
  if (!renderRevealChain.some((n) => localName(n.tag) === "Menu")) return; // tylko gdy w kontekście Menu
  const chain = renderRevealChain.filter((n) => localName(n.tag) === "MenuItem");
  if (!chain.length) return;
  const rr = rootEl.getBoundingClientRect();
  const z = rootEl.offsetWidth > 0 ? rr.width / rootEl.offsetWidth : 1;
  const toRoot = (r: DOMRect) => ({
    left: (r.left - rr.left) / z,
    top: (r.top - rr.top) / z,
    right: (r.right - rr.left) / z,
    bottom: (r.bottom - rr.top) / z,
  });
  const anchorEl = rootEl.querySelector<HTMLElement>(`[data-xve-id="${chain[0].id}"]`);
  if (!anchorEl) return;
  let prev = toRoot(anchorEl.getBoundingClientRect());
  const W = rootEl.offsetWidth;
  const H = rootEl.offsetHeight;
  for (let i = 0; i < chain.length; i++) {
    const items = menuChildren(chain[i]);
    if (!items.length) break; // liść — bez panelu
    const nextNode = i + 1 < chain.length ? chain[i + 1] : null;
    const popup = buildMenuPopup(items, nextNode?.id ?? null);
    popup.dataset.xvePopupKey = "menu:" + chain[i].id; // stabilny klucz pamięci scrolla
    popup.style.position = "absolute";
    popup.style.visibility = "hidden";
    rootEl.appendChild(popup);
    const pw = popup.offsetWidth;
    const ph = popup.offsetHeight;
    let left: number;
    let top: number;
    let avail: number;
    if (i === 0) {
      // poziom 0: rozwiń POD paskiem albo NAD nim (nie zasłaniając pozycji paska); szerszy obszar wygrywa,
      // a przy nadmiarze włącza się scroll — inaczej długie menu przykrywało swój pasek nadrzędny.
      left = prev.left;
      const below = H - prev.bottom;
      const above = prev.top;
      if (ph <= below || below >= above) {
        top = prev.bottom;
        avail = below;
      } else {
        avail = above;
        top = Math.max(0, prev.top - Math.min(ph, avail));
      }
      if (left + pw > W) left = Math.max(0, W - pw);
    } else {
      left = prev.right; // podmenu w prawo
      top = prev.top;
      if (left + pw > W) left = Math.max(0, prev.left - pw); // brak miejsca → kaskada w lewo
      if (top + ph > H) top = Math.max(0, H - ph);
      avail = H - top;
    }
    // panel wyższy niż dostępny obszar → ogranicz wysokość i włącz przewijanie (jak prawdziwy WPF)
    const maxH = Math.max(0, avail);
    if (ph > maxH) {
      popup.style.maxHeight = maxH + "px";
      popup.style.overflowY = "auto";
    }
    popup.style.left = left + "px";
    popup.style.top = top + "px";
    popup.style.visibility = "";
    // zapamiętany scroll (użytkownik przewinął kółkiem) ma priorytet nad auto-przewinięciem do pod-pozycji
    const remembered = popupScroll.get(popup.dataset.xvePopupKey!);
    if (ph > maxH && remembered != null) popup.scrollTop = remembered;
    if (!nextNode) break;
    const rowEl = popup.querySelector<HTMLElement>(`[data-xve-id="${nextNode.id}"]`);
    if (!rowEl) break;
    if (ph > maxH && remembered == null) {
      // przewiń SAM popup tak, by otwarta pod-pozycja była widoczna (bez ruszania reszty podglądu)
      const rt = rowEl.offsetTop;
      const rh = rowEl.offsetHeight;
      if (rt + rh > popup.scrollTop + maxH) popup.scrollTop = rt + rh - maxH;
      else if (rt < popup.scrollTop) popup.scrollTop = rt;
    }
    prev = toRoot(rowEl.getBoundingClientRect()); // kotwica następnego poziomu = wiersz otwartej pod-pozycji
  }
}

/** Buduje całe drzewo do podanego kontenera (#surface). `opts` steruje auto-podglądem menu/list. */
/** Po layoucie skaluje treść każdego Viewboxa wg Stretch (znamy już rozmiar treści i kontenera). */
function scaleViewboxes(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>("[data-xve-viewbox]").forEach((vb) => {
    const child = vb.firstElementChild as HTMLElement | null;
    if (!child) return;
    const stretch = vb.dataset.xveStretch || "Uniform";
    if (stretch === "None") return;
    const natW = child.offsetWidth;
    const natH = child.offsetHeight;
    if (natW < 0.5 || natH < 0.5) return;
    const availW = vb.clientWidth;
    const availH = vb.clientHeight;
    let sx = availW / natW;
    let sy = availH / natH;
    if (stretch === "Uniform") sx = sy = Math.min(sx, sy);
    else if (stretch === "UniformToFill") sx = sy = Math.max(sx, sy);
    child.style.transformOrigin = "center center";
    child.style.transform = `scale(${sx}, ${sy})`;
    // Uniform: Viewbox kurczy się do przeskalowanej treści i centruje w komórce (jak WPF). Fill/
    // UniformToFill wypełniają cały dostępny obszar (przy UniformToFill nadmiar przycina overflow).
    if (stretch === "Uniform") {
      vb.style.width = natW * sx + "px";
      vb.style.height = natH * sy + "px";
      vb.style.justifySelf = "center";
      vb.style.alignSelf = "center";
    }
  });
}

/** Po layoucie wyrównuje ścieżki Grid o wspólnym SharedSizeGroup (w obrębie IsSharedSizeScope). */
function applySharedSizes(root: HTMLElement) {
  for (const axis of ["Col", "Row"] as const) {
    // grupowanie: zakres (najbliższy przodek-scope) → nazwa grupy → lista { grid, indeks ścieżki }
    const groups = new Map<Element | null, Map<string, { grid: HTMLElement; idx: number }[]>>();
    root.querySelectorAll<HTMLElement>(`[data-xve-shared-${axis.toLowerCase()}]`).forEach((grid) => {
      const scope = grid.closest("[data-xve-sharedscope]");
      const byGroup = groups.get(scope) ?? new Map();
      groups.set(scope, byGroup);
      for (const pair of grid.dataset[`xveShared${axis}`]!.split(";")) {
        const [idxStr, name] = pair.split(":");
        const list = byGroup.get(name) ?? [];
        list.push({ grid, idx: Number(idxStr) });
        byGroup.set(name, list);
      }
    });
    // dla każdej grupy: maksymalna rozwiązana szerokość/wysokość ścieżki → narzuć wszystkim członkom
    const prop = axis === "Col" ? "gridTemplateColumns" : "gridTemplateRows";
    const maxByGridIdx = new Map<HTMLElement, Map<number, number>>();
    for (const byGroup of groups.values()) {
      for (const members of byGroup.values()) {
        let max = 0;
        for (const m of members) {
          const tracks = getComputedStyle(m.grid)[prop].split(" ");
          max = Math.max(max, parseFloat(tracks[m.idx]) || 0);
        }
        for (const m of members) {
          const perGrid = maxByGridIdx.get(m.grid) ?? new Map();
          perGrid.set(m.idx, max);
          maxByGridIdx.set(m.grid, perGrid);
        }
      }
    }
    // przebuduj szablon każdego Grida z oryginalnych tokenów, podmieniając ścieżki grupowe na px
    for (const [grid, perGrid] of maxByGridIdx) {
      const tokens = grid.dataset[`xveTokens${axis}`]!.split("|");
      for (const [idx, px] of perGrid) tokens[idx] = px + "px";
      grid.style[prop] = tokens.join(" ");
    }
  }
}

export function renderTreeToDom(
  root: RenderNode | null,
  surface: HTMLElement,
  opts: {
    selectedId?: number | null;
    autoReveal?: boolean;
    zoom?: number;
    tabSelection?: Map<number, number>;
    imageUris?: Record<string, string>;
    resources?: ResourceModel | null;
    /** Kultura podglądu — TA SAMA wartość, którą provider wysyła hostowi WPF (cultureForHost):
     *  override per-plik / język VS Code / "" (invariant). undefined = brak parametru,
     *  jak host bez `culture` → kultura OS (locale przeglądarki). */
    culture?: string;
  } = {}
): void {
  // zapamiętaj przewinięcia przed zburzeniem DOM (przywrócimy po przebudowie)
  surface.querySelectorAll<HTMLElement>("[data-xve-id]").forEach((el) => {
    const id = Number(el.dataset.xveId);
    if (el.scrollTop > 0 || el.scrollLeft > 0) scrollMemory.set(id, { top: el.scrollTop, left: el.scrollLeft });
    else scrollMemory.delete(id);
  });
  // to samo dla popupów listy/menu (klucz "combo:id"/"menu:id") — scroll przeżywa przebudowę
  surface.querySelectorAll<HTMLElement>("[data-xve-popup-key]").forEach((el) => {
    const key = el.dataset.xvePopupKey!;
    if (el.scrollTop > 0) popupScroll.set(key, el.scrollTop);
    else popupScroll.delete(key);
  });

  surface.innerHTML = "";
  // zasoby/style: skonwertuj surowe kolory pędzli na CSS (cssColor) i ustaw na czas renderu
  const model = opts.resources ?? null;
  const brushesCss: Record<string, string> = {};
  if (model) {
    for (const [k, v] of Object.entries(model.brushes)) {
      const c = cssColor(v);
      if (c) brushesCss[k] = c;
    }
  }
  setResources(model, brushesCss, model?.brushImages ?? {});
  renderSelectedId = opts.selectedId ?? null;
  renderTabSelection = opts.tabSelection ?? null;
  renderImageUris = opts.imageUris ?? {};
  renderCulture = opts.culture;
  renderRevealPath = root ? computeRevealPath(root, renderSelectedId, opts.autoReveal === true) : new Set();
  pendingPopups = [];
  if (!root) return;
  const rootEl = renderNode(root, "grid");
  surface.appendChild(rootEl);
  applySharedSizes(rootEl); // wyrównaj ścieżki Grid o wspólnym SharedSizeGroup (przed pomiarem popupów)
  scaleViewboxes(rootEl); // przeskaluj treść Viewboxów wg Stretch
  placePopups(rootEl, opts.zoom ?? 1); // po wstawieniu do DOM znamy geometrię → pozycjonuj popupy (ComboBox)
  placeMenuCascade(rootEl); // kaskada paneli menu (poziom 0 pod paskiem, podmenu w prawo)

  // przywróć przewinięcia ScrollViewerów (po append element ma już layout → scrollTop działa)
  if (scrollMemory.size)
    surface.querySelectorAll<HTMLElement>("[data-xve-id]").forEach((el) => {
      const s = scrollMemory.get(Number(el.dataset.xveId));
      if (s) {
        el.scrollTop = s.top;
        el.scrollLeft = s.left;
      }
    });
}
