import "./style.css";
import { renderTreeToDom, RenderNode } from "./renderer";
import type { Change } from "../src/core/StructuralDiff";
import type { ResourceModel, ResourceState } from "../src/core/ResourceModel";
import {
  metaFor,
  knownProperties,
  defaultValue,
  PropMeta,
  ADDABLE_GROUPS,
  defaultSnippet,
  isContainer,
  isItemsHost,
} from "../src/core/TypeRegistry";

// Komunikacja z extension host
declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): any;
  setState(s: any): void;
};
const vscode = acquireVsCodeApi();

let l10n: Record<string, string> = {};
let tree: RenderNode | null = null;
let selectedId: number | null = null;
// ostatni element, do którego PRZEWINĘLIŚMY podgląd — pozwala odróżnić pierwszy wybór (wyrównaj do
// lewego górnego rogu) od ponownego wyboru tego samego elementu (minimalne przewinięcie, na zmianę rogi)
let lastPreviewScrollId: number | null = null;
let changed: Record<number, Record<string, string | null>> = {};
let changesData: Change[] = [];
// mapa „surowa wartość Source z XAML" → webview-URI (rozwiązane przez extension) — render obrazków w trybie web
let imageMap: Record<string, string> = {};
// model zasobów/stylów (pędzle, style) z pliku + App.xaml + słownik motywu — renderer web nakłada je
let resourceModel: ResourceModel | null = null;
// wspólny stan zasobów (web + WPF) — okienko wyboru, log, kropka; ustawiany w „doc"/„hostStatus"
let resourceState: ResourceState | null = null;
let resourcesDialogOpen = false;
let viewMode: "design" | "changes" = "design";
let showInlineDiff = true; // podświetlanie zmian w edytorze tekstu (przełącznik w Changes)
let showErrorsInCode = true; // podświetlanie błędów renderu w edytorze tekstu (przełącznik w logu hosta)
let isWindows = false;
let backend = "auto"; // auto | web | wpf-host (silnik — ustawienie globalne)
// izolacja hosta WPF (per-okno): efektywny stan po decyzji rozszerzenia (osobny proces + zasoby)
let isolationEffective = "off"; // off (web) | shared | isolated
let isolationPolicy = "ask"; // globalna polityka (sekcja Ustawień): ask | auto | shared | isolated
let uiLanguage = ""; // język UI (xve.language); "" = język VS Code. Zmiana działa po przeładowaniu webview
// stan UI utrwalany w pamięci webview (przeżywa reload panelu): zwinięcie i szerokości
// paneli, pozycja pływającego paska, tryb Fit, przełączniki płótna (snap/siatka/linijki).
const persisted: Record<string, any> = vscode.getState() || {};
let treeOpen = persisted.treeOpen !== false;
let propsOpen = persisted.propsOpen !== false;
let treeW = typeof persisted.treeW === "number" ? persisted.treeW : 240;
let propsW = typeof persisted.propsW === "number" ? persisted.propsW : 200;
// pływający pasek narzędzi: zadokowany do krawędzi albo pozycja swobodna
type Dock = "top" | "bottom" | "left" | "right" | "free";
let toolbarDock: Dock = ["top", "bottom", "left", "right", "free"].includes(persisted.toolbarDock)
  ? persisted.toolbarDock
  : "top";
let toolbarX = typeof persisted.toolbarX === "number" ? persisted.toolbarX : 8;
let toolbarY = typeof persisted.toolbarY === "number" ? persisted.toolbarY : 8;
// szerokość paska w trybie swobodnym (free) — 0 = auto; steruje zawijaniem ikon do kolejnych rzędów
let toolbarW = typeof persisted.toolbarW === "number" ? persisted.toolbarW : 0;
// przypięty = stały pasek obok podglądu (nie nakłada się); tylko gdy zadokowany do krawędzi
let toolbarPinned = persisted.toolbarPinned !== false;
// tryb panelu Właściwości: atrybuty elementu / ustawienia / prowadnice+siatka
type PropsMode = "props" | "settings" | "guides";
let propsMode: PropsMode = "props";
// zoom „dopasuj": gdy dokument nie mieści się w podglądzie → pomniejsz; gdy się mieści → 100%
let fitMode = persisted.fitMode !== false;
let needFit = fitMode; // przy najbliższym renderze dopasuj zoom (po otwarciu/zmianie dokumentu)
// synchronizacja zaznaczenia z edytorem tekstu obok (źródło prawdy: xve.sync.*)
let syncSelectInText = true; // XVE → przesuń kursor w tekście
let syncSelectFromText = true; // kursor w tekście → zaznacz w XVE
let previewMode: "web" | "wpf" = "web";
let autoReveal = persisted.autoReveal !== false; // auto-podgląd menu/list (funkcja 2)
let hostPng: string | null = null;
let hostW = 0; // pełny logiczny rozmiar powierzchni
let hostH = 0;
let hostVx = 0; // wycinek (slice) renderu — w trybie „widoczny obszar"
let hostVy = 0;
let hostVw = 0;
let hostVh = 0;
let viewportRender = true; // render tylko widocznego obszaru (domyślnie wł.)
const hostRects = new Map<
  number,
  {
    x: number; y: number; w: number; h: number; scroll?: boolean; sw?: number; sh?: number;
    // granice realne (nieprzycięte) + flaga „całkiem niewidoczny" — ramka zaznaczenia i narzędzia
    // działają na realnych granicach, by dało się chwycić element poza widocznym obszarem.
    rx?: number; ry?: number; rw?: number; rh?: number; clipped?: boolean;
  }
>();
// pełna lista prostokątów w kolejności malowania (z blokami fake-paneli) — do trafień w panel/z-order
let hostRectList: { id: number; x: number; y: number; w: number; h: number; block: boolean }[] = [];
// funkcja 3 (host): zapamiętane przewinięcia ScrollViewer per id (offset w jednostkach projektu)
const scrollOffsets = new Map<number, { h: number; v: number }>();
// Syntetyczne id przewijalnych „fake paneli" (lista ComboBox / menu) z hosta — host nadaje ScrollViewerowi
// nakładki uid = "u"+(FAKE_SCROLL_BASE+idWłaściciela). Te prostokąty służą TYLKO do przewijania kółkiem
// (nie do zaznaczania), bo realny element jest pod spodem zasłonięty fake panelem.
const FAKE_SCROLL_BASE = 900000000;
// strategia podglądu przeciągania w trybie PNG (host WPF)
let dragPreviewMode: "overlay" | "frames" | "ms" = "ms";
let dragMs = 25; // interwał re-renderu na żywo (ms); pole „klatki" w UI to przeliczenie przez frameMs
let dragSession = true; // trwała sesja hosta (szybciej) vs pełny re-render co klatkę
let dragCoalesce = true; // koalescencja: tylko 1 klatka „w locie" (odrzuca zaległe)
let dragOnChange = true; // renderuj klatkę drag tylko gdy atrybuty się zmieniły (pomija bezruch)
let adaptiveRes = true; // adaptacyjna rozdzielczość: niska w ruchu, pełna po ustaniu ruchu
let motionRes = 512; // rozdzielczość w ruchu (do pola w Ustawieniach; decyzję o limicie ma rozszerzenie)
let adaptiveFps = 30; // próg FPS: degraduj dopiero gdy pełny render poniżej (0 = zawsze)
const MOTION_SETTLE_MS = 120; // po ustaniu ruchu: opóźnienie do dosłania klatki w pełnej rozdzielczości
// szacowany czas jednej klatki ekranu (ms) — do przeliczeń ms↔klatki (interwał re-renderu).
// Mierzony z odstępów requestAnimationFrame; domyślnie 60 Hz; aktualizowany też podczas przeciągania.
let frameMs = 1000 / 60;
function clampFrameMs(v: number): number {
  return v >= 4 && v <= 60 ? v : 1000 / 60; // 16–250 Hz; poza zakresem → 60 Hz
}
(function measureFrameMs() {
  let last = 0;
  let n = 0;
  const samples: number[] = [];
  const tick = (t: number) => {
    if (last) {
      const d = t - last;
      if (d > 0 && d < 100) samples.push(d);
    }
    last = t;
    if (++n < 10) requestAnimationFrame(tick);
    else if (samples.length) {
      samples.sort((a, b) => a - b);
      frameMs = clampFrameMs(samples[Math.floor(samples.length / 2)]); // mediana odstępów
    }
  };
  requestAnimationFrame(tick);
})();
let renderCap = 4096; // limit rozdzielczości renderu hosta (px urządzenia); 0 = bez limitu
let overscan = 100; // zapas (px jednostek projektu) doliczany do widocznego obszaru w trybie viewbox
let capBasis = "visible"; // podstawa limitu w trybie viewbox: "visible" (sam widoczny obszar) | "slice"
let debugConsole = false; // konsola debug na dole podglądu (telemetria renderu)
let consoleOnStart = true; // pokaż dok konsoli przy starcie hosta WPF (błędy pokazują się zawsze)
let debugLiveDrag = false; // aktualizuj telemetrię także podczas przeciągania elementu
let zoom = 1; // skala podglądu (1 = 100%)
let previewTheme = "none"; // motyw efektywny: none|classic98|system|light|dark|native LUB resource:<ścieżka>
// kultura podglądu — ta sama, którą provider wysyła hostowi WPF (web renderer: Calendar itp.)
let previewCulture: string | undefined;
// motywy projektu (pliki ResourceDictionary z zasobów) — sekcja „— motywy projektu —" w combo
let projectThemes: { value: string; label: string }[] = [];
let renderScale = "auto"; // skala renderu hosta: auto (=devicePixelRatio) | 1 | 1.5 | 2 | 3
const nodeById = new Map<number, RenderNode>();
const parentById = new Map<number, RenderNode | null>();
// pamięć aktywnej zakładki per TabControl (id TabControl → id wybranej TabItem). Aktualizowana, gdy przy
// włączonym auto-podglądzie zaznaczysz zakładkę lub element z jej wnętrza; stosowana przy każdym renderze,
// więc widok zakładki trwa przy zaznaczaniu elementów spoza TabControl i po wyłączeniu auto-podglądu.
const tabSelection = new Map<number, number>();
let clipboardXml: string | null = null;
// skrót zawartości schowka (znacznik korzenia + liczba pod-elementów) — pozycja Info w menu
let clipboardInfo: { tag: string; count: number } | null = null;

// status hosta WPF (kropka w pasku + log po kliknięciu)
interface HostLogEntry {
  t: number;
  level: string;
  msg: string;
  line?: number; // wiersz błędu (1-based) — gdy obecny, wpis jest klikalny (skok w edytorze)
  col?: number;
}
interface HostErrorInfo {
  message: string;
  line: number;
  col: number;
  fixTo?: string; // nazwa docelowa „Auto fix to <typ>" (gdy da się naprawić literówkę)
}
interface HostResourceInfo {
  level: string;
  msg: string;
}
let hostState: {
  status: string;
  active: boolean;
  log: HostLogEntry[];
  error: HostErrorInfo | null; // aktywny, blokujący błąd renderu (zakładka Console)
  resources: HostResourceInfo | null; // info o załadowanych zasobach (osobna sekcja)
} = {
  status: "inactive",
  active: false,
  log: [],
  error: null,
  resources: null,
};
let hostLogOpen = false;
let hostLogTab: "console" | "log" = "console"; // aktywna zakładka w okienku logu
// dok konsoli (na dole obszaru podglądu/zmian): klucz stanu, dla którego dok pokazano (błąd renderu
// albo uruchamianie hosta) — by nie otwierać go ponownie dla tego samego stanu po ręcznym zamknięciu.
let hostConsoleKey: string | null = null;
let runMode = "snapshot"; // ostatnio wybrany tryb „play": snapshot | live (zapamiętany dla zaznaczenia w menu)

function T(key: string): string {
  return l10n[key] ?? key;
}

function applyStaticL10n() {
  document.querySelectorAll<HTMLElement>("[data-l10n]").forEach((el) => {
    el.textContent = T(el.dataset.l10n!);
  });
}

function indexTree(n: RenderNode, parent: RenderNode | null = null) {
  nodeById.set(n.id, n);
  parentById.set(n.id, parent);
  n.children.forEach((c) => indexTree(c, n));
}

// ---------- pomocnicze: atrybuty / liczby / thickness ----------
function attrMapOf(n: RenderNode): Record<string, string> {
  const m: Record<string, string> = {};
  for (const a of n.attributes) m[a.name] = a.value;
  return m;
}
function numOf(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = parseFloat(v);
  return isNaN(n) ? undefined : n;
}
function thicknessOf(v: string | undefined): [number, number, number, number] {
  if (!v) return [0, 0, 0, 0];
  const p = v.split(",").map((s) => parseFloat(s.trim()) || 0);
  if (p.length === 1) return [p[0], p[0], p[0], p[0]];
  if (p.length === 2) return [p[0], p[1], p[0], p[1]];
  return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 0];
}
function localTag(tag: string): string {
  const i = tag.indexOf(":");
  return i >= 0 ? tag.slice(i + 1) : tag;
}

// ---------- panel struktury ----------
function renderStructure() {
  const host = document.getElementById("tree")!;
  host.innerHTML = "";
  if (tree) host.appendChild(renderStructureNode(tree));
}

function renderStructureNode(n: RenderNode): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "tnode";
  const row = document.createElement("div");
  row.className = "trow" + (n.id === selectedId ? " selected" : "");
  row.dataset.id = String(n.id);
  const name = n.attributes.find((a) => a.name === "Name" || a.name === "x:Name")?.value;
  row.textContent = n.tag + (name ? ` (${name})` : "");
  row.onclick = () => select(n.id, { scrollPreview: true });
  setupTreeDnd(row, n);
  wrap.appendChild(row);
  if (n.children.length) {
    const kids = document.createElement("div");
    kids.className = "tkids";
    n.children.forEach((c) => kids.appendChild(renderStructureNode(c)));
    wrap.appendChild(kids);
  }
  return wrap;
}

// ---------- reorder: przeciąganie w drzewie struktury ----------
// Strefy upuszczania (wzorzec z desktopowego TreeDropAdorner): górna połowa = przed,
// dolna = po, środek = do wnętrza (gdy cel jest kontenerem). Zabronione: upuszczenie na
// siebie lub do własnego poddrzewa.
type DropZone = "before" | "after" | "into";
let treeDragId: number | null = null;

function isPropertyElementTag(tag: string): boolean {
  return localTag(tag).includes(".");
}

/** Czy `ancestorId` jest przodkiem (lub równy) `nodeId` — blokada upuszczenia do własnego poddrzewa. */
function isAncestorOrSelf(ancestorId: number, nodeId: number): boolean {
  let cur: number | null = nodeId;
  while (cur !== null) {
    if (cur === ancestorId) return true;
    cur = parentById.get(cur)?.id ?? null;
  }
  return false;
}

/** Wyznacza strefę upuszczania dla celu i kursora; null = upuszczenie niedozwolone. */
function dropZone(row: HTMLElement, target: RenderNode, e: DragEvent): DropZone | null {
  if (treeDragId === null || treeDragId === target.id) return null;
  if (isAncestorOrSelf(treeDragId, target.id)) return null; // cel w poddrzewie przeciąganego
  const r = row.getBoundingClientRect();
  const rel = (e.clientY - r.top) / r.height;
  const canInto = isContainer(target.tag) && !isPropertyElementTag(target.tag);
  if (canInto && rel > 0.33 && rel < 0.67) return "into";
  // przed/po wymaga rodzica (korzeń nie ma rodzeństwa)
  if (!parentById.get(target.id)) return canInto ? "into" : null;
  return rel < 0.5 ? "before" : "after";
}

function clearDropMarkers() {
  document
    .querySelectorAll("#tree .trow")
    .forEach((r) => r.classList.remove("drop-before", "drop-after", "drop-into"));
}
function markDrop(row: HTMLElement, zone: DropZone) {
  clearDropMarkers();
  row.classList.add(zone === "into" ? "drop-into" : zone === "before" ? "drop-before" : "drop-after");
}

function setupTreeDnd(row: HTMLElement, n: RenderNode) {
  const isRoot = !!tree && n.id === tree.id;
  if (isRoot || isPropertyElementTag(n.tag)) return; // korzeń i elementy-właściwości nieprzeciągalne
  row.draggable = true;
  row.addEventListener("dragstart", (e) => {
    treeDragId = n.id;
    if (n.id !== selectedId) select(n.id); // przeciągany element staje się wybrany
    e.dataTransfer?.setData("text/plain", String(n.id));
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  });
  row.addEventListener("dragend", () => {
    treeDragId = null;
    clearDropMarkers();
  });
  row.addEventListener("dragover", (e) => {
    const zone = dropZone(row, n, e);
    if (zone === null) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    markDrop(row, zone);
  });
  row.addEventListener("dragleave", () =>
    row.classList.remove("drop-before", "drop-after", "drop-into")
  );
  row.addEventListener("drop", (e) => {
    const zone = dropZone(row, n, e);
    clearDropMarkers();
    if (zone === null || treeDragId === null) return;
    e.preventDefault();
    commitTreeMove(treeDragId, n, zone);
    treeDragId = null;
  });
}

function commitTreeMove(dragId: number, target: RenderNode, zone: DropZone) {
  let newParentId: number;
  let beforeId: number | null;
  if (zone === "into") {
    newParentId = target.id;
    beforeId = null; // na koniec kontenera
  } else {
    const parent = parentById.get(target.id);
    if (!parent) return;
    newParentId = parent.id;
    if (zone === "before") {
      beforeId = target.id;
    } else {
      const sibs = parent.children;
      const idx = sibs.findIndex((c) => c.id === target.id);
      beforeId = idx >= 0 && idx + 1 < sibs.length ? sibs[idx + 1].id : null;
    }
  }
  vscode.postMessage({ type: "moveElement", id: dragId, newParentId, beforeId });
}

// ---------- podgląd ----------
function renderPreview() {
  const surface = document.getElementById("surface")!;
  const png = previewMode === "wpf" && hostPng;
  surface.classList.toggle("png", !!png);
  if (png) {
    // #surface = PEŁNY logiczny rozmiar powierzchni; obraz to wycinek (vx,vy,vw,vh).
    // Dla pełnego renderu wycinek = cała powierzchnia, więc obraz ją wypełnia.
    surface.style.width = hostW + "px";
    surface.style.height = hostH + "px";
    // REUŻYWAMY ten sam <img> (zamiast usuwać+tworzyć co klatkę) — element zachowuje stare piksele
    // do czasu zdekodowania nowego src, więc podczas przeciągania nie ma migotania (pustej klatki).
    let img = surface.firstElementChild as HTMLImageElement | null;
    if (!img || img.tagName !== "IMG") {
      surface.innerHTML = "";
      img = document.createElement("img");
      img.style.position = "absolute";
      surface.appendChild(img);
    }
    img.src = "data:image/png;base64," + hostPng;
    img.style.left = hostVx + "px";
    img.style.top = hostVy + "px";
    img.style.width = hostVw + "px";
    img.style.height = hostVh + "px";
  } else {
    surface.style.width = "";
    surface.style.height = "";
    applyWebTheme(surface); // motyw web (parność z host WPF: classic / Fluent light / dark)
    // reorderRevealId: spring-open podmenu w trakcie reorderu rozwija kaskadę do tego MenuItem
    // (samo zaznaczenie/nakładka pozostają na faktycznie wybranym elemencie).
    renderTreeToDom(tree, surface, { selectedId: reorderRevealId ?? selectedId, autoReveal, zoom, tabSelection, imageUris: imageMap, resources: resourceModel, culture: previewCulture });
  }
  applyZoomTransform();
  // pierwsze dopasowanie po otwarciu/zmianie dokumentu (rozmiar powierzchni jest już znany)
  if (needFit && surface.offsetWidth > 0) {
    needFit = false;
    applyFit();
  }
  updateOverlay();
  drawDecorations();
  scheduleViewbox(); // tryb „widoczny obszar": doślij aktualny wycinek (guard kluczem)
}

/** Klasa motywu web wg ustawienia `xve.preview.theme` (none/system→classic/Fluent, native→GTK). */
function webThemeClass(): "xve-theme-classic" | "xve-theme-classic98" | "xve-theme-light" | "xve-theme-dark" | "xve-theme-native" {
  let t = previewTheme;
  if (t === "system")
    t = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  if (t === "classic98") return "xve-theme-classic98";
  if (t === "light") return "xve-theme-light";
  if (t === "dark") return "xve-theme-dark";
  if (t === "native") return "xve-theme-native";
  return "xve-theme-classic"; // none / classic
}
/** Nakłada klasę motywu na #surface (zmienne CSS sterują wyglądem kontrolek web). */
function applyWebTheme(surface: HTMLElement) {
  surface.classList.remove("xve-theme-classic", "xve-theme-classic98", "xve-theme-light", "xve-theme-dark", "xve-theme-native");
  surface.classList.add(webThemeClass());
}
// motyw „system" w trybie web reaguje na zmianę schematu kolorów OS
if (window.matchMedia) {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (previewMode === "web" && previewTheme === "system") {
      const s = document.getElementById("surface");
      if (s) applyWebTheme(s);
    }
  });
}

/** Stos id pod kursorem, OD WIERZCHNIEGO (z-order + klip). PNG: hostRects są w kolejności malowania
 *  (wierzchni ostatni) i już przycięte do widoczności po stronie hosta. Web: elementsFromPoint. */
function pickStack(clientX: number, clientY: number): number[] {
  if (previewMode === "wpf" && hostPng) {
    const d = clientToDesign(clientX, clientY);
    const hits: number[] = [];
    for (const [id, r] of hostRects) {
      if (d.x >= r.x && d.x <= r.x + r.w && d.y >= r.y && d.y <= r.y + r.h) hits.push(id);
    }
    const stack = hits.reverse(); // malowanie: wierzchni ostatni → odwróć na „od wierzchniego"
    injectClippedSelected(stack, (r) =>
      r.rx != null && d.x >= r.rx && d.x <= r.rx + (r.rw ?? 0) && d.y >= (r.ry ?? 0) && d.y <= (r.ry ?? 0) + (r.rh ?? 0)
    );
    return stack;
  }
  const out: number[] = [];
  for (const el of document.elementsFromPoint(clientX, clientY)) {
    const h = el as HTMLElement;
    if (h.dataset?.xveId !== undefined && h.closest("#surface")) {
      const id = Number(h.dataset.xveId);
      if (!out.includes(id)) out.push(id);
    }
  }
  // web: elementsFromPoint pomija element przycięty poza klipem — dołóż zaznaczony wg realnych granic DOM
  if (drag === null && reorderId === null && selectedId !== null && !out.includes(selectedId)) {
    const el = document.querySelector<HTMLElement>(`#surface [data-xve-id="${selectedId}"]`);
    if (el) {
      const tr = el.getBoundingClientRect();
      const inside = clientX >= tr.left && clientX <= tr.right && clientY >= tr.top && clientY <= tr.bottom;
      if (inside && isClippedInWeb(el, tr)) out.unshift(selectedId);
    }
  }
  return out;
}

/** PNG: dołóż zaznaczony, ale przycięty element na wierzch stosu, gdy kursor jest w jego REALNYCH granicach
 *  (host pomija go w hit-teście, bo poza widocznym obszarem). Dzięki temu ramką da się go chwycić i wejść
 *  w cykl; nie-zaznaczone przycięte pozostają nieklikalne. Pomijane w trakcie gestu (drag/reorder). */
function injectClippedSelected(
  stack: number[],
  inReal: (r: { rx?: number; ry?: number; rw?: number; rh?: number }) => boolean
): void {
  if (drag !== null || reorderId !== null || selectedId === null || stack.includes(selectedId)) return;
  const r = hostRects.get(selectedId);
  if (r?.clipped && inReal(r)) stack.unshift(selectedId);
}

function arraysEqual(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Trafienie w fake-panel (lista/menu): "none" poza panelem, "bg" w tło panelu (pochłoń klik),
 *  albo id wiersza gdy kliknięto pozycję. Tło panelu NIE zaznacza elementu zasłoniętego. */
function fakePanelHit(e: MouseEvent): "none" | "bg" | number {
  if (previewMode === "wpf" && hostPng) {
    const d = clientToDesign(e.clientX, e.clientY);
    let topBlock = -1;
    let topElem = -1;
    let topElemId = -1;
    hostRectList.forEach((r, i) => {
      if (d.x < r.x || d.x > r.x + r.w || d.y < r.y || d.y > r.y + r.h) return;
      if (r.block) topBlock = Math.max(topBlock, i);
      else if (i > topElem) {
        topElem = i;
        topElemId = r.id;
      }
    });
    if (topBlock < 0) return "none"; // nie nad panelem
    return topElem > topBlock ? topElemId : "bg"; // wiersz nad panelem vs samo tło panelu
  }
  const t = e.target as HTMLElement;
  if (!t.closest(".xve-popup")) return "none";
  const row = t.closest<HTMLElement>(".xve-popup [data-xve-id]");
  return row ? Number(row.dataset.xveId) : "bg";
}

// Cykliczne zaznaczanie: powtórne kliknięcie w to samo miejsce przechodzi do elementu „pod spodem".
let pickStackPrev: number[] = [];
let pickPrevX = -1;
let pickPrevY = -1;
function pickCyclic(clientX: number, clientY: number): number | null {
  const stack = pickStack(clientX, clientY);
  if (!stack.length) return null;
  const same =
    Math.abs(clientX - pickPrevX) <= 2 && Math.abs(clientY - pickPrevY) <= 2 && arraysEqual(stack, pickStackPrev);
  let idx = 0;
  if (same && selectedId !== null) {
    const cur = stack.indexOf(selectedId);
    idx = cur >= 0 ? (cur + 1) % stack.length : 0; // następny w głąb stosu
  }
  pickStackPrev = stack;
  pickPrevX = clientX;
  pickPrevY = clientY;
  return stack[idx];
}

// Selekcja przy KLIKU (bez przeciągania) odłożona do puszczenia przycisku. Naciśnięcie wewnątrz już
// zaznaczonego elementu operuje na NIM (drag rusza zaznaczony, nie ten spod spodu) — a sama zmiana
// zaznaczenia (wierzch/cykl, jak dawniej) następuje dopiero przy puszczeniu, o ile nie było ruchu.
// Pierwszy realny ruch myszy (onDragMove/onReorderMove) kasuje to id → drag NIE zmienia zaznaczenia.
let clickSelectId: number | null = null;
function applyClickSelect(): void {
  const id = clickSelectId;
  clickSelectId = null;
  if (id === null || id === selectedId) return;
  select(id, { scrollTree: true });
  setStatus();
}

/** Rozstrzyga naciśnięcie myszy dla narzędzi move/reorder. Zwraca `dragId` (element, na którym
 *  zadziała ewentualne przeciąganie) i `selectNow` (zaznaczyć od razu, albo null = odłóż do kliku).
 *  Gdy naciśnięto w obrębie aktualnie zaznaczonego elementu, przeciąganie rusza JEGO (nie spod spodu),
 *  a normalną zmianę zaznaczenia (wierzch/cykl) odkładamy do puszczenia bez ruchu (`clickSelectId`). */
function resolvePress(
  e: MouseEvent,
  rowId: number | null
): { dragId: number | null; selectNow: number | null } {
  if (rowId !== null) {
    clickSelectId = null; // wiersz fake-panelu: jawne trafienie → zaznacz natychmiast
    return { dragId: rowId, selectNow: rowId };
  }
  const stack = pickStack(e.clientX, e.clientY);
  const clickPick = pickCyclic(e.clientX, e.clientY); // normalna selekcja (wierzch/cykl), jak dawniej
  if (clickPick === null) {
    clickSelectId = null;
    return { dragId: null, selectNow: null };
  }
  if (selectedId !== null && stack.includes(selectedId)) {
    clickSelectId = clickPick; // klik (bez ruchu) zaznaczy normalnie; ruch ⇒ skasujemy i nie zmienimy
    return { dragId: selectedId, selectNow: null }; // przeciąganie operuje na zaznaczonym elemencie
  }
  clickSelectId = null;
  return { dragId: clickPick, selectNow: clickPick }; // świeży wybór → zaznacz od razu, można od razu ciągnąć
}

/** Web: czy element jest przycięty przez któregoś przodka (overflow≠visible) — choć na jednym boku. */
function isClippedInWeb(target: HTMLElement, tr: DOMRect): boolean {
  let clipL = -Infinity, clipT = -Infinity, clipR = Infinity, clipB = Infinity;
  for (let el = target.parentElement; el && el.id !== "surface"; el = el.parentElement) {
    const o = getComputedStyle(el);
    if (/(hidden|auto|scroll|clip)/.test(o.overflow + o.overflowX + o.overflowY)) {
      const cr = el.getBoundingClientRect();
      clipL = Math.max(clipL, cr.left);
      clipT = Math.max(clipT, cr.top);
      clipR = Math.min(clipR, cr.right);
      clipB = Math.min(clipB, cr.bottom);
    }
  }
  const eps = 0.5;
  return tr.left < clipL - eps || tr.top < clipT - eps || tr.right > clipR + eps || tr.bottom > clipB + eps;
}

function updateOverlay() {
  const overlay = document.getElementById("sel-overlay")!;
  const scroll = document.getElementById("surface-scroll")!;
  if (selectedId === null) {
    overlay.style.display = "none";
    return;
  }
  // podczas aktywnego przeciągania w trybie PNG nakładką steruje onDragMove (lokalnie),
  // a host nie odsyła już mapy hit-test co klatkę — nie nadpisuj nakładki nieaktualnymi rects
  if (drag && previewMode === "wpf" && hostPng) return;
  // tryb PNG (host WPF): pozycja z mapy hit-test (współrzędne projektu × zoom)
  if (previewMode === "wpf" && hostPng) {
    const r = hostRects.get(selectedId);
    if (!r) {
      overlay.style.display = "none";
      return;
    }
    // element przycięty (częściowo lub całkiem) → ramka na REALNYCH granicach + styl przerywany,
    // by było widać pełny obrys tam, gdzie wychodzi poza kontener (i dało się go chwycić narzędziami).
    const rx = r.clipped ? r.rx ?? r.x : r.x;
    const ry = r.clipped ? r.ry ?? r.y : r.y;
    const rw = r.clipped ? r.rw ?? r.w : r.w;
    const rh = r.clipped ? r.rh ?? r.h : r.h;
    overlay.classList.toggle("clipped", !!r.clipped);
    const ze = zoomEl();
    overlay.style.display = "block";
    overlay.style.left = (ze.offsetLeft + rx * zoom) - 0.5 + "px";
    overlay.style.top = (ze.offsetTop + ry * zoom) - 0.5 + "px";
    overlay.style.width = (rw * zoom) - 0.5 + "px";
    overlay.style.height = (rh * zoom) - 0.5 + "px";
    return;
  }
  const target = document.querySelector<HTMLElement>(`#surface [data-xve-id="${selectedId}"]`);
  if (!target) {
    overlay.style.display = "none";
    return;
  }
  const tr = target.getBoundingClientRect();
  // web: getBoundingClientRect ignoruje klip kontenerów, więc ramka i tak jest na realnych granicach;
  // sprawdź, czy któryś bok wychodzi poza przycinającego przodka (overflow≠visible) → ramka przerywana
  overlay.classList.toggle("clipped", isClippedInWeb(target, tr));
  const sr = scroll.getBoundingClientRect();
  overlay.style.display = "block";
  overlay.style.left = tr.left - 1 - sr.left + scroll.scrollLeft + "px";
  overlay.style.top = tr.top - 1 - sr.top + scroll.scrollTop + "px";
  overlay.style.width = tr.width - 0.1 + "px";
  overlay.style.height = tr.height - 0.1 + "px";
}

// ---------- panel właściwości (typowany) ----------
function setAttr(id: number, name: string, value: string) {
  vscode.postMessage({ type: "setAttribute", id, name, value });
}
function removeAttr(id: number, name: string) {
  vscode.postMessage({ type: "removeAttribute", id, name });
}

function makeEditor(
  meta: PropMeta,
  value: string,
  onChange: (v: string) => void,
  ctx?: { id: number; name: string }
): HTMLElement {
  switch (meta.kind) {
    case "bool": {
      const sel = document.createElement("select");
      sel.className = "field-input";
      for (const v of ["True", "False"]) {
        const o = document.createElement("option");
        o.value = o.textContent = v;
        sel.appendChild(o);
      }
      sel.value = /true/i.test(value) ? "True" : "False";
      sel.onchange = () => onChange(sel.value);
      return sel;
    }
    case "enum": {
      const sel = document.createElement("select");
      sel.className = "field-input";
      const vals = meta.values ?? [];
      if (value && !vals.includes(value)) vals.unshift(value);
      for (const v of vals) {
        const o = document.createElement("option");
        o.value = o.textContent = v;
        sel.appendChild(o);
      }
      sel.value = value;
      sel.onchange = () => onChange(sel.value);
      return sel;
    }
    case "brush": {
      const col = document.createElement("div");
      col.className = "field-brush-col";
      const wrap = document.createElement("div");
      wrap.className = "field-brush";
      // próbnik (przycisk) otwiera niestandardowy color picker z kanałem alfa
      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.className = "field-swatch";
      const text = document.createElement("input");
      text.className = "field-input";
      text.value = value;
      // bieżący kolor jako RGBA; gdy wartość nie jest jednolitym kolorem (np. gradient) → biały
      let color: RGBA = parseColor(value) ?? { r: 255, g: 255, b: 255, a: 255 };
      const paint = (c: RGBA) => {
        swatch.style.setProperty("--sw", `rgba(${c.r},${c.g},${c.b},${(c.a / 255).toFixed(3)})`);
      };
      paint(color);
      swatch.onclick = () => {
        openColorPicker(
          swatch,
          color,
          (c) => {
            // live: aktualizuj próbnik i pole tekstowe bez commitu
            color = c;
            paint(c);
            text.value = composeWpfHex(c);
          },
          (c) => {
            color = c;
            paint(c);
            text.value = composeWpfHex(c);
            onChange(composeWpfHex(c));
          }
        );
      };
      text.onchange = () => {
        const c = parseColor(text.value);
        if (c) {
          color = c;
          paint(c);
        }
        onChange(text.value);
      };
      wrap.append(swatch, text);
      col.append(wrap);
      return col;
    }
    case "image": {
      // pole tekstowe (ścieżka, edytowalne ręcznie) + przycisk wyboru pliku (dialog w extension)
      const wrap = document.createElement("div");
      wrap.className = "field-image";
      const input = document.createElement("input");
      input.className = "field-input";
      input.value = value;
      input.onchange = () => onChange(input.value);
      const browse = iconBtn("codicon-folder-opened", T("Prop.BrowseImage"), () => {
        if (ctx) vscode.postMessage({ type: "browseImage", id: ctx.id, name: ctx.name });
      });
      wrap.append(input, browse);
      return wrap;
    }
    default: {
      const input = document.createElement("input");
      input.className = "field-input";
      input.value = value;
      input.onchange = () => onChange(input.value);
      return input;
    }
  }
}

/** Buduje nagłówek panelu Właściwości: tytuł (wg trybu) + przyciski Prowadnice / Ustawienia / X. */
function buildPropsHeader() {
  const head = document.getElementById("props-header");
  if (!head) return;
  head.innerHTML = "";
  const title = document.createElement("span");
  title.textContent =
    propsMode === "settings"
      ? T("Settings.Title")
      : propsMode === "guides"
        ? T("Guides.PanelTitle")
        : T("View.Properties");
  head.appendChild(title);

  const actions = document.createElement("div");
  actions.className = "pane-actions";
  const guidesBtn = document.createElement("button");
  guidesBtn.className = "pane-btn" + (propsMode === "guides" ? " active" : "");
  guidesBtn.title = T("Guides.PanelTitle");
  guidesBtn.innerHTML = '<span class="codicon codicon-symbol-ruler"></span>';
  guidesBtn.onclick = () => setPropsMode("guides");
  const gearBtn = document.createElement("button");
  gearBtn.className = "pane-btn" + (propsMode === "settings" ? " active" : "");
  gearBtn.title = T("Settings.Title");
  gearBtn.innerHTML = '<span class="codicon codicon-settings-gear"></span>';
  gearBtn.onclick = () => setPropsMode("settings");
  const closeBtn = document.createElement("button");
  closeBtn.className = "pane-close";
  closeBtn.title = T("Pane.Close");
  closeBtn.innerHTML = '<span class="codicon codicon-close"></span>';
  closeBtn.onclick = () => setPaneOpen("props", false);
  actions.append(guidesBtn, gearBtn, closeBtn);
  head.appendChild(actions);
}

/** Przełącza tryb panelu Właściwości (atrybuty/ustawienia/prowadnice); ponowny klik → atrybuty. */
function setPropsMode(mode: PropsMode) {
  propsMode = propsMode === mode ? "props" : mode;
  renderProps();
}

function renderProps() {
  buildPropsHeader();
  const host = document.getElementById("props")!;
  host.innerHTML = "";
  if (propsMode === "settings") {
    buildSettings(host);
    return;
  }
  if (propsMode === "guides") {
    renderGuidesPanel(host);
    return;
  }
  const node = selectedId !== null ? nodeById.get(selectedId) : undefined;
  if (!node) {
    const note = document.createElement("div");
    note.className = "empty";
    note.textContent = T("View.NoSelection");
    host.appendChild(note);
    return;
  }
  const id = node.id;
  const ch = changed[id] ?? {};

  for (const attr of node.attributes) {
    const meta = metaFor(node.tag, attr.name);
    const field = document.createElement("div");
    field.className = "field" + (attr.name in ch ? " changed" : "");
    field.dataset.attr = attr.name;

    const head = document.createElement("div");
    head.className = "field-head";
    const label = document.createElement("span");
    label.className = "field-name";
    label.textContent = attr.name;
    head.appendChild(label);

    if (attr.name in ch) {
      const revert = document.createElement("button");
      revert.className = "field-btn";
      revert.title = T("Prop.Revert");
      revert.textContent = "↶";
      const base = ch[attr.name];
      revert.onclick = () =>
        base === null ? removeAttr(id, attr.name) : setAttr(id, attr.name, base);
      head.appendChild(revert);
    }
    const del = document.createElement("button");
    del.className = "field-btn";
    del.title = T("Prop.Remove");
    del.textContent = "✕";
    del.onclick = () => removeAttr(id, attr.name);
    head.appendChild(del);

    field.appendChild(head);
    field.appendChild(
      makeEditor(meta, attr.value, (v) => setAttr(id, attr.name, v), { id, name: attr.name })
    );
    host.appendChild(field);
  }

  // dodaj właściwość
  const present = new Set(node.attributes.map((a) => a.name));
  const candidates = knownProperties(node.tag).filter((p) => !present.has(p.name));
  if (candidates.length) {
    const add = document.createElement("div");
    add.className = "field-add";
    const sel = document.createElement("select");
    sel.className = "field-input";
    const ph = document.createElement("option");
    ph.value = "";
    ph.textContent = T("Prop.Add");
    sel.appendChild(ph);
    for (const p of candidates) {
      const o = document.createElement("option");
      o.value = o.textContent = p.name;
      sel.appendChild(o);
    }
    sel.onchange = () => {
      if (!sel.value) return;
      const meta = metaFor(node.tag, sel.value);
      setAttr(id, sel.value, defaultValue(meta));
    };
    add.appendChild(sel);
    host.appendChild(add);
  }
}

/** Tryb „Prowadnice i siatka" panelu Właściwości: krok siatki + listy prowadnic + Wyczyść. */
function renderGuidesPanel(host: HTMLElement) {
  // „Step & snap" (px) — krok siatki ORAZ próg przyciągania do prowadnic; widoczność siatki/linijek
  // (a wraz z nią aktywność odpowiedniego przyciągania) ustawia się w pasku narzędzi
  const gridSec = document.createElement("div");
  gridSec.className = "guides-section";
  const gridTitle = document.createElement("div");
  gridTitle.className = "pane-subtitle";
  gridTitle.textContent = T("Tool.Grid");
  gridSec.appendChild(gridTitle);
  const gridRow = document.createElement("label");
  gridRow.className = "tool-field";
  const gridNum = document.createElement("input");
  gridNum.type = "number";
  gridNum.min = "1";
  gridNum.className = "field-input";
  gridNum.value = String(gridStep);
  gridNum.onchange = () => {
    const v = parseInt(gridNum.value, 10);
    if (v > 0) {
      gridStep = v;
      renderGrid();
      persistState();
    }
  };
  gridRow.append(document.createTextNode(T("Tool.GridStep")), gridNum, document.createTextNode("px"));
  gridSec.appendChild(gridRow);
  host.appendChild(gridSec);

  // listy prowadnic (pionowe/poziome) — dostępne także bez zaznaczenia elementu
  const sec = document.createElement("div");
  sec.className = "guides-section";
  const title = document.createElement("div");
  title.className = "pane-subtitle";
  title.textContent = T("Guides.Title");
  sec.appendChild(title);
  if (!showRulers) {
    const note = document.createElement("div");
    note.className = "settings-note";
    note.textContent = T("Guides.NeedRulers");
    sec.appendChild(note);
  }
  sec.appendChild(guideList("x", T("Guides.Vertical")));
  sec.appendChild(guideList("y", T("Guides.Horizontal")));
  if (guides.length) {
    const clr = document.createElement("button");
    clr.className = "tool-btn";
    clr.textContent = T("Tool.ClearGuides");
    clr.onclick = () => {
      guides = [];
      renderGuides();
      updateRulers();
      renderProps();
    };
    sec.appendChild(clr);
  }
  host.appendChild(sec);
}
function guideList(axis: "x" | "y", label: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "guide-group";
  const h = document.createElement("div");
  h.className = "field-name";
  h.textContent = label;
  wrap.appendChild(h);
  guides.forEach((g, i) => {
    if (g.axis !== axis) return;
    const row = document.createElement("div");
    row.className = "guide-row";
    const inp = document.createElement("input");
    inp.type = "number";
    inp.className = "field-input";
    inp.value = String(g.pos);
    inp.onchange = () => {
      const v = parseFloat(inp.value);
      if (!isNaN(v)) {
        g.pos = v;
        renderGuides();
        updateRulers();
      }
    };
    const del = document.createElement("button");
    del.className = "field-btn";
    del.title = T("Prop.Remove");
    del.textContent = "✕";
    del.onclick = () => {
      guides.splice(i, 1);
      renderGuides();
      updateRulers();
      renderProps();
    };
    row.append(inp, del);
    wrap.appendChild(row);
  });
  const add = document.createElement("button");
  add.className = "tool-btn guide-add";
  add.textContent = "+ " + T(axis === "x" ? "Guides.AddV" : "Guides.AddH");
  add.onclick = () => {
    // jak w aplikacji: nowa prowadnica za ostatnią (max+20), a pierwsza w 50 — nie wszystkie w 0
    const axisPos = guides.filter((g) => g.axis === axis).map((g) => g.pos);
    const pos = axisPos.length ? Math.round(Math.max(...axisPos) + 20) : 50;
    guides.push({ axis, pos });
    renderGuides();
    updateRulers();
    renderProps();
  };
  wrap.appendChild(add);
  return wrap;
}

/** Próbuje sprowadzić wartość pędzla do #RRGGBB dla <input type=color>. */
function toHexColor(v: string): string | null {
  const s = v.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s;
  if (/^#[0-9a-fA-F]{3}$/.test(s)) return "#" + s.slice(1).replace(/./g, (c) => c + c);
  if (/^#[0-9a-fA-F]{8}$/.test(s)) return "#" + s.slice(3); // #AARRGGBB → #RRGGBB
  const named = NAMED_COLORS[s.toLowerCase()];
  return named ?? null;
}

const NAMED_COLORS: Record<string, string> = {
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  green: "#008000",
  blue: "#0000ff",
  gray: "#808080",
  grey: "#808080",
  lightgreen: "#90ee90",
  transparent: "#000000",
};

// ---------- niestandardowy próbnik koloru (z kanałem alfa) ----------
interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Parsuje wartość pędzla do RGBA (a: 0–255). Zwraca null dla nie-jednolitych pędzli. */
function parseColor(v: string): RGBA | null {
  const s = v.trim();
  if (s.toLowerCase() === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  const m8 = s.match(/^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/);
  if (m8) return { a: parseInt(m8[1], 16), r: parseInt(m8[2], 16), g: parseInt(m8[3], 16), b: parseInt(m8[4], 16) };
  const hex6 = toHexColor(s); // #RRGGBB / #RGB / #AARRGGBB→RGB / nazwa
  if (hex6) {
    return { r: parseInt(hex6.slice(1, 3), 16), g: parseInt(hex6.slice(3, 5), 16), b: parseInt(hex6.slice(5, 7), 16), a: 255 };
  }
  return null;
}

/** Składa wartość WPF: #RRGGBB gdy alfa=255, inaczej #AARRGGBB. */
function composeWpfHex(c: RGBA): string {
  const hh = (n: number) => Math.round(n).toString(16).padStart(2, "0");
  const rgb = hh(c.r) + hh(c.g) + hh(c.b);
  return (c.a >= 255 ? "#" + rgb : "#" + hh(c.a) + rgb).toUpperCase();
}

function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h = h * 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

function hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}

let openPicker: HTMLElement | null = null;
let pickerAnchor: HTMLElement | null = null;
function closeColorPicker() {
  openPicker?.remove();
  openPicker = null;
  pickerAnchor = null;
  window.removeEventListener("mousedown", onPickerOutside, true);
  window.removeEventListener("keydown", onPickerKey, true);
}
function onPickerOutside(e: MouseEvent) {
  const t = e.target as Node;
  if (openPicker && !openPicker.contains(t) && !pickerAnchor?.contains(t)) closeColorPicker();
}
function onPickerKey(e: KeyboardEvent) {
  if (e.key === "Escape") closeColorPicker();
}

/** Przeciąganie po elemencie → ułamki 0–1 (clamp); onEnd wywołuje commit po puszczeniu. */
function attachPickerDrag(el: HTMLElement, onMove: (fx: number, fy: number) => void, onEnd: () => void) {
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const r = el.getBoundingClientRect();
    const calc = (ev: PointerEvent) => {
      const fx = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
      const fy = Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height));
      onMove(fx, fy);
    };
    el.setPointerCapture(e.pointerId);
    calc(e);
    const move = (ev: PointerEvent) => calc(ev);
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      onEnd();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  });
}

/**
 * Otwiera niestandardowy próbnik koloru z polem nasycenie/jasność, suwakiem barwy,
 * suwakiem alfa i polami HEX/RGBA. onLive → podgląd na żywo, onCommit → zapis wartości.
 */
function openColorPicker(anchor: HTMLElement, initial: RGBA, onLive: (c: RGBA) => void, onCommit: (c: RGBA) => void) {
  const wasOpen = openPicker !== null && pickerAnchor === anchor;
  closeColorPicker();
  if (wasOpen) return; // ponowny klik w próbnik = zamknij

  pickerAnchor = anchor;
  let { h, s, v } = rgbToHsv(initial.r, initial.g, initial.b);
  let a = initial.a;
  const rgba = (): RGBA => ({ ...hsvToRgb(h, s, v), a });

  const pop = document.createElement("div");
  pop.className = "color-picker";

  const sv = document.createElement("div");
  sv.className = "cp-sv";
  const svThumb = document.createElement("div");
  svThumb.className = "cp-thumb";
  sv.appendChild(svThumb);

  const controls = document.createElement("div");
  controls.className = "cp-controls";
  const preview = document.createElement("div");
  preview.className = "cp-preview";
  const sliders = document.createElement("div");
  sliders.className = "cp-sliders";
  const hue = document.createElement("div");
  hue.className = "cp-hue";
  const hueThumb = document.createElement("div");
  hueThumb.className = "cp-slider-thumb";
  hue.appendChild(hueThumb);
  const alpha = document.createElement("div");
  alpha.className = "cp-alpha";
  const alphaFill = document.createElement("div");
  alphaFill.className = "cp-alpha-fill";
  const alphaThumb = document.createElement("div");
  alphaThumb.className = "cp-slider-thumb";
  alpha.append(alphaFill, alphaThumb);
  sliders.append(hue, alpha);
  controls.append(preview, sliders);

  const hexIn = document.createElement("input");
  hexIn.className = "field-input cp-hex";

  const nums = document.createElement("div");
  nums.className = "cp-nums";
  const makeNum = (label: string, title: string) => {
    const w = document.createElement("div");
    w.className = "cp-num-wrap";
    const i = document.createElement("input");
    i.className = "field-input cp-num";
    i.type = "number";
    i.min = "0";
    i.max = "255";
    i.title = title;
    const l = document.createElement("span");
    l.className = "cp-num-label";
    l.textContent = label;
    w.append(i, l);
    nums.appendChild(w);
    return i;
  };
  const rIn = makeNum("R", "R");
  const gIn = makeNum("G", "G");
  const bIn = makeNum("B", "B");
  const aIn = makeNum("A", T("Prop.Alpha"));

  pop.append(sv, controls, hexIn, nums);

  const refresh = () => {
    const c = hsvToRgb(h, s, v);
    sv.style.background =
      `linear-gradient(to top, #000, rgba(0,0,0,0)), ` +
      `linear-gradient(to right, #fff, rgba(255,255,255,0)), ` +
      `hsl(${h.toFixed(1)}, 100%, 50%)`;
    svThumb.style.left = s * 100 + "%";
    svThumb.style.top = (1 - v) * 100 + "%";
    svThumb.style.background = `rgb(${c.r},${c.g},${c.b})`;
    hueThumb.style.left = (h / 360) * 100 + "%";
    alphaFill.style.background = `linear-gradient(to right, rgba(${c.r},${c.g},${c.b},0), rgb(${c.r},${c.g},${c.b}))`;
    alphaThumb.style.left = (a / 255) * 100 + "%";
    preview.style.setProperty("--sw", `rgba(${c.r},${c.g},${c.b},${(a / 255).toFixed(3)})`);
    hexIn.value = composeWpfHex({ ...c, a });
    rIn.value = String(c.r);
    gIn.value = String(c.g);
    bIn.value = String(c.b);
    aIn.value = String(a);
  };

  attachPickerDrag(sv, (fx, fy) => { s = fx; v = 1 - fy; refresh(); onLive(rgba()); }, () => onCommit(rgba()));
  attachPickerDrag(hue, (fx) => { h = fx * 360; refresh(); onLive(rgba()); }, () => onCommit(rgba()));
  attachPickerDrag(alpha, (fx) => { a = Math.round(fx * 255); refresh(); onLive(rgba()); }, () => onCommit(rgba()));

  hexIn.onchange = () => {
    const c = parseColor(hexIn.value);
    if (c) {
      const hsv = rgbToHsv(c.r, c.g, c.b);
      h = hsv.h; s = hsv.s; v = hsv.v; a = c.a;
      refresh();
      onCommit(rgba());
    } else {
      refresh();
    }
  };

  const clamp255 = (val: string) => Math.min(255, Math.max(0, Math.round(Number(val) || 0)));
  const onNum = () => {
    const hsv = rgbToHsv(clamp255(rIn.value), clamp255(gIn.value), clamp255(bIn.value));
    h = hsv.h; s = hsv.s; v = hsv.v; a = clamp255(aIn.value);
    refresh();
    onCommit(rgba());
  };
  rIn.onchange = gIn.onchange = bIn.onchange = aIn.onchange = onNum;

  document.body.appendChild(pop);
  refresh();
  const r = anchor.getBoundingClientRect();
  let left = r.left;
  let top = r.bottom + 4;
  if (left + pop.offsetWidth > window.innerWidth - 8) left = window.innerWidth - 8 - pop.offsetWidth;
  if (top + pop.offsetHeight > window.innerHeight - 8) top = r.top - 4 - pop.offsetHeight;
  pop.style.left = Math.max(8, left) + "px";
  pop.style.top = Math.max(8, top) + "px";
  openPicker = pop;
  setTimeout(() => {
    window.addEventListener("mousedown", onPickerOutside, true);
    window.addEventListener("keydown", onPickerKey, true);
  }, 0);
}

// ---------- selekcja (dwukierunkowa) ----------
interface SelectOpts {
  /** przewiń podgląd do elementu (tryb web: DOM scroll) */
  scrollPreview?: boolean;
  /** przewiń drzewo struktury do zaznaczonego wiersza */
  scrollTree?: boolean;
  /** odeślij revealNode → przesuń kursor w edytorze tekstu (domyślnie tak) */
  revealText?: boolean;
}
/** Zapamiętuje aktywną zakładkę TabControl zawierającego `id` (gdy zaznaczono zakładkę lub element z jej
 *  wnętrza). Zwraca true, jeśli pamięć się zmieniła. Wywoływane tylko przy włączonym auto-podglądzie. */
function rememberTabFor(id: number): boolean {
  let node: RenderNode | null = nodeById.get(id) ?? null;
  let child: RenderNode | null = null;
  while (node) {
    if (localTag(node.tag) === "TabControl") {
      // child = TabItem na ścieżce do zaznaczenia; sam TabControl (child === null) nie zmienia zakładki
      if (child && localTag(child.tag) === "TabItem" && tabSelection.get(node.id) !== child.id) {
        tabSelection.set(node.id, child.id);
        return true;
      }
      return false;
    }
    child = node;
    node = parentById.get(node.id) ?? null;
  }
  return false;
}

/** Wysyła do hosta WPF pełną listę aktywnych TabItem (uid) — host stosuje ją przy każdym renderze. */
function sendTabsToHost() {
  if (previewMode !== "wpf") return;
  vscode.postMessage({ type: "setTabs", uids: [...tabSelection.values()].map((v) => "u" + v) });
}

/** Po przebudowie drzewa usuwa nieaktualne wpisy (klucz nie jest już TabControl, a wartość jego TabItem). */
function pruneTabSelection() {
  for (const [tcId, tiId] of [...tabSelection]) {
    const tc = nodeById.get(tcId);
    const ok = tc && localTag(tc.tag) === "TabControl" && tc.children.some((c) => c.id === tiId);
    if (!ok) tabSelection.delete(tcId);
  }
}

function select(id: number, opts: SelectOpts = {}) {
  const { scrollPreview = false, scrollTree = false, revealText = true } = opts;
  selectedId = id;
  renderStructure();
  renderProps();
  // auto-podgląd: zmiana zaznaczenia zakładki / elementu z jej wnętrza zapamiętuje aktywną zakładkę
  const tabChanged = autoReveal ? rememberTabFor(id) : false;
  // auto-podgląd: zmiana zaznaczenia może otworzyć/przełączyć listę/menu
  if (autoReveal && previewMode === "web") {
    renderPreview(); // web: przerysuj DOM
    scrollInnerToReveal(id); // najpierw przewiń wewnętrzny ScrollViewer, by element był widoczny
    scrollFakePopupToReveal(id); // a fake-listę (popup) przewiń do zaznaczonej pozycji
  } else if (autoReveal && previewMode === "wpf") {
    if (tabChanged) sendTabsToHost(); // utrwal nową zakładkę zanim host przerysuje pod reveal
    vscode.postMessage({ type: "setReveal", uid: "u" + id }); // host: re-render
  }
  updateOverlay();
  if (scrollPreview) scrollPreviewToSelected(id);
  if (scrollTree) scrollTreeToSelected();
  // przewiń edytor tekstu (jeśli otwarty obok) do pierwszego wiersza elementu
  if (revealText) vscode.postMessage({ type: "revealNode", id });
}

/** Czyści zaznaczenie (żaden element nie jest wybrany) — np. klik w puste tło podglądu. */
function deselect() {
  if (selectedId === null) return;
  selectedId = null;
  lastPreviewScrollId = null; // następny wybór liczy się jako „pierwszy" (lewy górny róg)
  renderStructure();
  renderProps();
  // auto-podgląd: odznaczenie zamyka otwartą fake-listę (nic już nie jest zaznaczone).
  // Web: przerysuj DOM bez reveal. Host WPF: wyczyść reveal (uid=null) → re-render bez listy.
  if (autoReveal && previewMode === "web") renderPreview();
  else if (autoReveal && previewMode === "wpf") vscode.postMessage({ type: "setReveal", uid: null });
  updateOverlay();
  setStatus();
}

/** Przewija panel struktury tak, by zaznaczony wiersz był widoczny. */
function scrollTreeToSelected() {
  const row = document.querySelector<HTMLElement>("#tree .trow.selected");
  row?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/** Przewija podgląd do elementu, gdy nie jest w pełni widoczny (web: DOM; PNG: rect hosta). */
// Auto-scroll WEWNĘTRZNYCH ScrollViewerów (web), by zaznaczony element stał się widoczny — minimalnie,
// od najbardziej zagnieżdżonego ku zewnętrznym. Dopiero potem zewnętrzne centrowanie podglądu domyka resztę.
// Działa tylko przy włączonym Auto-podglądzie (na życzenie użytkownika).
function scrollInnerToReveal(id: number) {
  if (!autoReveal || pngMode()) return;
  const target = document.querySelector<HTMLElement>(`#surface [data-xve-id="${id}"]`);
  if (!target) return;
  let el = target.parentElement;
  const pad = 4;
  while (el && el.id !== "surface") {
    // gdy zaznaczono samą zawartość ScrollViewera (np. StackPanel większy niż viewport),
    // nie przewijaj go — nie ma czego „odsłaniać", scroll zostaje na swoim miejscu.
    // Dzieci panelu mają rodzica = panel (nie ScrollViewer), więc nadal są odsłaniane.
    if (el.classList.contains("xve-scrollviewer") && target.parentElement !== el) {
      const er = el.getBoundingClientRect();
      const tr = target.getBoundingClientRect(); // świeży rect (po przewinięciu wewnętrznych już uwzględnia zmianę)
      // różnice w px ekranu → dziel przez zoom (scrollTop/Left są w jednostkach treści, nieskalowane)
      if (tr.top < er.top) el.scrollTop -= (er.top - tr.top) / zoom + pad;
      else if (tr.bottom > er.bottom) el.scrollTop += (tr.bottom - er.bottom) / zoom + pad;
      if (tr.left < er.left) el.scrollLeft -= (er.left - tr.left) / zoom + pad;
      else if (tr.right > er.right) el.scrollLeft += (tr.right - er.right) / zoom + pad;
    }
    el = el.parentElement;
  }
}

// Web: przewiń fake-listę (popup ComboBox/Menu) tak, by zaznaczona pozycja była widoczna — jak reveal
// realnego ScrollViewera. Wołane przy ZMIANIE zaznaczenia (nie przy innych re-renderach), więc pozycja
// z kółka jest utrzymywana, a wybór elementu z drzewa/kodu odsłania go (minimalnie).
function scrollFakePopupToReveal(id: number) {
  if (!autoReveal || pngMode()) return;
  const row = document.querySelector<HTMLElement>(`.xve-popup [data-xve-id="${id}"]`);
  const popup = row?.closest<HTMLElement>(".xve-popup");
  if (!row || !popup || popup.scrollHeight <= popup.clientHeight) return; // brak listy lub nic do przewinięcia
  const er = popup.getBoundingClientRect();
  const tr = row.getBoundingClientRect();
  const pad = 4;
  if (tr.top < er.top) popup.scrollTop -= (er.top - tr.top) / zoom + pad;
  else if (tr.bottom > er.bottom) popup.scrollTop += (tr.bottom - er.bottom) / zoom + pad;
}

function scrollPreviewToSelected(id: number) {
  // pierwszy wybór tego elementu → wyrównaj do lewego górnego rogu; ponowny → minimalnie (rogi na zmianę)
  const fresh = id !== lastPreviewScrollId;
  lastPreviewScrollId = id;
  if (pngMode()) {
    const r = hostRects.get(id);
    if (!r) return; // brak geometrii (np. klatka drag) — nic nie przewijamy
    // niewidoczny (przycięty) → przewiń do REALNYCH granic, by pokazać ramkę tam, gdzie element naprawdę jest
    const x = r.clipped ? r.rx ?? r.x : r.x;
    const y = r.clipped ? r.ry ?? r.y : r.y;
    const w = r.clipped ? r.rw ?? r.w : r.w;
    const h = r.clipped ? r.rh ?? r.h : r.h;
    const ze = zoomEl();
    scrollRectIntoView(ze.offsetLeft + x * zoom, ze.offsetTop + y * zoom, w * zoom, h * zoom, fresh);
  } else {
    const target = document.querySelector<HTMLElement>(`#surface [data-xve-id="${id}"]`);
    if (target) {
      const sc = scrollEl();
      const tr = target.getBoundingClientRect();
      const sr = sc.getBoundingClientRect();
      scrollRectIntoView(
        tr.left - sr.left + sc.scrollLeft,
        tr.top - sr.top + sc.scrollTop,
        tr.width,
        tr.height,
        fresh
      );
    }
  }
  updateOverlay();
}

/**
 * Minimalnie przewija #surface-scroll, by prostokąt (we współrzędnych treści) był widoczny.
 * `forceTopLeft` wyrównuje do lewego górnego rogu elementu (pierwszy wybór) — bez tego, dla
 * elementu większego niż widok, kolejne wybory „skakałyby" na zmianę między lewą i prawą krawędzią.
 */
function scrollRectIntoView(left: number, top: number, w: number, h: number, forceTopLeft = false) {
  const sc = scrollEl();
  const pad = 24; // margines oddechu od krawędzi
  const viewL = sc.scrollLeft;
  const viewT = sc.scrollTop;
  const right = left + w;
  const bottom = top + h;
  let nl = viewL;
  let nt = viewT;
  const outX = left < viewL || right > viewL + sc.clientWidth;
  const outY = top < viewT || bottom > viewT + sc.clientHeight;
  if (forceTopLeft) {
    // pierwszy wybór: zawsze lewy górny róg elementu (stabilnie, bez skakania)
    if (outX) nl = Math.max(0, left - pad);
    if (outY) nt = Math.max(0, top - pad);
  } else {
    // ponowny wybór: minimalne przewinięcie do najbliższej krawędzi
    if (outX) nl = left < viewL ? Math.max(0, left - pad) : right - sc.clientWidth + pad;
    if (outY) nt = top < viewT ? Math.max(0, top - pad) : bottom - sc.clientHeight + pad;
  }
  if (nl !== viewL || nt !== viewT) sc.scrollTo({ left: nl, top: nt, behavior: "smooth" });
}

function countElements(n: RenderNode): number {
  return 1 + n.children.reduce((s, c) => s + countElements(c), 0);
}

function setStatus() {
  const sb = document.getElementById("statusbar")!;
  if (!tree) {
    sb.textContent = "";
    return;
  }
  const sel = selectedId !== null ? nodeById.get(selectedId)?.tag : null;
  sb.textContent =
    T("Status.ParsedElements").replace("{0}", String(countElements(tree))) +
    (sel ? ` · ${sel}` : "");
}

// ---------- selektor silnika + izolacji hosta WPF ----------
// Jeden dropdown łączy globalny silnik (auto/web/wpf-host) z per-okno izolacją hosta WPF.
// „WPF host — izolowany" = świeży proces z osobnymi zasobami tylko dla tego pliku.
function engineModeOptions(): { value: string; label: string }[] {
  const opts: { value: string; label: string; winOnly?: boolean }[] = [
    { value: "auto", label: T("Backend.Auto") },
    { value: "web", label: T("Backend.Web") },
    { value: "wpf-host", label: T("Backend.WpfHost"), winOnly: true },
    { value: "wpf-host-isolated", label: T("Backend.WpfHostIsolated"), winOnly: true },
  ];
  return opts.filter((o) => !o.winOnly || isWindows).map(({ value, label }) => ({ value, label }));
}
/** Wartość dropdownu wyprowadzona z globalnego silnika + efektywnej izolacji tego okna. */
function engineModeValue(): string {
  if (backend === "web") return "web";
  if (!isWindows) return backend === "wpf-host" ? "wpf-host" : "auto";
  if (isolationEffective === "isolated") return "wpf-host-isolated";
  if (backend === "wpf-host") return "wpf-host";
  return "auto";
}

// ---------- combo motywu (toolbar + ustawienia) ----------
// Standardowe motywy + (gdy projekt ma pliki ResourceDictionary) sekcja „— motywy projektu —".
// Wzorzec z aplikacji XAML Visual Editor: pliki motywów projektu na górze, standardowe niżej.
function standardThemeItems(): { value: string; label: string }[] {
  return [
    { value: "none", label: T("Theme.Classic") },
    { value: "classic98", label: T("Theme.Classic98") },
    { value: "system", label: T("Theme.System") },
    { value: "light", label: T("Theme.Light") },
    { value: "dark", label: T("Theme.Dark") },
    { value: "native", label: T("Theme.Native") },
  ];
}
/** Wypełnia <select> motywu: motywy projektu (optgroup) + standardowe; ustawia bieżącą wartość. */
function fillThemeSelect(sel: HTMLSelectElement) {
  sel.innerHTML = "";
  const addInto = (parent: HTMLElement, items: { value: string; label: string }[]) => {
    for (const it of items) {
      const o = document.createElement("option");
      o.value = it.value;
      o.textContent = it.label;
      parent.appendChild(o);
    }
  };
  if (projectThemes.length > 0) {
    const proj = document.createElement("optgroup");
    proj.label = T("Theme.ProjectSep");
    addInto(proj, projectThemes);
    sel.appendChild(proj);
    const std = document.createElement("optgroup");
    std.label = T("Theme.StdSep");
    addInto(std, standardThemeItems());
    sel.appendChild(std);
  } else {
    addInto(sel, standardThemeItems());
  }
  sel.value = previewTheme; // resource:<ścieżka> lub standardowy klucz
}

// ---------- zwijanie / szerokości paneli bocznych (Struktura / Właściwości) ----------
function persistState() {
  vscode.setState({
    treeOpen,
    propsOpen,
    treeW,
    propsW,
    toolbarDock,
    toolbarX,
    toolbarY,
    toolbarW,
    toolbarPinned,
    fitMode,
    gridStep,
    showGrid,
    showRulers,
    autoReveal,
  });
}
/** Nakłada klasy zwinięcia na #layout (kolumny 0 + ukrycie panelu) i szerokości paneli. */
function applyPaneLayout() {
  const layout = document.getElementById("layout");
  if (!layout) return;
  layout.classList.toggle("tree-collapsed", !treeOpen);
  layout.classList.toggle("props-collapsed", !propsOpen);
  layout.style.setProperty("--tree-w", treeW + "px");
  layout.style.setProperty("--props-w", propsW + "px");
}
/** Otwiera/zamyka panel, zapamiętuje stan i odświeża układ + pasek (przyciski otwierania). */
function setPaneOpen(which: "tree" | "props", open: boolean) {
  if (which === "tree") treeOpen = open;
  else propsOpen = open;
  persistState();
  applyPaneLayout();
  buildFloatToolbar();
  buildPropsHeader();
  scheduleDecorations();
}
/** Podpina przyciski X w nagłówkach paneli, splittery i ustawia początkowy układ (raz). */
function setupPaneToggles() {
  const tc = document.getElementById("tree-close");
  if (tc) {
    tc.title = T("Pane.Close");
    tc.onclick = () => setPaneOpen("tree", false);
  }
  applyPaneLayout();
  setupSplitters();
}

/** Uchwyty zmiany szerokości paneli Struktura / Właściwości (przeciąganie kolumn gridu). */
function setupSplitters() {
  const mk = (id: string, which: "tree" | "props") => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      el.classList.add("dragging");
      const startX = e.clientX;
      const start = which === "tree" ? treeW : propsW;
      const onMove = (m: MouseEvent) => {
        const dx = m.clientX - startX;
        // panel Właściwości rośnie w lewo (delta odwrócona)
        const raw = which === "tree" ? start + dx : start - dx;
        const w = Math.max(140, Math.min(640, raw));
        if (which === "tree") treeW = w;
        else propsW = w;
        applyPaneLayout();
      };
      const onUp = () => {
        el.classList.remove("dragging");
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        persistState();
        scheduleDecorations();
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    });
  };
  mk("splitter-tree", "tree");
  mk("splitter-props", "props");
}

// ---------- pomocnicze: przyciski-ikony + menu popup (Codicons) ----------
interface IconBtnOpts {
  active?: boolean;
  label?: string;
}
// Ikona „ręka" (narzędzie Pan) — w zestawie Codicons nie ma dłoni, więc wstawiamy własny SVG
// (Material „pan_tool"). Rysowany przez currentColor, więc dziedziczy kolor jak Codicony.
const HAND_ICON =
  '<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">' +
  '<path d="M23 5.5V20c0 2.2-1.8 4-4 4h-7.3c-1.08 0-2.1-.43-2.85-1.19L1 14.83s1.26-1.23 1.3-1.25' +
  'c.22-.19.49-.29.79-.29.22 0 .42.06.6.16.04.01 4.31 2.46 4.31 2.46V4c0-.83.67-1.5 1.5-1.5S11 3.17 11 4' +
  'v7h1V1.5c0-.83.67-1.5 1.5-1.5S15 .67 15 1.5V11h1V2.5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5V11h1V5.5' +
  'c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5z"/></svg>';
/** Tworzy przycisk-ikonę (Codicon lub własny SVG) z tooltipem; opcjonalnie aktywny i z etykietą. */
function iconBtn(
  codicon: string,
  title: string,
  onClick: (e: MouseEvent, btn: HTMLButtonElement) => void,
  opts: IconBtnOpts = {}
): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "ic-btn" + (opts.active ? " active" : "");
  b.title = title;
  const span = document.createElement("span");
  if (codicon.startsWith("<svg")) {
    span.className = "tb-icon";
    span.innerHTML = codicon;
  } else {
    span.className = "codicon " + codicon;
  }
  b.appendChild(span);
  if (opts.label) {
    const l = document.createElement("span");
    l.className = "ic-label";
    l.textContent = opts.label;
    b.appendChild(l);
  }
  b.onclick = (e) => onClick(e, b);
  return b;
}
function tbDivider(): HTMLElement {
  const d = document.createElement("div");
  d.className = "tb-divider";
  return d;
}

interface MenuItem {
  value?: string;
  label: string;
  separator?: boolean;
}
let openMenu: HTMLElement | null = null;
let menuAnchor: HTMLElement | null = null;
function closeIconMenu() {
  openMenu?.remove();
  openMenu = null;
  menuAnchor = null;
  window.removeEventListener("mousedown", onMenuOutside, true);
  window.removeEventListener("keydown", onMenuKey, true);
}
function onMenuOutside(e: MouseEvent) {
  const t = e.target as Node;
  // klik w kotwicę zostaw przyciskowi (toggle przez onClick) — zamykaj tylko poza menu i kotwicą
  if (openMenu && !openMenu.contains(t) && !menuAnchor?.contains(t)) closeIconMenu();
}
function onMenuKey(e: KeyboardEvent) {
  if (e.key === "Escape") closeIconMenu();
}
/** Otwiera małe menu popup przy kotwicy (wybór motywu / silnika). */
function openIconMenu(
  anchor: HTMLElement,
  items: MenuItem[],
  current: string,
  onPick: (value: string) => void,
  opts: { showCheck?: boolean } = {}
) {
  const showCheck = opts.showCheck !== false; // domyślnie pokazuj „ptaszek" wybranej pozycji
  const wasOpen = openMenu !== null && menuAnchor === anchor;
  closeIconMenu();
  if (wasOpen) return; // ponowny klik w tę samą ikonę = zamknij
  menuAnchor = anchor;
  const menu = document.createElement("div");
  menu.className = "ic-menu" + (showCheck ? "" : " no-check");
  for (const it of items) {
    if (it.separator) {
      const lab = document.createElement("div");
      lab.className = "ic-menu-label";
      lab.textContent = it.label;
      menu.appendChild(lab);
      continue;
    }
    const row = document.createElement("div");
    row.className = "ic-menu-item" + (showCheck && it.value === current ? " selected" : "");
    if (showCheck) {
      const check = document.createElement("span");
      check.className = "codicon " + (it.value === current ? "codicon-check" : "codicon-blank");
      row.appendChild(check);
    }
    const label = document.createElement("span");
    label.textContent = it.label;
    row.appendChild(label);
    row.onclick = () => {
      closeIconMenu();
      onPick(it.value!);
    };
    menu.appendChild(row);
  }
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  let left = r.left;
  let top = r.bottom + 4;
  if (left + menu.offsetWidth > window.innerWidth - 8) left = window.innerWidth - 8 - menu.offsetWidth;
  if (top + menu.offsetHeight > window.innerHeight - 8) top = r.top - 4 - menu.offsetHeight;
  menu.style.left = Math.max(8, left) + "px";
  menu.style.top = Math.max(8, top) + "px";
  openMenu = menu;
  setTimeout(() => {
    window.addEventListener("mousedown", onMenuOutside, true);
    window.addEventListener("keydown", onMenuKey, true);
  }, 0);
}
/** Pozycje menu motywu: motywy projektu (z separatorami) + standardowe. */
function themeMenuItems(): MenuItem[] {
  const items: MenuItem[] = [];
  if (projectThemes.length) {
    items.push({ label: T("Theme.ProjectSep"), separator: true });
    for (const t of projectThemes) items.push({ value: t.value, label: t.label });
    items.push({ label: T("Theme.StdSep"), separator: true });
  }
  for (const t of standardThemeItems()) items.push({ value: t.value, label: t.label });
  return items;
}

function setTool(t: Tool) {
  tool = t;
  const sc = document.getElementById("surface-scroll");
  // Pan = łapka. Reorder zachowuje się jak drzewko: strzałka nad tłem, łapka z palcem nad elementem
  // (ustawiana dynamicznie w mousemove na #surface). Pozostałe narzędzia: domyślny kursor.
  if (sc) sc.style.cursor = t === "pan" ? "grab" : "";
  const surf = document.getElementById("surface");
  if (surf) surf.style.cursor = "";
  applyToolHandles();
  buildFloatToolbar();
}

/** Przełącza auto-podgląd menu/list (funkcja 2). Tryb web: przerysuj DOM; host: poinformuj proces. */
function toggleAutoReveal() {
  autoReveal = !autoReveal;
  persistState();
  buildFloatToolbar();
  vscode.postMessage({ type: "setAutoReveal", enabled: autoReveal }); // host WPF (funkcja 2 host)
  if (autoReveal && selectedId !== null) {
    if (rememberTabFor(selectedId)) sendTabsToHost(); // włączenie nad elementem z zakładki → zapamiętaj ją
    vscode.postMessage({ type: "setReveal", uid: "u" + selectedId });
  }
  if (previewMode === "web") renderPreview();
}

// ---------- pływający, dokowalny pasek narzędzi ----------
// Jeden pasek (wszystko jako ikony z tooltipami) pływający nad podglądem; można go przenosić
// i dokować do dowolnej krawędzi (góra/dół = poziomo, boki = pionowo). Zoom ma osobny panel.
function buildFloatToolbar() {
  const tb = document.getElementById("float-toolbar")!;
  // panel zoomu bywa wstawiany JAKO dziecko paska (pin dół) — wyjmij go z powrotem do panelu,
  // zanim wyczyścimy pasek, by nie został usunięty razem z jego zawartością
  const zpEl = document.getElementById("zoom-panel");
  const paneEl = document.getElementById("preview-pane");
  if (zpEl && paneEl && zpEl.parentElement === tb) paneEl.appendChild(zpEl);
  tb.innerHTML = "";
  tb.classList.toggle("vertical", toolbarDock === "left" || toolbarDock === "right");

  // uchwyt przenoszenia
  const grip = document.createElement("span");
  grip.className = "tb-grip codicon codicon-gripper";
  grip.title = T("Toolbar.Move");
  setupToolbarDrag(grip);
  tb.appendChild(grip);

  // Przypinanie/odpinanie odbywa się przeciągnięciem paska (poza krawędź = przypięty), więc osobny
  // przycisk ze strzałką jest zbędny.

  // gdy Struktura zwinięta → przycisk otwierania
  if (!treeOpen)
    tb.appendChild(
      iconBtn("codicon-layout-sidebar-left", T("Pane.OpenStructure"), () => setPaneOpen("tree", true))
    );

  tb.appendChild(tbDivider());

  // narzędzia: przesuwanie widoku (Pan = ręka) / przesuwanie elementów (Move = strzałki) / kolejność
  tb.appendChild(
    iconBtn(HAND_ICON, T("Tool.PanTip"), () => setTool("pan"), { active: tool === "pan" })
  );
  tb.appendChild(
    iconBtn("codicon-move", T("Tool.SelectTip"), () => setTool("select"), { active: tool === "select" })
  );
  tb.appendChild(
    iconBtn("codicon-list-tree", T("Tool.ReorderTip"), () => setTool("reorder"), { active: tool === "reorder" })
  );
  // auto-podgląd menu/list (funkcja 2) — przełącznik
  tb.appendChild(
    iconBtn("codicon-eye", T("Preview.AutoRevealTip"), () => toggleAutoReveal(), { active: autoReveal })
  );

  tb.appendChild(tbDivider());
  
  // cofnij / ponów / usuń
  tb.appendChild(iconBtn("codicon-discard", T("Tb.Undo"), () => vscode.postMessage({ type: "undo" })));
  tb.appendChild(iconBtn("codicon-redo", T("Tb.Redo"), () => vscode.postMessage({ type: "redo" })));
  tb.appendChild(iconBtn("codicon-trash", T("Tb.DeleteTip"), () => deleteSelected()));

  tb.appendChild(tbDivider());

  // widok: Projekt / Zmiany (aktywny pokazuje też etykietę)
  tb.appendChild(
    iconBtn(
      "codicon-edit",
      T("View.Design"),
      () => {
        viewMode = "design";
        applyViewMode();
      },
      { active: viewMode === "design", label: viewMode === "design" ? T("View.Design") : undefined }
    )
  );
  const changesBtn = iconBtn(
    "codicon-git-compare",
    changesLabel(),
    () => {
      viewMode = "changes";
      applyViewMode();
    },
    {
      active: viewMode === "changes",
      label: viewMode === "changes" ? changesLabel() : changesLabel(true) || undefined,
    }
  );
  changesBtn.id = "view-changes-btn";
  tb.appendChild(changesBtn);

  tb.appendChild(tbDivider());

  // siatka / linijki — przełączniki (przyciąganie wynika z ich aktywności: siatka→snap do siatki,
  // linijki→snap do prowadnic; nie ma osobnego przycisku magnesu).
  tb.appendChild(
    iconBtn("codicon-symbol-numeric", T("Tool.ShowGrid"), () => {
      showGrid = !showGrid;
      renderGrid();
      persistState();
      buildFloatToolbar();
    }, { active: showGrid })
  );
  tb.appendChild(
    iconBtn("codicon-symbol-ruler", T("Tool.Rulers"), () => {
      showRulers = !showRulers;
      applyRulersVisibility();
      persistState();
      buildFloatToolbar();
    }, { active: showRulers })
  );

  tb.appendChild(tbDivider());

  // motyw / silnik — ikony otwierające menu popup
  tb.appendChild(
    iconBtn("codicon-symbol-color", T("Settings.PreviewTheme"), (_e, btn) =>
      openIconMenu(btn, themeMenuItems(), previewTheme, (v) => {
        previewTheme = v;
        vscode.postMessage({ type: "setPreviewTheme", value: v });
      })
    )
  );
  tb.appendChild(
    iconBtn("codicon-server-process", T("Settings.Backend"), (_e, btn) =>
      openIconMenu(
        btn,
        engineModeOptions().map((o) => ({ value: o.value, label: o.label })),
        engineModeValue(),
        (v) => vscode.postMessage({ type: "setEngineMode", value: v })
      )
    )
  );

  // uruchom okno — menu wyboru trybu: migawka (jednorazowa) albo na żywo (aktualizuje się ze zmianami)
  tb.appendChild(
    iconBtn("codicon-play", T("Tb.RunWindowTip"), (_e, btn) =>
      openIconMenu(
        btn,
        [
          { value: "snapshot", label: T("Run.Snapshot") },
          { value: "live", label: T("Run.Live") },
        ],
        runMode,
        (v) => {
          runMode = v;
          vscode.postMessage({ type: "showWindow", live: v === "live" });
        },
        { showCheck: false } // play to akcja, nie wybór stanu — same opcje bez „ptaszka"
      )
    )
  );
  // zasoby projektu (web + WPF): otwórz okienko wyboru/stanu
  tb.appendChild(iconBtn("codicon-package", T("Tb.ResourcesTip"), () => toggleResourcesDialog()));

  tb.appendChild(tbDivider());

  // kropka statusu hosta WPF (klik → log)
  const dotBtn = document.createElement("button");
  dotBtn.className = "ic-btn host-dot-btn";
  dotBtn.id = "host-dot-btn";
  const dotSpan = document.createElement("span");
  dotSpan.className = "host-dot";
  dotBtn.appendChild(dotSpan);
  dotBtn.onclick = () => toggleHostLog();
  tb.appendChild(dotBtn);
  updateHostDot();

  // gdy Właściwości zwinięte → przycisk otwierania
  if (!propsOpen)
    tb.appendChild(
      iconBtn("codicon-layout-sidebar-right", T("Pane.OpenProperties"), () => setPaneOpen("props", true))
    );

  // uchwyt zmiany rozmiaru — tylko gdy pasek pływa swobodnie (nie zadokowany)
  if (toolbarDock === "free") {
    const rs = document.createElement("span");
    rs.className = "tb-resize codicon codicon-triangle-right";
    rs.title = T("Toolbar.Resize");
    setupToolbarResize(rs);
    tb.appendChild(rs);
  }

  applyToolbarPos();
  positionZoomPanel(); // panel zoomu ustaw względem przypiętego paska (dół/prawa)
}

/** Nakłada na #preview-pane klasy układu dla przypiętego paska (rezerwuje pasek obok podglądu). */
function applyPinLayout() {
  const pane = document.getElementById("preview-pane")!;
  const tb = document.getElementById("float-toolbar")!;
  pane.classList.remove("pinned", "pin-top", "pin-bottom", "pin-left", "pin-right");
  const pinned = toolbarPinned && toolbarDock !== "free";
  tb.classList.toggle("pinned", pinned);
  if (pinned) pane.classList.add("pinned", "pin-" + toolbarDock);
}

/** Rezerwa miejsca panelu zoomu (prawy-dolny róg) — by zadokowany pasek nie wchodził pod zoom. */
function zoomReserve(): { w: number; h: number } {
  const zp = document.getElementById("zoom-panel");
  if (!zp || zp.offsetParent === null || zp.offsetWidth === 0) return { w: 0, h: 0 };
  const gap = 10; // odstęp panelu od krawędzi (right/bottom: 10px) + lekki margines
  return { w: zp.offsetWidth + gap + 6, h: zp.offsetHeight + gap + 6 };
}

/** Pozycjonuje pasek wg stanu doku (krawędź) lub pozycji swobodnej; trzyma go w granicach. */
function applyToolbarPos() {
  const tb = document.getElementById("float-toolbar")!;
  const pane = document.getElementById("preview-pane")!;
  const pw = pane.clientWidth;
  const ph = pane.clientHeight;
  const m = 8;

  // wyzeruj ograniczenia z poprzedniego ułożenia (zawijanie/rozmiar swobodny)
  tb.style.maxWidth = "";
  tb.style.maxHeight = "";
  tb.style.width = "";
  tb.style.minHeight = "";

  if (toolbarPinned && toolbarDock !== "free") return; // przypięty = układ flex, bez pozycji absolutnej

  if (toolbarDock === "free") {
    // tryb swobodny: szerokość ustawiona uchwytem resize steruje zawijaniem (wysokość = treść,
    // bez pustej przestrzeni). Limit naturalny (jeden rząd) pilnuje resize, tu tylko granice panelu.
    if (toolbarW > 0) tb.style.width = Math.max(80, Math.min(pw - 2 * m, toolbarW)) + "px";
    const tw = tb.offsetWidth;
    const th = tb.offsetHeight;
    const left = Math.max(m, Math.min(pw - tw - m, toolbarX));
    const top = Math.max(m, Math.min(ph - th - m, toolbarY));
    tb.style.left = left + "px";
    tb.style.top = top + "px";
    tb.style.right = "auto";
    tb.style.bottom = "auto";
    return;
  }

  // Zadokowany przy krawędzi: ogranicz wymiar wzdłuż krawędzi stykającej się z zoomem, by pasek
  // zawinął się i nie wszedł pod panel zoomu (prawy-dolny róg) — „jakby nie mieścił się w oknie".
  const z = zoomReserve();
  const vertical = toolbarDock === "left" || toolbarDock === "right";
  const avoidH = toolbarDock === "right" ? z.h : 0; // zoom stoi po prawej-dole
  const avoidW = toolbarDock === "bottom" ? z.w : 0;
  // Linijki zajmują pas o szerokości --rw u góry i po lewej viewportu (= początek pane). Zadokowany
  // (nieprzypięty) pasek u góry/po lewej musiałby je zasłaniać — przesuń go o szerokość linijki w jego boku.
  const rw = showRulers
    ? parseFloat(getComputedStyle(document.getElementById("preview-viewport")!).getPropertyValue("--rw")) || 0
    : 0;
  if (vertical) tb.style.maxHeight = Math.max(60, ph - 2 * m - avoidH) + "px";
  else tb.style.maxWidth = Math.max(60, pw - 2 * m - avoidW) + "px";

  const tw = tb.offsetWidth;
  const th = tb.offsetHeight;
  let left: number;
  let top: number;
  switch (toolbarDock) {
    case "top":
      left = (pw - avoidW - tw) / 2;
      top = m + rw; // pod linijką górną
      break;
    case "bottom":
      left = (pw - avoidW - tw) / 2;
      top = ph - th - m;
      break;
    case "left":
      left = m + rw; // obok linijki lewej
      top = (ph - avoidH - th) / 2;
      break;
    case "right":
      left = pw - tw - m;
      top = (ph - avoidH - th) / 2;
      break;
    default:
      left = toolbarX;
      top = toolbarY;
      break;
  }
  left = Math.max(m, Math.min(pw - tw - m, left));
  top = Math.max(m, Math.min(ph - th - m, top));
  tb.style.left = left + "px";
  tb.style.top = top + "px";
  tb.style.right = "auto";
  tb.style.bottom = "auto";
}

/** Przeciąganie paska za uchwyt + dokowanie do najbliższej krawędzi (w progu). */
interface DropTarget {
  dock: Dock;
  pinned: boolean;
}
type SizeMap = Record<string, { w: number; h: number }>;

/** Mierzy rozmiar paska w danej orientacji i ograniczeniu osi głównej, bez malowania (czyta
 * offset* → wymusza layout, ale nie repaint, więc bez migotania). Przywraca poprzedni stan. */
function measureToolbarSize(tb: HTMLElement, vertical: boolean, maxMain: number): { w: number; h: number } {
  const savedClass = tb.className;
  const s = {
    mw: tb.style.maxWidth, mh: tb.style.maxHeight, w: tb.style.width, mnh: tb.style.minHeight,
    pos: tb.style.position, l: tb.style.left, r: tb.style.right, t: tb.style.top, b: tb.style.bottom,
  };
  tb.classList.remove("pinned"); // nie mierz w układzie flex (przypięty) — tam rozmiar narzuca kontener
  tb.classList.toggle("vertical", vertical);
  // Mierzymy „swobodnie": absolutnie w rogu (0,0). Inaczej przy doku z PRAWEJ duże `left` ogranicza
  // szerokość shrink-to-fit do wąskiej szczeliny przy krawędzi → poziomy pasek zawijałby się w wąską,
  // wysoką kolumnę i ghost pokazywał błędne (pionowe) wymiary.
  tb.style.position = "absolute";
  tb.style.left = "0";
  tb.style.top = "0";
  tb.style.right = "auto";
  tb.style.bottom = "auto";
  tb.style.width = "";
  tb.style.minHeight = "";
  if (vertical) {
    tb.style.maxWidth = "";
    tb.style.maxHeight = maxMain + "px";
  } else {
    tb.style.maxHeight = "";
    tb.style.maxWidth = maxMain + "px";
  }
  const w = tb.offsetWidth;
  const h = tb.offsetHeight;
  tb.className = savedClass;
  tb.style.maxWidth = s.mw;
  tb.style.maxHeight = s.mh;
  tb.style.width = s.w;
  tb.style.minHeight = s.mnh;
  tb.style.position = s.pos;
  tb.style.left = s.l;
  tb.style.right = s.r;
  tb.style.top = s.t;
  tb.style.bottom = s.b;
  return { w, h };
}

/** Rzeczywiste rozmiary paska PO zadokowaniu do każdej krawędzi (góra/dół poziomo, boki pionowo;
 * prawa/dół uwzględniają rezerwę panelu zoomu). Liczone raz na początku drag — treść stała. */
function dockedSizes(tb: HTMLElement, pane: HTMLElement): SizeMap {
  // panel zoomu bywa dzieckiem paska (pin dół) — wyjmij go, inaczej zafałszuje wymiary (zwłaszcza
  // szerokość przy doku bocznym). Po drag i tak przerysujemy pasek i ustawimy zoom od nowa.
  const zp = document.getElementById("zoom-panel");
  if (zp && zp.parentElement === tb) pane.appendChild(zp);
  const m = 8;
  const z = zoomReserve();
  const pw = pane.clientWidth;
  const ph = pane.clientHeight;
  return {
    top: measureToolbarSize(tb, false, pw - 2 * m),
    bottom: measureToolbarSize(tb, false, pw - 2 * m - z.w),
    left: measureToolbarSize(tb, true, ph - 2 * m),
    right: measureToolbarSize(tb, true, ph - 2 * m - z.h),
  };
}

/** Gdzie wyląduje pasek przy upuszczeniu: kursor poza podglądem (lub poza oknem) → przypięty poza
 * tą krawędzią; blisko krawędzi (wg rogu paska) → dok pływający; inaczej → swobodnie. */
function computeDrop(cx: number, cy: number, paneRect: DOMRect, tbX: number, tbY: number, tw: number, th: number): DropTarget {
  // 1) kursor wyszedł poza panel którąś stroną (także poza całe okno) → przypnij poza tą krawędzią
  const overL = paneRect.left - cx;
  const overR = cx - paneRect.right;
  const overT = paneRect.top - cy;
  const overB = cy - paneRect.bottom;
  const over = Math.max(overL, overR, overT, overB);
  if (over > 0) {
    const dock: Dock = over === overL ? "left" : over === overR ? "right" : over === overT ? "top" : "bottom";
    return { dock, pinned: true };
  }
  // 2) wewnątrz: najbliższa krawędź w progu → dok pływający (jeszcze nad podglądem)
  const thresh = 48;
  const dl = tbX;
  const dr = paneRect.width - (tbX + tw);
  const dtp = tbY;
  const db = paneRect.height - (tbY + th);
  const min = Math.min(dl, dr, dtp, db);
  if (min <= thresh) {
    const dock: Dock = min === dtp ? "top" : min === db ? "bottom" : min === dl ? "left" : "right";
    return { dock, pinned: false };
  }
  return { dock: "free", pinned: false };
}

/** Podświetla miejsce, w które trafi pasek po upuszczeniu — w jego DOCELOWYCH wymiarach (po
 * zadokowaniu), nie w bieżącym rozmiarze. */
function showDropIndicator(pane: HTMLElement, drop: DropTarget, sizes: SizeMap) {
  if (drop.dock === "free") {
    hideDropIndicator();
    return;
  }
  let el = document.getElementById("tb-drop-indicator");
  if (!el) {
    el = document.createElement("div");
    el.id = "tb-drop-indicator";
    pane.appendChild(el);
  }
  el.style.display = "block";
  el.classList.toggle("pinned", drop.pinned);
  const pw = pane.clientWidth;
  const ph = pane.clientHeight;
  const m = 8;
  const sz = sizes[drop.dock];
  let l: number, t: number, w: number, h: number;
  if (drop.pinned) {
    // pasek poza podglądem: pas przy krawędzi o grubości docelowego paska
    if (drop.dock === "left") [l, t, w, h] = [0, 0, sz.w, ph];
    else if (drop.dock === "right") [l, t, w, h] = [pw - sz.w, 0, sz.w, ph];
    else if (drop.dock === "top") [l, t, w, h] = [0, 0, pw, sz.h];
    else [l, t, w, h] = [0, ph - sz.h, pw, sz.h];
  } else {
    // dok pływający przy krawędzi: prostokąt o wymiarach paska po zadokowaniu
    w = sz.w;
    h = sz.h;
    if (drop.dock === "top") [l, t] = [(pw - w) / 2, m];
    else if (drop.dock === "bottom") [l, t] = [(pw - w) / 2, ph - h - m];
    else if (drop.dock === "left") [l, t] = [m, (ph - h) / 2];
    else [l, t] = [pw - w - m, (ph - h) / 2];
  }
  el.style.left = Math.max(0, l) + "px";
  el.style.top = Math.max(0, t) + "px";
  el.style.width = w + "px";
  el.style.height = h + "px";
}
function hideDropIndicator() {
  const el = document.getElementById("tb-drop-indicator");
  if (el) el.style.display = "none";
}

function setupToolbarDrag(grip: HTMLElement) {
  grip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const tb = document.getElementById("float-toolbar")!;
    const pane = document.getElementById("preview-pane")!;
    // przeciągnięcie przypiętego paska odpina go (wraca do trybu pływającego)
    if (toolbarPinned) {
      toolbarPinned = false;
      applyPinLayout();
    }
    positionZoomPanel(); // wyjmij zoom z paska (jeśli był w nim wpięty) → czyste pomiary + zoom w rogu
    tb.classList.add("dragging");
    // docelowe wymiary po zadokowaniu (raz — treść się nie zmienia podczas drag)
    const sizes = dockedSizes(tb, pane);
    // Pasek od razu przyjmuje swój wygląd po upuszczeniu w trybie swobodnym: poziomy + ustawiony
    // rozmiar (np. z pionowego doku robi się poziomy zaraz po chwycie).
    toolbarDock = "free";
    tb.classList.remove("vertical");
    tb.style.maxWidth = "";
    tb.style.maxHeight = "";
    tb.style.minHeight = "";
    tb.style.width = toolbarW > 0 ? Math.max(80, Math.min(pane.clientWidth - 16, toolbarW)) + "px" : "";
    const paneRect = pane.getBoundingClientRect();
    const tbRect = tb.getBoundingClientRect();
    let offX = Math.max(0, Math.min(tb.offsetWidth, e.clientX - tbRect.left));
    let offY = Math.max(0, Math.min(tb.offsetHeight, e.clientY - tbRect.top));
    try {
      grip.setPointerCapture(e.pointerId);
    } catch {
      /* brak wsparcia capture — drag i tak działa w obrębie okna */
    }
    let drop: DropTarget = { dock: "free", pinned: false };
    const onMove = (mv: PointerEvent) => {
      const x = Math.max(0, Math.min(pane.clientWidth - tb.offsetWidth, mv.clientX - paneRect.left - offX));
      const y = Math.max(0, Math.min(pane.clientHeight - tb.offsetHeight, mv.clientY - paneRect.top - offY));
      toolbarX = x;
      toolbarY = y;
      toolbarDock = "free";
      tb.style.left = x + "px";
      tb.style.top = y + "px";
      tb.style.right = "auto";
      tb.style.bottom = "auto";
      // docelowe ułożenie (dok przy krawędzi / przypięcie poza podglądem — także gdy kursor poza oknem)
      drop = computeDrop(mv.clientX, mv.clientY, paneRect, x, y, tb.offsetWidth, tb.offsetHeight);
      showDropIndicator(pane, drop, sizes);
    };
    const onUp = () => {
      grip.removeEventListener("pointermove", onMove);
      grip.removeEventListener("pointerup", onUp);
      grip.removeEventListener("pointercancel", onUp);
      try {
        grip.releasePointerCapture(e.pointerId);
      } catch {
        /* już zwolniony */
      }
      tb.classList.remove("dragging");
      hideDropIndicator();
      toolbarDock = drop.dock;
      toolbarPinned = drop.pinned && drop.dock !== "free";
      tb.classList.toggle("vertical", toolbarDock === "left" || toolbarDock === "right");
      applyPinLayout();
      buildFloatToolbar(); // odśwież ikony (strzałka przypięcia dla nowej krawędzi) + applyToolbarPos
      persistState();
      scheduleDecorations(); // rozmiar podglądu mógł się zmienić (przypięcie poza podgląd)
    };
    grip.addEventListener("pointermove", onMove);
    grip.addEventListener("pointerup", onUp);
    grip.addEventListener("pointercancel", onUp);
  });
}

/** Zmiana szerokości pływającego (free) paska uchwytem w prawym-dolnym rogu. Limit górny = naturalna
 * szerokość w jednym rzędzie (nie da się rozciągnąć ponad to, co potrzeba na wszystkie ikony). */
function setupToolbarResize(handle: HTMLElement) {
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation(); // nie rozpoczynaj przeciągania paska
    const tb = document.getElementById("float-toolbar")!;
    // naturalna szerokość (wszystko w jednym rzędzie) — twardy limit górny
    const sMaxW = tb.style.maxWidth;
    const sW = tb.style.width;
    tb.style.maxWidth = "none";
    tb.style.width = "max-content";
    const naturalW = tb.offsetWidth;
    tb.style.maxWidth = sMaxW;
    tb.style.width = sW;
    const startX = e.clientX;
    const startW = tb.offsetWidth;
    tb.classList.add("resizing");
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      /* brak wsparcia capture */
    }
    const onMove = (mv: PointerEvent) => {
      toolbarW = Math.max(80, Math.min(naturalW, startW + (mv.clientX - startX)));
      applyToolbarPos();
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      try {
        handle.releasePointerCapture(e.pointerId);
      } catch {
        /* już zwolniony */
      }
      tb.classList.remove("resizing");
      persistState();
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  });
}

// ---------- pływający panel zoomu (prawy-dolny róg podglądu) ----------
function buildZoomPanel() {
  const zp = document.getElementById("zoom-panel")!;
  zp.innerHTML = "";
  zp.appendChild(
    iconBtn("codicon-zoom-out", T("Zoom.Out"), () => {
      fitMode = false;
      setZoom(zoom / 1.25);
      persistState();
      buildZoomPanel();
    })
  );
  const label = document.createElement("button");
  label.id = "zoom-label";
  label.className = "ic-btn";
  label.title = T("Zoom.Reset");
  label.textContent = Math.round(zoom * 100) + "%";
  label.onclick = () => {
    fitMode = false;
    setZoom(1);
    persistState();
    buildZoomPanel();
  };
  zp.appendChild(label);
  zp.appendChild(
    iconBtn("codicon-zoom-in", T("Zoom.In"), () => {
      fitMode = false;
      setZoom(zoom * 1.25);
      persistState();
      buildZoomPanel();
    })
  );
  zp.appendChild(
    iconBtn("codicon-screen-full", T("Zoom.FitTip"), () => {
      fitMode = true;
      applyFit();
      persistState();
      buildZoomPanel();
    }, { active: fitMode })
  );
  positionZoomPanel();
}

/** Ustawia panel zoomu względem PRZYPIĘTEGO paska (pin dół/prawa), by się nie zasłaniały.
 * - pin DÓŁ: jeśli zoom mieści się po prawej w pasku → wstaw go JAKO element paska (dosunięty do
 *   prawej), inaczej przesuń zoom NAD pasek;
 * - pin PRAWA: przesuń zoom w lewo, obok pionowego paska.
 * Dotyczy tylko paska PRZYPIĘTEGO (poza podglądem) — pływający dok obsługuje applyToolbarPos. */
function positionZoomPanel() {
  const zp = document.getElementById("zoom-panel");
  const tb = document.getElementById("float-toolbar");
  const pane = document.getElementById("preview-pane");
  if (!zp || !tb || !pane) return;
  // ZAWSZE zacznij od stanu domyślnego: zoom jako bezpośrednie dziecko panelu, absolutnie w rogu
  if (zp.parentElement !== pane) pane.appendChild(zp);
  zp.classList.remove("in-toolbar");
  zp.style.left = "";
  zp.style.top = "";
  zp.style.right = "";
  zp.style.bottom = "";

  const pinned = toolbarPinned && toolbarDock !== "free";
  if (!pinned || zp.offsetParent === null) return; // brak przypięcia albo zoom ukryty (tryb Zmiany)

  if (toolbarDock === "right") {
    zp.style.right = tb.offsetWidth + 10 + "px"; // w lewo, obok pionowego paska
    return;
  }
  if (toolbarDock === "bottom") {
    const zw = zp.offsetWidth;
    const last = tb.lastElementChild as HTMLElement | null;
    const tbRect = tb.getBoundingClientRect();
    // wolne miejsce po prawej w ostatnim rzędzie paska (od końca ostatniego przycisku do krawędzi)
    const freeRight = last ? tbRect.right - last.getBoundingClientRect().right - 4 : tbRect.width;
    if (freeRight >= zw + 12) {
      // mieści się → wstaw zoom DO paska jako element flex, dosunięty do prawej (margin-left:auto)
      zp.classList.add("in-toolbar");
      tb.appendChild(zp);
    } else {
      // nie mieści się → przesuń zoom NAD pasek (pozostaje w panelu, absolutnie)
      zp.style.right = "10px";
      zp.style.bottom = tb.offsetHeight + 10 + "px";
    }
  }
}

// ---------- status hosta WPF: kropka + log ----------
function hostStatusText(): string {
  let s: string;
  if (!hostState.active) return T("Host.Inactive");
  if (hostState.status === "ok") s = T("Host.Ok");
  else if (hostState.status === "error") s = T("Host.Error");
  else s = T("Host.Idle");
  // dopisz znacznik, gdy to okno używa izolowanego (osobnego) hosta
  if (isolationEffective === "isolated") s += " · " + T("Host.Isolated");
  return s;
}
function hostDotState(): string {
  if (!hostState.active) return "inactive";
  return hostState.status === "ok" || hostState.status === "error" ? hostState.status : "idle";
}
function updateHostDot() {
  const btn = document.getElementById("host-dot-btn");
  const span = btn?.querySelector<HTMLElement>(".host-dot");
  if (!btn || !span) return;
  // niebieski pierścień, gdy aktywne są jakiekolwiek zasoby (web lub WPF) — w tym z innego okna
  span.className = "host-dot host-" + hostDotState() + (resourceState?.loaded ? " has-res" : "");
  btn.title = hostStatusText() + " · " + T("Host.ClickLog");
}
function toggleHostLog(force?: boolean) {
  hostLogOpen = force ?? !hostLogOpen;
  const existing = document.getElementById("host-log-overlay");
  if (!hostLogOpen) {
    existing?.remove();
    return;
  }
  if (!existing) {
    const overlay = document.createElement("div");
    overlay.id = "host-log-overlay";
    overlay.onclick = (e) => {
      if (e.target === overlay) toggleHostLog(false);
    };
    document.body.appendChild(overlay);
  }
  renderHostLog();
}
function renderHostLog() {
  const overlay = document.getElementById("host-log-overlay");
  if (!overlay) return;
  overlay.innerHTML = "";
  const panel = document.createElement("div");
  panel.id = "host-log-panel";

  const head = document.createElement("div");
  head.className = "settings-head";
  const titleWrap = document.createElement("div");
  titleWrap.style.display = "flex";
  titleWrap.style.alignItems = "center";
  titleWrap.style.gap = "8px";
  const title = document.createElement("span");
  title.className = "pane-subtitle";
  title.style.margin = "0";
  title.textContent = T("Host.LogTitle");
  const badge = document.createElement("span");
  badge.className = "host-dot host-" + hostDotState() + (resourceState?.loaded ? " has-res" : "");
  titleWrap.append(title, badge);
  const close = document.createElement("button");
  close.className = "field-btn";
  close.textContent = "✕";
  close.onclick = () => toggleHostLog(false);
  head.append(titleWrap, close);
  panel.appendChild(head);

  // 1) stan hosta (np. „WPF host: OK") + silnik (Web / WPF)
  const statusLine = document.createElement("div");
  statusLine.className = "settings-note host-status-line";
  statusLine.textContent = hostStatusText() + " · " + engineLabel();
  panel.appendChild(statusLine);

  // 2) sekcja zasobów projektu (oddzielona od logu/konsoli)
  panel.appendChild(renderResourcesSection());

  // 3) zakładki: Console (aktywny błąd) | Log (historia)
  const tabs = document.createElement("div");
  tabs.className = "host-tabs";
  const mkTab = (id: "console" | "log", label: string) => {
    const b = document.createElement("button");
    b.className = "host-tab" + (hostLogTab === id ? " active" : "");
    b.textContent = label;
    b.onclick = () => {
      hostLogTab = id;
      renderHostLog();
    };
    return b;
  };
  tabs.append(mkTab("console", T("Host.TabConsole")), mkTab("log", T("Host.TabLog")));
  panel.appendChild(tabs);

  const body = document.createElement("div");
  body.className = "host-tab-body";
  body.appendChild(hostLogTab === "console" ? renderConsoleTab() : renderLogTab());
  panel.appendChild(body);

  overlay.appendChild(panel);
}

// ---------- okienko „Project resources" (web + WPF) ----------
function engineLabel(): string {
  return resourceState?.engine === "wpf" ? T("Engine.Wpf") : T("Engine.Web");
}
function toggleResourcesDialog(force?: boolean) {
  resourcesDialogOpen = force ?? !resourcesDialogOpen;
  const existing = document.getElementById("resources-overlay");
  if (!resourcesDialogOpen) {
    existing?.remove();
    return;
  }
  if (!existing) {
    const overlay = document.createElement("div");
    overlay.id = "resources-overlay";
    overlay.onclick = (e) => {
      if (e.target === overlay) toggleResourcesDialog(false);
    };
    document.body.appendChild(overlay);
  }
  renderResourcesDialog();
}
function renderResourcesDialog() {
  const overlay = document.getElementById("resources-overlay");
  if (!overlay) return;
  overlay.innerHTML = "";
  const panel = document.createElement("div");
  panel.id = "resources-panel";
  const st = resourceState;

  const head = document.createElement("div");
  head.className = "settings-head";
  const title = document.createElement("span");
  title.className = "pane-subtitle";
  title.style.margin = "0";
  title.textContent = T("Resources.DialogTitle");
  const close = document.createElement("button");
  close.className = "field-btn";
  close.textContent = "✕";
  close.onclick = () => toggleResourcesDialog(false);
  head.append(title, close);
  panel.appendChild(head);

  const eng = document.createElement("div");
  eng.className = "settings-note";
  eng.textContent = T("Resources.Engine") + ": " + engineLabel();
  panel.appendChild(eng);

  const sum = document.createElement("div");
  sum.className = "host-resources";
  if (st && st.summary) {
    const r = document.createElement("div");
    r.className = "host-log-row host-log-info";
    r.textContent = st.summary;
    sum.appendChild(r);
  } else {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = T("Host.NoResources");
    sum.appendChild(e);
  }
  panel.appendChild(sum);

  if (st?.sharedByOther) {
    const sh = document.createElement("div");
    sh.className = "host-log-row host-log-info";
    sh.textContent = T("Resources.SharedByOther").replace("{0}", st.sharedByOther.name);
    panel.appendChild(sh);
  }

  // lista zasobów (checkboxy) — zmiana wysyła całą selekcję
  if (st && st.items.length) {
    const list = document.createElement("div");
    list.style.marginTop = "8px";
    for (const it of st.items) {
      const row = document.createElement("label");
      row.className = "res-row";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = it.selected;
      cb.dataset.path = it.path;
      cb.onchange = () => {
        const paths = Array.from(list.querySelectorAll<HTMLInputElement>("input[type=checkbox]"))
          .filter((c) => c.checked)
          .map((c) => c.dataset.path!);
        vscode.postMessage({ type: "setResourceSelection", paths });
      };
      const name = document.createElement("span");
      name.textContent = it.label;
      const kind = document.createElement("span");
      kind.className = "res-kind";
      kind.textContent = it.kind;
      row.append(cb, name, kind);
      list.appendChild(row);
    }
    panel.appendChild(list);
  }

  // wybór języka resx (gdy projekt ma warianty)
  if (st && st.languages.length) {
    const wrap = document.createElement("div");
    wrap.className = "res-lang";
    const lbl = document.createElement("span");
    lbl.textContent = T("Resources.Language") + ":";
    const sel = document.createElement("select");
    for (const l of st.languages) {
      const o = document.createElement("option");
      o.value = l.value;
      o.textContent = l.label;
      if (l.value === st.language) o.selected = true;
      sel.appendChild(o);
    }
    sel.onchange = () => vscode.postMessage({ type: "setResourceLanguage", lang: sel.value });
    wrap.append(lbl, sel);
    // WPF: opcjonalne wymuszenie kultury przez refleksję (TranslationSource.Instance.CurrentCulture)
    if (st.engine === "wpf") {
      const cbWrap = document.createElement("label");
      cbWrap.className = "res-reflect";
      cbWrap.title = T("Resources.ReflectCultureTip");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = st.reflectCulture;
      cb.onchange = () => vscode.postMessage({ type: "setResourceReflectCulture", enabled: cb.checked });
      const tx = document.createElement("span");
      tx.textContent = T("Resources.ReflectCulture");
      cbWrap.append(cb, tx);
      wrap.appendChild(cbWrap);
    }
    panel.appendChild(wrap);
  }

  const actions = document.createElement("div");
  actions.className = "res-actions";
  const load = resBtn("codicon-cloud-download", T("Resources.LoadBtn"), () =>
    vscode.postMessage({ type: "openResourcePicker" })
  );
  load.classList.add("primary");
  const unload = resBtn("codicon-clear-all", T("Resources.UnloadBtn"), () =>
    vscode.postMessage({ type: "unloadResources" })
  );
  actions.append(load, unload);
  panel.appendChild(actions);

  overlay.appendChild(panel);
}

/** Większy przycisk z ikoną (codicon) i etykietą — okienko zasobów. */
function resBtn(codicon: string, label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "res-btn";
  const ic = document.createElement("span");
  ic.className = "codicon " + codicon;
  const tx = document.createElement("span");
  tx.textContent = label;
  b.append(ic, tx);
  b.onclick = onClick;
  return b;
}

// ---------- dok konsoli hosta (na dole obszaru podglądu projektu / zmian) ----------
// Pokazujemy konsolę zadokowaną pod podglądem (w #preview-pane), a nie w panelach Struktura /
// Właściwości, w dwóch sytuacjach: (1) host WPF zgłosił błąd renderu, (2) host się uruchamia
// („starting…”) — wtedy pokazujemy jego status i log. Otwiera się automatycznie przy nowym stanie;
// można ją zamknąć (zostaje zamknięta do następnej, innej zmiany stanu). Po gotowości (ok) znika.
function hostConsoleStateKey(): string | null {
  if (hostState.status === "error" && hostState.error?.message) return "err:" + hostState.error.message;
  // active + jeszcze nie „ok” (status inactive/idle) → host się wczytuje; pokazujemy tylko gdy włączone
  if (consoleOnStart && hostState.active && hostState.status !== "ok") return "starting";
  return null;
}
function syncHostConsoleDock() {
  const key = hostConsoleStateKey();
  if (!key) {
    hostConsoleKey = null;
    hideHostConsoleDock();
    return;
  }
  if (key !== hostConsoleKey) {
    hostConsoleKey = key; // nowy stan → pokaż dok
    renderHostConsoleDock();
  } else if (document.getElementById("host-console-dock")?.classList.contains("visible")) {
    renderHostConsoleDock(); // ten sam stan, dok otwarty → tylko odśwież (np. nowe wpisy logu)
  }
}
function hideHostConsoleDock() {
  const dock = document.getElementById("host-console-dock");
  if (dock) {
    dock.classList.remove("visible");
    dock.innerHTML = "";
  }
}
function renderHostConsoleDock() {
  const dock = document.getElementById("host-console-dock");
  if (!dock) return;
  dock.classList.add("visible");
  dock.innerHTML = "";

  const isError = hostState.status === "error" && !!hostState.error?.message;

  const head = document.createElement("div");
  head.className = "host-dock-head";
  const titleWrap = document.createElement("div");
  titleWrap.className = "host-dock-title";
  const badge = document.createElement("span");
  badge.className = "host-dot host-" + (isError ? "error" : "idle");
  const title = document.createElement("span");
  // błąd → „Konsola”; uruchamianie → bieżący status hosta („uruchamianie…”)
  title.textContent = T("Host.LogTitle") + " · " + (isError ? T("Host.TabConsole") : hostStatusText());
  titleWrap.append(badge, title);
  const actions = document.createElement("div");
  actions.className = "host-dock-actions";
  const logBtn = document.createElement("button");
  logBtn.className = "field-btn";
  logBtn.title = T("Host.ClickLog");
  logBtn.textContent = T("Host.TabLog");
  logBtn.onclick = () => toggleHostLog(true);
  const close = document.createElement("button");
  close.className = "field-btn";
  close.title = T("Pane.Close");
  close.textContent = "✕";
  close.onclick = () => hideHostConsoleDock(); // hostConsoleKey zostaje → nie otwiera się ponownie
  actions.append(logBtn, close);
  head.append(titleWrap, actions);
  dock.appendChild(head);

  const box = document.createElement("div");
  box.className = "host-log";
  const err = hostState.error;
  if (isError && err) {
    const row = document.createElement("div");
    row.className = "host-log-row host-log-error";
    const loc = err.line > 0 ? ` (${err.line}:${err.col || 1})` : "";
    row.textContent = err.message + loc;
    if (err.line > 0) {
      row.classList.add("host-log-clickable");
      row.title = T("Host.GoToError");
      row.onclick = () =>
        vscode.postMessage({ type: "revealError", line: err.line, col: err.col || 1, message: err.message });
    }
    box.appendChild(row);
    if (err.fixTo) {
      const fixRow = document.createElement("div");
      fixRow.className = "host-fix-row";
      const b = document.createElement("button");
      b.className = "tb-btn";
      b.textContent = T("Host.AutoFix") + " " + err.fixTo;
      b.onclick = () => vscode.postMessage({ type: "autoFix" });
      fixRow.appendChild(b);
      box.appendChild(fixRow);
    }
  } else {
    // uruchamianie hosta: linia bieżącego statusu + chronologiczny log zdarzeń (jak zakładka Log)
    const statusRow = document.createElement("div");
    statusRow.className = "host-log-row host-log-info";
    statusRow.textContent = hostStatusText();
    box.appendChild(statusRow);
    for (const entry of hostState.log) {
      const row = document.createElement("div");
      row.className = "host-log-row host-log-" + entry.level;
      const time = new Date(entry.t).toLocaleTimeString();
      const loc = typeof entry.line === "number" && entry.line > 0 ? ` (${entry.line}:${entry.col ?? 1})` : "";
      row.textContent = "[" + time + "] " + entry.msg + loc;
      if (typeof entry.line === "number" && entry.line > 0) {
        row.classList.add("host-log-clickable");
        row.title = T("Host.GoToError");
        row.onclick = () =>
          vscode.postMessage({ type: "revealError", line: entry.line!, col: entry.col ?? 1, message: entry.msg });
      }
      box.appendChild(row);
    }
  }
  dock.appendChild(box);
}

// ---------- konsola debug (telemetria renderu hosta WPF) ----------
// Pokazywana na dole podglądu gdy włączona w ADVANCED. Średni czas klatki liczony od ostatniej
// zmiany ustawień ADVANCED (resetDebugStats zeruje akumulator).
let debugMsSum = 0;
let debugMsCount = 0;
let debugDockHidden = false; // ręczne zamknięcie ✕ (do najbliższej aktualizacji)
let lastDebugData: any = null; // ostatnia telemetria — do odświeżenia widoku po resecie średniej
function resetDebugStats() {
  debugMsSum = 0;
  debugMsCount = 0;
}
function hideDebugDock() {
  const dock = document.getElementById("debug-console-dock");
  if (dock) {
    dock.classList.remove("visible");
    dock.innerHTML = "";
  }
}
/** Przyjmuje telemetrię renderu z rozszerzenia i odświeża konsolę debug. */
function updateDebugDock(d: any) {
  if (!debugConsole) {
    hideDebugDock();
    return;
  }
  if (typeof d.ms === "number") {
    debugMsSum += d.ms;
    debugMsCount++;
  }
  lastDebugData = d;
  debugDockHidden = false; // nowa klatka → pokaż ponownie po ewentualnym zamknięciu
  renderDebugDock(d);
}
function renderDebugDock(d: any) {
  const dock = document.getElementById("debug-console-dock");
  if (!dock || debugDockHidden) return;
  dock.classList.add("visible");
  dock.innerHTML = "";

  const head = document.createElement("div");
  head.className = "host-dock-head";
  const titleWrap = document.createElement("div");
  titleWrap.className = "host-dock-title";
  const badge = document.createElement("span");
  badge.className = "host-dot host-idle";
  const title = document.createElement("span");
  title.textContent = T("Debug.Title");
  titleWrap.append(badge, title);
  const actions = document.createElement("div");
  actions.className = "host-dock-actions";
  // „Live when drag" — przy zaznaczeniu telemetria odświeża się też w trakcie przeciągania elementu
  const liveLbl = document.createElement("label");
  liveLbl.className = "debug-live-toggle";
  const liveCb = document.createElement("input");
  liveCb.type = "checkbox";
  liveCb.checked = debugLiveDrag;
  liveCb.onchange = () => {
    debugLiveDrag = liveCb.checked;
    vscode.postMessage({ type: "setConfig", key: "debugLiveDrag", value: debugLiveDrag });
  };
  liveLbl.append(liveCb, document.createTextNode(T("Debug.LiveDrag")));
  // reset liczenia średniego czasu renderu (jak przy zmianie opcji w Advanced)
  const resetBtn = document.createElement("button");
  resetBtn.className = "field-btn";
  resetBtn.title = T("Debug.ResetAvg");
  resetBtn.innerHTML = '<span class="codicon codicon-refresh"></span>';
  resetBtn.onclick = () => {
    resetDebugStats();
    if (lastDebugData) renderDebugDock(lastDebugData); // odśwież widok (avg → 0)
  };
  const close = document.createElement("button");
  close.className = "field-btn";
  close.title = T("Pane.Close");
  close.textContent = "✕";
  close.onclick = () => {
    debugDockHidden = true;
    hideDebugDock();
  };
  actions.append(liveLbl, resetBtn, close);
  head.append(titleWrap, actions);
  dock.appendChild(head);

  const sc = scrollEl();
  const paneW = Math.round(sc.clientWidth);
  const paneH = Math.round(sc.clientHeight);
  const z = (typeof d.zoom === "number" ? d.zoom : zoom) || 1;
  const num = (v: any, dp = 0) => (typeof v === "number" ? v.toFixed(dp) : "?");
  const avg = debugMsCount ? debugMsSum / debugMsCount : 0;
  const fps = typeof d.ms === "number" && d.ms > 0 ? 1000 / d.ms : 0;
  const avgFps = avg > 0 ? 1000 / avg : 0;
  const vp = d.viewportRender ? "on" : "off";
  const vb = d.viewportRender
    ? `viewbox ${num(d.vbX)},${num(d.vbY)} ${num(d.vbW)}×${num(d.vbH)} (vis ${num(d.visW)}×${num(d.visH)}, ${d.capBasis})`
    : "viewbox off";

  const lines = [
    `${d.backend ?? "wpf-host"}, renderScale=${d.renderScale} (×${num(d.scale, 2)}, dpr ${num(d.dpr, 2)}), cap=${num(d.cap)}px, overscan=${overscan}px, viewport=${vp}`,
    `surface ${num(d.surfW)}×${num(d.surfH)}, pane ${paneW}×${paneH} @${Math.round(z * 100)}%, ${vb}`,
    `rendered ${num(d.rpw)}×${num(d.rph)}px, last ${num(d.ms)}ms (${fps.toFixed(1)} FPS), avg ${avg.toFixed(1)}ms (${avgFps.toFixed(1)} FPS, ${debugMsCount} frames)`,
  ];

  const box = document.createElement("div");
  box.className = "host-log";
  for (const text of lines) {
    const row = document.createElement("div");
    row.className = "host-log-row host-log-info";
    row.textContent = text;
    box.appendChild(row);
  }
  dock.appendChild(box);
}

/** Sekcja „Zasoby projektu" — najświeższy wynik ładowania zasobów (lub brak). */
function renderResourcesSection(): HTMLElement {
  const sec = document.createElement("div");
  sec.className = "host-resources";
  const title = document.createElement("div");
  title.className = "pane-subtitle";
  title.textContent = T("Host.Resources");
  sec.appendChild(title);
  // wspólny stan (web + WPF) ma priorytet; fallback na starsze pole hosta
  const summary = resourceState?.summary || hostState.resources?.msg;
  if (summary) {
    const row = document.createElement("div");
    row.className = "host-log-row host-log-" + (hostState.resources?.level ?? "info");
    row.textContent = summary;
    sec.appendChild(row);
  } else {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = T("Host.NoResources");
    sec.appendChild(e);
  }
  // host współdzielony zajęty przez inne okno (jego zasoby wpływają na ten render)
  if (resourceState?.sharedByOther) {
    const note = document.createElement("div");
    note.className = "host-log-row host-log-info";
    note.textContent = T("Resources.SharedByOther").replace("{0}", resourceState.sharedByOther.name);
    sec.appendChild(note);
  }
  // przycisk do okienka wyboru zasobów
  const pick = resBtn("codicon-checklist", T("Resources.PickResources"), () => {
    toggleHostLog(false);
    toggleResourcesDialog(true);
  });
  pick.style.marginTop = "8px";
  sec.appendChild(pick);
  return sec;
}

/** Zakładka „Console" — tylko aktywny, blokujący błąd renderu + przełącznik podświetlania. */
function renderConsoleTab(): HTMLElement {
  const wrap = document.createElement("div");

  // przełącznik: koloruj linie błędów w edytorze tekstu (parność z „Show changes in code")
  const errField = document.createElement("label");
  errField.className = "tool-field changes-toggle";
  const errCb = document.createElement("input");
  errCb.type = "checkbox";
  errCb.checked = showErrorsInCode;
  errCb.onchange = () => {
    showErrorsInCode = errCb.checked;
    vscode.postMessage({ type: "setShowErrors", enabled: showErrorsInCode });
  };
  errField.append(errCb, document.createTextNode(T("Host.ShowErrors")));
  wrap.appendChild(errField);

  const box = document.createElement("div");
  box.className = "host-log";
  const err = hostState.error;
  if (err && err.message) {
    const row = document.createElement("div");
    row.className = "host-log-row host-log-error";
    const loc = err.line > 0 ? ` (${err.line}:${err.col || 1})` : "";
    row.textContent = err.message + loc;
    if (err.line > 0) {
      row.classList.add("host-log-clickable");
      row.title = T("Host.GoToError");
      row.onclick = () =>
        vscode.postMessage({ type: "revealError", line: err.line, col: err.col || 1, message: err.message });
    }
    box.appendChild(row);

    // przycisk auto-fix: poprawka literówki (poprawka po stronie wtyczki)
    if (err.fixTo) {
      const fixRow = document.createElement("div");
      fixRow.className = "host-fix-row";
      const b = document.createElement("button");
      b.className = "tb-btn";
      b.textContent = T("Host.AutoFix") + " " + err.fixTo;
      b.onclick = () => vscode.postMessage({ type: "autoFix" });
      fixRow.appendChild(b);
      box.appendChild(fixRow);
    }
  } else {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = T("Host.NoErrors");
    box.appendChild(e);
  }
  wrap.appendChild(box);
  return wrap;
}

/** Zakładka „Log" — chronologiczna historia zdarzeń hosta. */
function renderLogTab(): HTMLElement {
  const box = document.createElement("div");
  box.className = "host-log";
  if (!hostState.log.length) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = T("Host.LogEmpty");
    box.appendChild(e);
    return box;
  }
  for (const entry of hostState.log) {
    const row = document.createElement("div");
    row.className = "host-log-row host-log-" + entry.level;
    const time = new Date(entry.t).toLocaleTimeString();
    const loc = typeof entry.line === "number" && entry.line > 0 ? ` (${entry.line}:${entry.col ?? 1})` : "";
    row.textContent = "[" + time + "] " + entry.msg + loc;
    // wpis z pozycją błędu → klik przenosi kursor w edytorze tekstu na ten wiersz/kolumnę
    if (typeof entry.line === "number" && entry.line > 0) {
      row.classList.add("host-log-clickable");
      row.title = T("Host.GoToError");
      row.onclick = () =>
        vscode.postMessage({ type: "revealError", line: entry.line, col: entry.col ?? 1, message: entry.msg });
    }
    box.appendChild(row);
  }
  return box;
}

// ---------- panel ustawień (renderowany w panelu Właściwości, tryb „settings") ----------
/** Sekcja z etykietą i comboboxem (zamiast grupy radio). */
function settingsSelect(
  host: HTMLElement,
  label: string,
  options: { value: string; label: string }[],
  current: string,
  onPick: (v: string) => void,
  note?: string
) {
  const sec = document.createElement("div");
  sec.className = "settings-section";
  const lab = document.createElement("div");
  lab.className = "field-name";
  lab.textContent = label;
  sec.appendChild(lab);
  const sel = document.createElement("select");
  sel.className = "field-input";
  for (const o of options) {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    sel.appendChild(opt);
  }
  sel.value = current;
  sel.onchange = () => onPick(sel.value);
  sec.appendChild(sel);
  if (note) {
    const n = document.createElement("div");
    n.className = "settings-note";
    n.textContent = note;
    sec.appendChild(n);
  }
  host.appendChild(sec);
}
/** Wiersz przełącznika bool (checkbox). */
function settingsCheck(host: HTMLElement, label: string, checked: boolean, onToggle: (v: boolean) => void) {
  const row = document.createElement("label");
  row.className = "settings-radio";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = checked;
  cb.onchange = () => onToggle(cb.checked);
  row.append(cb, document.createTextNode(label));
  host.appendChild(row);
}

/** Wiersz z dwoma zsynchronizowanymi polami: ms oraz FPS (ms = 1000/fps). Edycja jednego aktualizuje
 *  drugie. `onChangeMs` dostaje wartość w ms (0 = brak/„zawsze", tylko gdy allowZero). */
function dualMsFpsField(
  host: HTMLElement,
  label: string,
  initialMs: number,
  onChangeMs: (ms: number) => void,
  opts?: { allowZero?: boolean; title?: string }
) {
  const row = document.createElement("label");
  row.className = "tool-field tool-field-dual";
  const msInp = document.createElement("input");
  msInp.type = "number";
  msInp.min = opts?.allowZero ? "0" : "1";
  msInp.className = "tool-num";
  const fpsInp = document.createElement("input");
  fpsInp.type = "number";
  fpsInp.min = "0";
  fpsInp.className = "tool-num";
  if (opts?.title) { msInp.title = opts.title; fpsInp.title = opts.title; }
  const show = (ms: number) => {
    msInp.value = ms > 0 ? String(Math.round(ms)) : "0";
    fpsInp.value = ms > 0 ? String(Math.round(1000 / ms)) : "0";
  };
  show(initialMs);
  msInp.onchange = () => {
    let ms = parseInt(msInp.value, 10);
    if (isNaN(ms) || ms < 0) return;
    if (!opts?.allowZero && ms < 1) ms = 1;
    fpsInp.value = ms > 0 ? String(Math.round(1000 / ms)) : "0";
    onChangeMs(ms);
  };
  fpsInp.onchange = () => {
    const fps = parseInt(fpsInp.value, 10);
    if (isNaN(fps) || fps < 0) return;
    const ms = fps > 0 ? Math.round(1000 / fps) : 0;
    msInp.value = ms > 0 ? String(ms) : "0";
    onChangeMs(ms);
  };
  if (label) row.appendChild(document.createTextNode(label));
  row.append(msInp, document.createTextNode("ms"), fpsInp, document.createTextNode("FPS"));
  host.appendChild(row);
}

function buildSettings(panel: HTMLElement) {
  // język UI — odzwierciedla główne ustawienie rozszerzenia (xve.language); zmiana po przeładowaniu (Ctrl+R)
  settingsSelect(
    panel,
    T("Settings.Language"),
    [
      { value: "", label: T("Language.FollowVsCode") },
      { value: "en", label: "English" },
      { value: "pl", label: "Polski" },
      { value: "es", label: "Español" },
      { value: "de", label: "Deutsch" },
      { value: "fr", label: "Français" },
      { value: "ja", label: "日本語" },
      { value: "zh", label: "中文" },
    ],
    uiLanguage,
    (v) => {
      uiLanguage = v;
      vscode.postMessage({ type: "setLanguage", value: v });
    },
    T("Settings.LanguageNote")
  );

  // silnik podglądu (combobox) — wspólny z popupem na pasku
  settingsSelect(
    panel,
    T("Settings.Backend"),
    engineModeOptions(),
    engineModeValue(),
    (v) => vscode.postMessage({ type: "setEngineMode", value: v }),
    isWindows ? T("Isolation.Note") : T("Backend.WindowsOnly")
  );

  // izolacja hosta WPF (combobox) — tylko Windows
  if (isWindows) {
    settingsSelect(
      panel,
      T("Settings.Isolation"),
      [
        { value: "ask", label: T("Isolation.Ask") },
        { value: "auto", label: T("Isolation.Auto") },
        { value: "isolated", label: T("Isolation.Always") },
        { value: "shared", label: T("Isolation.Never") },
      ],
      isolationPolicy,
      (v) => {
        isolationPolicy = v;
        vscode.postMessage({ type: "setIsolationPolicy", value: v });
      },
      T("Isolation.SettingNote")
    );
  }

  // motyw podglądu (combobox: motywy projektu + standardowe)
  const themeSec = document.createElement("div");
  themeSec.className = "settings-section";
  const tLabel = document.createElement("div");
  tLabel.className = "field-name";
  tLabel.textContent = T("Settings.PreviewTheme");
  themeSec.appendChild(tLabel);
  const tSel = document.createElement("select");
  tSel.className = "field-input";
  fillThemeSelect(tSel);
  tSel.onchange = () => {
    previewTheme = tSel.value;
    vscode.postMessage({ type: "setPreviewTheme", value: previewTheme });
  };
  themeSec.appendChild(tSel);
  panel.appendChild(themeSec);

  // synchronizacja zaznaczenia (checkboxy) — dotyczy obu silników
  const syncSec = document.createElement("div");
  syncSec.className = "settings-section";
  const syncLabel = document.createElement("div");
  syncLabel.className = "field-name";
  syncLabel.textContent = T("Settings.Sync");
  syncSec.appendChild(syncLabel);
  settingsCheck(syncSec, T("Sync.ToText"), syncSelectInText, (v) => {
    syncSelectInText = v;
    vscode.postMessage({ type: "setSync", key: "selectInTextEditor", value: v });
  });
  settingsCheck(syncSec, T("Sync.FromText"), syncSelectFromText, (v) => {
    syncSelectFromText = v;
    vscode.postMessage({ type: "setSync", key: "selectFromTextCursor", value: v });
  });
  const syncNote = document.createElement("div");
  syncNote.className = "settings-note";
  syncNote.textContent = T("Sync.Note");
  syncSec.appendChild(syncNote);
  panel.appendChild(syncSec);

  // przycisk na dole: otwórz natywne ustawienia rozszerzenia w VS Code
  const appendOpenSettingsBtn = () => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "settings-open-ext";
    btn.textContent = T("Settings.OpenExtSettings");
    btn.onclick = () => vscode.postMessage({ type: "openExtensionSettings" });
    panel.appendChild(btn);
  };

  // zaawansowane — host WPF (zwijane); pokazywane zawsze, nie tylko gdy host WPF aktywny
  const adv = document.createElement("details");
  adv.className = "settings-advanced";
  if (persisted.advancedOpen) adv.open = true;
  adv.addEventListener("toggle", () => {
    persisted.advancedOpen = adv.open; // zapamiętaj rozwinięcie na czas sesji webview
  });
  const sum = document.createElement("summary");
  sum.textContent = T("Settings.Advanced");
  adv.appendChild(sum);

  // skala renderu hosta
  settingsSelect(
    adv,
    T("Settings.RenderScale"),
    [
      { value: "auto", label: T("RenderScale.Auto") },
      { value: "1", label: "1×" },
      { value: "1.5", label: "1.5×" },
      { value: "2", label: "2×" },
      { value: "3", label: "3×" },
    ],
    renderScale,
    (v) => {
      renderScale = v;
      resetDebugStats();
      vscode.postMessage({ type: "setConfig", key: "renderScale", value: renderScale });
    }
  );

  // maks. rozdzielczość renderu (px po dłuższym boku; 0 = bez limitu) — tuż pod skalą renderu
  const capRow = document.createElement("label");
  capRow.className = "tool-field";
  const capInp = document.createElement("input");
  capInp.type = "number";
  capInp.min = "0";
  capInp.step = "256";
  capInp.className = "tool-num";
  capInp.value = String(renderCap);
  capInp.onchange = () => {
    const v = parseInt(capInp.value, 10);
    if (!isNaN(v) && v >= 0) {
      renderCap = v;
      resetDebugStats();
      vscode.postMessage({ type: "setRenderCap", value: renderCap });
    }
  };
  capRow.append(document.createTextNode(T("Drag.MaxRes")), capInp, document.createTextNode("px"));
  adv.appendChild(capRow);

  // adaptacyjna rozdzielczość: niska w ruchu (drag/scroll/zoom), pełna po ustaniu — pod limitem renderu
  settingsCheck(adv, T("Drag.AdaptiveRes"), adaptiveRes, (v) => {
    adaptiveRes = v;
    resetDebugStats();
    vscode.postMessage({ type: "setConfig", key: "adaptiveRes", value: v });
    renderProps(); // pokaż/ukryj pola zależne
  });
  if (adaptiveRes) {
    // rozdzielczość renderu w ruchu (px)
    const motRow = document.createElement("label");
    motRow.className = "tool-field";
    const motInp = document.createElement("input");
    motInp.type = "number";
    motInp.min = "0";
    motInp.step = "128";
    motInp.className = "tool-num";
    motInp.value = String(motionRes);
    motInp.onchange = () => {
      const v = parseInt(motInp.value, 10);
      if (!isNaN(v) && v >= 0) {
        motionRes = v;
        resetDebugStats();
        vscode.postMessage({ type: "setConfig", key: "motionResolution", value: v });
      }
    };
    motRow.append(document.createTextNode(T("Drag.MotionRes")), motInp, document.createTextNode("px"));
    adv.appendChild(motRow);

    // próg: degraduj dopiero gdy pełny render poniżej (zsynchronizowane pola ms/FPS; 0 = zawsze)
    dualMsFpsField(
      adv,
      T("Drag.AdaptiveFps"),
      adaptiveFps > 0 ? 1000 / adaptiveFps : 0,
      (ms) => {
        adaptiveFps = ms > 0 ? Math.round(1000 / ms) : 0;
        resetDebugStats();
        vscode.postMessage({ type: "setConfig", key: "adaptiveFpsThreshold", value: adaptiveFps });
      },
      { allowZero: true, title: T("Drag.AdaptiveFpsAlways") }
    );
  }

  // strategia podglądu przeciągania: tylko nakładka / re-render na żywo (interwał ms↔FPS)
  const dragSec = document.createElement("div");
  dragSec.className = "settings-section";
  const dragLab = document.createElement("div");
  dragLab.className = "field-name";
  dragLab.textContent = T("Settings.DragPreview");
  dragSec.appendChild(dragLab);
  const dragSel = document.createElement("select");
  dragSel.className = "field-input";
  for (const o of [
    { value: "overlay", label: T("Drag.Overlay") },
    { value: "ms", label: T("Drag.Ms") },
  ]) {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    dragSel.appendChild(opt);
  }
  const liveMode = dragPreviewMode !== "overlay"; // „frames" (zaszłość konfiguracji) traktujemy jak „ms"
  dragSel.value = liveMode ? "ms" : "overlay";
  dragSel.onchange = () => {
    dragPreviewMode = dragSel.value as typeof dragPreviewMode;
    resetDebugStats();
    vscode.postMessage({ type: "setConfig", key: "dragStrategy", value: dragPreviewMode });
    persisted.advancedOpen = true;
    renderProps(); // odśwież panel (pole interwału zależne od trybu)
  };
  dragSec.appendChild(dragSel);
  if (liveMode) {
    // interwał re-renderu jako JEDNA wartość (ms); pole „klatki" to ten sam czas przeliczony przez
    // zmierzony czas klatki ekranu (ms = klatki × frameMs). Edycja jednego pola aktualizuje drugie.
    const row = document.createElement("label");
    row.className = "tool-field tool-field-dual";
    const msInp = document.createElement("input");
    msInp.type = "number";
    msInp.min = "0";
    msInp.className = "tool-num";
    const frInp = document.createElement("input");
    frInp.type = "number";
    frInp.min = "1";
    frInp.className = "tool-num";
    const show = () => {
      msInp.value = String(Math.round(dragMs));
      frInp.value = String(Math.max(1, Math.round(dragMs / frameMs)));
    };
    show();
    const commit = () => {
      resetDebugStats();
      vscode.postMessage({ type: "setConfig", key: "dragIntervalMs", value: dragMs });
    };
    msInp.onchange = () => {
      const v = parseInt(msInp.value, 10);
      if (!isNaN(v) && v >= 0) { dragMs = v; frInp.value = String(Math.max(1, Math.round(dragMs / frameMs))); commit(); }
    };
    frInp.onchange = () => {
      const v = parseInt(frInp.value, 10);
      if (!isNaN(v) && v >= 1) { dragMs = Math.round(v * frameMs); msInp.value = String(dragMs); commit(); }
    };
    row.append(msInp, document.createTextNode("ms"), frInp, document.createTextNode(T("Drag.UnitFrames")));
    dragSec.appendChild(row);
  }
  adv.appendChild(dragSec);

  // przełączniki bool zaawansowane
  settingsCheck(adv, T("Drag.Session"), dragSession, (v) => {
    dragSession = v;
    resetDebugStats();
    vscode.postMessage({ type: "setConfig", key: "dragSession", value: v });
  });
  settingsCheck(adv, T("Drag.Coalesce"), dragCoalesce, (v) => {
    dragCoalesce = v;
    resetDebugStats();
    vscode.postMessage({ type: "setConfig", key: "dragCoalesce", value: v });
  });
  settingsCheck(adv, T("Drag.OnChange"), dragOnChange, (v) => {
    dragOnChange = v;
    resetDebugStats();
    vscode.postMessage({ type: "setConfig", key: "dragOnChange", value: v });
  });

  settingsCheck(adv, T("Drag.Viewport"), viewportRender, (v) => {
    viewportRender = v;
    resetDebugStats();
    if (viewportRender) sendViewbox();
    vscode.postMessage({ type: "setViewportRender", enabled: v });
  });

  // podstawa limitu rozdzielczości w trybie „widoczny obszar" + rozmiar overscanu
  if (viewportRender) {
    settingsSelect(
      adv,
      T("Settings.CapBasis"),
      [
        { value: "visible", label: T("CapBasis.Visible") },
        { value: "slice", label: T("CapBasis.Slice") },
      ],
      capBasis,
      (v) => {
        capBasis = v;
        resetDebugStats();
        sendViewbox();
        vscode.postMessage({ type: "setConfig", key: "capBasis", value: v });
      }
    );
    const overRow = document.createElement("label");
    overRow.className = "tool-field";
    const overInp = document.createElement("input");
    overInp.type = "number";
    overInp.min = "0";
    overInp.step = "25";
    overInp.className = "tool-num";
    overInp.value = String(overscan);
    overInp.onchange = () => {
      const v = parseInt(overInp.value, 10);
      if (!isNaN(v) && v >= 0) {
        overscan = v;
        resetDebugStats();
        sendViewbox();
        vscode.postMessage({ type: "setConfig", key: "overscan", value: v });
      }
    };
    overRow.append(document.createTextNode(T("Settings.Overscan")), overInp, document.createTextNode("px"));
    adv.appendChild(overRow);
  }

  const dnote = document.createElement("div");
  dnote.className = "settings-note";
  dnote.textContent = T("Drag.Note");
  adv.appendChild(dnote);

  // konsola debug (telemetria renderu) — na dole sekcji zaawansowanej
  settingsCheck(adv, T("Settings.DebugConsole"), debugConsole, (v) => {
    debugConsole = v;
    resetDebugStats();
    if (!v) hideDebugDock();
    vscode.postMessage({ type: "setConfig", key: "debugConsole", value: v });
  });

  // dok konsoli przy starcie hosta (błędy pokazują się zawsze, niezależnie od tego przełącznika)
  settingsCheck(adv, T("Settings.ConsoleOnStart"), consoleOnStart, (v) => {
    consoleOnStart = v;
    syncHostConsoleDock(); // wyłączenie chowa dok „uruchamianie…”; błąd zostaje widoczny
    vscode.postMessage({ type: "setConfig", key: "consoleOnStart", value: v });
  });

  panel.appendChild(adv);
  appendOpenSettingsBtn();
}

function changesLabel(short = false): string {
  if (short) return changesData.length ? String(changesData.length) : "";
  return T("View.Changes") + (changesData.length ? ` (${changesData.length})` : "");
}
function updateChangesBadge() {
  // licznik zmian jest częścią przycisku Zmiany (ikona+etykieta) — przebuduj pasek
  buildFloatToolbar();
}

function applyViewMode() {
  document.getElementById("preview-pane")!.classList.toggle("mode-changes", viewMode === "changes");
  buildFloatToolbar();
  if (viewMode === "changes") renderChanges();
  else drawDecorations();
}

// ---------- widok Changes (zmiany vs zapisany plik) ----------
function renderChanges() {
  const host = document.getElementById("changes-view")!;
  host.innerHTML = "";
  const header = document.createElement("div");
  header.className = "changes-header";
  const title = document.createElement("span");
  title.className = "pane-subtitle";
  title.textContent = `${T("Changes.Title")} (${changesData.length})`;
  header.appendChild(title);
  if (changesData.length) {
    const all = document.createElement("button");
    all.className = "tb-btn";
    all.textContent = T("Changes.RevertAll");
    all.onclick = () => vscode.postMessage({ type: "revertAll" });
    header.appendChild(all);
  }
  host.appendChild(header);

  // przełącznik: pokaż zmiany w kodzie (dekoracje linii w edytorze tekstu)
  const diffField = document.createElement("label");
  diffField.className = "tool-field changes-toggle";
  const diffCb = document.createElement("input");
  diffCb.type = "checkbox";
  diffCb.checked = showInlineDiff;
  diffCb.onchange = () => {
    showInlineDiff = diffCb.checked;
    vscode.postMessage({ type: "setInlineDiff", enabled: showInlineDiff });
  };
  diffField.append(diffCb, document.createTextNode(T("Changes.InlineDiff")));
  host.appendChild(diffField);
  if (!changesData.length) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = T("Changes.Empty");
    host.appendChild(e);
    return;
  }
  for (const c of changesData) host.appendChild(changeRow(c));
}

/** T() z podstawieniem placeholderów {0},{1}… (port L.F). */
function tf(key: string, ...args: (string | number)[]): string {
  let s = T(key);
  args.forEach((a, i) => (s = s.replace("{" + i + "}", String(a))));
  return s;
}

type AttrDelta = { name: string; baseline: string | null; current: string | null };

/** Podsumowanie zmienionych atrybutów: `~ name`, `+ name`, `− name` (port BuildAttributeSummary). */
function changeSummary(attrs: AttrDelta[]): string {
  const parts: string[] = [];
  for (const a of attrs) {
    const nm = a.name === "(content)" ? T("View.Source").toLowerCase() : a.name;
    if (a.baseline !== null && a.current === null) parts.push("− " + nm);
    else if (a.baseline === null && a.current !== null) parts.push("+ " + nm);
    else parts.push("~ " + nm);
  }
  return parts.join(", ");
}

/** Buduje monospaced linię otwierającego znacznika z podświetleniem per atrybut (port BuildDiffSideTextBlock). */
function tagLine(
  sign: string,
  tag: string,
  attrs: { name: string; value: string }[],
  content: string | null,
  hi: Map<string, "changed" | "added" | "removed">,
  side: "old" | "new" | "moved",
  contentHi: boolean
): HTMLElement {
  const line = document.createElement("div");
  line.className = "diff-line diff-" + side;
  const add = (text: string, cls?: string) => {
    const s = document.createElement("span");
    if (cls) s.className = cls;
    s.textContent = text;
    line.append(s);
  };
  add(sign + " ", "diff-sign");
  add("<" + tag, "diff-tag");
  for (const a of attrs) {
    const h = hi.get(a.name);
    add(` ${a.name}="${a.value}"`, "diff-pair" + (h ? " hl-" + h : ""));
  }
  if (content !== null && content !== "") {
    add(">");
    add(content, contentHi ? "hl-changed" : undefined);
    add("</" + tag + ">");
  } else add(" />");
  return line;
}

function changeRow(c: Change): HTMLElement {
  const card = document.createElement("div");
  card.className = "change-card";
  const head = document.createElement("div");
  head.className = "change-card-head";
  const title = document.createElement("span");
  title.className = "change-title";
  const revertBtn = document.createElement("button");
  revertBtn.className = "tb-btn change-revert";
  revertBtn.textContent = T("Changes.Revert");

  if (c.kind === "attrs") {
    card.classList.add("ch-attrs");
    title.textContent = tf("Changes.Line", c.line);
    revertBtn.onclick = () => {
      const real = c.attrs.filter((a) => a.name !== "(content)"); // treść revertujemy przez tekst, nie atrybut
      const sets = real.filter((a) => a.baseline !== null).map((a) => ({ name: a.name, value: a.baseline as string }));
      const removes = real.filter((a) => a.baseline === null).map((a) => a.name);
      vscode.postMessage({ type: "revertAttrs", id: c.id, sets, removes });
    };
  } else if (c.kind === "added") {
    card.classList.add("ch-added");
    title.textContent = tf("Changes.Added", c.line);
    revertBtn.onclick = () => vscode.postMessage({ type: "deleteElement", id: c.id });
  } else if (c.kind === "moved") {
    card.classList.add("ch-moved");
    title.textContent = tf("Changes.Moved", c.baseLine, c.line);
    revertBtn.onclick = () =>
      vscode.postMessage({ type: "moveElement", id: c.id, newParentId: c.revertParentId, beforeId: c.revertBeforeId });
  } else {
    card.classList.add("ch-removed");
    title.textContent = tf("Changes.Removed", c.line);
    revertBtn.onclick = () => vscode.postMessage({ type: "revertRemoved", parentId: c.parentId, xml: c.xml, index: c.index });
  }

  head.append(title, revertBtn);
  card.append(head);

  // klik w tytuł (poza removed — element już nie istnieje) → zaznacz i wróć do design
  if (c.kind !== "removed") {
    title.classList.add("clickable");
    title.onclick = () => {
      select((c as { id: number }).id, { scrollPreview: true, scrollTree: true });
      viewMode = "design";
      applyViewMode();
    };
  }

  if (c.kind === "attrs") {
    const oldHi = new Map<string, "changed" | "added" | "removed">();
    const newHi = new Map<string, "changed" | "added" | "removed">();
    let contentChanged = false;
    for (const a of c.attrs) {
      if (a.name === "(content)") {
        contentChanged = true;
        continue;
      }
      if (a.baseline !== null && a.current === null) oldHi.set(a.name, "removed");
      else if (a.baseline !== null && a.current !== null) {
        oldHi.set(a.name, "changed");
        newHi.set(a.name, "changed");
      } else if (a.current !== null) newHi.set(a.name, "added");
    }
    const summary = changeSummary(c.attrs);
    if (summary) {
      const s = document.createElement("div");
      s.className = "change-summary";
      s.textContent = summary;
      card.append(s);
    }
    card.append(tagLine("−", c.tag, c.baselineAttrs, c.baselineContent, oldHi, "old", contentChanged));
    card.append(tagLine("+", c.tag, c.currentAttrs, c.currentContent, newHi, "new", contentChanged));
  } else if (c.kind === "added") {
    card.append(tagLine("+", c.tag, c.attrs, c.content, new Map(), "new", false));
  } else if (c.kind === "moved") {
    card.append(tagLine("↷", c.tag, c.attrs, c.content, new Map(), "moved", false));
  } else {
    card.append(tagLine("−", c.tag, c.attrs, c.content, new Map(), "old", false));
  }
  return card;
}

/** Wyznacza rodzica-kontener dla nowego elementu na podstawie zaznaczenia. */
function targetContainer(): { parentId: number; beforeId: number | null } | null {
  if (!tree) return null;
  if (selectedId === null) return { parentId: tree.id, beforeId: null };
  const node = nodeById.get(selectedId);
  // kontener panelowy LUB items-host (np. zaznaczony TabControl) → wklej do środka jako kolejne dziecko
  if (node && (isContainer(node.tag) || isItemsHost(node.tag))) return { parentId: node.id, beforeId: null };
  const parent = parentById.get(selectedId);
  if (parent) return { parentId: parent.id, beforeId: null };
  return { parentId: tree.id, beforeId: null };
}

function addElement(type: string) {
  const tgt = targetContainer();
  if (!tgt) return;
  vscode.postMessage({
    type: "insertChild",
    parentId: tgt.parentId,
    beforeId: tgt.beforeId,
    xml: defaultSnippet(type),
  });
}

function deleteSelected() {
  if (selectedId === null || !tree || selectedId === tree.id) return;
  vscode.postMessage({ type: "deleteElement", id: selectedId });
  selectedId = null;
}

/** Wytnij = kopiuj do schowka systemowego + usuń (host robi obie operacje). */
function cutElement(id: number) {
  if (!tree || id === tree.id) return; // nie wycinaj korzenia
  vscode.postMessage({ type: "requestCut", id });
  if (selectedId === id) selectedId = null;
}

function pasteClipboard() {
  if (!clipboardXml) return;
  const tgt = targetContainer();
  if (!tgt) return;
  // Autorytatywną zawartość czyta host ze schowka systemowego (między oknami / z edytora tekstu);
  // tu wysyłamy tylko miejsce docelowe. `clipboardXml` to cache UI do szybkiego no-op.
  vscode.postMessage({ type: "requestPaste", parentId: tgt.parentId, beforeId: tgt.beforeId });
}

// ---------- uchwyty zaznaczenia (resize) ----------
const HANDLE_DIRS = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
function buildHandles() {
  const overlay = document.getElementById("sel-overlay")!;
  for (const dir of HANDLE_DIRS) {
    const h = document.createElement("div");
    h.className = "sel-handle h-" + dir;
    h.dataset.handle = dir;
    overlay.appendChild(h);
  }
  applyToolHandles();
}

/** Uchwyty resize widoczne tylko dla narzędzia select (zaznacz/przesuń/skaluj). W Pan i Reorder
 *  zaznaczony element pokazuje samą ramkę bez uchwytów. */
function applyToolHandles() {
  const overlay = document.getElementById("sel-overlay");
  if (overlay) overlay.classList.toggle("no-handles", tool !== "select");
}

// ---------- narzędzia / snap / siatka / prowadnice ----------
type Tool = "select" | "pan" | "reorder";
let tool: Tool = "reorder"; // domyślne narzędzie: zmiana kolejności
// Przyciąganie nie ma już osobnego przełącznika: do siatki gdy `showGrid`, do prowadnic gdy `showRulers`.
let gridStep = typeof persisted.gridStep === "number" ? persisted.gridStep : 8;
let showGrid = persisted.showGrid === true;
let showRulers = persisted.showRulers !== false;
interface Guide {
  axis: "x" | "y";
  pos: number;
}
let guides: Guide[] = [];
let guideDrag: number | null = null;

// ---------- gesty: przesuwanie i skalowanie ----------
// Przyciąganie do SIATKI tylko gdy jest aktywna i widoczna (Pokaż siatkę). Krok = „Step & snap" (gridStep).
function snap(v: number): number {
  const step = showGrid ? gridStep : 1;
  return Math.round(v / step) * step;
}
/** Rozmiar elementu w jednostkach projektu (px) — z DOM (web) lub mapy hit-test hosta (PNG). */
function nodeDesignSize(id: number): { w: number; h: number } {
  if (pngMode()) {
    const r = hostRects.get(id);
    // niewidoczny (przycięty) → realne granice; w pozostałych wypadkach widoczne (jak dotąd)
    if (r?.clipped) return { w: r.rw ?? 0, h: r.rh ?? 0 };
    return { w: r?.w ?? 0, h: r?.h ?? 0 };
  }
  const el = document.querySelector<HTMLElement>(`#surface [data-xve-id="${id}"]`);
  const r = el?.getBoundingClientRect();
  return { w: (r?.width ?? 0) / zoom, h: (r?.height ?? 0) / zoom };
}
/** Prostokąt elementu w jednostkach projektu (x,y,w,h) — z mapy hit-test hosta (PNG) lub z DOM
 *  (web, pozycja ekranowa przeliczona na współrzędne projektu). Baza geometryczna gestu skalowania. */
function nodeDesignRect(id: number): { x: number; y: number; w: number; h: number } {
  if (pngMode()) {
    const r = hostRects.get(id);
    if (!r) return { x: 0, y: 0, w: 0, h: 0 };
    // niewidoczny (przycięty) → realne granice (rx…), by narzędzia działały na prawdziwej geometrii;
    // częściowo widoczny (np. w ScrollViewerze) → widoczne granice jak dotąd (uchwyty pasują do ramki)
    if (r.clipped) return { x: r.rx ?? 0, y: r.ry ?? 0, w: r.rw ?? 0, h: r.rh ?? 0 };
    return { x: r.x, y: r.y, w: r.w, h: r.h };
  }
  const el = document.querySelector<HTMLElement>(`#surface [data-xve-id="${id}"]`);
  const r = el?.getBoundingClientRect();
  if (!r) return { x: 0, y: 0, w: 0, h: 0 };
  const tl = clientToDesign(r.left, r.top);
  return { x: tl.x, y: tl.y, w: r.width / zoom, h: r.height / zoom };
}
/** Snap krawędzi początkowej (lewa/górna) z uwzględnieniem krawędzi końcowej (pos+size): do prowadnicy
 *  może przyciągnąć się DOWOLNA z dwóch krawędzi, zwracana jest wynikowa pozycja krawędzi początkowej.
 *  Odpowiednik SnapEdgeToGuides w aplikacji — dzięki temu element łapie się prawym/dolnym bokiem też. */
function snapEdgeToGuides(axis: "x" | "y", pos: number, size: number): number {
  if (!showRulers) return pos;
  let best = pos;
  let bestD = gridStep;
  for (const g of guides) {
    if (g.axis !== axis) continue;
    const d1 = Math.abs(g.pos - pos);
    if (d1 < bestD) {
      bestD = d1;
      best = g.pos;
    }
    const d2 = Math.abs(g.pos - (pos + size));
    if (d2 < bestD) {
      bestD = d2;
      best = g.pos - size;
    }
  }
  return best;
}

/** Snap POJEDYNCZEJ, edytowanej krawędzi (pozycja absolutna w jednostkach projektu) — najpierw do
 *  siatki, potem do najbliższej prowadnicy w obrębie progu (gridStep). Przeciwna krawędź zostaje na
 *  miejscu (rozmiar liczy wywołujący względem niej), więc nieedytowane boki/narożniki nie drgają. */
function snapResizeEdge(axis: "x" | "y", pos: number): number {
  let best = snap(pos); // siatka (krok = gridStep gdy widoczna, inaczej 1px)
  if (showRulers) {
    let bestD = gridStep;
    for (const g of guides) {
      if (g.axis !== axis) continue;
      const d = Math.abs(g.pos - best);
      if (d < bestD) {
        bestD = d;
        best = g.pos;
      }
    }
  }
  return best;
}

/** Indeks prowadnicy danej osi najbliższej `pos`, jeśli leży w obrębie progu snap (gridStep);
 *  inaczej null. Pozwala traktować klik/przeciągnięcie „w pobliżu" jak trafienie w istniejącą
 *  prowadnicę (jak FindHoveredGuide w aplikacji) — nie tworzymy wtedy dubla. */
function nearestGuideIndex(axis: "x" | "y", pos: number): number | null {
  let best: number | null = null;
  let bestD = gridStep + 0.001;
  guides.forEach((g, i) => {
    if (g.axis !== axis) return;
    const d = Math.abs(g.pos - pos);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

/** Pozycja przeciąganej prowadnicy: najpierw przyciąganie do siatki, a jeśli w obrębie progu snap
 *  (gridStep) leży inna prowadnica tej samej osi — przyciągnij DOKŁADNIE na nią. Dzięki temu snap/scal
 *  jest widoczny już w trakcie przeciągania (po puszczeniu LPM mergeDraggedGuide usunie dubla). */
function snapGuideDrag(axis: "x" | "y", value: number, selfIdx: number): number {
  const gridded = snap(value);
  let best = gridded;
  let bestD = gridStep;
  guides.forEach((g, i) => {
    if (i === selfIdx || g.axis !== axis) return;
    const d = Math.abs(g.pos - gridded);
    if (d < bestD) {
      bestD = d;
      best = g.pos;
    }
  });
  return best;
}

/** Po przeciągnięciu: jeśli prowadnica trafiła w obrębie progu snap (gridStep) w inną na tej samej
 *  osi — scal je: usuń przeciąganą, zostaw istniejącą. Dzięki temu nie powstają dwie prowadnice
 *  w (prawie) tym samym miejscu. */
function mergeDraggedGuide(idx: number) {
  const g = guides[idx];
  if (!g) return;
  for (let i = 0; i < guides.length; i++) {
    if (i === idx) continue;
    const o = guides[i];
    if (o.axis === g.axis && Math.abs(o.pos - g.pos) < gridStep) {
      guides.splice(idx, 1);
      return;
    }
  }
}

// Ręczne wykrywanie podwójnego LPM na prowadnicy. Nie polegamy na natywnym `dblclick`, bo każdy
// mousedown przebudowuje znaczniki linijki (innerHTML=""), a zniszczenie elementu pierwszego
// kliknięcia gubi zdarzenie dblclick w Chromium (webview VS Code). Porównujemy referencję obiektu
// prowadnicy (a nie indeks), bo indeksy zmieniają się przy scalaniu/sortowaniu.
const GUIDE_DBLCLICK_MS = 400;
let lastGuidePress: { guide: Guide; t: number } | null = null;

/** Wciśnięcie LPM na prowadnicy `gi`: drugi klik w tę samą prowadnicę w krótkim odstępie usuwa ją
 *  (zwraca true); inaczej rozpoczyna przeciąganie (zwraca false). */
function pressGuide(gi: number): boolean {
  const g = guides[gi];
  if (!g) return false;
  const now = Date.now();
  if (lastGuidePress && lastGuidePress.guide === g && now - lastGuidePress.t < GUIDE_DBLCLICK_MS) {
    lastGuidePress = null;
    guideDrag = null;
    guides.splice(gi, 1);
    renderGuides();
    updateRulers();
    renderProps();
    return true;
  }
  lastGuidePress = { guide: g, t: now };
  guideDrag = gi;
  return false;
}

interface Drag {
  mode: "move" | "resize";
  dir?: string;
  id: number;
  startX: number;
  startY: number;
  moved: boolean;
  /** rozmiar elementu w chwili rozpoczęcia gestu (baza dla podglądu skalowania) */
  w0: number;
  h0: number;
  /** prostokąt elementu (jednostki projektu) w chwili rozpoczęcia — baza krawędzi przy skalowaniu */
  baseRect?: { x: number; y: number; w: number; h: number };
}
let drag: Drag | null = null;
let dragBaseRect: { x: number; y: number; w: number; h: number } | null = null;
// offset powierzchni (px ekranu) w chwili startu gestu — do przesuwania podglądu, by przy zmianie
// rozmiaru KORZENIA uchwytami lewo/góra przeciwna krawędź (prawo/dół) została wizualnie przypięta.
let dragSurfaceAnchor: { left: number; top: number } | null = null;
// ostatni prostokąt nakładki z onDragMove (jednostki projektu) — do utrzymania ramki
// na nowej pozycji po puszczeniu, zanim wróci autorytatywny render hosta
let dragLastRect: { x: number; y: number; w: number; h: number } | null = null;
let dragLatestAttrs: Record<string, string> | null = null;
let dragRaf = 0;
let dragLastSent = 0;
let dragLastSentKey = ""; // serializacja ostatnio wysłanych atrybutów (dedup przy „render tylko na zmianę")
let dragSettleTimer: ReturnType<typeof setTimeout> | undefined; // dosłanie pełnej rozdzielczości po ustaniu ruchu
let dragSessionActive = false;
let renderInFlight = false; // koalescencja: najwyżej jedna klatka „w locie"

function pngMode(): boolean {
  return previewMode === "wpf" && !!hostPng;
}

function startMove(e: MouseEvent, id: number) {
  drag = { mode: "move", id, startX: e.clientX, startY: e.clientY, moved: false, w0: 0, h0: 0 };
  dragBaseRect = pngMode() ? nodeDesignRect(id) : null; // realne granice (też dla niewidocznych)
  dragLatestAttrs = null;
  // Pompę/sesję hosta uruchamiamy dopiero przy pierwszym realnym ruchu (onDragMove). Inaczej samo
  // kliknięcie wysyła „dragStart", a host re-renderuje BEZ auto-podglądu → fake-lista mignęłaby i znikła.
}
function startResize(e: MouseEvent, dir: string) {
  if (selectedId === null) return;
  e.stopPropagation();
  // baza geometryczna gestu w jednostkach projektu — krawędzie liczymy z niej (PNG i web).
  const base = nodeDesignRect(selectedId);
  dragBaseRect = pngMode() ? { ...base } : null;
  // zapamiętaj bieżące przesunięcie powierzchni (wyśrodkowanie) — dla korzenia uchwyty lewo/góra
  // przesuwają podgląd o tyle, by przeciwna krawędź została w miejscu na ekranie
  const ze0 = zoomEl();
  dragSurfaceAnchor = { left: ze0.offsetLeft, top: ze0.offsetTop };
  drag = {
    mode: "resize",
    dir,
    id: selectedId,
    startX: e.clientX,
    startY: e.clientY,
    moved: false,
    w0: base.w,
    h0: base.h,
    baseRect: base,
  };
  dragLatestAttrs = null;
  // jw. — sesję hosta startujemy dopiero przy realnym ruchu (onDragMove)
}

/** Ustawia nakładkę zaznaczenia we współrzędnych projektu (tryb PNG). */
function setOverlayDesignRect(x: number, y: number, w: number, h: number) {
  dragLastRect = { x, y, w, h }; // zapamiętaj na potrzeby commitu (utrzymanie ramki po puszczeniu)
  const ze = zoomEl();
  const o = document.getElementById("sel-overlay")!;
  o.style.display = "block";
  // korekta -1px jak w updateOverlay() — inaczej ramka podczas move/resize byłaby przesunięta o 1px
  o.style.left = ze.offsetLeft + x * zoom - 0.5 + "px";
  o.style.top = ze.offsetTop + y * zoom - 0.5 + "px";
  o.style.width = Math.max(0, w * zoom) - 0.5 + "px";
  o.style.height = Math.max(0, h * zoom) - 0.5 + "px";
}

// Pompa re-renderu na żywo (tylko tryb PNG + strategia frames/ms). Wysyła do hosta
// PODGLĄD (previewDrag) bez commitu do dokumentu — finalny zapis dopiero po puszczeniu.
/** Wysyła klatkę podglądu, jeśli pozwala odstęp (klatki/ms) i nic nie jest „w locie". */
function trySendDragFrame(now: number) {
  if (!drag || !dragLatestAttrs) return;
  if (dragCoalesce && renderInFlight) return; // koalescencja: czekaj na powrót klatki
  // „render tylko na zmianę": pomiń klatkę, gdy atrybuty się nie zmieniły (np. mysz stoi w miejscu)
  const attrsKey = JSON.stringify(dragLatestAttrs);
  if (dragOnChange && attrsKey === dragLastSentKey) return;
  // „Live re-render every": jedna wartość interwału w ms (pole „klatki" to jej przeliczenie)
  if (now - dragLastSent < Math.max(0, dragMs)) return;
  dragLastSent = now;
  dragLastSentKey = attrsKey;
  renderInFlight = true;
  // w ruchu: niska rozdzielczość (rozszerzenie decyduje wg progu FPS); rootDrag → render pełnej
  // powierzchni bez wycinka (zmiana rozmiaru korzenia rozjeżdża slice „widoczny obszar")
  const msg = { id: drag.id, attrs: dragLatestAttrs, lowRes: adaptiveRes, rootDrag: !!tree && drag.id === tree.id };
  if (dragSessionActive) vscode.postMessage({ type: "dragUpdate", ...msg });
  else vscode.postMessage({ type: "previewDrag", ...msg });
  armDragSettle();
}

/** Po ustaniu ruchu dosyła JEDNĄ klatkę w pełnej rozdzielczości (lowRes:false). Tylko gdy adaptacja wł. */
function armDragSettle() {
  if (!adaptiveRes) return;
  if (dragSettleTimer) clearTimeout(dragSettleTimer);
  dragSettleTimer = setTimeout(() => {
    dragSettleTimer = undefined;
    if (!drag || !dragLatestAttrs) return;
    if (renderInFlight) {
      armDragSettle(); // klatka w locie → spróbuj ponownie po chwili
      return;
    }
    renderInFlight = true;
    dragLastSentKey = JSON.stringify(dragLatestAttrs); // oznacz jako wysłane (unik powtórki w pompie)
    const msg = { id: drag.id, attrs: dragLatestAttrs, lowRes: false, rootDrag: !!tree && drag.id === tree.id };
    if (dragSessionActive) vscode.postMessage({ type: "dragUpdate", ...msg });
    else vscode.postMessage({ type: "previewDrag", ...msg });
  }, MOTION_SETTLE_MS);
}

function startDragPump() {
  if (!pngMode() || dragPreviewMode === "overlay") return;
  dragLastSent = performance.now();
  dragLastSentKey = ""; // nowy gest → pierwsza klatka zawsze idzie
  if (dragSettleTimer) { clearTimeout(dragSettleTimer); dragSettleTimer = undefined; }
  renderInFlight = false;
  // trwała sesja nie dla korzenia (Window): zmiana jego Width/Height musi przeliczyć
  // rozmiar płótna, co robi tylko pełny re-render
  dragSessionActive = dragSession && !!drag && !!tree && drag.id !== tree.id;
  // trwała sesja: host parsuje RAZ na początku gestu
  if (dragSessionActive && drag) vscode.postMessage({ type: "dragStart", id: drag.id });
  let prevT = 0;
  const tick = (t: number) => {
    if (!drag) {
      dragRaf = 0;
      return;
    }
    if (prevT) {
      const d = t - prevT;
      if (d > 0 && d < 100) frameMs = clampFrameMs(frameMs * 0.9 + d * 0.1); // odśwież szac. czasu klatki
    }
    prevT = t;
    trySendDragFrame(t);
    dragRaf = requestAnimationFrame(tick);
  };
  dragRaf = requestAnimationFrame(tick);
}
function stopDragPump() {
  if (dragRaf) cancelAnimationFrame(dragRaf);
  dragRaf = 0;
  if (dragSettleTimer) { clearTimeout(dragSettleTimer); dragSettleTimer = undefined; }
  renderInFlight = false;
  if (dragSessionActive) {
    vscode.postMessage({ type: "dragEnd" });
    dragSessionActive = false;
  }
}

function onDragMove(e: MouseEvent) {
  if (!drag) return;
  const dx = (e.clientX - drag.startX) / zoom;
  const dy = (e.clientY - drag.startY) / zoom;
  const firstMove = !drag.moved;
  if (firstMove && (Math.abs(dx) + Math.abs(dy)) * zoom < 3) return;
  drag.moved = true;
  clickSelectId = null; // realne przeciąganie → to nie klik; nie zmieniaj zaznaczenia przy puszczeniu
  const node = nodeById.get(drag.id);
  if (!node) return;
  // pierwszy realny ruch → dopiero teraz uruchamiamy pompę/sesję hosta (klik nie gasi auto-podglądu)
  if (firstMove) startDragPump();

  // tryb PNG: brak DOM elementu — animujemy tylko nakładkę; attrs trzymamy do commitu/pompy
  if (pngMode()) {
    const base = dragBaseRect ?? { x: 0, y: 0, w: drag.w0, h: drag.h0 };
    if (drag.mode === "move") {
      const { tx, ty } = liveMoveOffset(node, dx, dy);
      setOverlayDesignRect(base.x + tx, base.y + ty, base.w, base.h);
      dragLatestAttrs = computeMove(node, dx, dy);
    } else {
      const dir = drag.dir!;
      let x = base.x;
      let y = base.y;
      let w = base.w;
      let h = base.h;
      const isRoot = !!tree && drag.id === tree.id;
      if (isRoot) {
        // korzeń: zmieniamy tylko rozmiar (bez marginesu), ale uchwyty lewo/góra przypinają przeciwną
        // krawędź — przesuwamy powierzchnię o przyrost rozmiaru, by prawa/dolna została na ekranie.
        if (dir.includes("e") || dir.includes("w")) {
          const ex = dir.includes("e") ? dx : -dx;
          w = Math.max(0, snapResizeEdge("x", base.x + base.w + ex) - base.x);
        }
        if (dir.includes("s") || dir.includes("n")) {
          const ey = dir.includes("s") ? dy : -dy;
          h = Math.max(0, snapResizeEdge("y", base.y + base.h + ey) - base.y);
        }
        const ze = zoomEl();
        if (dir.includes("w") && dragSurfaceAnchor) ze.style.left = dragSurfaceAnchor.left + (base.w - w) * zoom + "px";
        if (dir.includes("n") && dragSurfaceAnchor) ze.style.top = dragSurfaceAnchor.top + (base.h - h) * zoom + "px";
      } else {
        // Skalowanie przyciąga TYLKO edytowaną krawędź (do siatki/prowadnic); przeciwna zostaje na miejscu.
        if (dir.includes("e")) w = Math.max(0, snapResizeEdge("x", base.x + base.w + dx) - base.x);
        if (dir.includes("s")) h = Math.max(0, snapResizeEdge("y", base.y + base.h + dy) - base.y);
        if (dir.includes("w")) {
          x = snapResizeEdge("x", base.x + dx);
          w = Math.max(0, base.x + base.w - x);
        }
        if (dir.includes("n")) {
          y = snapResizeEdge("y", base.y + dy);
          h = Math.max(0, base.y + base.h - y);
        }
      }
      setOverlayDesignRect(x, y, w, h);
      dragLatestAttrs = computeResize(node, dir, dx, dy, drag.w0, drag.h0, base);
    }
    return;
  }

  // tryb web (DOM): podgląd przez transform realnego elementu
  const target = document.querySelector<HTMLElement>(`#surface [data-xve-id="${drag.id}"]`);
  if (!target) return;
  if (drag.mode === "move") {
    const { tx, ty } = liveMoveOffset(node, dx, dy);
    target.style.transform = `translate(${tx}px, ${ty}px)`;
  } else {
    applyResizePreview(target, drag.dir!, dx, dy, drag.baseRect!, !!tree && drag.id === tree.id);
  }
  updateOverlay();
}

/** Przesunięcie w px po nałożeniu snapu do siatki i prowadnic (podgląd na żywo). */
function liveMoveOffset(node: RenderNode, dx: number, dy: number): { tx: number; ty: number } {
  const a = attrMapOf(node);
  const { w, h } = nodeDesignSize(node.id);
  const parent = parentById.get(node.id);
  if (parent && localTag(parent.tag) === "Canvas") {
    const baseL = numOf(a["Canvas.Left"]) ?? 0;
    const baseT = numOf(a["Canvas.Top"]) ?? 0;
    return {
      tx: snapEdgeToGuides("x", snap(baseL + dx), w) - baseL,
      ty: snapEdgeToGuides("y", snap(baseT + dy), h) - baseT,
    };
  }
  const [ml, mt, mr, mb] = thicknessOf(a.Margin);
  const ha = a.HorizontalAlignment || "Stretch";
  const va = a.VerticalAlignment || "Stretch";
  const tx = ha === "Right" ? -(snap(mr - dx) - mr) : snapEdgeToGuides("x", snap(ml + dx), w) - ml;
  const ty = va === "Bottom" ? -(snap(mb - dy) - mb) : snapEdgeToGuides("y", snap(mt + dy), h) - mt;
  return { tx, ty };
}

function applyResizePreview(
  el: HTMLElement,
  dir: string,
  dx: number,
  dy: number,
  base: { x: number; y: number; w: number; h: number },
  root = false
) {
  // korzeń: tylko rozmiar (bez marginesu); uchwyty lewo/góra przypinają przeciwną krawędź
  // (translate odsuwa lewą/górną o przyrost rozmiaru, by prawa/dolna została w miejscu).
  if (root) {
    let w = base.w;
    let h = base.h;
    if (dir.includes("e") || dir.includes("w")) {
      const ex = dir.includes("e") ? dx : -dx;
      w = Math.max(0, snapResizeEdge("x", base.x + base.w + ex) - base.x);
    }
    if (dir.includes("s") || dir.includes("n")) {
      const ey = dir.includes("s") ? dy : -dy;
      h = Math.max(0, snapResizeEdge("y", base.y + base.h + ey) - base.y);
    }
    el.style.width = w + "px";
    el.style.height = h + "px";
    const tx = dir.includes("w") ? base.w - w : 0;
    const ty = dir.includes("n") ? base.h - h : 0;
    el.style.transform = `translate(${tx}px, ${ty}px)`;
    return;
  }
  // baza = prostokąt startowy gestu; przyciągamy TYLKO edytowaną krawędź (siatka/prowadnice),
  // przeciwną zostawiamy na miejscu — translate odsuwa lewą/górną o tyle, ile przesunęła się krawędź.
  let x = base.x;
  let y = base.y;
  let w = base.w;
  let h = base.h;
  if (dir.includes("e")) w = Math.max(0, snapResizeEdge("x", base.x + base.w + dx) - base.x);
  if (dir.includes("s")) h = Math.max(0, snapResizeEdge("y", base.y + base.h + dy) - base.y);
  if (dir.includes("w")) {
    x = snapResizeEdge("x", base.x + dx);
    w = Math.max(0, base.x + base.w - x);
  }
  if (dir.includes("n")) {
    y = snapResizeEdge("y", base.y + dy);
    h = Math.max(0, base.y + base.h - y);
  }
  el.style.width = w + "px";
  el.style.height = h + "px";
  el.style.transform = `translate(${x - base.x}px, ${y - base.y}px)`;
}

function onDragUp(e: MouseEvent) {
  if (!drag) return;
  const d = drag;
  drag = null;
  stopDragPump();
  dragBaseRect = null;
  dragSurfaceAnchor = null;
  dragLatestAttrs = null;

  const node = d.moved ? nodeById.get(d.id) : null;
  let attrs: Record<string, string> | null = null;
  if (node) {
    const dxRaw = (e.clientX - d.startX) / zoom;
    const dyRaw = (e.clientY - d.startY) / zoom;
    // move: snap przesunięcia do siatki (jak dotąd). resize: surowe delty — snap krawędzi robi
    // computeResize, a użycie surowych delt eliminuje skok między ostatnią klatką podglądu a commitem.
    attrs =
      d.mode === "move"
        ? computeMove(node, snap(dxRaw), snap(dyRaw))
        : computeResize(node, d.dir!, dxRaw, dyRaw, d.w0, d.h0, d.baseRect!);
  }
  const committing = !!(attrs && Object.keys(attrs).length);

  if (committing) {
    // Tryb PNG: utrzymaj ramkę zaznaczenia na NOWEJ pozycji do czasu autorytatywnego renderu
    // (host nie odsyła mapy hit-test co klatkę) — inaczej „mrugnęłaby" do pozycji sprzed edycji.
    if (pngMode() && dragLastRect) hostRects.set(d.id, { ...dragLastRect });
    // Tryb web: NIE czyścimy podglądu (transform/rozmiar). Kolejny render `doc` przebuduje DOM
    // na nowej pozycji; reset tutaj powodowałby skok do stanu sprzed edycji i z powrotem.
    vscode.postMessage({ type: "setAttributes", id: d.id, attrs: attrs! });
  } else if (!pngMode() && d.moved) {
    // Ruch był, ale bez commitu (poniżej progu/snapu) — podgląd zmutował inline-style elementu
    // (renderer nakłada Width/Height/transform jako style!). Nie czyścimy ich ręcznie (to wymazałoby
    // też wartości renderera) — odbudowujemy podgląd z niezmienionego drzewa.
    renderPreview();
  }
  dragLastRect = null;
}

function computeMove(node: RenderNode, dx: number, dy: number): Record<string, string> {
  const a = attrMapOf(node);
  const { w, h } = nodeDesignSize(node.id);
  const parent = parentById.get(node.id);
  if (parent && localTag(parent.tag) === "Canvas") {
    const l = snapEdgeToGuides("x", snap((numOf(a["Canvas.Left"]) ?? 0) + dx), w);
    const t = snapEdgeToGuides("y", snap((numOf(a["Canvas.Top"]) ?? 0) + dy), h);
    return { "Canvas.Left": String(l), "Canvas.Top": String(t) };
  }
  const [ml, mt, mr, mb] = thicknessOf(a.Margin);
  let nl = ml,
    nt = mt,
    nr = mr,
    nb = mb;
  if ((a.HorizontalAlignment || "Stretch") === "Right") nr = snap(mr - dx);
  else nl = snapEdgeToGuides("x", snap(ml + dx), w);
  if ((a.VerticalAlignment || "Stretch") === "Bottom") nb = snap(mb - dy);
  else nt = snapEdgeToGuides("y", snap(mt + dy), h);
  return { Margin: `${nl},${nt},${nr},${nb}` };
}

function computeResize(
  node: RenderNode,
  dir: string,
  dx: number,
  dy: number,
  w0: number,
  h0: number,
  base: { x: number; y: number; w: number; h: number }
): Record<string, string> {
  const a = attrMapOf(node);
  const W0 = numOf(a.Width) ?? Math.round(w0);
  const H0 = numOf(a.Height) ?? Math.round(h0);
  const [ml, mt, mr, mb] = thicknessOf(a.Margin);
  const ha = a.HorizontalAlignment || "Stretch";
  const va = a.VerticalAlignment || "Stretch";
  const parent = parentById.get(node.id);
  const onCanvas = !!parent && localTag(parent.tag) === "Canvas";

  // korzeń (Window/UserControl): przypięty do (0,0) powierzchni — uchwyty lewo/góra NIE przesuwają
  // pozycji (margines nie ma sensu dla rozmiaru okna), tylko zmieniają Width/Height (kotwica top-left).
  if (!!tree && node.id === tree.id) {
    let w = base.w;
    let h = base.h;
    if (dir.includes("e") || dir.includes("w")) {
      const ex = dir.includes("e") ? dx : -dx; // lewy uchwyt: ciągnięcie na zewnątrz powiększa
      w = Math.max(0, snapResizeEdge("x", base.x + base.w + ex) - base.x);
    }
    if (dir.includes("s") || dir.includes("n")) {
      const ey = dir.includes("s") ? dy : -dy;
      h = Math.max(0, snapResizeEdge("y", base.y + base.h + ey) - base.y);
    }
    return { Width: String(Math.round(w)), Height: String(Math.round(h)) };
  }

  // Skalujemy przyciągając edytowaną krawędź (siatka/prowadnice) w przestrzeni projektu; przeciwna
  // krawędź zostaje na miejscu, więc rozmiar liczymy względem niej. dLeft/dTop = o ile przesunęła
  // się lewa/górna krawędź (≠0 tylko dla uchwytów w/n) → tym samym korygujemy margines/Canvas.
  let newW = W0;
  let newH = H0;
  let dLeft = 0;
  let dTop = 0;

  if (dir.includes("e")) {
    if (!onCanvas && ha === "Right") newW = Math.max(0, snap(W0 + dx)); // kotwica od prawej: snap rozmiaru
    else newW = Math.max(0, snapResizeEdge("x", base.x + base.w + dx) - base.x);
  } else if (dir.includes("w")) {
    const left = snapResizeEdge("x", base.x + dx);
    newW = Math.max(0, base.x + base.w - left); // prawa krawędź stała
    dLeft = left - base.x;
  }
  if (dir.includes("s")) {
    if (!onCanvas && va === "Bottom") newH = Math.max(0, snap(H0 + dy));
    else newH = Math.max(0, snapResizeEdge("y", base.y + base.h + dy) - base.y);
  } else if (dir.includes("n")) {
    const top = snapResizeEdge("y", base.y + dy);
    newH = Math.max(0, base.y + base.h - top); // dolna krawędź stała
    dTop = top - base.y;
  }

  const out: Record<string, string> = {
    Width: String(Math.round(newW)),
    Height: String(Math.round(newH)),
  };
  if (onCanvas) {
    if (dLeft) out["Canvas.Left"] = String(Math.round((numOf(a["Canvas.Left"]) ?? 0) + dLeft));
    if (dTop) out["Canvas.Top"] = String(Math.round((numOf(a["Canvas.Top"]) ?? 0) + dTop));
    return out;
  }
  let nml = ml;
  let nmt = mt;
  let marginTouched = false;
  // kotwica od prawej/dołu trzyma przeciwną krawędź sama (mr/mb), więc margines ruszamy tylko gdy
  // element jest kotwiczony od lewej/góry — wtedy przesunięcie krawędzi = przesunięcie marginesu.
  if (dLeft && ha !== "Right") {
    nml = ml + dLeft;
    marginTouched = true;
  }
  if (dTop && va !== "Bottom") {
    nmt = mt + dTop;
    marginTouched = true;
  }
  if (marginTouched) out.Margin = `${Math.round(nml)},${Math.round(nmt)},${Math.round(mr)},${Math.round(mb)}`;
  return out;
}

// ---------- wiersz dodawania elementu (panel Struktura, pod nagłówkiem) ----------
function buildTreeAdd() {
  const host = document.getElementById("tree-add");
  if (!host) return;
  host.innerHTML = "";
  const sel = document.createElement("select");
  sel.id = "tb-type";
  sel.className = "tb-select";
  for (const group of ADDABLE_GROUPS) {
    const og = document.createElement("optgroup");
    og.label = T(group.label);
    for (const tname of group.types) {
      const o = document.createElement("option");
      o.value = o.textContent = tname;
      og.appendChild(o);
    }
    sel.appendChild(og);
  }
  host.appendChild(sel);
  host.appendChild(iconBtn("codicon-add", T("Tb.AddTip"), () => addElement(sel.value)));
}

function applyRulersVisibility() {
  const vp = document.getElementById("preview-viewport")!;
  vp.classList.toggle("rulers-on", showRulers);
  vp.classList.toggle("rulers-off", !showRulers);
  renderGuides(); // prowadnice widoczne tylko gdy linijki są włączone
  updateRulers();
}

// ---------- współrzędne projektu ↔ ekran ----------
function surfaceEl(): HTMLElement {
  return document.getElementById("surface")!;
}
function scrollEl(): HTMLElement {
  return document.getElementById("surface-scroll")!;
}
/** Zgłasza realny rozmiar powierzchni podglądu (px, bez paddingu) — host użyje go jako
 * fallbacku dla korzeni bez jawnego Width/Height zamiast sztywnego 1200×900. */
function reportViewport() {
  const sc = scrollEl();
  const w = Math.max(1, Math.round(sc.clientWidth / zoom));
  const h = Math.max(1, Math.round(sc.clientHeight / zoom));
  vscode.postMessage({ type: "viewport", width: w, height: h });
}

/** Przyjmuje migawkę ustawień podglądu z rozszerzenia (źródło prawdy: `xve.preview.*`). */
function applyConfig(c: any) {
  if (!c) return;
  if (typeof c.language === "string") uiLanguage = c.language;
  if (typeof c.renderScale === "string") renderScale = c.renderScale;
  if (typeof c.maxResolution === "number") renderCap = c.maxResolution;
  if (typeof c.theme === "string") previewTheme = c.theme;
  if (typeof c.previewCulture === "string") previewCulture = c.previewCulture;
  if (typeof c.viewportRender === "boolean") viewportRender = c.viewportRender;
  if (typeof c.overscan === "number") overscan = c.overscan;
  if (c.capBasis === "visible" || c.capBasis === "slice") capBasis = c.capBasis;
  if (typeof c.debugConsole === "boolean") debugConsole = c.debugConsole;
  if (typeof c.consoleOnStart === "boolean") consoleOnStart = c.consoleOnStart;
  if (typeof c.debugLiveDrag === "boolean") debugLiveDrag = c.debugLiveDrag;
  if (c.dragStrategy === "overlay" || c.dragStrategy === "frames" || c.dragStrategy === "ms")
    dragPreviewMode = c.dragStrategy;
  if (typeof c.dragIntervalMs === "number") dragMs = c.dragIntervalMs;
  if (typeof c.dragCoalesce === "boolean") dragCoalesce = c.dragCoalesce;
  if (typeof c.dragSession === "boolean") dragSession = c.dragSession;
  if (typeof c.dragOnChange === "boolean") dragOnChange = c.dragOnChange;
  if (typeof c.adaptiveRes === "boolean") adaptiveRes = c.adaptiveRes;
  if (typeof c.motionResolution === "number") motionRes = c.motionResolution;
  if (typeof c.adaptiveFpsThreshold === "number") adaptiveFps = c.adaptiveFpsThreshold;
}

/** Przyjmuje ustawienia synchronizacji zaznaczenia (`xve.sync.*`). */
function applySync(s: any) {
  if (!s) return;
  if (typeof s.selectInTextEditor === "boolean") syncSelectInText = s.selectInTextEditor;
  if (typeof s.selectFromTextCursor === "boolean") syncSelectFromText = s.selectFromTextCursor;
}

/** Przyjmuje stan izolacji hosta WPF; zwraca true, gdy efektywny stan się zmienił (do przerysowania). */
function applyIsolation(iso: any): boolean {
  if (!iso) return false;
  const prev = isolationEffective;
  const prevPolicy = isolationPolicy;
  if (typeof iso.effective === "string") isolationEffective = iso.effective;
  if (typeof iso.policy === "string") isolationPolicy = iso.policy;
  return isolationEffective !== prev || isolationPolicy !== prevPolicy;
}

/** Sygnatura listy motywów projektu (do taniej detekcji zmian). */
function themesSig(items: { value: string }[]): string {
  return items.map((t) => t.value).join("|");
}
/** Przyjmuje motywy projektu + motyw efektywny; zwraca true, gdy zmiana wymaga odświeżenia combo. */
function applyThemeState(themes: any, theme: any): boolean {
  let changed = false;
  if (Array.isArray(themes)) {
    const next = themes.filter(
      (t: any) => t && typeof t.value === "string" && typeof t.label === "string"
    );
    if (themesSig(next) !== themesSig(projectThemes)) {
      projectThemes = next;
      changed = true;
    }
  }
  if (typeof theme === "string" && theme !== previewTheme) {
    previewTheme = theme;
    changed = true;
  }
  return changed;
}

/** Przyjmuje ustawienia podświetlania w edytorze tekstu (`xve.editor.*`). */
function applyEditorCfg(e: any) {
  if (!e) return;
  if (typeof e.highlightChanges === "boolean") showInlineDiff = e.highlightChanges;
  if (typeof e.highlightErrors === "boolean") showErrorsInCode = e.highlightErrors;
}

/** Domyślne płótna (`xve.canvas.*` + fitOnOpen) — stosowane tylko gdy brak zapamiętanego stanu. */
function applyCanvasDefaults(c: any) {
  if (!c) return;
  if (persisted.gridStep === undefined && typeof c.gridStep === "number") gridStep = c.gridStep;
  if (persisted.showGrid === undefined && typeof c.showGrid === "boolean") showGrid = c.showGrid;
  if (persisted.showRulers === undefined && typeof c.showRulers === "boolean") showRulers = c.showRulers;
  if (persisted.fitMode === undefined && typeof c.fitOnOpen === "boolean") {
    fitMode = c.fitOnOpen;
    needFit = fitMode;
  }
  applyRulersVisibility();
}

/** Zgłasza bieżący devicePixelRatio — host renderuje w rozdzielczości ekranu (renderScale=auto). */
function reportDpr() {
  vscode.postMessage({ type: "dpr", value: window.devicePixelRatio || 1 });
}
let dprMql: MediaQueryList | null = null;
function onDprChange() {
  reportDpr();
  watchDpr(); // przezbrój nasłuch dla nowej gęstości (np. przeniesienie okna na inny monitor)
}
function watchDpr() {
  if (dprMql) dprMql.removeEventListener("change", onDprChange);
  dprMql = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
  dprMql.addEventListener("change", onDprChange);
}

/** Wysyła widoczny prostokąt (jednostki projektu) do hosta — tryb „render widocznego obszaru".
 *  `motion`=true (scroll/zoom w ruchu) → niska rozdzielczość + dosłanie pełnej po ustaniu ruchu. */
function sendViewbox(motion = false) {
  if (!viewportRender || previewMode !== "wpf") return;
  const lowRes = adaptiveRes && motion;
  const sc = scrollEl();
  const ze = zoomEl().getBoundingClientRect();
  const scR = sc.getBoundingClientRect();
  const margin = Math.max(0, overscan); // overscan w jednostkach projektu (zapas przy przewijaniu)
  // sam widoczny obszar (bez overscanu), przycięty do powierzchni — podstawa limitu cap (capBasis=visible)
  const visLeft = Math.max(0, (scR.left - ze.left) / zoom);
  const visTop = Math.max(0, (scR.top - ze.top) / zoom);
  let visW = sc.clientWidth / zoom;
  let visH = sc.clientHeight / zoom;
  if (hostW > 0) visW = Math.min(visW, hostW - visLeft);
  if (hostH > 0) visH = Math.min(visH, hostH - visTop);
  // wycinek z overscanem
  let vx = Math.max(0, (scR.left - ze.left) / zoom - margin);
  let vy = Math.max(0, (scR.top - ze.top) / zoom - margin);
  let vw = sc.clientWidth / zoom + margin * 2;
  let vh = sc.clientHeight / zoom + margin * 2;
  if (hostW > 0) vw = Math.min(vw, hostW - vx);
  if (hostH > 0) vh = Math.min(vh, hostH - vy);
  const rx = Math.round(vx);
  const ry = Math.round(vy);
  const rw = Math.max(1, Math.round(vw));
  const rh = Math.max(1, Math.round(vh));
  const rvw = Math.max(1, Math.round(visW));
  const rvh = Math.max(1, Math.round(visH));
  // lowRes w kluczu → przejście niska→pełna rozdzielczość to osobne wysłanie (settle nie jest pomijany)
  const key = `${rx},${ry},${rw},${rh},${rvw},${rvh},${capBasis},${lowRes ? "L" : "F"},${zoom.toFixed(3)}`;
  // po ustaniu ruchu dosyłamy pełną rozdzielczość (osobny klucz F)
  if (lowRes) armViewboxSettle();
  if (key === lastVbKey) return; // bez zmian → nie wysyłaj (unik pętli render→viewbox)
  // koalescencja: nie wysyłaj kolejnego wycinka, póki poprzedni render nie wrócił
  if (dragCoalesce && viewboxInFlight) {
    viewboxDirty = true;
    viewboxDirtyMotion = lowRes;
    return;
  }
  lastVbKey = key;
  vscode.postMessage({ type: "viewbox", x: rx, y: ry, w: rw, h: rh, visW: rvw, visH: rvh, capBasis, zoom, lowRes });
  viewboxInFlight = true;
  viewboxDirty = false;
}
let viewboxSettleTimer: ReturnType<typeof setTimeout> | undefined;
/** Po ustaniu scroll/zoom dosyła wycinek w pełnej rozdzielczości (lowRes=false). */
function armViewboxSettle() {
  if (!adaptiveRes) return;
  if (viewboxSettleTimer) clearTimeout(viewboxSettleTimer);
  viewboxSettleTimer = setTimeout(() => {
    viewboxSettleTimer = undefined;
    sendViewbox(false); // pełna rozdzielczość (osobny klucz → nie zostanie pominięte)
  }, MOTION_SETTLE_MS);
}

// Przewinięcie ScrollViewer W PROJEKCIE (kółko nad treścią) — adaptacyjnie: niska rozdzielczość
// w trakcie przewijania, pełna po ustaniu (settle). Resend tej samej pozycji z lowRes:false.
let scrollSettleTimer: ReturnType<typeof setTimeout> | undefined;
let lastScrollMsg: { uid: string; h: number; v: number } | null = null;
function sendScroll(uid: string, h: number, v: number) {
  lastScrollMsg = { uid, h, v };
  vscode.postMessage({ type: "scrollViewer", uid, h, v, lowRes: adaptiveRes });
  if (!adaptiveRes) return;
  if (scrollSettleTimer) clearTimeout(scrollSettleTimer);
  scrollSettleTimer = setTimeout(() => {
    scrollSettleTimer = undefined;
    if (lastScrollMsg) vscode.postMessage({ type: "scrollViewer", ...lastScrollMsg, lowRes: false });
  }, MOTION_SETTLE_MS);
}
let viewboxPending = false;
let viewboxPendingMotion = false; // czy zaplanowany wycinek pochodzi z ruchu (scroll/zoom)
let viewboxInFlight = false; // koalescencja: tylko 1 render wycinka „w locie"
let viewboxDirty = false; // jest nowszy stan czekający na wysłanie
let viewboxDirtyMotion = false; // motion ostatniego zakoalescowanego wycinka (dla dosyłki)
let lastVbKey = ""; // ostatnio wysłany wycinek (unik pętli render→viewbox)
function scheduleViewbox(motion = false) {
  if (!viewportRender || drag) return; // podczas gestu render prowadzi pompa drag — bez konkurencyjnych viewboxów
  if (motion) viewboxPendingMotion = true;
  if (viewboxPending) return;
  viewboxPending = true;
  requestAnimationFrame(() => {
    viewboxPending = false;
    const m = viewboxPendingMotion;
    viewboxPendingMotion = false;
    sendViewbox(m);
  });
}
function zoomEl(): HTMLElement {
  return document.getElementById("zoom")!;
}
/** Współrzędna projektowa z pozycji myszy (0,0 = lewy-górny róg powierzchni; uwzględnia zoom). */
function clientToDesign(clientX: number, clientY: number): { x: number; y: number } {
  const z = zoomEl().getBoundingClientRect();
  return { x: (clientX - z.left) / zoom, y: (clientY - z.top) / zoom };
}

/** Ustawia transform skali, wyśrodkowanie (gdy mieści się) i rozmiar sizera (paski przewijania). */
function applyZoomTransform() {
  const ze = zoomEl();
  ze.style.transform = `scale(${zoom})`;
  const s = surfaceEl();
  const sc = scrollEl();
  const scaledW = s.offsetWidth * zoom;
  const scaledH = s.offsetHeight * zoom;
  let ox: number;
  let oy: number;
  if (drag) {
    // podczas gestu NIE przeliczaj wyśrodkowania (parność z trybem web) — inaczej zmiana rozmiaru
    // korzenia (Window) przesuwałaby podgląd co klatkę. Zachowaj bieżące przesunięcie; wyśrodkowanie
    // wróci po zakończeniu gestu (przy renderze po commicie).
    ox = ze.offsetLeft;
    oy = ze.offsetTop;
  } else {
    // wyśrodkuj powierzchnię, gdy jest mniejsza niż obszar przewijania (inaczej offset 0 = przewijanie)
    ox = Math.max(0, Math.floor((sc.clientWidth - scaledW) / 2));
    oy = Math.max(0, Math.floor((sc.clientHeight - scaledH) / 2));
    ze.style.left = ox + "px";
    ze.style.top = oy + "px";
  }
  const sizer = document.getElementById("zoom-sizer")!;
  sizer.style.width = Math.max(1, ox + scaledW) + "px";
  sizer.style.height = Math.max(1, oy + scaledH) + "px";
}

const ZOOM_MIN = 0.1;
const ZOOM_MAX = 8;
/** Ustawia zoom; opcjonalnie zakotwicza punkt projektu pod kursorem (anchor w client px). */
function setZoom(z: number, anchorX?: number, anchorY?: number) {
  z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
  const sc = scrollEl();
  let dx = 0;
  let dy = 0;
  if (anchorX !== undefined && anchorY !== undefined) {
    const before = clientToDesign(anchorX, anchorY); // design pod kursorem przed
    const old = zoom;
    zoom = z;
    applyZoomTransform();
    // przewiń tak, by ten sam punkt projektu został pod kursorem
    const ze = zoomEl().getBoundingClientRect();
    const nowClientX = ze.left + before.x * zoom;
    const nowClientY = ze.top + before.y * zoom;
    dx = nowClientX - anchorX;
    dy = nowClientY - anchorY;
    sc.scrollLeft += dx;
    sc.scrollTop += dy;
    void old;
  } else {
    zoom = z;
    applyZoomTransform();
  }
  updateOverlay();
  drawDecorations();
  updateZoomLabel();
  scheduleViewbox(true); // zoom = ruch → niska rozdzielczość, pełna po ustaniu
}
function updateZoomLabel() {
  const el = document.getElementById("zoom-label");
  if (el) el.textContent = Math.round(zoom * 100) + "%";
}
/**
 * „Dopasuj": gdy powierzchnia NIE mieści się w widoku → pomniejsz do dopasowania; gdy się
 * mieści → 100% (nigdy nie powiększaj powyżej 100%). Wołane też przy zmianie rozmiaru, gdy fitMode.
 */
function applyFit() {
  const s = surfaceEl();
  const sc = scrollEl();
  const sw = s.offsetWidth;
  const sh = s.offsetHeight;
  if (sw <= 0 || sh <= 0) return;
  const margin = 16;
  const fit = Math.min((sc.clientWidth - margin) / sw, (sc.clientHeight - margin) / sh);
  setZoom(Math.min(1, fit));
  sc.scrollLeft = 0;
  sc.scrollTop = 0;
}

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

// ---------- linijki (CSS/DOM — bez canvas) ----------
/** Dobiera „ładny" krok podziałki (1/2/5×10ⁿ) tak, by odstęp etykiet ≈ 80 px ekranu na każdym zoomie. */
function niceRulerStep(): number {
  const targetPx = 80;
  const raw = targetPx / zoom; // krok w jednostkach projektu
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) if (m * pow >= raw) return m * pow;
  return 10 * pow;
}
/** Synchronizuje podziałkę (tło) ze scrollem i przerysowuje etykiety — z adaptacją do zoomu. */
function updateRulers() {
  if (!showRulers) return;
  const topEl = document.getElementById("ruler-top")!;
  const leftEl = document.getElementById("ruler-left")!;
  const ze = zoomEl().getBoundingClientRect();
  // origin = ekranowa pozycja design-0 względem lewej/górnej krawędzi paska (po zoomie/scroll)
  const originX = ze.left - topEl.getBoundingClientRect().left;
  const originY = ze.top - leftEl.getBoundingClientRect().top;
  const major = niceRulerStep();
  const minor = major / 5;
  const topTicks = document.getElementById("ruler-top-ticks");
  const leftTicks = document.getElementById("ruler-left-ticks");
  if (topTicks) {
    topTicks.style.backgroundPositionX = `${originX}px, ${originX}px`;
    topTicks.style.backgroundSize = `${minor * zoom}px 5px, ${major * zoom}px 10px`;
  }
  if (leftTicks) {
    leftTicks.style.backgroundPositionY = `${originY}px, ${originY}px`;
    leftTicks.style.backgroundSize = `5px ${minor * zoom}px, 10px ${major * zoom}px`;
  }
  buildAxisLabels(document.getElementById("ruler-top-labels"), "x", originX, major);
  buildAxisLabels(document.getElementById("ruler-left-labels"), "y", originY, major);
  renderGuideMarkers(originX, originY);
}
/** Znaczniki prowadnic na linijkach (z wartością pozycji, przeciągalne). */
function renderGuideMarkers(originX: number, originY: number) {
  const top = document.getElementById("ruler-top-guides");
  const left = document.getElementById("ruler-left-guides");
  if (top) top.innerHTML = "";
  if (left) left.innerHTML = "";
  guides.forEach((g, i) => {
    const host = g.axis === "x" ? top : left;
    if (!host) return;
    const m = document.createElement("div");
    m.className = "ruler-guide " + (g.axis === "x" ? "gx" : "gy") + (guideDrag === i ? " dragging" : "");
    m.textContent = String(g.pos);
    if (g.axis === "x") m.style.left = originX + g.pos * zoom + "px";
    else m.style.top = originY + g.pos * zoom + "px";
    m.dataset.gi = String(i);
    host.appendChild(m);
  });
}
function buildAxisLabels(host: HTMLElement | null, axis: "x" | "y", origin: number, step: number) {
  if (!host) return;
  const length = axis === "x" ? host.clientWidth : host.clientHeight;
  host.innerHTML = "";
  if (length <= 0 || step <= 0) return;
  // etykiety co `step` jednostek PROJEKTU (adaptacyjny krok); pozycja ekranowa = origin + c*zoom
  const startC = Math.ceil((2 - origin) / zoom / step) * step;
  const endC = Math.floor((length - 2 - origin) / zoom / step) * step;
  for (let c = startC; c <= endC; c += step) {
    const p = origin + c * zoom;
    const span = document.createElement("span");
    span.className = "ruler-label";
    span.textContent = String(Math.round(c));
    if (axis === "x") span.style.left = p + 2 + "px";
    else span.style.top = p + "px";
    host.appendChild(span);
  }
}

// ---------- siatka i prowadnice ----------
// Warstwy są przyklejone DOKŁADNIE do powierzchni (#surface), nie do całego scrolla —
// inaczej powiększałyby zawartość i scrollWidth rosłoby w nieskończoność.
function sizeLayer(layer: HTMLElement) {
  const s = surfaceEl();
  layer.style.left = s.offsetLeft + "px";
  layer.style.top = s.offsetTop + "px";
  layer.style.width = s.offsetWidth + "px";
  layer.style.height = s.offsetHeight + "px";
}
function renderGrid() {
  const layer = document.getElementById("grid-layer")!;
  sizeLayer(layer);
  if (!showGrid) {
    layer.style.backgroundImage = "none";
    return;
  }
  // siatka jako półprzezroczyste punkty (kropki) DOKŁADNIE w węzłach (0, krok, 2·krok…).
  // Kropka radial-gradient jest w środku kafelka, więc przesuwamy tło o -krok/2, by trafiła w węzeł.
  const dot = cssVar("--vscode-editorForeground", cssVar("--vscode-foreground", "#888"));
  layer.style.backgroundImage = `radial-gradient(circle, color-mix(in srgb, ${dot} 45%, transparent) 1px, transparent 1.5px)`;
  layer.style.backgroundSize = `${gridStep}px ${gridStep}px`;
  layer.style.backgroundPosition = `${-gridStep / 2}px ${-gridStep / 2}px`;
}
function renderGuides() {
  const layer = document.getElementById("guide-layer")!;
  sizeLayer(layer);
  // prowadnice widoczne tylko gdy linijki są włączone (skąd się je przeciąga)
  layer.style.display = showRulers ? "block" : "none";
  layer.innerHTML = "";
  guides.forEach((g, i) => {
    const d = document.createElement("div");
    d.className = "guide " + (g.axis === "x" ? "gx" : "gy");
    if (g.axis === "x") d.style.left = g.pos + "px";
    else d.style.top = g.pos + "px";
    d.dataset.gi = String(i);
    d.title = `${g.axis === "x" ? "X" : "Y"} = ${g.pos}`;
    layer.appendChild(d);
  });
}
function drawDecorations() {
  updateRulers();
  renderGrid();
  renderGuides();
}

// linijki: klik w pasek = utwórz prowadnicę i od razu ją przeciągaj; klik w pobliżu istniejącej =
// przeciągaj ją (bez dubla); podwójny LPM w tę samą prowadnicę = usuń (odpowiednik PPM w aplikacji).
function rulerMouseDown(axis: "x" | "y", e: MouseEvent) {
  e.preventDefault();
  const d = clientToDesign(e.clientX, e.clientY);
  const pos = axis === "x" ? d.x : d.y;
  const hit = nearestGuideIndex(axis, pos);
  if (hit !== null) {
    if (pressGuide(hit)) return; // podwójny klik usunął prowadnicę
  } else {
    guides.push({ axis, pos: snap(pos) });
    guideDrag = guides.length - 1;
    lastGuidePress = null; // świeża prowadnica nie tworzy pary do podwójnego kliknięcia
  }
  renderGuides();
  updateRulers();
}
document.getElementById("ruler-top")!.addEventListener("mousedown", (e) => rulerMouseDown("x", e));
document.getElementById("ruler-left")!.addEventListener("mousedown", (e) => rulerMouseDown("y", e));

// przeciąganie / usuwanie prowadnic na powierzchni (podwójny LPM usuwa — patrz pressGuide)
document.getElementById("guide-layer")!.addEventListener("mousedown", (e) => {
  const g = (e.target as HTMLElement).closest<HTMLElement>(".guide");
  if (!g) return;
  e.preventDefault();
  pressGuide(Number(g.dataset.gi));
});

// ---------- pan ----------
// Pan łączy się z wewnętrznym ScrollViewerem (jak kółko myszy): najpierw przewija ScrollViewer pod
// kursorem, a dopiero gdy ten dojdzie do krańca — przesuwa cały podgląd. inner = element DOM (web),
// innerId = id ScrollViewera (host PNG, przez offset wysyłany do hosta).
let pan:
  | {
      x: number;
      y: number;
      sl: number;
      st: number;
      inner: HTMLElement | null;
      innerL: number;
      innerT: number;
      innerId: number | null;
      innerH: number;
      innerV: number;
    }
  | null = null;
function startPan(e: MouseEvent) {
  const sc = scrollEl();
  let inner: HTMLElement | null = null;
  let innerId: number | null = null;
  // łączenie pana z wewnętrznym ScrollViewerem tylko przy włączonym Auto-podglądzie (jak auto-scroll)
  if (autoReveal) {
    if (previewMode === "wpf" && hostPng) {
      const d = clientToDesign(e.clientX, e.clientY);
      innerId = scrollableHitId(d.x, d.y);
    } else {
      const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>(".xve-scrollviewer") ?? null;
      if (hit && (hit.scrollHeight > hit.clientHeight || hit.scrollWidth > hit.clientWidth)) inner = hit;
    }
  }
  const off = innerId !== null ? scrollOffsets.get(innerId) : undefined;
  pan = {
    x: e.clientX,
    y: e.clientY,
    sl: sc.scrollLeft,
    st: sc.scrollTop,
    inner,
    innerL: inner?.scrollLeft ?? 0,
    innerT: inner?.scrollTop ?? 0,
    innerId,
    innerH: off?.h ?? 0,
    innerV: off?.v ?? 0,
  };
  sc.style.cursor = "grabbing";
}

// ---------- reorder: przeciąganie elementu w PODGLĄDZIE (port narzędzia Reorder z aplikacji WPF) ----------
// Działa w obu trybach: PNG (hit-test po hostRects) i web (elementFromPoint). Strefy i commit
// współdzielą logikę z reorderem w drzewie (dropZone/commitTreeMove). Wskaźnik #reorder-indicator
// rysowany w przestrzeni #surface-scroll (jak nakładka zaznaczenia).
let reorderId: number | null = null;
let reorderTargetId: number | null = null;
let reorderZone: DropZone | null = null;

// spring-load: w trakcie reorderu przytrzymanie „do wnętrza" MenuItem mającego podmenu otwiera je
// po 0,3 s (jak spring-loaded folders), by można było upuścić przeciągany element także w tym podmenu.
const SPRING_OPEN_MS = 300;
let springTimer: number | null = null;
let springTargetId: number | null = null; // cel, dla którego biegnie odliczanie
let reorderRevealId: number | null = null; // MenuItem z podmenu otwartym (spring) na czas reorderu

/** MenuItem mający pod-pozycje (podmenu) — kandydat do spring-open podczas reorderu. */
function hasSubmenu(node: RenderNode): boolean {
  return localTag(node.tag) === "MenuItem" && node.children.some((c) => localTag(c.tag) === "MenuItem");
}
function clearSpringTimer() {
  if (springTimer !== null) {
    clearTimeout(springTimer);
    springTimer = null;
  }
  springTargetId = null;
}
/** Po zmianie celu/strefy: uruchom lub anuluj odliczanie do otwarcia podmenu najechanego MenuItem. */
function updateSpringLoad(targetId: number | null, zone: DropZone | null) {
  if (!autoReveal) return; // podmenu pokazuje wyłącznie auto-podgląd — bez niego nie ma czego otwierać
  const node = targetId !== null ? nodeById.get(targetId) : undefined;
  // kandydat: „do wnętrza" MenuItem z podmenu, które nie jest jeszcze otwarte
  const candidate = zone === "into" && node && hasSubmenu(node) && targetId !== reorderRevealId ? targetId : null;
  if (candidate === null) {
    clearSpringTimer();
    return;
  }
  if (springTargetId === candidate) return; // odliczanie dla tego celu już trwa
  clearSpringTimer();
  springTargetId = candidate;
  springTimer = window.setTimeout(() => {
    springTimer = null;
    springTargetId = null;
    // wciąż trwa reorder i kursor wciąż „do wnętrza" tego samego celu? → otwórz jego podmenu
    if (reorderId !== null && reorderTargetId === candidate && reorderZone === "into") openReorderReveal(candidate);
  }, SPRING_OPEN_MS);
}
/** Otwiera (spring) podmenu danego MenuItem na czas reorderu — bez zmiany właściwego zaznaczenia. */
function openReorderReveal(id: number) {
  reorderRevealId = id;
  // host WPF: re-render z rozwiniętą kaskadą (noScroll — nie przewijaj podglądu w trakcie gestu)
  if (previewMode === "wpf") vscode.postMessage({ type: "setReveal", uid: "u" + id, noScroll: true });
  else renderPreview(); // web: przerysuj DOM z kaskadą menu do tego MenuItem
}
/** Koniec/anulowanie reorderu: zamknij spring-podmenu i przywróć podgląd do faktycznego zaznaczenia. */
function endReorderReveal() {
  clearSpringTimer();
  if (reorderRevealId === null) return;
  reorderRevealId = null;
  if (previewMode === "wpf") vscode.postMessage({ type: "setReveal", uid: selectedId !== null ? "u" + selectedId : null, noScroll: true });
  else renderPreview();
}

/** Id wierzchniego (widocznego) elementu pod punktem ekranu — oba tryby. */
function previewHitId(clientX: number, clientY: number): number | null {
  return pickStack(clientX, clientY)[0] ?? null;
}

/** Prostokąt elementu w współrzędnych ekranu (client) — oba tryby. */
function previewClientRect(id: number): { left: number; top: number; width: number; height: number } | null {
  if (previewMode === "wpf" && hostPng) {
    const r = hostRects.get(id);
    if (!r) return null;
    const x = r.clipped ? r.rx ?? r.x : r.x;
    const y = r.clipped ? r.ry ?? r.y : r.y;
    const w = r.clipped ? r.rw ?? r.w : r.w;
    const h = r.clipped ? r.rh ?? r.h : r.h;
    const z = zoomEl().getBoundingClientRect();
    return { left: z.left + x * zoom, top: z.top + y * zoom, width: w * zoom, height: h * zoom };
  }
  const el = document.querySelector<HTMLElement>(`#surface [data-xve-id="${id}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

/** Czy rodzeństwo układa się poziomo (rodzic = Menu/StackPanel-Horizontal/WrapPanel/ToolBar/TabControl). */
function isHorizontalContainer(node: RenderNode): boolean {
  const tag = localTag(node.tag);
  if (tag === "Menu" || tag === "WrapPanel" || tag === "ToolBar" || tag === "ToolBarTray") return true;
  if (tag === "StackPanel") return /horizontal/i.test(node.attributes.find((a) => a.name === "Orientation")?.value || "");
  // TabControl: zakładki domyślnie u góry (poziomo) → pionowa kreska jak w Menu; Left/Right = pionowo
  if (tag === "TabControl")
    return !/left|right/i.test(node.attributes.find((a) => a.name === "TabStripPlacement")?.value || "");
  return false;
}
/** Czy rodzeństwo celu jest ułożone poziomo (decyduje o pionowym wskaźniku i osi strefy). */
function targetHorizontal(targetId: number): boolean {
  const parent = parentById.get(targetId);
  return !!parent && isHorizontalContainer(parent);
}
/** Czy można upuścić „do wnętrza" celu (kontener lub MenuItem/Menu → pod-pozycja menu). */
function canDropInto(node: RenderNode): boolean {
  const t = localTag(node.tag);
  if (t === "MenuItem" || t === "Menu" || t === "ContextMenu") return true;
  return isContainer(node.tag) && !isPropertyElementTag(node.tag);
}

/** Strefa upuszczania dla celu pod kursorem (port dropZone; oś wg orientacji rodzeństwa). */
function previewDropZone(srcId: number, targetId: number, clientX: number, clientY: number): DropZone | null {
  if (targetId === srcId) return null;
  if (isAncestorOrSelf(srcId, targetId)) return null; // cel w poddrzewie przeciąganego
  const node = nodeById.get(targetId);
  if (!node) return null;
  const rect = previewClientRect(targetId);
  if (!rect) return null;
  const horiz = targetHorizontal(targetId);
  const extent = horiz ? rect.width : rect.height;
  if (extent <= 0) return null;
  const rel = horiz ? (clientX - rect.left) / rect.width : (clientY - rect.top) / rect.height;
  const canInto = canDropInto(node);
  if (canInto && rel > 0.33 && rel < 0.67) return "into";
  if (!parentById.get(targetId)) return canInto ? "into" : null; // korzeń: tylko „do wnętrza"
  return rel < 0.5 ? "before" : "after";
}

function reorderIndicatorEl(): HTMLElement {
  let el = document.getElementById("reorder-indicator");
  if (!el) {
    el = document.createElement("div");
    el.id = "reorder-indicator";
    el.style.display = "none";
    scrollEl().appendChild(el);
  }
  return el;
}
function clearReorderIndicator() {
  const el = document.getElementById("reorder-indicator");
  if (el) el.style.display = "none";
}
function drawReorderIndicator(targetId: number, zone: DropZone, horiz: boolean) {
  const rect = previewClientRect(targetId);
  if (!rect) {
    clearReorderIndicator();
    return;
  }
  const sc = scrollEl();
  const sr = sc.getBoundingClientRect();
  const left = rect.left - sr.left + sc.scrollLeft;
  const top = rect.top - sr.top + sc.scrollTop;
  const el = reorderIndicatorEl();
  el.className = "ind-" + zone;
  el.style.display = "block";
  if (zone === "into") {
    el.style.left = left + "px";
    el.style.top = top + "px";
    el.style.width = rect.width + "px";
    el.style.height = rect.height + "px";
  } else if (horiz) {
    // rodzeństwo poziome → pionowa kreska na lewej/prawej krawędzi celu
    const x = zone === "before" ? left : left + rect.width;
    el.style.left = x - 1 + "px";
    el.style.top = top + "px";
    el.style.width = "2px";
    el.style.height = rect.height + "px";
  } else {
    const y = zone === "before" ? top : top + rect.height;
    el.style.left = left + "px";
    el.style.top = y - 1 + "px";
    el.style.width = rect.width + "px";
    el.style.height = "2px";
  }
}

function startReorder(_e: MouseEvent, id: number) {
  reorderId = id;
  reorderTargetId = null;
  reorderZone = null;
  // w trakcie przeciągania kursor jak w drzewku: zamknięta ręka (grabbing)
  document.getElementById("surface")!.style.cursor = "grabbing";
  window.addEventListener("mousemove", onReorderMove);
  window.addEventListener("mouseup", onReorderUp);
}
function onReorderMove(e: MouseEvent) {
  if (reorderId === null) return;
  const targetId = previewHitId(e.clientX, e.clientY);
  const zone = targetId === null ? null : previewDropZone(reorderId, targetId, e.clientX, e.clientY);
  reorderTargetId = targetId;
  reorderZone = zone;
  if (targetId === null || zone === null) clearReorderIndicator();
  else {
    clickSelectId = null; // realne przeciąganie na inny element → to nie klik
    drawReorderIndicator(targetId, zone, targetHorizontal(targetId));
  }
  updateSpringLoad(targetId, zone); // najechanie „do wnętrza" MenuItem z podmenu → otwórz je po 1,5 s
}
function onReorderUp() {
  window.removeEventListener("mousemove", onReorderMove);
  window.removeEventListener("mouseup", onReorderUp);
  document.getElementById("surface")!.style.cursor = ""; // koniec drag → kursor wg trafienia (hover)
  clearReorderIndicator();
  endReorderReveal(); // zamknij ewentualne spring-podmenu i przywróć podgląd do zaznaczenia
  if (reorderId !== null && reorderTargetId !== null && reorderZone !== null) {
    const target = nodeById.get(reorderTargetId);
    if (target) commitTreeMove(reorderId, target, reorderZone);
  }
  reorderId = reorderTargetId = null;
  reorderZone = null;
}
function cancelReorder() {
  if (reorderId === null) return;
  window.removeEventListener("mousemove", onReorderMove);
  window.removeEventListener("mouseup", onReorderUp);
  document.getElementById("surface")!.style.cursor = "";
  clearReorderIndicator();
  endReorderReveal();
  reorderId = reorderTargetId = null;
  reorderZone = null;
  clickSelectId = null; // anulowano (Esc) → nie zmieniaj zaznaczenia przy najbliższym puszczeniu
}

// Wspólna obsługa naciśnięcia w podglądzie — używana przez powierzchnię ORAZ ciało ramki .clipped.
// KLIK zaznacza wierzchni/cykliczny element (powtórny klik w to samo miejsce schodzi w głąb stosu);
// naciśnięcie w obrębie zaznaczonego operuje na nim (drag/reorder), a zmianę zaznaczenia odkłada do
// puszczenia bez ruchu. Dzięki użyciu tej samej ścieżki ramka przyciętego elementu też cyklicznie
// zaznacza (nie blokuje się np. na StackPanelu większym niż ScrollViewer).
function previewPress(e: MouseEvent): void {
  // fake-panel (lista/menu): klik w tło panelu nic nie robi (nie zaznacza zasłoniętego elementu)
  const ph = fakePanelHit(e);
  if (ph === "bg") {
    e.preventDefault();
    e.stopPropagation(); // pochłoń klik — nie odznaczaj na handlerze tła
    return;
  }
  const onRow = typeof ph === "number"; // kliknięto wiersz panelu → traktuj jak trafienie w ten element
  const { dragId, selectNow } = resolvePress(e, onRow ? (ph as number) : null);
  if (dragId === null) return;
  e.preventDefault();
  // Auto-podgląd (web) przerysowuje #surface w select() — kliknięty węzeł zostaje odpięty z DOM.
  // Zatrzymaj propagację, by handler tła (#surface-scroll) nie potraktował tego jako klik w pustkę.
  e.stopPropagation();
  if (selectNow !== null && selectNow !== selectedId) {
    select(selectNow, { scrollTree: true });
    setStatus();
  }
  if (tree && dragId !== tree.id) {
    if (tool === "reorder") startReorder(e, dragId);
    else startMove(e, dragId);
  }
}

// klik w podglądzie → pan / reorder / zaznaczenie + start przeciągania
document.getElementById("surface")!.addEventListener("mousedown", (e) => {
  if (tool === "pan" || e.button === 1) {
    e.preventDefault();
    startPan(e);
    return;
  }
  if (e.button !== 0) return;
  previewPress(e);
});

// narzędzie Reorder: kursor jak w drzewku — strzałka nad tłem, łapka z palcem (pointer) nad
// elementem, który można przeciągnąć. Podczas trwającego przeciągania nie nadpisujemy kursora.
document.getElementById("surface")!.addEventListener("mousemove", (e) => {
  const surf = document.getElementById("surface")!;
  if (tool !== "reorder" || reorderId !== null) {
    if (tool !== "reorder") surf.style.cursor = "";
    return;
  }
  const ph = fakePanelHit(e);
  const id = ph === "bg" ? null : typeof ph === "number" ? ph : previewHitId(e.clientX, e.clientY);
  surf.style.cursor = id !== null && tree && id !== tree.id ? "pointer" : "";
});

// klik w puste tło (szachownica poza oknem projektu) → odznacz wybrany element.
// Handler na #surface-scroll łapie kliknięcia, które nie trafiły w #surface (okno), nakładkę ani
// prowadnicę. Pan (narzędzie/środkowy przycisk) i inne przyciski myszy nie odznaczają.
document.getElementById("surface-scroll")!.addEventListener("mousedown", (e) => {
  if (tool === "pan" || e.button !== 0) return;
  const tgt = e.target as HTMLElement;
  if (tgt.closest("#surface") || tgt.closest("#sel-overlay") || tgt.closest(".guide")) return;
  deselect();
});

// uchwyty resize + ciało ramki (na nakładce; .clipped ma pointer-events:auto, więc łapie zdarzenia)
document.getElementById("sel-overlay")!.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return; // PPM → menu kontekstowe, nie skalowanie
  const h = (e.target as HTMLElement).closest<HTMLElement>("[data-handle]");
  if (h) {
    e.preventDefault();
    startResize(e, h.dataset.handle!);
    return;
  }
  // Ciało ramki (tylko .clipped) — ta sama ścieżka co powierzchnia: cykliczne zaznaczanie + chwyt
  // zaznaczonego (pickStack dokłada go wg realnych granic). Pan obsługujemy jak na powierzchni.
  if (tool === "pan") {
    e.preventDefault();
    startPan(e);
    return;
  }
  previewPress(e);
});

// ---------- menu kontekstowe (PPM) ----------
// Trzy warianty jak w aplikacji WPF: podgląd (z „Wklej w <kontener>" i listą „Wybierz:"),
// drzewko (sam element) i właściwości (cofnij atrybut / wszystkie atrybuty elementu).
interface CtxItem {
  label?: string;
  enabled?: boolean; // domyślnie true
  checked?: boolean;
  hint?: string; // skrót klawiszowy po prawej (Ctrl+C…)
  header?: boolean; // nagłówek sekcji (nieklikalny)
  separator?: boolean;
  onClick?: () => void;
}
let ctxMenuEl: HTMLElement | null = null;
function closeContextMenu() {
  if (!ctxMenuEl) return;
  ctxMenuEl.remove();
  ctxMenuEl = null;
  window.removeEventListener("mousedown", onCtxOutside, true);
}
function onCtxOutside(e: MouseEvent) {
  if (ctxMenuEl && !ctxMenuEl.contains(e.target as Node)) closeContextMenu();
}
function showContextMenu(clientX: number, clientY: number, items: CtxItem[]) {
  closeContextMenu();
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  for (const it of items) {
    if (it.separator) {
      const s = document.createElement("div");
      s.className = "ctx-sep";
      menu.appendChild(s);
      continue;
    }
    const row = document.createElement("div");
    row.className =
      "ctx-item" + (it.header ? " ctx-header" : "") + (it.enabled === false ? " disabled" : "");
    const check = document.createElement("span");
    check.className = "ctx-check";
    check.textContent = it.checked ? "✓" : "";
    const lbl = document.createElement("span");
    lbl.className = "ctx-label";
    lbl.textContent = it.label ?? "";
    row.append(check, lbl);
    if (it.hint) {
      const h = document.createElement("span");
      h.className = "ctx-hint";
      h.textContent = it.hint;
      row.appendChild(h);
    }
    if (!it.header && it.enabled !== false && it.onClick) {
      const fn = it.onClick;
      row.onclick = () => {
        closeContextMenu();
        fn();
      };
    }
    menu.appendChild(row);
  }
  document.body.appendChild(menu);
  // dociśnij do widocznego obszaru, żeby menu nie wychodziło poza krawędź
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(4, Math.min(clientX, window.innerWidth - r.width - 4)) + "px";
  menu.style.top = Math.max(4, Math.min(clientY, window.innerHeight - r.height - 4)) + "px";
  ctxMenuEl = menu;
  window.addEventListener("mousedown", onCtxOutside, true);
}

/** Etykieta elementu w menu: Tag lub Tag "Name". */
function describeNode(n: RenderNode): string {
  const name = n.attributes.find((a) => a.name === "Name" || a.name === "x:Name")?.value;
  return name ? `${localTag(n.tag)} "${name}"` : localTag(n.tag);
}
/** Cofnięcie wszystkich zmienionych atrybutów elementu do stanu z pliku (Ctx.RevertElement). */
function revertElement(id: number) {
  const ch = changed[id];
  if (!ch) return;
  const sets: { name: string; value: string }[] = [];
  const removes: string[] = [];
  for (const [name, base] of Object.entries(ch)) {
    if (name === "(content)") continue; // treść cofamy osobno, nie jako atrybut
    if (base === null) removes.push(name);
    else sets.push({ name, value: base });
  }
  if (sets.length || removes.length) vscode.postMessage({ type: "revertAttrs", id, sets, removes });
}
/** Wklejenie schowka jako rodzeństwo PO elemencie `id`. */
function pasteAfter(id: number) {
  if (!clipboardXml) return;
  const parent = parentById.get(id);
  if (!parent) return;
  const sibs = parent.children;
  const idx = sibs.findIndex((c) => c.id === id);
  const beforeId = idx >= 0 && idx + 1 < sibs.length ? sibs[idx + 1].id : null;
  vscode.postMessage({ type: "requestPaste", parentId: parent.id, beforeId });
}
/** Wklejenie schowka do wnętrza kontenera (na końcu). */
function pasteInto(containerId: number) {
  if (!clipboardXml) return;
  vscode.postMessage({ type: "requestPaste", parentId: containerId, beforeId: null });
}
/** Etykieta pozycji Info o schowku: `<Tag>` lub `<Tag> (+ N)` gdy ma pod-elementy. */
function clipboardLabel(info: { tag: string; count: number }): string {
  return `<${info.tag}>` + (info.count > 0 ? ` (+ ${info.count})` : "");
}
/** Liczba wszystkich elementów potomnych (rekurencyjnie). */
function countDescendants(n: RenderNode): number {
  let c = 0;
  for (const ch of n.children) c += 1 + countDescendants(ch);
  return c;
}
/** Etykieta pozycji Info o elemencie do skopiowania: `<Tag>` lub `<Tag> (+ N)`. */
function nodeInfoLabel(n: RenderNode): string {
  return clipboardLabel({ tag: n.tag, count: countDescendants(n) });
}
/** Ścieżka id od elementu w górę do korzenia (element, rodzic, dziadek…) — cele „Wklej w" w drzewku. */
function ancestorChain(id: number): number[] {
  const out: number[] = [];
  let cur: RenderNode | null | undefined = nodeById.get(id);
  while (cur) {
    out.push(cur.id);
    cur = parentById.get(cur.id) ?? null;
  }
  return out;
}
/** Pozycje menu dla elementu. `chain` (stos kontenerów: pod kursorem w podglądzie albo przodkowie
 *  w drzewku) zasila „Wklej w <kontener>". `showSelect` dodaje sekcję „Wybierz:" (tylko podgląd).
 *  Kolejność: Info → akcje (Kopiuj/Wytnij/Usuń/Przywróć) → Wklej → Wybierz. */
function elementMenuItems(id: number | null, opts?: { chain?: number[]; showSelect?: boolean }): CtxItem[] {
  const chain = opts?.chain;
  const showSelect = opts?.showSelect ?? false;
  const hasClip = clipboardXml !== null;
  const ch = id !== null ? changed[id] : undefined;
  const canRevert = !!ch && Object.keys(ch).some((k) => k !== "(content)");
  const isRoot = id !== null && tree !== null && id === tree.id;
  const node = id !== null ? nodeById.get(id) : undefined;
  // „Wklej pod" wstawia rodzeństwo (kolejne dziecko tego samego rodzica — także items-hosta: TabItem
  // pod TabItem → kolejna pozycja w TabControl). Korzeń nie ma rodzeństwa.
  const canPasteSibling = id !== null && !isRoot;
  // Domyślny cel Ctrl+V (= targetContainer): sam zaznaczony kontener/items-host, albo jego
  // rodzic-kontener/items-host. Wtedy „Wklej w <kontener>" jest pierwsze i przejmuje Ctrl+V.
  const isPasteTarget = (t: string) => isContainer(t) || isItemsHost(t);
  const parentNode = id !== null ? parentById.get(id) : null;
  const defaultTargetId =
    node && isPasteTarget(node.tag)
      ? node.id
      : parentNode && isPasteTarget(parentNode.tag)
        ? parentNode.id
        : null;

  const items: CtxItem[] = [];
  // 1) Info o zaznaczonym elemencie (nieaktywne) — np. `<StackPanel> (+ 15)`
  if (node) {
    items.push({ label: nodeInfoLabel(node), enabled: false });
    items.push({ separator: true });
  }
  // 2) Akcje dotyczące elementu
  items.push({
    label: T("Ctx.CopyElement"),
    hint: "Ctrl+C",
    enabled: id !== null,
    onClick: () => vscode.postMessage({ type: "requestCopy", id }),
  });
  items.push({
    label: T("Ctx.CutElement"),
    hint: "Ctrl+X",
    enabled: id !== null && !isRoot,
    onClick: () => id !== null && cutElement(id),
  });
  items.push({
    label: T("Ctx.DeleteElement"),
    hint: "Del",
    enabled: id !== null && !isRoot,
    onClick: () => {
      if (id === null) return;
      vscode.postMessage({ type: "deleteElement", id });
      if (selectedId === id) selectedId = null;
    },
  });
  if (canRevert)
    items.push({ label: T("Ctx.RevertElement"), enabled: true, onClick: () => id !== null && revertElement(id) });

  // 3) Wklej — gdy schowek pusty, tylko nieaktywne „Nic do wklejenia"; inaczej skrót schowka,
  //    „Wklej pod" i „Wklej w <kontener>" (kontenery panelowe ORAZ items-hosty: TabControl/Menu/…)
  items.push({ separator: true });
  if (!hasClip) {
    items.push({ label: T("Ctx.NothingToPaste"), enabled: false });
  } else {
    if (clipboardInfo) items.push({ label: clipboardLabel(clipboardInfo), enabled: false });
    // domyślny kontener (Grid/StackPanel/TabControl/…): „Wklej w <kontener>" jako PIERWSZE i Ctrl+V
    const tgtNode = defaultTargetId !== null ? nodeById.get(defaultTargetId) : undefined;
    if (tgtNode)
      items.push({
        label: tf("Ctx.PasteInto", describeNode(tgtNode)),
        hint: "Ctrl+V",
        enabled: true,
        onClick: () => pasteInto(tgtNode.id),
      });
    items.push({
      label: T("Ctx.PasteUnder"),
      hint: defaultTargetId === null ? "Ctrl+V" : undefined, // Ctrl+V przejęte przez „Wklej w <kontener>"
      enabled: canPasteSibling,
      onClick: () => id !== null && pasteAfter(id),
    });
    for (const cid of chain ?? []) {
      if (cid === defaultTargetId) continue; // już pokazany jako pierwszy
      const n = nodeById.get(cid);
      // realne kontenery oraz items-hosty (przyjmują pozycje jako kolejne dzieci); pomiń property-elementy
      if (!n || isPropertyElementTag(n.tag) || !(isContainer(n.tag) || isItemsHost(n.tag))) continue;
      items.push({ label: tf("Ctx.PasteInto", describeNode(n)), enabled: true, onClick: () => pasteInto(cid) });
    }
  }

  // 4) sekcja „Wybierz:" — elementy pod kursorem jako drzewko (korzeń→najgłębszy), wcięcie 1 spacji/poziom
  if (showSelect && chain && chain.length) {
    items.push({ separator: true }, { label: T("Ctx.SelectHeader"), header: true });
    // wcięcie = liczba przodków obecnych NA LIŚCIE (a nie pozycja w stosie): rodzeństwo nakładające
    // się w tej samej Grid dostaje równe wcięcie, a faktyczne dziecko jest wcięte głębiej — jak w drzewku
    const inList = new Set(chain);
    const listDepth = (cid: number): number => {
      let d = 0;
      for (let p = parentById.get(cid); p; p = parentById.get(p.id) ?? null) if (inList.has(p.id)) d++;
      return d;
    };
    [...chain].reverse().forEach((cid) => {
      const n = nodeById.get(cid);
      if (!n) return;
      items.push({
        label: " ".repeat(listDepth(cid)) + describeNode(n), // twarda spacja: zwykłe wiodące spacje zwija HTML
        checked: cid === selectedId,
        onClick: () => select(cid, { scrollPreview: true, scrollTree: true }),
      });
    });
  }
  return items;
}

// PPM w podglądzie
document.getElementById("surface-scroll")!.addEventListener("contextmenu", (e) => {
  if ((e.target as HTMLElement).closest(".guide")) return; // prowadnice mają własną obsługę
  e.preventDefault();
  const chain = pickStack(e.clientX, e.clientY);
  let id: number | null;
  if (selectedId !== null && chain.includes(selectedId)) {
    id = selectedId; // PPM na zaznaczonym elemencie nie zmienia wyboru
  } else {
    id = chain[0] ?? null;
    if (id !== null) select(id, { scrollTree: true });
  }
  showContextMenu(e.clientX, e.clientY, elementMenuItems(id, { chain, showSelect: true }));
});

// PPM w drzewku struktury
document.getElementById("tree")!.addEventListener("contextmenu", (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>(".trow");
  if (!row) return;
  e.preventDefault();
  const id = Number(row.dataset.id);
  if (id !== selectedId) select(id, { scrollPreview: true });
  // w drzewku „Wklej w <kontener>" dla elementu i jego przodków (bez sekcji „Wybierz:")
  showContextMenu(e.clientX, e.clientY, elementMenuItems(id, { chain: ancestorChain(id) }));
});

// PPM w panelu właściwości (na wierszu atrybutu) → cofnij ten atrybut / wszystkie atrybuty elementu
document.getElementById("props")!.addEventListener("contextmenu", (e) => {
  if (propsMode !== "props" || selectedId === null) return;
  const field = (e.target as HTMLElement).closest<HTMLElement>(".field");
  const attr = field?.dataset.attr;
  if (!attr) return;
  e.preventDefault();
  const id = selectedId;
  const ch = changed[id] ?? {};
  const anyChanged = Object.keys(ch).some((k) => k !== "(content)");
  showContextMenu(e.clientX, e.clientY, [
    {
      label: tf("Props.RevertAttr", attr),
      enabled: attr in ch,
      onClick: () => (ch[attr] === null ? removeAttr(id, attr) : setAttr(id, attr, ch[attr] as string)),
    },
    { label: T("Props.RevertAllAttrs"), enabled: anyChanged, onClick: () => revertElement(id) },
  ]);
});

// zamknij menu przy Escape, przewijaniu i zmianie rozmiaru okna
window.addEventListener("keydown", (e) => { if (e.key === "Escape") closeContextMenu(); }, true);
window.addEventListener("scroll", closeContextMenu, true);
window.addEventListener("resize", closeContextMenu);

window.addEventListener("mousemove", onDragMove);
window.addEventListener("mouseup", onDragUp);
// Puszczenie przycisku po KLIKU bez przeciągania (move/reorder): zastosuj odłożoną selekcję
// (wierzch/cykl). Po realnym przeciąganiu clickSelectId jest już skasowane → no-op.
window.addEventListener("mouseup", (e) => {
  if (e.button === 0) applyClickSelect();
});

// przeciąganie prowadnic + pan
window.addEventListener("mousemove", (e) => {
  if (guideDrag !== null && guides[guideDrag]) {
    const g = guides[guideDrag];
    const d = clientToDesign(e.clientX, e.clientY);
    // snap do siatki ORAZ do sąsiedniej prowadnicy — widoczne już w trakcie przeciągania
    g.pos = snapGuideDrag(g.axis, g.axis === "x" ? d.x : d.y, guideDrag);
    renderGuides();
    updateRulers();
  }
  if (pan) {
    const sc = scrollEl();
    const dx = e.clientX - pan.x;
    const dy = e.clientY - pan.y;
    if (pan.inner) {
      // web: najpierw wewnętrzny ScrollViewer (w jednostkach treści = px/zoom), nadmiar → ekran
      const el = pan.inner;
      const maxT = el.scrollHeight - el.clientHeight;
      const maxL = el.scrollWidth - el.clientWidth;
      const newT = Math.max(0, Math.min(maxT, pan.innerT - dy / zoom));
      const newL = Math.max(0, Math.min(maxL, pan.innerL - dx / zoom));
      el.scrollTop = newT;
      el.scrollLeft = newL;
      // część niewchłonięta przez wnętrze (po przeliczeniu na px ekranu) przesuwa cały podgląd
      sc.scrollTop = pan.st - dy - (newT - pan.innerT) * zoom;
      sc.scrollLeft = pan.sl - dx - (newL - pan.innerL) * zoom;
      updateOverlay();
    } else if (pan.innerId !== null) {
      // host PNG: wewnętrzny ScrollViewer przez offset wysyłany do hosta; nadmiar → ekran
      const r = hostRects.get(pan.innerId);
      const newV = Math.max(0, Math.min(r?.sh ?? 0, pan.innerV - dy / zoom));
      const newH = Math.max(0, Math.min(r?.sw ?? 0, pan.innerH - dx / zoom));
      const cur = scrollOffsets.get(pan.innerId);
      if (!cur || cur.v !== newV || cur.h !== newH) {
        scrollOffsets.set(pan.innerId, { h: newH, v: newV });
        sendScroll("u" + pan.innerId, newH, newV);
      }
      sc.scrollTop = pan.st - dy - (newV - pan.innerV) * zoom;
      sc.scrollLeft = pan.sl - dx - (newH - pan.innerH) * zoom;
    } else {
      sc.scrollLeft = pan.sl - dx;
      sc.scrollTop = pan.st - dy;
    }
  }
});
window.addEventListener("mouseup", () => {
  if (pan) {
    scrollEl().style.cursor = tool === "pan" ? "grab" : "";
    pan = null;
  }
  if (guideDrag !== null) {
    mergeDraggedGuide(guideDrag); // scal z sąsiadem, jeśli trafiła w obrębie snap
    guideDrag = null;
    renderGuides();
    updateRulers(); // zdejmij podświetlenie „dragging"
    renderProps(); // odśwież liczby w sekcji Prowadnice
  }
});

// skróty: Delete / Ctrl+C / Ctrl+X / Ctrl+V
window.addEventListener("keydown", (e) => {
  const tag = (e.target as HTMLElement)?.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
  if (e.key === "Escape" && reorderId !== null) {
    cancelReorder();
    e.preventDefault();
    return;
  }
  if (e.key === "Delete" || e.key === "Backspace") {
    deleteSelected();
    e.preventDefault();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
    if (selectedId !== null) vscode.postMessage({ type: "requestCopy", id: selectedId });
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "x") {
    if (selectedId !== null) cutElement(selectedId);
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") {
    pasteClipboard();
  }
});

document.getElementById("surface-scroll")!.addEventListener("scroll", () => {
  updateOverlay();
  updateRulers();
  scheduleViewbox(true); // scroll = ruch → niska rozdzielczość, pełna po ustaniu
});
// Przewinięcie WEWNĘTRZNEGO ScrollViewer (web) nie bąbelkuje — łapiemy w fazie capture, by ramka
// zaznaczenia podążała za elementem (jego pozycja na ekranie się zmienia, jak cały kontener w WPF).
document.getElementById("surface-scroll")!.addEventListener(
  "scroll",
  (e) => {
    if (e.target !== scrollEl()) updateOverlay();
  },
  true
);
/** Czy punkt (jednostki projektu) leży nad tłem fake-panelu (lista/menu) hosta. */
function overFakePanel(x: number, y: number): boolean {
  for (const r of hostRectList)
    if (r.block && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return true;
  return false;
}

/** Id przewijalnego ScrollViewer-a pod punktem projektu (najbardziej zagnieżdżony). Nad fake-panelem
 *  przewijamy WYŁĄCZNIE jego nakładkę (fake-scroll), poza nim — tylko realne ScrollViewery; inaczej
 *  kółko przewijałoby ScrollViewer zasłonięty fake panelem. */
function scrollableHitId(x: number, y: number): number | null {
  const onFake = overFakePanel(x, y);
  let best: number | null = null;
  let bestArea = Infinity;
  for (const [id, r] of hostRects) {
    if (!r.scroll) continue;
    if (onFake !== id >= FAKE_SCROLL_BASE) continue; // nad panelem → tylko fake; poza → tylko realne
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) {
      const area = r.w * r.h;
      if (area < bestArea) {
        bestArea = area;
        best = id;
      }
    }
  }
  return best;
}

// Ctrl + kółko = zoom; zwykłe kółko nad ScrollViewer (tryb PNG) = przewiń ten ScrollViewer w hoście.
// W trybie web natywne kółko obsługuje zagnieżdżony overflow:auto — tu nic nie robimy.
document.getElementById("surface-scroll")!.addEventListener(
  "wheel",
  (e) => {
    if (e.ctrlKey) {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      fitMode = false; // ręczny zoom wyłącza tryb dopasowania
      setZoom(zoom * factor, e.clientX, e.clientY);
      persistState();
      buildZoomPanel();
      return;
    }
    if (previewMode === "wpf" && hostPng) {
      const d = clientToDesign(e.clientX, e.clientY);
      const id = scrollableHitId(d.x, d.y);
      if (id === null) return; // brak przewijalnego ScrollViewer — pozwól przewinąć cały podgląd
      const r = hostRects.get(id)!;
      const cur = scrollOffsets.get(id) ?? { h: 0, v: 0 };
      const next = {
        h: Math.max(0, Math.min((r.sw ?? 0), cur.h + e.deltaX / zoom)),
        v: Math.max(0, Math.min((r.sh ?? 0), cur.v + e.deltaY / zoom)),
      };
      if (next.h === cur.h && next.v === cur.v) return; // już na krańcu → nie blokuj
      e.preventDefault();
      scrollOffsets.set(id, next);
      sendScroll("u" + id, next.h, next.v);
    }
  },
  { passive: false }
);

// Stabilne odświeżanie przy zmianie rozmiaru viewportu (resize okna VS Code,
// przełączanie paneli, toggle linijek) — debounce przez requestAnimationFrame.
let decoPending = false;
function scheduleDecorations() {
  if (decoPending) return;
  decoPending = true;
  requestAnimationFrame(() => {
    decoPending = false;
    if (fitMode) applyFit(); // re-dopasowanie przy zmianie rozmiaru podglądu/paneli
    updateOverlay();
    drawDecorations();
    reportViewport();
    applyToolbarPos(); // utrzymaj zadokowany pasek przy krawędzi po zmianie rozmiaru
    positionZoomPanel(); // panel zoomu względem przypiętego paska po zmianie rozmiaru
  });
}
window.addEventListener("resize", scheduleDecorations);
const viewport = document.getElementById("preview-viewport");
if (viewport && typeof ResizeObserver !== "undefined") {
  new ResizeObserver(scheduleDecorations).observe(viewport);
}
buildHandles();
setupPaneToggles(); // podłącz X w nagłówkach paneli + nałóż zapisany stan zwinięcia
requestAnimationFrame(reportViewport);

window.addEventListener("message", (e) => {
  const msg = e.data;
  switch (msg.type) {
    case "init":
      l10n = msg.l10n ?? {};
      isWindows = !!msg.isWindows;
      backend = msg.backend ?? "auto";
      applyIsolation(msg.isolation); // tryb + efekt izolacji hosta WPF (selektor silnika)
      applyConfig(msg.config); // ustawienia podglądu z konfiguracji VS Code
      applyThemeState(msg.projectThemes, msg.previewTheme); // motywy projektu + motyw efektywny
      applySync(msg.sync); // ustawienia synchronizacji zaznaczenia
      applyEditorCfg(msg.editor); // podświetlanie zmian/błędów w edytorze tekstu
      applyCanvasDefaults(msg.canvas); // domyślne snap/siatka/linijki + fit-on-open
      applyStaticL10n();
      // tytuł przycisku X w nagłówku Struktury (l10n dostępne dopiero po „init")
      {
        const b = document.getElementById("tree-close");
        if (b) b.title = T("Pane.Close");
      }
      // zsynchronizuj host z trwałym stanem auto-podglądu (webview pamięta, host startuje od false)
      if (autoReveal) vscode.postMessage({ type: "setAutoReveal", enabled: true });
      buildTreeAdd();
      applyPinLayout();
      buildFloatToolbar();
      buildZoomPanel();
      buildPropsHeader();
      reportDpr();
      watchDpr();
      break;
    case "config":
      applyConfig(msg.config);
      applyThemeState(msg.projectThemes, msg.previewTheme); // motyw efektywny (np. resource:…)
      buildFloatToolbar(); // zsynchronizuj ikonę/menu motywu na pasku
      // odśwież panel ustawień, jeśli akurat otwarty (zmiana z UI Settings)
      if (propsMode === "settings") renderProps();
      break;
    case "syncConfig":
      applySync(msg.sync);
      if (propsMode === "settings") renderProps();
      break;
    case "editorConfig":
      applyEditorCfg(msg.editor);
      if (viewMode === "changes") renderChanges(); // odśwież checkbox „Show changes in code"
      if (hostLogOpen) renderHostLog(); // odśwież checkbox „Show errors in code"
      break;
    case "clipboard":
      clipboardXml = msg.xml ?? null;
      clipboardInfo = msg.info ?? null;
      break;
    case "selectNode":
      // kursor zmienił pozycję w edytorze tekstu obok → zaznacz element w XVE.
      // revealText=false, by nie odsyłać kursora z powrotem (unik pętli).
      if (typeof msg.id === "number" && msg.id !== selectedId && nodeById.has(msg.id)) {
        select(msg.id, { scrollPreview: true, scrollTree: true, revealText: false });
        setStatus();
      }
      break;
    case "render":
      hostPng = msg.png ?? null;
      hostW = msg.width ?? 0;
      hostH = msg.height ?? 0;
      hostVx = msg.vx ?? 0;
      hostVy = msg.vy ?? 0;
      hostVw = msg.vw ?? hostW;
      hostVh = msg.vh ?? hostH;
      // null = klatka drag bez mapy hit-test → zachowaj poprzednie rects (overlay jedzie lokalnie)
      if (msg.rects != null) {
        hostRects.clear();
        hostRectList = [];
        for (const r of msg.rects) {
          if (r.block) {
            // tło fake-panelu (lista/menu) — w liście (kolejność malowania) jako bloker; bez numerycznego id
            hostRectList.push({ id: -1, x: r.x, y: r.y, w: r.w, h: r.h, block: true });
            continue;
          }
          const id = parseInt(String(r.uid).slice(1), 10);
          if (!isNaN(id)) {
            hostRects.set(id, {
              x: r.x, y: r.y, w: r.w, h: r.h, scroll: r.scroll, sw: r.sw, sh: r.sh,
              rx: r.rx, ry: r.ry, rw: r.rw, rh: r.rh, clipped: r.clipped,
            });
            // fake-scroll panele (lista/menu) → tylko hostRects (kółko). Do z-order/hit-testu wchodzą elementy
            // z niepustym WIDOCZNYM prostokątem: częściowo przycięte zostają klikalne w widocznej części,
            // a całkiem niewidoczne (host wysyła w=h=0) są pominięte — nieklikalne tam, gdzie ich nie widać.
            if (id < FAKE_SCROLL_BASE && r.w >= 0.5 && r.h >= 0.5) hostRectList.push({ id, x: r.x, y: r.y, w: r.w, h: r.h, block: false });
          }
        }
      }
      if (msg.debug) updateDebugDock(msg.debug); // telemetria konsoli debug
      // klatka wróciła → zwolnij „in-flight" i ewentualnie wyślij najnowszy stan
      renderInFlight = false;
      viewboxInFlight = false;
      if (viewboxDirty && !drag) sendViewbox(viewboxDirtyMotion); // dosyłka najświeższego wycinka
      if (drag) {
        trySendDragFrame(performance.now());
        // podczas drag nie przebudowujemy całego podglądu (overlay już jedzie),
        // ale przy aktywnym renderze w trybie PNG odśwież obraz
        if (previewMode === "wpf") renderPreview();
      } else if (previewMode === "wpf") {
        renderPreview();
      }
      break;
    case "scrolled":
      // host przewinął ScrollViewery, by zaznaczony element był widoczny (auto-podgląd) → zsynchronizuj
      // stan kółka i skoryguj nakładkę + minimalnie zewnętrzne przewinięcie do nowej pozycji
      for (const s of msg.offsets ?? []) {
        const sid = parseInt(String(s.uid).slice(1), 10);
        if (!isNaN(sid)) scrollOffsets.set(sid, { h: s.h, v: s.v });
      }
      updateOverlay();
      if (selectedId !== null) {
        lastPreviewScrollId = selectedId; // wymuś minimalne (nie „do rogu") domknięcie widoczności
        scrollPreviewToSelected(selectedId);
      }
      break;
    case "renderError":
      renderInFlight = false;
      viewboxInFlight = false;
      hostPng = null; // spadek na renderer web
      renderPreview();
      setStatus();
      break;
    case "hostStatus": {
      hostState = {
        status: msg.status ?? "inactive",
        active: !!msg.active,
        log: msg.log ?? [],
        error: msg.error ?? null,
        resources: msg.resources ?? null,
      };
      resourceState = msg.resourceState ?? null;
      // silnik/izolacja mogły się zmienić (decyzja auto, przełączenie trybu) → odśwież selektor
      const prevBackend = backend;
      if (typeof msg.backend === "string") backend = msg.backend;
      const isoChanged = applyIsolation(msg.isolation);
      if (isoChanged || backend !== prevBackend) {
        buildFloatToolbar();
        if (propsMode === "settings") renderProps();
      }
      updateHostDot();
      if (hostLogOpen) renderHostLog();
      if (resourcesDialogOpen) renderResourcesDialog();
      syncHostConsoleDock(); // błąd hosta → konsola zadokowana pod podglądem
      break;
    }
    case "doc": {
      tree = msg.tree;
      imageMap = msg.imageMap ?? {};
      resourceModel = msg.resources ?? null;
      resourceState = msg.resourceState ?? null;
      changed = msg.changed ?? {};
      const prevMode = previewMode;
      previewMode = msg.previewMode === "wpf" ? "wpf" : "web";
      if (previewMode === "web" && prevMode !== "web") hostPng = null;
      // przełączenie na host WPF → wyślij bieżącą pamięć zakładek (w trybie web setTabs nie leci)
      if (previewMode === "wpf" && prevMode !== "wpf") sendTabsToHost();
      // motywy projektu / motyw efektywny mogły się zmienić (po skanie zasobów) → odśwież pasek
      if (applyThemeState(msg.projectThemes, msg.previewTheme)) {
        buildFloatToolbar();
        if (propsMode === "settings") renderProps();
      }
      changesData = msg.changes ?? [];
      updateChangesBadge();
      if (viewMode === "changes") renderChanges();
      nodeById.clear();
      if (tree) indexTree(tree);
      pruneTabSelection(); // usuń wpisy zakładek dla elementów, których już nie ma (po edycji struktury)
      if (selectedId !== null && !nodeById.has(selectedId)) {
        selectedId = null;
        lastPreviewScrollId = null;
      }
      renderStructure();
      renderPreview();
      renderProps();
      setStatus();
      updateHostDot(); // pierścień zasobów może się zmienić (web: motyw/selekcja/język)
      if (hostLogOpen) renderHostLog();
      if (resourcesDialogOpen) renderResourcesDialog();
      break;
    }
  }
});

vscode.postMessage({ type: "ready" });
