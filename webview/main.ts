import "./style.css";
import { renderTreeToDom, RenderNode } from "./renderer";
import {
  metaFor,
  knownProperties,
  defaultValue,
  PropMeta,
  ADDABLE_TYPES,
  defaultSnippet,
  isContainer,
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
let changed: Record<number, Record<string, string | null>> = {};
const nodeById = new Map<number, RenderNode>();
const parentById = new Map<number, RenderNode | null>();
let clipboardXml: string | null = null;

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
  row.onclick = () => select(n.id, true);
  wrap.appendChild(row);
  if (n.children.length) {
    const kids = document.createElement("div");
    kids.className = "tkids";
    n.children.forEach((c) => kids.appendChild(renderStructureNode(c)));
    wrap.appendChild(kids);
  }
  return wrap;
}

// ---------- podgląd ----------
function renderPreview() {
  const surface = document.getElementById("surface")!;
  renderTreeToDom(tree, surface);
  updateOverlay();
  drawDecorations();
}

function updateOverlay() {
  const overlay = document.getElementById("sel-overlay")!;
  const scroll = document.getElementById("surface-scroll")!;
  if (selectedId === null) {
    overlay.style.display = "none";
    return;
  }
  const target = document.querySelector<HTMLElement>(`#surface [data-xve-id="${selectedId}"]`);
  if (!target) {
    overlay.style.display = "none";
    return;
  }
  const tr = target.getBoundingClientRect();
  const sr = scroll.getBoundingClientRect();
  overlay.style.display = "block";
  overlay.style.left = tr.left - sr.left + scroll.scrollLeft + "px";
  overlay.style.top = tr.top - sr.top + scroll.scrollTop + "px";
  overlay.style.width = tr.width + "px";
  overlay.style.height = tr.height + "px";
}

// ---------- panel właściwości (typowany) ----------
function setAttr(id: number, name: string, value: string) {
  vscode.postMessage({ type: "setAttribute", id, name, value });
}
function removeAttr(id: number, name: string) {
  vscode.postMessage({ type: "removeAttribute", id, name });
}

function makeEditor(meta: PropMeta, value: string, onChange: (v: string) => void): HTMLElement {
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
      const wrap = document.createElement("div");
      wrap.className = "field-brush";
      const swatch = document.createElement("input");
      swatch.type = "color";
      swatch.className = "field-swatch";
      const hex = toHexColor(value);
      if (hex) swatch.value = hex;
      const text = document.createElement("input");
      text.className = "field-input";
      text.value = value;
      // live: tylko aktualizuj podgląd hexa (bez commitu, żeby nie zamykać próbnika)
      swatch.oninput = () => {
        text.value = swatch.value;
      };
      // commit dopiero po zamknięciu próbnika
      swatch.onchange = () => onChange(swatch.value);
      text.onchange = () => {
        const h = toHexColor(text.value);
        if (h) swatch.value = h;
        onChange(text.value);
      };
      wrap.appendChild(swatch);
      wrap.appendChild(text);
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

function renderProps() {
  const host = document.getElementById("props")!;
  host.innerHTML = "";
  if (selectedId === null) {
    host.innerHTML = `<div class="empty">${T("View.NoSelection")}</div>`;
    return;
  }
  const node = nodeById.get(selectedId);
  if (!node) return;
  const id = node.id;
  const ch = changed[id] ?? {};

  for (const attr of node.attributes) {
    const meta = metaFor(node.tag, attr.name);
    const field = document.createElement("div");
    field.className = "field" + (attr.name in ch ? " changed" : "");

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
    field.appendChild(makeEditor(meta, attr.value, (v) => setAttr(id, attr.name, v)));
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

// ---------- selekcja (dwukierunkowa) ----------
function select(id: number, scrollPreview = false) {
  selectedId = id;
  renderStructure();
  renderProps();
  updateOverlay();
  if (scrollPreview) {
    const target = document.querySelector<HTMLElement>(`#surface [data-xve-id="${id}"]`);
    target?.scrollIntoView({ block: "nearest", inline: "nearest" });
    updateOverlay();
  }
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

// ---------- pasek narzędzi: dodaj / usuń element ----------
function buildToolbar() {
  const tb = document.getElementById("toolbar")!;
  tb.innerHTML = "";
  const sel = document.createElement("select");
  sel.id = "tb-type";
  sel.className = "tb-select";
  for (const tname of ADDABLE_TYPES) {
    const o = document.createElement("option");
    o.value = o.textContent = tname;
    sel.appendChild(o);
  }
  const add = document.createElement("button");
  add.className = "tb-btn";
  add.textContent = "+ " + T("Tb.Add");
  add.title = T("Tb.AddTip");
  add.onclick = () => addElement(sel.value);

  const del = document.createElement("button");
  del.className = "tb-btn";
  del.textContent = "🗑 " + T("Tb.Delete");
  del.title = T("Tb.DeleteTip");
  del.onclick = () => deleteSelected();

  tb.appendChild(sel);
  tb.appendChild(add);
  tb.appendChild(del);
}

/** Wyznacza rodzica-kontener dla nowego elementu na podstawie zaznaczenia. */
function targetContainer(): { parentId: number; beforeId: number | null } | null {
  if (!tree) return null;
  if (selectedId === null) return { parentId: tree.id, beforeId: null };
  const node = nodeById.get(selectedId);
  if (node && isContainer(node.tag)) return { parentId: node.id, beforeId: null };
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

function pasteClipboard() {
  if (!clipboardXml) return;
  const tgt = targetContainer();
  if (!tgt) return;
  vscode.postMessage({
    type: "insertChild",
    parentId: tgt.parentId,
    beforeId: tgt.beforeId,
    xml: clipboardXml,
  });
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
}

// ---------- narzędzia / snap / siatka / prowadnice ----------
type Tool = "select" | "pan";
let tool: Tool = "select";
let snapOn = true;
let gridStep = 8;
let showGrid = false;
let showRulers = true;
let guidesVisible = true;
interface Guide {
  axis: "x" | "y";
  pos: number;
}
let guides: Guide[] = [];

// ---------- gesty: przesuwanie i skalowanie ----------
function snap(v: number): number {
  const step = snapOn ? gridStep : 1;
  return Math.round(v / step) * step;
}
/** Przyciąganie wartości do najbliższej prowadnicy danej osi (w granicach progu). */
function snapToGuide(axis: "x" | "y", value: number, threshold = 6): number {
  let best = value;
  let bestD = threshold;
  for (const g of guides) {
    if (g.axis === axis) {
      const d = Math.abs(g.pos - value);
      if (d < bestD) {
        bestD = d;
        best = g.pos;
      }
    }
  }
  return best;
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
}
let drag: Drag | null = null;

function startMove(e: MouseEvent, id: number) {
  drag = { mode: "move", id, startX: e.clientX, startY: e.clientY, moved: false, w0: 0, h0: 0 };
}
function startResize(e: MouseEvent, dir: string) {
  if (selectedId === null) return;
  e.stopPropagation();
  const el = document.querySelector<HTMLElement>(`#surface [data-xve-id="${selectedId}"]`);
  const r = el?.getBoundingClientRect();
  drag = {
    mode: "resize",
    dir,
    id: selectedId,
    startX: e.clientX,
    startY: e.clientY,
    moved: false,
    w0: r?.width ?? 0,
    h0: r?.height ?? 0,
  };
}

function onDragMove(e: MouseEvent) {
  if (!drag) return;
  const dx = e.clientX - drag.startX;
  const dy = e.clientY - drag.startY;
  if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
  drag.moved = true;
  const target = document.querySelector<HTMLElement>(`#surface [data-xve-id="${drag.id}"]`);
  if (!target) return;
  const node = nodeById.get(drag.id);
  // podgląd na żywo Z UWZGLĘDNIENIEM snapu (nie tylko po upuszczeniu)
  if (drag.mode === "move" && node) {
    const { tx, ty } = liveMoveOffset(node, dx, dy);
    target.style.transform = `translate(${tx}px, ${ty}px)`;
  } else if (drag.mode === "resize") {
    applyResizePreview(target, drag.dir!, dx, dy, drag.w0, drag.h0);
  }
  updateOverlay();
}

/** Przesunięcie w px po nałożeniu snapu do siatki i prowadnic (podgląd na żywo). */
function liveMoveOffset(node: RenderNode, dx: number, dy: number): { tx: number; ty: number } {
  const a = attrMapOf(node);
  const parent = parentById.get(node.id);
  if (parent && localTag(parent.tag) === "Canvas") {
    const baseL = numOf(a["Canvas.Left"]) ?? 0;
    const baseT = numOf(a["Canvas.Top"]) ?? 0;
    return {
      tx: snapToGuide("x", snap(baseL + dx)) - baseL,
      ty: snapToGuide("y", snap(baseT + dy)) - baseT,
    };
  }
  const [ml, mt, mr, mb] = thicknessOf(a.Margin);
  const ha = a.HorizontalAlignment || "Stretch";
  const va = a.VerticalAlignment || "Stretch";
  const tx = ha === "Right" ? -(snap(mr - dx) - mr) : snapToGuide("x", snap(ml + dx)) - ml;
  const ty = va === "Bottom" ? -(snap(mb - dy) - mb) : snapToGuide("y", snap(mt + dy)) - mt;
  return { tx, ty };
}

function applyResizePreview(el: HTMLElement, dir: string, dx: number, dy: number, w0: number, h0: number) {
  // baza = rozmiar startowy gestu; snap stosujemy też na żywo
  let w = w0;
  let h = h0;
  let tx = 0;
  let ty = 0;
  if (dir.includes("e")) w = snap(w0 + dx);
  if (dir.includes("s")) h = snap(h0 + dy);
  if (dir.includes("w")) {
    w = snap(w0 - dx);
    tx = w0 - w;
  }
  if (dir.includes("n")) {
    h = snap(h0 - dy);
    ty = h0 - h;
  }
  el.style.width = Math.max(0, w) + "px";
  el.style.height = Math.max(0, h) + "px";
  el.style.transform = `translate(${tx}px, ${ty}px)`;
}

function onDragUp(e: MouseEvent) {
  if (!drag) return;
  const d = drag;
  drag = null;
  const target = document.querySelector<HTMLElement>(`#surface [data-xve-id="${d.id}"]`);
  if (target) target.style.transform = "";
  if (!d.moved) return;
  const node = nodeById.get(d.id);
  if (!node) return;
  const dx = snap(e.clientX - d.startX);
  const dy = snap(e.clientY - d.startY);
  const attrs =
    d.mode === "move" ? computeMove(node, dx, dy) : computeResize(node, d.dir!, dx, dy, d.w0, d.h0);
  if (attrs && Object.keys(attrs).length) {
    vscode.postMessage({ type: "setAttributes", id: d.id, attrs });
  }
}

function computeMove(node: RenderNode, dx: number, dy: number): Record<string, string> {
  const a = attrMapOf(node);
  const parent = parentById.get(node.id);
  if (parent && localTag(parent.tag) === "Canvas") {
    const l = snapToGuide("x", snap((numOf(a["Canvas.Left"]) ?? 0) + dx));
    const t = snapToGuide("y", snap((numOf(a["Canvas.Top"]) ?? 0) + dy));
    return { "Canvas.Left": String(l), "Canvas.Top": String(t) };
  }
  const [ml, mt, mr, mb] = thicknessOf(a.Margin);
  let nl = ml,
    nt = mt,
    nr = mr,
    nb = mb;
  if ((a.HorizontalAlignment || "Stretch") === "Right") nr = snap(mr - dx);
  else nl = snapToGuide("x", snap(ml + dx));
  if ((a.VerticalAlignment || "Stretch") === "Bottom") nb = snap(mb - dy);
  else nt = snapToGuide("y", snap(mt + dy));
  return { Margin: `${nl},${nt},${nr},${nb}` };
}

function computeResize(
  node: RenderNode,
  dir: string,
  dx: number,
  dy: number,
  w0: number,
  h0: number
): Record<string, string> {
  const a = attrMapOf(node);
  let w = numOf(a.Width) ?? Math.round(w0);
  let h = numOf(a.Height) ?? Math.round(h0);
  let [ml, mt, mr, mb] = thicknessOf(a.Margin);
  const ha = a.HorizontalAlignment || "Stretch";
  const va = a.VerticalAlignment || "Stretch";
  let marginTouched = false;

  if (dir.includes("e")) w += dx;
  if (dir.includes("s")) h += dy;
  if (dir.includes("w")) {
    w -= dx;
    if (ha !== "Right") {
      ml += dx;
      marginTouched = true;
    }
  }
  if (dir.includes("n")) {
    h -= dy;
    if (va !== "Bottom") {
      mt += dy;
      marginTouched = true;
    }
  }
  const out: Record<string, string> = {
    Width: String(Math.max(0, snap(w))),
    Height: String(Math.max(0, snap(h))),
  };
  if (marginTouched) out.Margin = `${snap(ml)},${snap(mt)},${snap(mr)},${snap(mb)}`;
  return out;
}

// ---------- pasek narzędzi podglądu (Select/Pan + snap/siatka) ----------
function buildPreviewTools() {
  const host = document.getElementById("preview-tools")!;
  host.innerHTML = "";

  const group = document.createElement("div");
  group.className = "tool-group";
  const mkTool = (id: Tool, label: string, tip: string) => {
    const b = document.createElement("button");
    b.className = "tool-btn" + (tool === id ? " active" : "");
    b.textContent = label;
    b.title = tip;
    b.onclick = () => {
      tool = id;
      const sc = document.getElementById("surface-scroll")!;
      sc.style.cursor = id === "pan" ? "grab" : "";
      buildPreviewTools();
    };
    return b;
  };
  group.appendChild(mkTool("select", T("Tool.Select"), T("Tool.SelectTip")));
  group.appendChild(mkTool("pan", T("Tool.Pan"), T("Tool.PanTip")));
  host.appendChild(group);

  host.appendChild(sep());

  // snap on/off + krok siatki
  const snapField = document.createElement("label");
  snapField.className = "tool-field";
  const snapCb = document.createElement("input");
  snapCb.type = "checkbox";
  snapCb.checked = snapOn;
  snapCb.onchange = () => (snapOn = snapCb.checked);
  snapField.append(snapCb, document.createTextNode(T("Tool.Snap")));
  host.appendChild(snapField);

  const gridField = document.createElement("label");
  gridField.className = "tool-field";
  const gridNum = document.createElement("input");
  gridNum.type = "number";
  gridNum.min = "1";
  gridNum.className = "tool-num";
  gridNum.value = String(gridStep);
  gridNum.onchange = () => {
    const v = parseInt(gridNum.value, 10);
    if (v > 0) {
      gridStep = v;
      renderGrid();
    }
  };
  gridField.append(document.createTextNode(T("Tool.Grid")), gridNum, document.createTextNode("px"));
  host.appendChild(gridField);

  const showField = document.createElement("label");
  showField.className = "tool-field";
  const showCb = document.createElement("input");
  showCb.type = "checkbox";
  showCb.checked = showGrid;
  showCb.onchange = () => {
    showGrid = showCb.checked;
    renderGrid();
  };
  showField.append(showCb, document.createTextNode(T("Tool.ShowGrid")));
  host.appendChild(showField);

  host.appendChild(sep());

  // przełączniki: linijki / prowadnice
  const rulersField = document.createElement("label");
  rulersField.className = "tool-field";
  const rulersCb = document.createElement("input");
  rulersCb.type = "checkbox";
  rulersCb.checked = showRulers;
  rulersCb.onchange = () => {
    showRulers = rulersCb.checked;
    applyRulersVisibility();
  };
  rulersField.append(rulersCb, document.createTextNode(T("Tool.Rulers")));
  host.appendChild(rulersField);

  const guidesField = document.createElement("label");
  guidesField.className = "tool-field";
  const guidesCb = document.createElement("input");
  guidesCb.type = "checkbox";
  guidesCb.checked = guidesVisible;
  guidesCb.onchange = () => {
    guidesVisible = guidesCb.checked;
    renderGuides();
  };
  guidesField.append(guidesCb, document.createTextNode(T("Tool.Guides")));
  host.appendChild(guidesField);

  const clr = document.createElement("button");
  clr.className = "tool-btn";
  clr.textContent = T("Tool.ClearGuides");
  clr.title = T("Tool.ClearGuidesTip");
  clr.onclick = () => {
    guides = [];
    renderGuides();
  };
  host.appendChild(clr);
}

function applyRulersVisibility() {
  const vp = document.getElementById("preview-viewport")!;
  vp.classList.toggle("rulers-on", showRulers);
  vp.classList.toggle("rulers-off", !showRulers);
  updateRulers();
}
function sep(): HTMLElement {
  const s = document.createElement("div");
  s.className = "tool-sep";
  return s;
}

// ---------- współrzędne projektu ↔ ekran ----------
function surfaceEl(): HTMLElement {
  return document.getElementById("surface")!;
}
function scrollEl(): HTMLElement {
  return document.getElementById("surface-scroll")!;
}
/** Współrzędna projektowa z pozycji myszy (0,0 = lewy-górny róg powierzchni). */
function clientToDesign(clientX: number, clientY: number): { x: number; y: number } {
  const sc = scrollEl();
  const r = sc.getBoundingClientRect();
  const s = surfaceEl();
  return {
    x: clientX - r.left + sc.scrollLeft - s.offsetLeft,
    y: clientY - r.top + sc.scrollTop - s.offsetTop,
  };
}

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

// ---------- linijki (CSS/DOM — bez canvas) ----------
const RULER_MAJOR = 50;
/** Synchronizuje podziałkę (tło) ze scrollem i przerysowuje etykiety. */
function updateRulers() {
  if (!showRulers) return;
  const sc = scrollEl();
  const s = surfaceEl();
  const originX = s.offsetLeft - sc.scrollLeft; // px do design-0 względem lewej krawędzi paska
  const originY = s.offsetTop - sc.scrollTop;
  const topTicks = document.getElementById("ruler-top-ticks");
  const leftTicks = document.getElementById("ruler-left-ticks");
  if (topTicks) topTicks.style.backgroundPositionX = `${originX}px, ${originX}px`;
  if (leftTicks) leftTicks.style.backgroundPositionY = `${originY}px, ${originY}px`;
  buildAxisLabels(document.getElementById("ruler-top-labels"), "x", originX);
  buildAxisLabels(document.getElementById("ruler-left-labels"), "y", originY);
}
function buildAxisLabels(host: HTMLElement | null, axis: "x" | "y", origin: number) {
  if (!host) return;
  const length = axis === "x" ? host.clientWidth : host.clientHeight;
  host.innerHTML = "";
  if (length <= 0) return;
  const startC = Math.ceil((2 - origin) / RULER_MAJOR) * RULER_MAJOR;
  const endC = Math.floor((length - 2 - origin) / RULER_MAJOR) * RULER_MAJOR;
  for (let c = startC; c <= endC; c += RULER_MAJOR) {
    const p = origin + c;
    const span = document.createElement("span");
    span.className = "ruler-label";
    span.textContent = String(c);
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
  const line = cssVar("--vscode-panel-border", "#8884");
  layer.style.backgroundImage = `linear-gradient(to right, ${line} 1px, transparent 1px), linear-gradient(to bottom, ${line} 1px, transparent 1px)`;
  layer.style.backgroundSize = `${gridStep}px ${gridStep}px`;
  layer.style.backgroundPosition = `0 0`;
}
function renderGuides() {
  const layer = document.getElementById("guide-layer")!;
  sizeLayer(layer);
  layer.style.display = guidesVisible ? "block" : "none";
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

// dodawanie prowadnic klikiem w linijkę
document.getElementById("ruler-top")!.addEventListener("mousedown", (e) => {
  const { x } = clientToDesign(e.clientX, e.clientY);
  guides.push({ axis: "x", pos: snap(x) });
  renderGuides();
});
document.getElementById("ruler-left")!.addEventListener("mousedown", (e) => {
  const { y } = clientToDesign(e.clientX, e.clientY);
  guides.push({ axis: "y", pos: snap(y) });
  renderGuides();
});

// przeciąganie / usuwanie prowadnic
let guideDrag: number | null = null;
document.getElementById("guide-layer")!.addEventListener("mousedown", (e) => {
  const g = (e.target as HTMLElement).closest<HTMLElement>(".guide");
  if (!g) return;
  e.preventDefault();
  guideDrag = Number(g.dataset.gi);
});
document.getElementById("guide-layer")!.addEventListener("dblclick", (e) => {
  const g = (e.target as HTMLElement).closest<HTMLElement>(".guide");
  if (!g) return;
  guides.splice(Number(g.dataset.gi), 1);
  renderGuides();
});

// ---------- pan ----------
let pan: { x: number; y: number; sl: number; st: number } | null = null;
function startPan(e: MouseEvent) {
  const sc = scrollEl();
  pan = { x: e.clientX, y: e.clientY, sl: sc.scrollLeft, st: sc.scrollTop };
  sc.style.cursor = "grabbing";
}

// klik w podglądzie → pan / zaznaczenie + start przeciągania
document.getElementById("surface")!.addEventListener("mousedown", (e) => {
  if (tool === "pan" || e.button === 1) {
    e.preventDefault();
    startPan(e);
    return;
  }
  const t = (e.target as HTMLElement).closest<HTMLElement>("[data-xve-id]");
  if (!t) return;
  e.preventDefault();
  const id = Number(t.dataset.xveId);
  if (id !== selectedId) {
    select(id);
    setStatus();
  }
  if (tree && id !== tree.id) startMove(e, id);
});

// uchwyty resize (na nakładce)
document.getElementById("sel-overlay")!.addEventListener("mousedown", (e) => {
  const h = (e.target as HTMLElement).closest<HTMLElement>("[data-handle]");
  if (h) {
    e.preventDefault();
    startResize(e, h.dataset.handle!);
  }
});

window.addEventListener("mousemove", onDragMove);
window.addEventListener("mouseup", onDragUp);

// przeciąganie prowadnic + pan
window.addEventListener("mousemove", (e) => {
  if (guideDrag !== null && guides[guideDrag]) {
    const g = guides[guideDrag];
    const d = clientToDesign(e.clientX, e.clientY);
    g.pos = snap(g.axis === "x" ? d.x : d.y);
    renderGuides();
  }
  if (pan) {
    const sc = scrollEl();
    sc.scrollLeft = pan.sl - (e.clientX - pan.x);
    sc.scrollTop = pan.st - (e.clientY - pan.y);
  }
});
window.addEventListener("mouseup", () => {
  if (pan) {
    scrollEl().style.cursor = tool === "pan" ? "grab" : "";
    pan = null;
  }
  guideDrag = null;
});

// skróty: Delete / Ctrl+C / Ctrl+V
window.addEventListener("keydown", (e) => {
  const tag = (e.target as HTMLElement)?.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
  if (e.key === "Delete" || e.key === "Backspace") {
    deleteSelected();
    e.preventDefault();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
    if (selectedId !== null) vscode.postMessage({ type: "requestCopy", id: selectedId });
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") {
    pasteClipboard();
  }
});

document.getElementById("surface-scroll")!.addEventListener("scroll", () => {
  updateOverlay();
  updateRulers();
});

// Stabilne odświeżanie przy zmianie rozmiaru viewportu (resize okna VS Code,
// przełączanie paneli, toggle linijek) — debounce przez requestAnimationFrame.
let decoPending = false;
function scheduleDecorations() {
  if (decoPending) return;
  decoPending = true;
  requestAnimationFrame(() => {
    decoPending = false;
    updateOverlay();
    drawDecorations();
  });
}
window.addEventListener("resize", scheduleDecorations);
const viewport = document.getElementById("preview-viewport");
if (viewport && typeof ResizeObserver !== "undefined") {
  new ResizeObserver(scheduleDecorations).observe(viewport);
}
buildHandles();

window.addEventListener("message", (e) => {
  const msg = e.data;
  switch (msg.type) {
    case "init":
      l10n = msg.l10n ?? {};
      applyStaticL10n();
      buildToolbar();
      buildPreviewTools();
      break;
    case "clipboard":
      clipboardXml = msg.xml ?? null;
      break;
    case "doc": {
      tree = msg.tree;
      changed = msg.changed ?? {};
      nodeById.clear();
      if (tree) indexTree(tree);
      if (selectedId !== null && !nodeById.has(selectedId)) selectedId = null;
      renderStructure();
      renderPreview();
      renderProps();
      setStatus();
      break;
    }
  }
});

vscode.postMessage({ type: "ready" });
