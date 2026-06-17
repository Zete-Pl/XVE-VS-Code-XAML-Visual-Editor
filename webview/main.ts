import "./style.css";
import { renderTreeToDom, RenderNode } from "./renderer";

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

// ---------- panel właściwości ----------
function renderProps() {
  const host = document.getElementById("props")!;
  host.innerHTML = "";
  if (selectedId === null) {
    host.innerHTML = `<div class="empty">${T("View.NoSelection")}</div>`;
    return;
  }
  const node = nodeById.get(selectedId);
  if (!node) return;
  for (const attr of node.attributes) {
    const field = document.createElement("label");
    field.className = "field";
    const label = document.createElement("span");
    label.className = "field-name";
    label.textContent = attr.name;
    const input = document.createElement("input");
    input.className = "field-input";
    input.value = attr.value;
    input.onchange = () =>
      vscode.postMessage({ type: "setAttribute", id: node.id, name: attr.name, value: input.value });
    field.appendChild(label);
    field.appendChild(input);
    host.appendChild(field);
  }
}

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
