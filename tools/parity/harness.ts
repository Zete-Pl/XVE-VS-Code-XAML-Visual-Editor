// Harness przeglądarkowy dla testera parzystości web↔WPF.
//
// Bundlowany esbuildem (browser/IIFE) do dist/parity-harness.js i ładowany w headless Chromium
// przez tools/parity/web-runner.ts. Wystawia globalne window.xveMeasure(xamlText, opts), które
// renderuje XAML tym samym pipeline'em co webview (XamlDocument.toTree + extractResources +
// renderTreeToDom) i zwraca zmierzony układ każdego elementu (getBoundingClientRect) względem
// lewego-górnego rogu #surface — w tych samych jednostkach (logical px) co prostokąty hosta WPF.
//
// Parsowanie odbywa się w przeglądarce z TEGO SAMEGO tekstu, którego Node używa do toHostXaml(),
// więc id węzłów (nadawane przez XamlParser w kolejności dokumentu) są identyczne po obu stronach
// i join „web ↔ WPF" po id jest pewny.

import { XamlDocument } from "../../src/core/XamlDocument.ts";
import { extractResources } from "../../src/core/ResourceModel.ts";
import { renderTreeToDom, type RenderNode } from "../../webview/renderer.ts";

export interface WebRect {
  id: number;
  tag: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface MeasureOpts {
  /** Klasa motywu nadawana na #surface (parność z motywem hosta). Domyślnie classic. */
  themeClass?: string;
  /** Kultura podglądu (jak parametr `culture` hosta) — undefined = locale przeglądarki. */
  culture?: string;
}

declare global {
  interface Window {
    xveMeasure: (xamlText: string, opts?: MeasureOpts) => WebRect[];
  }
}

function tagById(root: RenderNode | null): Map<number, string> {
  const m = new Map<number, string>();
  const walk = (n: RenderNode) => {
    m.set(n.id, n.tag);
    for (const c of n.children) walk(c);
  };
  if (root) walk(root);
  return m;
}

window.xveMeasure = (xamlText: string, opts: MeasureOpts = {}): WebRect[] => {
  const surface = document.getElementById("surface")!;
  // Motyw: ta sama klasa co w prawdziwym webview — main.ts ZAWSZE nadaje klasę motywu
  // (dla „none"/classic → xve-theme-classic), więc harness też, inaczej reguły
  // `#surface.xve-theme-classic …` (metryki kontrolek classic) by nie zadziałały.
  surface.className = "";
  surface.classList.add(opts.themeClass ?? "xve-theme-classic");

  const tree = new XamlDocument(xamlText).toTree() as RenderNode | null;
  const resources = extractResources(xamlText);
  renderTreeToDom(tree, surface, { resources, zoom: 1, culture: opts.culture });

  const tags = tagById(tree);
  const base = surface.getBoundingClientRect();
  const out: WebRect[] = [];
  surface.querySelectorAll<HTMLElement>("[data-xve-id]").forEach((el) => {
    const id = Number(el.dataset.xveId);
    const r = el.getBoundingClientRect();
    // elementy niewidoczne (Visibility=Collapsed → display:none) mają 0×0 — host w ogóle ich
    // nie raportuje, więc pomijamy, by nie zaśmiecały diffu jako „tylko w web"
    if (r.width === 0 && r.height === 0) return;
    out.push({
      id,
      tag: tags.get(id) ?? el.tagName.toLowerCase(),
      x: r.left - base.left,
      y: r.top - base.top,
      w: r.width,
      h: r.height,
    });
  });
  return out;
};
