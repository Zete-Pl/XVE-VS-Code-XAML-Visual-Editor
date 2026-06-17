import "./style.css";

// Komunikacja z extension host
declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): any;
  setState(s: any): void;
};
const vscode = acquireVsCodeApi();

interface TreeNodeDto {
  id: number;
  tag: string;
  attributes: { name: string; value: string }[];
  children: TreeNodeDto[];
}

let l10n: Record<string, string> = {};
let tree: TreeNodeDto | null = null;
let selectedId: number | null = null;
const nodeById = new Map<number, TreeNodeDto>();

function T(key: string): string {
  return l10n[key] ?? key;
}

function applyStaticL10n() {
  document.querySelectorAll<HTMLElement>("[data-l10n]").forEach((el) => {
    el.textContent = T(el.dataset.l10n!);
  });
}

function indexTree(n: TreeNodeDto) {
  nodeById.set(n.id, n);
  n.children.forEach(indexTree);
}

function renderTree() {
  const host = document.getElementById("tree")!;
  host.innerHTML = "";
  if (!tree) return;
  host.appendChild(renderNode(tree));
}

function renderNode(n: TreeNodeDto): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "tnode";

  const row = document.createElement("div");
  row.className = "trow" + (n.id === selectedId ? " selected" : "");
  const name = n.attributes.find((a) => a.name === "Name" || a.name === "x:Name")?.value;
  row.textContent = n.tag + (name ? ` (${name})` : "");
  row.onclick = () => select(n.id);
  wrap.appendChild(row);

  if (n.children.length) {
    const kids = document.createElement("div");
    kids.className = "tkids";
    n.children.forEach((c) => kids.appendChild(renderNode(c)));
    wrap.appendChild(kids);
  }
  return wrap;
}

function select(id: number) {
  selectedId = id;
  renderTree();
  renderProps();
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

  for (const attr of node.attributes) {
    const field = document.createElement("label");
    field.className = "field";
    const label = document.createElement("span");
    label.className = "field-name";
    label.textContent = attr.name;
    const input = document.createElement("input");
    input.className = "field-input";
    input.value = attr.value;
    input.onchange = () => {
      vscode.postMessage({ type: "setAttribute", id: node.id, name: attr.name, value: input.value });
    };
    field.appendChild(label);
    field.appendChild(input);
    host.appendChild(field);
  }
}

function setSource(text: string) {
  document.getElementById("source")!.textContent = text;
}

function setStatus(text: string) {
  document.getElementById("statusbar")!.textContent = text;
}

function countElements(n: TreeNodeDto): number {
  return 1 + n.children.reduce((s, c) => s + countElements(c), 0);
}

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
      setSource(msg.source ?? "");
      renderTree();
      renderProps();
      setStatus(
        tree
          ? T("Status.ParsedElements").replace("{0}", String(countElements(tree))) +
              " · " +
              T("Status.PreviewSoon")
          : ""
      );
      break;
    }
  }
});

vscode.postMessage({ type: "ready" });
