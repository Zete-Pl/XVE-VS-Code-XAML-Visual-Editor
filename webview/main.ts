import "./style.css";
import { renderTreeToDom, RenderNode } from "./renderer";
import type { Change } from "../src/core/StructuralDiff";
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
let changesData: Change[] = [];
let viewMode: "design" | "changes" = "design";
let showInlineDiff = true; // podświetlanie zmian w edytorze tekstu (przełącznik w Changes)
let isWindows = false;
let backend = "auto"; // auto | web | wpf-host
let previewMode: "web" | "wpf" = "web";
let hostPng: string | null = null;
let hostW = 0; // pełny logiczny rozmiar powierzchni
let hostH = 0;
let hostVx = 0; // wycinek (slice) renderu — w trybie „widoczny obszar"
let hostVy = 0;
let hostVw = 0;
let hostVh = 0;
let viewportRender = true; // render tylko widocznego obszaru (domyślnie wł.)
const hostRects = new Map<number, { x: number; y: number; w: number; h: number }>();
// strategia podglądu przeciągania w trybie PNG (host WPF)
let dragPreviewMode: "overlay" | "frames" | "ms" = "ms";
let dragFrames = 2; // co ile klatek re-render
let dragMs = 25; // co ile ms re-render
let dragSession = true; // trwała sesja hosta (szybciej) vs pełny re-render co klatkę
let dragCoalesce = true; // koalescencja: tylko 1 klatka „w locie" (odrzuca zaległe)
let dragRealSize = true; // render w rzeczywistym rozmiarze viewportu vs sztywne 1200×900
let renderCap = 2560; // limit rozdzielczości renderu hosta (px); 0 = bez limitu
let zoom = 1; // skala podglądu (1 = 100%)
let previewTheme = "none"; // motyw podglądu hosta: none | system | light | dark
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
  const png = previewMode === "wpf" && hostPng;
  surface.classList.toggle("png", !!png);
  if (png) {
    // #surface = PEŁNY logiczny rozmiar powierzchni; obraz to wycinek (vx,vy,vw,vh).
    // Dla pełnego renderu wycinek = cała powierzchnia, więc obraz ją wypełnia.
    surface.innerHTML = "";
    surface.style.width = hostW + "px";
    surface.style.height = hostH + "px";
    const img = document.createElement("img");
    img.src = "data:image/png;base64," + hostPng;
    img.style.position = "absolute";
    img.style.left = hostVx + "px";
    img.style.top = hostVy + "px";
    img.style.width = hostVw + "px";
    img.style.height = hostVh + "px";
    surface.appendChild(img);
  } else {
    surface.style.width = "";
    surface.style.height = "";
    renderTreeToDom(tree, surface);
  }
  applyZoomTransform();
  updateOverlay();
  drawDecorations();
  scheduleViewbox(); // tryb „widoczny obszar": doślij aktualny wycinek (guard kluczem)
}

function hitTestRects(x: number, y: number): number | null {
  let best: number | null = null;
  let bestArea = Infinity;
  for (const [id, r] of hostRects) {
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

function updateOverlay() {
  const overlay = document.getElementById("sel-overlay")!;
  const scroll = document.getElementById("surface-scroll")!;
  if (selectedId === null) {
    overlay.style.display = "none";
    return;
  }
  // tryb PNG (host WPF): pozycja z mapy hit-test (współrzędne projektu × zoom)
  if (previewMode === "wpf" && hostPng) {
    const r = hostRects.get(selectedId);
    if (!r) {
      overlay.style.display = "none";
      return;
    }
    const ze = zoomEl();
    overlay.style.display = "block";
    overlay.style.left = ze.offsetLeft + r.x * zoom + "px";
    overlay.style.top = ze.offsetTop + r.y * zoom + "px";
    overlay.style.width = r.w * zoom + "px";
    overlay.style.height = r.h * zoom + "px";
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
  const node = selectedId !== null ? nodeById.get(selectedId) : undefined;
  if (!node) {
    const note = document.createElement("div");
    note.className = "empty";
    note.textContent = T("View.NoSelection");
    host.appendChild(note);
    renderGuidesSection(host);
    return;
  }
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

  renderGuidesSection(host);
}

/** Sekcja „Prowadnice" — lista pionowych/poziomych z edycją liczbową, +Dodaj, ×, Usuń wszystkie. */
function renderGuidesSection(host: HTMLElement) {
  const sec = document.createElement("div");
  sec.className = "guides-section";
  const title = document.createElement("div");
  title.className = "pane-subtitle";
  title.textContent = T("Guides.Title");
  sec.appendChild(title);
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
    guides.push({ axis, pos: 0 });
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
  // przewiń edytor tekstu (jeśli otwarty obok) do pierwszego wiersza elementu
  vscode.postMessage({ type: "revealNode", id });
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

  // przełącznik widoku: Design / Changes
  tb.appendChild(sep());
  const vg = document.createElement("div");
  vg.className = "tool-group";
  const mkView = (id: "design" | "changes", label: string) => {
    const b = document.createElement("button");
    b.className = "tool-btn" + (viewMode === id ? " active" : "");
    b.textContent = label;
    if (id === "changes") b.id = "view-changes-btn";
    b.onclick = () => {
      viewMode = id;
      applyViewMode();
    };
    return b;
  };
  vg.appendChild(mkView("design", T("View.Design")));
  vg.appendChild(mkView("changes", changesLabel()));
  tb.appendChild(vg);

  // przycisk ustawień (po prawej)
  const spacer = document.createElement("div");
  spacer.style.flex = "1";
  tb.appendChild(spacer);
  const gear = document.createElement("button");
  gear.className = "tb-btn";
  gear.textContent = "⚙";
  gear.title = T("Settings.Title");
  gear.onclick = () => toggleSettings();
  tb.appendChild(gear);
}

// ---------- panel ustawień ----------
function toggleSettings(force?: boolean) {
  const overlay = document.getElementById("settings-overlay")!;
  const show = force ?? overlay.classList.contains("hidden");
  overlay.classList.toggle("hidden", !show);
  if (show) buildSettings();
}
function buildSettings() {
  const panel = document.getElementById("settings-panel")!;
  panel.innerHTML = "";

  const head = document.createElement("div");
  head.className = "settings-head";
  const title = document.createElement("span");
  title.className = "pane-subtitle";
  title.textContent = T("Settings.Title");
  const close = document.createElement("button");
  close.className = "field-btn";
  close.textContent = "✕";
  close.onclick = () => toggleSettings(false);
  head.append(title, close);
  panel.appendChild(head);

  // wybór backendu podglądu
  const sec = document.createElement("div");
  sec.className = "settings-section";
  const label = document.createElement("div");
  label.className = "field-name";
  label.textContent = T("Settings.Backend");
  sec.appendChild(label);

  const opts: { value: string; label: string; winOnly?: boolean }[] = [
    { value: "auto", label: T("Backend.Auto") },
    { value: "web", label: T("Backend.Web") },
    { value: "wpf-host", label: T("Backend.WpfHost"), winOnly: true },
  ];
  for (const o of opts) {
    if (o.winOnly && !isWindows) continue;
    const row = document.createElement("label");
    row.className = "settings-radio";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "xve-backend";
    radio.checked = backend === o.value;
    radio.onchange = () => {
      backend = o.value;
      vscode.postMessage({ type: "setBackend", value: o.value });
    };
    row.append(radio, document.createTextNode(o.label));
    sec.appendChild(row);
  }
  if (!isWindows) {
    const note = document.createElement("div");
    note.className = "settings-note";
    note.textContent = T("Backend.WindowsOnly");
    sec.appendChild(note);
  }
  panel.appendChild(sec);

  // opcje trybu host — tylko gdy aktywny host WPF
  const wpfActive = isWindows && (backend === "wpf-host" || backend === "auto");
  if (!wpfActive) return;

  // motyw podglądu (host WPF)
  const themeSec = document.createElement("div");
  themeSec.className = "settings-section";
  const tLabel = document.createElement("div");
  tLabel.className = "field-name";
  tLabel.textContent = T("Settings.PreviewTheme");
  themeSec.appendChild(tLabel);
  const tSel = document.createElement("select");
  tSel.className = "field-input";
  for (const [val, label] of [
    ["none", T("Theme.Classic")],
    ["system", T("Theme.System")],
    ["light", T("Theme.Light")],
    ["dark", T("Theme.Dark")],
  ]) {
    const o = document.createElement("option");
    o.value = val;
    o.textContent = label;
    tSel.appendChild(o);
  }
  tSel.value = previewTheme;
  tSel.onchange = () => {
    previewTheme = tSel.value;
    vscode.postMessage({ type: "setPreviewTheme", value: previewTheme });
  };
  themeSec.appendChild(tSel);
  panel.appendChild(themeSec);

  const drag = document.createElement("div");
  drag.className = "settings-section";
  const dlabel = document.createElement("div");
  dlabel.className = "field-name";
  dlabel.textContent = T("Settings.DragPreview");
  drag.appendChild(dlabel);

  const dragOpts: { value: typeof dragPreviewMode; label: string; num?: "frames" | "ms" }[] = [
    { value: "overlay", label: T("Drag.Overlay") },
    { value: "frames", label: T("Drag.Frames"), num: "frames" },
    { value: "ms", label: T("Drag.Ms"), num: "ms" },
  ];
  for (const o of dragOpts) {
    const row = document.createElement("label");
    row.className = "settings-radio";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "xve-drag";
    radio.checked = dragPreviewMode === o.value;
    radio.onchange = () => {
      dragPreviewMode = o.value;
      buildSettings();
    };
    row.append(radio, document.createTextNode(o.label));
    if (o.num) {
      const inp = document.createElement("input");
      inp.type = "number";
      inp.min = "1";
      inp.className = "tool-num";
      inp.value = String(o.num === "frames" ? dragFrames : dragMs);
      inp.onchange = () => {
        const v = parseInt(inp.value, 10);
        if (v > 0) {
          if (o.num === "frames") dragFrames = v;
          else dragMs = v;
        }
      };
      row.appendChild(inp);
      row.appendChild(document.createTextNode(o.num === "frames" ? T("Drag.UnitFrames") : "ms"));
    }
    drag.appendChild(row);
  }
  // metoda re-renderu na żywo: trwała sesja hosta (szybciej) vs pełny re-render co klatkę
  const sessRow = document.createElement("label");
  sessRow.className = "settings-radio";
  const sessCb = document.createElement("input");
  sessCb.type = "checkbox";
  sessCb.checked = dragSession;
  sessCb.onchange = () => {
    dragSession = sessCb.checked;
  };
  sessRow.append(sessCb, document.createTextNode(T("Drag.Session")));
  drag.appendChild(sessRow);

  // koalescencja in-flight (odrzucanie zaległych klatek)
  const coalRow = document.createElement("label");
  coalRow.className = "settings-radio";
  const coalCb = document.createElement("input");
  coalCb.type = "checkbox";
  coalCb.checked = dragCoalesce;
  coalCb.onchange = () => {
    dragCoalesce = coalCb.checked;
  };
  coalRow.append(coalCb, document.createTextNode(T("Drag.Coalesce")));
  drag.appendChild(coalRow);

  // render w rzeczywistym rozmiarze viewportu
  const sizeRow = document.createElement("label");
  sizeRow.className = "settings-radio";
  const sizeCb = document.createElement("input");
  sizeCb.type = "checkbox";
  sizeCb.checked = dragRealSize;
  sizeCb.onchange = () => {
    dragRealSize = sizeCb.checked;
    vscode.postMessage({ type: "setRealSize", enabled: dragRealSize });
  };
  sizeRow.append(sizeCb, document.createTextNode(T("Drag.RealSize")));
  drag.appendChild(sizeRow);

  // limit rozdzielczości renderu (px po dłuższym boku; 0 = bez limitu, pełna ostrość)
  const capRow = document.createElement("label");
  capRow.className = "settings-radio";
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
      vscode.postMessage({ type: "setRenderCap", value: renderCap });
    }
  };
  capRow.append(document.createTextNode(T("Drag.MaxRes")), capInp, document.createTextNode("px"));
  drag.appendChild(capRow);

  // render tylko widocznego obszaru (eksperymentalne)
  const vpRow = document.createElement("label");
  vpRow.className = "settings-radio";
  const vpCb = document.createElement("input");
  vpCb.type = "checkbox";
  vpCb.checked = viewportRender;
  vpCb.onchange = () => {
    viewportRender = vpCb.checked;
    if (viewportRender) sendViewbox(); // przekaż prostokąt zanim host zacznie renderować wycinek
    vscode.postMessage({ type: "setViewportRender", enabled: viewportRender });
  };
  vpRow.append(vpCb, document.createTextNode(T("Drag.Viewport")));
  drag.appendChild(vpRow);

  const dnote = document.createElement("div");
  dnote.className = "settings-note";
  dnote.textContent = T("Drag.Note");
  drag.appendChild(dnote);
  panel.appendChild(drag);
}

function changesLabel(): string {
  return T("View.Changes") + (changesData.length ? ` (${changesData.length})` : "");
}
function updateChangesBadge() {
  const b = document.getElementById("view-changes-btn");
  if (b) b.textContent = changesLabel();
}

function applyViewMode() {
  document.getElementById("preview-pane")!.classList.toggle("mode-changes", viewMode === "changes");
  buildToolbar();
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

function changeRow(c: Change): HTMLElement {
  const row = document.createElement("div");
  row.className = "change-row";
  const label = document.createElement("span");
  label.className = "change-label";
  let revert: () => void;

  if (c.kind === "attrs") {
    row.classList.add("ch-attrs");
    label.innerHTML = `<b>${c.tag}</b> · ${c.attrs.map((a) => a.name).join(", ")}`;
    revert = () => {
      const sets = c.attrs.filter((a) => a.baseline !== null).map((a) => ({ name: a.name, value: a.baseline as string }));
      const removes = c.attrs.filter((a) => a.baseline === null).map((a) => a.name);
      vscode.postMessage({ type: "revertAttrs", id: c.id, sets, removes });
    };
  } else if (c.kind === "added") {
    row.classList.add("ch-added");
    label.innerHTML = `<span class="ch-sign">+</span> <b>${c.tag}</b>`;
    revert = () => vscode.postMessage({ type: "deleteElement", id: c.id });
  } else {
    row.classList.add("ch-removed");
    label.innerHTML = `<span class="ch-sign">−</span> <b>${c.tag}</b>`;
    revert = () => vscode.postMessage({ type: "revertRemoved", parentId: c.parentId, xml: c.xml, index: c.index });
  }

  if (c.kind !== "removed") {
    label.style.cursor = "pointer";
    label.onclick = () => {
      select((c as { id: number }).id);
      viewMode = "design";
      applyViewMode();
    };
  }

  const btn = document.createElement("button");
  btn.className = "field-btn";
  btn.title = T("Prop.Revert");
  btn.textContent = "↶";
  btn.onclick = revert;
  row.append(label, btn);
  return row;
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
let guideDrag: number | null = null;

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
let dragBaseRect: { x: number; y: number; w: number; h: number } | null = null;
let dragLatestAttrs: Record<string, string> | null = null;
let dragRaf = 0;
let dragFrameCount = 0;
let dragLastSent = 0;
let dragLastFrameSent = 0;
let dragSessionActive = false;
let renderInFlight = false; // koalescencja: najwyżej jedna klatka „w locie"

function pngMode(): boolean {
  return previewMode === "wpf" && !!hostPng;
}

function startMove(e: MouseEvent, id: number) {
  drag = { mode: "move", id, startX: e.clientX, startY: e.clientY, moved: false, w0: 0, h0: 0 };
  dragBaseRect = pngMode() ? hostRects.get(id) ?? null : null;
  dragLatestAttrs = null;
  startDragPump();
}
function startResize(e: MouseEvent, dir: string) {
  if (selectedId === null) return;
  e.stopPropagation();
  let w0 = 0;
  let h0 = 0;
  if (pngMode()) {
    const r = hostRects.get(selectedId);
    dragBaseRect = r ? { ...r } : null;
    w0 = r?.w ?? 0;
    h0 = r?.h ?? 0;
  } else {
    const el = document.querySelector<HTMLElement>(`#surface [data-xve-id="${selectedId}"]`);
    const r = el?.getBoundingClientRect();
    dragBaseRect = null;
    w0 = (r?.width ?? 0) / zoom;
    h0 = (r?.height ?? 0) / zoom;
  }
  drag = { mode: "resize", dir, id: selectedId, startX: e.clientX, startY: e.clientY, moved: false, w0, h0 };
  dragLatestAttrs = null;
  startDragPump();
}

/** Ustawia nakładkę zaznaczenia we współrzędnych projektu (tryb PNG). */
function setOverlayDesignRect(x: number, y: number, w: number, h: number) {
  const ze = zoomEl();
  const o = document.getElementById("sel-overlay")!;
  o.style.display = "block";
  o.style.left = ze.offsetLeft + x * zoom + "px";
  o.style.top = ze.offsetTop + y * zoom + "px";
  o.style.width = Math.max(0, w * zoom) + "px";
  o.style.height = Math.max(0, h * zoom) + "px";
}

// Pompa re-renderu na żywo (tylko tryb PNG + strategia frames/ms). Wysyła do hosta
// PODGLĄD (previewDrag) bez commitu do dokumentu — finalny zapis dopiero po puszczeniu.
/** Wysyła klatkę podglądu, jeśli pozwala odstęp (klatki/ms) i nic nie jest „w locie". */
function trySendDragFrame(now: number) {
  if (!drag || !dragLatestAttrs) return;
  if (dragCoalesce && renderInFlight) return; // koalescencja: czekaj na powrót klatki
  const spacingOk =
    dragPreviewMode === "frames"
      ? dragFrameCount - dragLastFrameSent >= Math.max(1, dragFrames)
      : now - dragLastSent >= Math.max(1, dragMs);
  if (!spacingOk) return;
  dragLastSent = now;
  dragLastFrameSent = dragFrameCount;
  renderInFlight = true;
  if (dragSessionActive) vscode.postMessage({ type: "dragUpdate", id: drag.id, attrs: dragLatestAttrs });
  else vscode.postMessage({ type: "previewDrag", id: drag.id, attrs: dragLatestAttrs });
}

function startDragPump() {
  if (!pngMode() || dragPreviewMode === "overlay") return;
  dragFrameCount = 0;
  dragLastFrameSent = 0;
  dragLastSent = performance.now();
  renderInFlight = false;
  // trwała sesja nie dla korzenia (Window): zmiana jego Width/Height musi przeliczyć
  // rozmiar płótna, co robi tylko pełny re-render
  dragSessionActive = dragSession && !!drag && !!tree && drag.id !== tree.id;
  // trwała sesja: host parsuje RAZ na początku gestu
  if (dragSessionActive && drag) vscode.postMessage({ type: "dragStart", id: drag.id });
  const tick = (t: number) => {
    if (!drag) {
      dragRaf = 0;
      return;
    }
    dragFrameCount++;
    trySendDragFrame(t);
    dragRaf = requestAnimationFrame(tick);
  };
  dragRaf = requestAnimationFrame(tick);
}
function stopDragPump() {
  if (dragRaf) cancelAnimationFrame(dragRaf);
  dragRaf = 0;
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
  if (!drag.moved && (Math.abs(dx) + Math.abs(dy)) * zoom < 3) return;
  drag.moved = true;
  const node = nodeById.get(drag.id);
  if (!node) return;

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
      if (dir.includes("e")) w = snap(base.w + dx);
      if (dir.includes("s")) h = snap(base.h + dy);
      if (dir.includes("w")) {
        const nw = snap(base.w - dx);
        x = base.x + (base.w - nw);
        w = nw;
      }
      if (dir.includes("n")) {
        const nh = snap(base.h - dy);
        y = base.y + (base.h - nh);
        h = nh;
      }
      setOverlayDesignRect(x, y, w, h);
      dragLatestAttrs = computeResize(node, dir, dx, dy, drag.w0, drag.h0);
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
  stopDragPump();
  dragBaseRect = null;
  dragLatestAttrs = null;
  if (!pngMode()) {
    const target = document.querySelector<HTMLElement>(`#surface [data-xve-id="${d.id}"]`);
    if (target) target.style.transform = "";
  }
  if (!d.moved) return;
  const node = nodeById.get(d.id);
  if (!node) return;
  const dx = snap((e.clientX - d.startX) / zoom);
  const dy = snap((e.clientY - d.startY) / zoom);
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

  // zoom: −  100%  +  (oraz Ctrl+scroll)
  const zoomGroup = document.createElement("div");
  zoomGroup.className = "tool-group";
  const zOut = document.createElement("button");
  zOut.className = "tool-btn";
  zOut.textContent = "−";
  zOut.title = T("Zoom.Out");
  zOut.onclick = () => setZoom(zoom / 1.25);
  const zLabel = document.createElement("button");
  zLabel.id = "zoom-label";
  zLabel.className = "tool-btn";
  zLabel.title = T("Zoom.Reset");
  zLabel.textContent = Math.round(zoom * 100) + "%";
  zLabel.onclick = () => setZoom(1);
  const zIn = document.createElement("button");
  zIn.className = "tool-btn";
  zIn.textContent = "+";
  zIn.title = T("Zoom.In");
  zIn.onclick = () => setZoom(zoom * 1.25);
  const zFit = document.createElement("button");
  zFit.className = "tool-btn";
  zFit.textContent = T("Zoom.Fit");
  zFit.title = T("Zoom.FitTip");
  zFit.onclick = () => fitZoom();
  zoomGroup.append(zOut, zLabel, zIn, zFit);
  host.appendChild(zoomGroup);

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
/** Zgłasza realny rozmiar powierzchni podglądu (px, bez paddingu) — host użyje go jako
 * fallbacku dla korzeni bez jawnego Width/Height zamiast sztywnego 1200×900. */
function reportViewport() {
  const sc = scrollEl();
  const w = Math.max(1, Math.round((sc.clientWidth - 48) / zoom));
  const h = Math.max(1, Math.round((sc.clientHeight - 48) / zoom));
  vscode.postMessage({ type: "viewport", width: w, height: h });
}

/** Wysyła widoczny prostokąt (jednostki projektu) do hosta — tryb „render widocznego obszaru". */
function sendViewbox() {
  if (!viewportRender || previewMode !== "wpf") return;
  const sc = scrollEl();
  const ze = zoomEl().getBoundingClientRect();
  const scR = sc.getBoundingClientRect();
  const margin = 100; // overscan w jednostkach projektu (zapas przy przewijaniu)
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
  const key = `${rx},${ry},${rw},${rh},${zoom.toFixed(3)}`;
  if (key === lastVbKey) return; // bez zmian → nie wysyłaj (unik pętli render→viewbox)
  // koalescencja: nie wysyłaj kolejnego wycinka, póki poprzedni render nie wrócił
  if (dragCoalesce && viewboxInFlight) {
    viewboxDirty = true;
    return;
  }
  lastVbKey = key;
  vscode.postMessage({ type: "viewbox", x: rx, y: ry, w: rw, h: rh, zoom });
  viewboxInFlight = true;
  viewboxDirty = false;
}
let viewboxPending = false;
let viewboxInFlight = false; // koalescencja: tylko 1 render wycinka „w locie"
let viewboxDirty = false; // jest nowszy stan czekający na wysłanie
let lastVbKey = ""; // ostatnio wysłany wycinek (unik pętli render→viewbox)
function scheduleViewbox() {
  if (!viewportRender || viewboxPending) return;
  viewboxPending = true;
  requestAnimationFrame(() => {
    viewboxPending = false;
    sendViewbox();
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

/** Ustawia transform skali i rozmiar sizera (paski przewijania odzwierciedlają zoom). */
function applyZoomTransform() {
  const ze = zoomEl();
  ze.style.transform = `scale(${zoom})`;
  const s = surfaceEl();
  const sizer = document.getElementById("zoom-sizer")!;
  sizer.style.width = Math.max(1, s.offsetWidth * zoom) + "px";
  sizer.style.height = Math.max(1, s.offsetHeight * zoom) + "px";
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
  scheduleViewbox();
}
function updateZoomLabel() {
  const el = document.getElementById("zoom-label");
  if (el) el.textContent = Math.round(zoom * 100) + "%";
}
/** Dopasowuje zoom tak, by cała powierzchnia zmieściła się w widoku. */
function fitZoom() {
  const s = surfaceEl();
  const sc = scrollEl();
  const sw = s.offsetWidth;
  const sh = s.offsetHeight;
  if (sw <= 0 || sh <= 0) return;
  const z = Math.min((sc.clientWidth - 48) / sw, (sc.clientHeight - 48) / sh);
  setZoom(z);
  sc.scrollLeft = 0;
  sc.scrollTop = 0;
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
  const topEl = document.getElementById("ruler-top")!;
  const leftEl = document.getElementById("ruler-left")!;
  const ze = zoomEl().getBoundingClientRect();
  // origin = ekranowa pozycja design-0 względem lewej/górnej krawędzi paska (po zoomie/scroll)
  const originX = ze.left - topEl.getBoundingClientRect().left;
  const originY = ze.top - leftEl.getBoundingClientRect().top;
  const topTicks = document.getElementById("ruler-top-ticks");
  const leftTicks = document.getElementById("ruler-left-ticks");
  if (topTicks) {
    topTicks.style.backgroundPositionX = `${originX}px, ${originX}px`;
    topTicks.style.backgroundSize = `${10 * zoom}px 5px, ${50 * zoom}px 10px`;
  }
  if (leftTicks) {
    leftTicks.style.backgroundPositionY = `${originY}px, ${originY}px`;
    leftTicks.style.backgroundSize = `5px ${10 * zoom}px, 10px ${50 * zoom}px`;
  }
  buildAxisLabels(document.getElementById("ruler-top-labels"), "x", originX);
  buildAxisLabels(document.getElementById("ruler-left-labels"), "y", originY);
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
function buildAxisLabels(host: HTMLElement | null, axis: "x" | "y", origin: number) {
  if (!host) return;
  const length = axis === "x" ? host.clientWidth : host.clientHeight;
  host.innerHTML = "";
  if (length <= 0) return;
  // etykiety co RULER_MAJOR jednostek PROJEKTU; pozycja ekranowa = origin + c*zoom
  const startC = Math.ceil((2 - origin) / zoom / RULER_MAJOR) * RULER_MAJOR;
  const endC = Math.floor((length - 2 - origin) / zoom / RULER_MAJOR) * RULER_MAJOR;
  for (let c = startC; c <= endC; c += RULER_MAJOR) {
    const p = origin + c * zoom;
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

// linijki: klik w pasek = utwórz prowadnicę i od razu ją przeciągaj;
// klik w istniejący znacznik = przeciągaj go; podwójny klik = usuń.
function rulerMouseDown(axis: "x" | "y", e: MouseEvent) {
  e.preventDefault();
  const marker = (e.target as HTMLElement).closest<HTMLElement>(".ruler-guide");
  if (marker) {
    guideDrag = Number(marker.dataset.gi);
  } else {
    const d = clientToDesign(e.clientX, e.clientY);
    guides.push({ axis, pos: snap(axis === "x" ? d.x : d.y) });
    guideDrag = guides.length - 1;
  }
  renderGuides();
  updateRulers();
}
function rulerDblRemove(e: MouseEvent) {
  const m = (e.target as HTMLElement).closest<HTMLElement>(".ruler-guide");
  if (!m) return;
  guides.splice(Number(m.dataset.gi), 1);
  renderGuides();
  updateRulers();
  renderProps();
}
document.getElementById("ruler-top")!.addEventListener("mousedown", (e) => rulerMouseDown("x", e));
document.getElementById("ruler-left")!.addEventListener("mousedown", (e) => rulerMouseDown("y", e));
document.getElementById("ruler-top")!.addEventListener("dblclick", rulerDblRemove);
document.getElementById("ruler-left")!.addEventListener("dblclick", rulerDblRemove);

// przeciąganie / usuwanie prowadnic na powierzchni
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
  updateRulers();
  renderProps();
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
  // tryb PNG: selekcja przez hit-test + start przeciągania (podgląd wg strategii z ustawień)
  if (previewMode === "wpf" && hostPng) {
    const d = clientToDesign(e.clientX, e.clientY);
    const id = hitTestRects(d.x, d.y);
    if (id === null) return;
    e.preventDefault();
    if (id !== selectedId) {
      select(id);
      setStatus();
    }
    if (tree && id !== tree.id) startMove(e, id);
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
    updateRulers();
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
  if (guideDrag !== null) {
    guideDrag = null;
    updateRulers(); // zdejmij podświetlenie „dragging"
    renderProps(); // odśwież liczby w sekcji Prowadnice
  }
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
  scheduleViewbox();
});
// Ctrl + kółko = zoom z zakotwiczeniem na kursorze
document.getElementById("surface-scroll")!.addEventListener(
  "wheel",
  (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    setZoom(zoom * factor, e.clientX, e.clientY);
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
    updateOverlay();
    drawDecorations();
    reportViewport();
  });
}
window.addEventListener("resize", scheduleDecorations);
const viewport = document.getElementById("preview-viewport");
if (viewport && typeof ResizeObserver !== "undefined") {
  new ResizeObserver(scheduleDecorations).observe(viewport);
}
buildHandles();
requestAnimationFrame(reportViewport);

window.addEventListener("message", (e) => {
  const msg = e.data;
  switch (msg.type) {
    case "init":
      l10n = msg.l10n ?? {};
      isWindows = !!msg.isWindows;
      backend = msg.backend ?? "auto";
      applyStaticL10n();
      buildToolbar();
      buildPreviewTools();
      break;
    case "clipboard":
      clipboardXml = msg.xml ?? null;
      break;
    case "render":
      hostPng = msg.png ?? null;
      hostW = msg.width ?? 0;
      hostH = msg.height ?? 0;
      hostVx = msg.vx ?? 0;
      hostVy = msg.vy ?? 0;
      hostVw = msg.vw ?? hostW;
      hostVh = msg.vh ?? hostH;
      hostRects.clear();
      for (const r of msg.rects ?? []) {
        const id = parseInt(String(r.uid).slice(1), 10);
        if (!isNaN(id)) hostRects.set(id, { x: r.x, y: r.y, w: r.w, h: r.h });
      }
      // klatka wróciła → zwolnij „in-flight" i ewentualnie wyślij najnowszy stan
      renderInFlight = false;
      viewboxInFlight = false;
      if (viewboxDirty && !drag) sendViewbox(); // dosyłka najświeższego wycinka
      if (drag) {
        trySendDragFrame(performance.now());
        // podczas drag nie przebudowujemy całego podglądu (overlay już jedzie),
        // ale przy aktywnym renderze w trybie PNG odśwież obraz
        if (previewMode === "wpf") renderPreview();
      } else if (previewMode === "wpf") {
        renderPreview();
      }
      break;
    case "renderError":
      renderInFlight = false;
      viewboxInFlight = false;
      hostPng = null; // spadek na renderer web
      renderPreview();
      setStatus();
      break;
    case "doc": {
      tree = msg.tree;
      changed = msg.changed ?? {};
      const prevMode = previewMode;
      previewMode = msg.previewMode === "wpf" ? "wpf" : "web";
      if (previewMode === "web" && prevMode !== "web") hostPng = null;
      changesData = msg.changes ?? [];
      updateChangesBadge();
      if (viewMode === "changes") renderChanges();
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
