import "./style.css";
import { renderTreeToDom, RenderNode } from "./renderer";
import { metaFor, knownProperties, defaultValue, PropMeta } from "../src/core/TypeRegistry";

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

function T(key: string): string {
  return l10n[key] ?? key;
}

function applyStaticL10n() {
  document.querySelectorAll<HTMLElement>("[data-l10n]").forEach((el) => {
    el.textContent = T(el.dataset.l10n!);
  });
}

function indexTree(n: RenderNode) {
  nodeById.set(n.id, n);
  n.children.forEach(indexTree);
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
      swatch.oninput = () => {
        text.value = swatch.value;
        onChange(swatch.value);
      };
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

// klik w podglądzie → zaznaczenie
document.getElementById("surface")!.addEventListener("mousedown", (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>("[data-xve-id]");
  if (t) {
    e.preventDefault();
    select(Number(t.dataset.xveId));
    setStatus();
  }
});

window.addEventListener("resize", updateOverlay);
document.getElementById("surface-scroll")!.addEventListener("scroll", updateOverlay);

window.addEventListener("message", (e) => {
  const msg = e.data;
  switch (msg.type) {
    case "init":
      l10n = msg.l10n ?? {};
      applyStaticL10n();
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
