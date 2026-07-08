// Warstwa zastosowania zasobów/stylów w rendererze web.
//
// Trzyma stan rozwiązanych zasobów na czas renderu i udostępnia rendererowi:
//   • effectiveAttrs(node) — atrybuty po nałożeniu stylów (implicit + nazwany + BasedOn),
//     z zachowaniem priorytetu: inline zawsze wygrywa,
//   • lookupBrushColor / resolveBrushRef — rozwiązanie {Static/DynamicResource} na kolor/obraz,
//   • plainText — re-eksport (markupy bez danych → "").
//
// Logika czysta (indeks, łańcuch BasedOn) żyje w src/core/ResourceModel — tu tylko stan + DOM-agnostyczne API.

import {
  buildStyleIndex,
  resolveStyleSetters,
  resourceKey,
  localName,
  plainText,
  isMarkup,
  locKey,
  fallbackValue,
  type StyleIndex,
  type ResourceModel,
} from "../src/core/ResourceModel.ts";

export { plainText, resourceKey };

/** Lekki widok węzła wystarczający do scalenia stylów (bez zależności od RenderNode). */
interface AttrNode {
  tag: string;
  attributes: { name: string; value: string }[];
}

let styleIndex: StyleIndex | null = null;
let resBrushes: Record<string, string> = {}; // klucz → KOLOR CSS (już skonwertowany przez renderer)
let resBrushImages: Record<string, string> = {}; // klucz → URI obrazu
let resStrings: Record<string, string> = {}; // klucz lokalizacji (resx) → tekst

/**
 * Ustawia zasoby na czas renderu. `brushesCss` to kolory JUŻ skonwertowane na CSS (renderer
 * woła cssColor na surowych wartościach z modelu — unikamy cyklu importów).
 */
export function setResources(
  model: ResourceModel | null,
  brushesCss: Record<string, string>,
  brushImages: Record<string, string>
): void {
  styleIndex = model ? buildStyleIndex(model.styles) : null;
  resBrushes = brushesCss;
  resBrushImages = brushImages;
  resStrings = model?.strings ?? {};
}

/**
 * Tekst do wyświetlenia z wartości atrybutu, z rozwiązaniem markupów:
 *   • literał / escape {} → jak jest,
 *   • {helpers:Loc Key} → tekst z resx (parytet z WPF; brak klucza → sam klucz, jak TranslationSource),
 *   • {Binding …, FallbackValue=X} → X (WPF pokazuje fallback gdy brak danych),
 *   • inne {Binding …} bez danych → "" (wartość runtime niedostępna w podglądzie).
 */
export function resolveText(raw: string | undefined): string {
  if (raw === undefined) return "";
  if (!isMarkup(raw)) return plainText(raw);
  const key = locKey(raw);
  if (key !== null) {
    if (key in resStrings) return resStrings[key];
    return Object.keys(resStrings).length ? key : ""; // resx wczytany → parytet WPF (klucz); brak → puste
  }
  const fb = fallbackValue(raw);
  return fb ?? "";
}

/** Kolor CSS dla klucza zasobu pędzla (lub undefined). */
export function lookupBrushColor(key: string): string | undefined {
  return resBrushes[key];
}

/** Rozwiązuje wartość pędzlową: {Static/DynamicResource K} → {image} lub {color}; inne → {}. */
export function resolveBrushRef(raw: string | undefined): { color?: string; image?: string } {
  const key = resourceKey(raw);
  if (!key) return {};
  if (resBrushImages[key]) return { image: resBrushImages[key] };
  if (resBrushes[key]) return { color: resBrushes[key] };
  return {};
}

/**
 * Atrybuty efektywne: settery stylu (implicit lub Style="{StaticResource …}" + BasedOn)
 * scalone z atrybutami inline (inline wygrywa). Bez zasobów → same atrybuty inline.
 */
export function effectiveAttrs(n: AttrNode): Map<string, string> {
  const inline = new Map<string, string>();
  for (const a of n.attributes) inline.set(a.name, a.value);
  if (!styleIndex) return inline;
  const styleVal = inline.get("Style");
  const key = styleVal ? resourceKey(styleVal) ?? undefined : undefined;
  const setters = resolveStyleSetters(styleIndex, { type: localName(n.tag), key });
  const keys = Object.keys(setters);
  if (!keys.length) return inline;
  const merged = new Map<string, string>();
  for (const k of keys) merged.set(k, setters[k]);
  for (const [k, v] of inline) merged.set(k, v); // inline > styl
  return merged;
}
