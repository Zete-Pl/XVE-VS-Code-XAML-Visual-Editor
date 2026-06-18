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

// ---------- gesty: przesuwanie i skalowanie ----------
const SNAP = 1; // krok zaokrąglenia (px)
function snap(v: number): number {
  return Math.round(v / SNAP) * SNAP;
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
  // podgląd na żywo bez zapisu — transform / wymiary tymczasowe
  if (drag.mode === "move") {
    target.style.transform = `translate(${dx}px, ${dy}px)`;
  } else {
    applyResizePreview(target, drag.dir!, dx, dy, drag.w0, drag.h0);
  }
  updateOverlay();
}

function applyResizePreview(el: HTMLElement, dir: string, dx: number, dy: number, w0: number, h0: number) {
  // baza = rozmiar startowy gestu (nie bieżący rect — inaczej zmiana by się kumulowała)
  let w = w0;
  let h = h0;
  let tx = 0;
  let ty = 0;
  if (dir.includes("e")) w += dx;
  if (dir.includes("s")) h += dy;
  if (dir.includes("w")) {
    w -= dx;
    tx = dx;
  }
  if (dir.includes("n")) {
    h -= dy;
    ty = dy;
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
    const l = numOf(a["Canvas.Left"]) ?? 0;
    const t = numOf(a["Canvas.Top"]) ?? 0;
    return { "Canvas.Left": String(snap(l + dx)), "Canvas.Top": String(snap(t + dy)) };
  }
  const [ml, mt, mr, mb] = thicknessOf(a.Margin);
  let nl = ml,
    nt = mt,
    nr = mr,
    nb = mb;
  if ((a.HorizontalAlignment || "Stretch") === "Right") nr = mr - dx;
  else nl = ml + dx;
  if ((a.VerticalAlignment || "Stretch") === "Bottom") nb = mb - dy;
  else nt = mt + dy;
  return { Margin: `${snap(nl)},${snap(nt)},${snap(nr)},${snap(nb)}` };
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

// klik w podglądzie → zaznaczenie + start przeciągania
document.getElementById("surface")!.addEventListener("mousedown", (e) => {
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

window.addEventListener("resize", updateOverlay);
document.getElementById("surface-scroll")!.addEventListener("scroll", updateOverlay);
buildHandles();

window.addEventListener("message", (e) => {
  const msg = e.data;
  switch (msg.type) {
    case "init":
      l10n = msg.l10n ?? {};
      applyStaticL10n();
      buildToolbar();
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
