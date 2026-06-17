// Web renderer subsetu XAML → DOM (Etap 1, cross-platform backend podglądu).
//
// Mapuje drzewo elementów na pozycjonowane elementy HTML. Każdy węzeł dostaje
// `data-xve-id`, dzięki czemu klik w podglądzie ↔ zaznaczenie w drzewie. To nie jest
// wierny silnik WPF — to dobrze udokumentowany subset; nieznane typy renderują się jako
// opisany placeholder (do pełnej wierności służy backend WPF host na Windows — Etap 5).

export interface RenderNode {
  id: number;
  tag: string;
  attributes: { name: string; value: string }[];
  children: RenderNode[];
}

type Layout = "grid" | "canvas" | "stack-v" | "stack-h" | "flow";

function attrMap(n: RenderNode): Map<string, string> {
  const m = new Map<string, string>();
  for (const a of n.attributes) m.set(a.name, a.value);
  return m;
}

function localName(tag: string): string {
  const i = tag.indexOf(":");
  return i >= 0 ? tag.slice(i + 1) : tag;
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

function applyCommon(el: HTMLElement, a: Map<string, string>) {
  const fs = num(a.get("FontSize"));
  if (fs) el.style.fontSize = fs + "px";
  const fw = a.get("FontWeight");
  if (fw) el.style.fontWeight = /bold/i.test(fw) ? "bold" : fw.toLowerCase();
  const ff = a.get("FontFamily");
  if (ff) el.style.fontFamily = ff;
  const fg = cssColor(a.get("Foreground"));
  if (fg) el.style.color = fg;
  const op = num(a.get("Opacity"));
  if (op !== undefined) el.style.opacity = String(op);
  const ta = a.get("TextAlignment") || a.get("HorizontalContentAlignment");
  if (ta) el.style.textAlign = ta.toLowerCase();
  if (a.get("Visibility") === "Collapsed") el.style.display = "none";
  if (a.get("Visibility") === "Hidden") el.style.visibility = "hidden";
}

/** Pozycjonuje wrapper w kontekście layoutu rodzica (Margin / alignment / Canvas.*). */
function positionInParent(el: HTMLElement, a: Map<string, string>, parent: Layout) {
  const [ml, mt, mr, mb] = thickness(a.get("Margin"));
  const w = num(a.get("Width"));
  const h = num(a.get("Height"));
  if (w !== undefined) el.style.width = w + "px";
  if (h !== undefined) el.style.height = h + "px";

  if (parent === "stack-v" || parent === "stack-h" || parent === "flow") {
    el.style.margin = `${mt}px ${mr}px ${mb}px ${ml}px`;
    const ha = a.get("HorizontalAlignment");
    const va = a.get("VerticalAlignment");
    if (parent === "stack-v" && ha) el.style.alignSelf = mapAlign(ha);
    if (parent === "stack-h" && va) el.style.alignSelf = mapAlign(va);
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
    case "DockPanel":
      return "flow";
    default:
      return "grid";
  }
}

/** Renderuje pojedynczy węzeł; zwraca wrapper z `data-xve-id`. */
function renderNode(n: RenderNode, parent: Layout): HTMLElement {
  const a = attrMap(n);
  const name = localName(n.tag);
  const el = document.createElement("div");
  el.className = "xve-el";
  el.dataset.xveId = String(n.id);
  positionInParent(el, a, parent);
  applyCommon(el, a);

  // tło / obramowanie wspólne dla kontenerów i kontrolek
  const bg = cssColor(a.get("Background"));
  if (bg) el.style.background = bg;
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
      el.style.background = bg || "#ffffff";
      el.style.color = el.style.color || "#000";
      renderChildren(el, n, "grid");
      return el;
    }
    case "Grid":
    case "Border":
    case "Viewbox":
    case "ScrollViewer":
      renderChildren(el, n, mine);
      return el;
    case "Canvas":
      renderChildren(el, n, "canvas");
      return el;
    case "StackPanel":
    case "WrapPanel":
    case "DockPanel":
      el.style.display = "flex";
      el.style.flexDirection = mine === "stack-h" ? "row" : "column";
      if (mine === "flow") el.style.flexWrap = "wrap";
      renderChildren(el, n, mine);
      return el;
    case "TextBlock":
    case "Label":
      el.textContent = a.get("Text") ?? a.get("Content") ?? "";
      el.classList.add("xve-text");
      return el;
    case "Button": {
      el.classList.add("xve-control", "xve-button");
      el.textContent = a.get("Content") ?? "";
      return el;
    }
    case "TextBox": {
      el.classList.add("xve-control", "xve-textbox");
      el.textContent = a.get("Text") ?? "";
      return el;
    }
    case "CheckBox":
    case "RadioButton": {
      el.classList.add("xve-control", "xve-check");
      const box = document.createElement("span");
      box.className = "xve-checkbox";
      if (/true/i.test(a.get("IsChecked") || "")) box.classList.add("checked");
      if (name === "RadioButton") box.classList.add("radio");
      const lbl = document.createElement("span");
      lbl.textContent = a.get("Content") ?? "";
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
      const thumb = document.createElement("div");
      thumb.className = "xve-slider-thumb";
      thumb.style.left = pct + "%";
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
      if (src) {
        const img = document.createElement("img");
        img.src = src;
        img.style.width = "100%";
        img.style.height = "100%";
        img.style.objectFit = "contain";
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
    default: {
      // nieznany typ → placeholder, ale renderuj dzieci (mógł być kontenerem)
      el.classList.add("xve-placeholder");
      if (n.children.length) renderChildren(el, n, mine);
      else el.textContent = name;
      return el;
    }
  }
}

function renderChildren(host: HTMLElement, n: RenderNode, layout: Layout) {
  for (const c of n.children) host.appendChild(renderNode(c, layout));
}

/** Buduje całe drzewo do podanego kontenera (#surface). Zwraca root element lub null. */
export function renderTreeToDom(root: RenderNode | null, surface: HTMLElement): void {
  surface.innerHTML = "";
  if (!root) return;
  surface.appendChild(renderNode(root, "grid"));
}
