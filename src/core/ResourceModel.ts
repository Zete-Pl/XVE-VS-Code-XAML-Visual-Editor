// Model zasobów XAML dla renderera web (Etap: wierniejszy podgląd web).
//
// Renderer web sam z siebie ignoruje `*.Resources`, `Style`, `{StaticResource}` i
// `{DynamicResource}`. Ten moduł wyciąga z XAML-a (pliku, App.xaml, słownika motywu)
// SERIALIZOWALNY podzbiór zasobów, który da się odwzorować na CSS:
//   • pędzle kolorowe (SolidColorBrush) i obrazowe (ImageBrush),
//   • style z prostymi setterami właściwości (bez ControlTemplate i triggerów),
//     z zachowaniem łańcucha BasedOn i stylów domyślnych (implicit, TargetType bez klucza).
//
// To celowo „dobry subset", nie silnik WPF. ControlTemplate/triggery/animacje oraz
// kontrolki z DLL pozostają domeną hosta WPF — tu degradujemy się łagodnie.
//
// Moduł jest CZYSTY (bez fs/vscode/DOM): używany zarówno po stronie rozszerzenia
// (budowa modelu z plików) jak i w webview (indeks + scalanie setterów).

import { XamlParser } from "./XamlParser.ts";
import type { XamlNode } from "./XamlParser.ts";

/** Styl XAML zredukowany do prostych setterów (mapowalnych na CSS). */
export interface StyleDef {
  /** x:Key stylu (brak = styl domyślny / implicit dla TargetType) */
  key?: string;
  /** lokalna nazwa TargetType, np. "Button" */
  targetType: string;
  /** BasedOn wskazujący na styl po kluczu (np. {StaticResource GhostButtonStyle}) */
  basedOnKey?: string;
  /** BasedOn wskazujący na styl domyślny typu (np. {StaticResource {x:Type Button}}) */
  basedOnType?: string;
  /** proste settery: nazwa właściwości → wartość (surowa, może być {DynamicResource …}) */
  setters: Record<string, string>;
}

/** Serializowalny model zasobów przekazywany do webview w komunikacie `doc`. */
export interface ResourceModel {
  /** klucz → surowa wartość koloru WPF (np. "#1C7ED6"); konwersję na CSS robi renderer */
  brushes: Record<string, string>;
  /** klucz → ścieżka/URI obrazu (ImageBrush); rozszerzenie rozwiązuje ścieżki na webview-URI */
  brushImages: Record<string, string>;
  styles: StyleDef[];
  /** lokalizacja: klucz zasobu (resx) → tekst; do rozwiązania markupów typu {helpers:Loc Key} */
  strings: Record<string, string>;
}

/** Indeks stylów zbudowany w webview (Mapy — nieserializowalne). */
export interface StyleIndex {
  byKey: Map<string, StyleDef>;
  implicitByType: Map<string, StyleDef>;
}

/** Pozycja zasobu projektu do listy wyboru w okienku „Project resources". */
export interface ResourceStateItem {
  path: string;
  label: string;
  kind: "dll" | "appResources" | "resourceDict";
  selected: boolean;
}

/** Wspólny stan zasobów (web + WPF) dla UI: okienko wyboru, log, kropka statusu. */
export interface ResourceState {
  engine: "web" | "wpf";
  /** cokolwiek aktywne (App.xaml/motyw/resx lub zasoby hosta) → niebieski pierścień na kropce */
  loaded: boolean;
  /** czytelne podsumowanie tego, co jest aktywne */
  summary: string;
  /** pozycje do checklisty (z scanProject + zapis selekcji) */
  items: ResourceStateItem[];
  /** wykryte warianty językowe resx (+ neutralny); pusty gdy projekt nie ma resx */
  languages: { value: string; label: string }[];
  /** aktywny język resx (klucz z `languages`) */
  language: string;
  /** WPF: wymuś kulturę przez refleksję (TranslationSource.Instance.CurrentCulture w DLL projektu) */
  reflectCulture: boolean;
  /** host współdzielony zajęty przez inny plik (zasoby z innego okna wpływają na ten render) */
  sharedByOther: { name: string } | null;
}

/**
 * Z nazw plików `Properties/Resources*.resx` buduje listę języków: neutralny (Resources.resx)
 * + warianty kulturowe (np. `Resources.pl.resx` → "pl", `Resources.zh-Hans.resx` → "zh-Hans").
 */
export function resxLanguagesFromNames(names: string[]): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  let hasNeutral = false;
  const cultures: string[] = [];
  for (const n of names) {
    const m = n.match(/^Resources(?:\.([A-Za-z]{2,3}(?:-[A-Za-z0-9]+)*))?\.resx$/);
    if (!m) continue;
    if (m[1]) cultures.push(m[1]);
    else hasNeutral = true;
  }
  if (hasNeutral) out.push({ value: "", label: "(neutral)" });
  cultures.sort((a, b) => a.localeCompare(b));
  for (const c of cultures) out.push({ value: c, label: c });
  return out;
}

/** Właściwości, które renderer web potrafi odwzorować na CSS — tylko te trzymamy w setterach. */
const SIMPLE_SETTERS = new Set<string>([
  "Width", "Height", "MinWidth", "MinHeight", "MaxWidth", "MaxHeight",
  "Margin", "Padding",
  "Background", "Foreground", "BorderBrush", "BorderThickness", "CornerRadius",
  "FontSize", "FontWeight", "FontStyle", "FontFamily",
  "Opacity", "Visibility",
  "HorizontalAlignment", "VerticalAlignment",
  "HorizontalContentAlignment", "VerticalContentAlignment",
  "TextAlignment",
]);

/** Lokalna nazwa znacznika/typu bez prefiksu namespace. */
export function localName(tag: string): string {
  const i = tag.indexOf(":");
  return i >= 0 ? tag.slice(i + 1) : tag;
}

/** Czy wartość atrybutu to markup-extension WPF (np. {Binding …}, {StaticResource …}). */
export function isMarkup(v: string | undefined): boolean {
  return !!v && v.trimStart().startsWith("{") && !v.trimStart().startsWith("{}");
}

/**
 * Tekst do wyświetlenia: markupy bez danych ({Binding}, {helpers:Loc …}) → "" (nie literał).
 * Escape `{}Literal` (WPF) → zwraca samą resztę.
 */
export function plainText(v: string | undefined): string {
  if (v === undefined) return "";
  const s = v.trimStart();
  if (s.startsWith("{}")) return s.slice(2);
  if (s.startsWith("{")) return "";
  return v;
}

/**
 * Klucz zasobu z {StaticResource K} / {DynamicResource K}; null dla innych markupów/literałów.
 * Zwraca też zagnieżdżony {x:Type T} jako "{x:Type T}" (rozróżniany wyżej w resolveStyleSetters).
 */
export function resourceKey(v: string | undefined): string | null {
  if (!v) return null;
  const m = v.trim().match(/^\{\s*(?:Static|Dynamic)Resource\s+(.+?)\s*\}$/);
  return m ? m[1].trim() : null;
}

/** Wyciąga lokalną nazwę typu z TargetType/BasedOn: "Button" lub "{x:Type Button}". */
function typeFromTypeRef(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const m = v.trim().match(/^\{\s*x:Type\s+(.+?)\s*\}$/);
  return localName((m ? m[1] : v).trim());
}

function attr(n: XamlNode, name: string): string | undefined {
  return n.attributes.find((a) => a.name === name)?.value;
}

/** Czy węzeł jest bezpośrednio w słowniku zasobów (`*.Resources` lub `ResourceDictionary`). */
function isInResourceHolder(n: XamlNode): boolean {
  const p = n.parent;
  if (!p || p.kind !== "element" || !p.tag) return false;
  const t = p.tag;
  return localName(t) === "ResourceDictionary" || t.endsWith(".Resources");
}

/** Pierwszy potomek-element spełniający predykat (przeszukiwanie w głąb, w kolejności dokumentu). */
function findDescendant(n: XamlNode, pred: (e: XamlNode) => boolean): XamlNode | null {
  for (const c of n.children) {
    if (c.kind !== "element") continue;
    if (pred(c)) return c;
    const d = findDescendant(c, pred);
    if (d) return d;
  }
  return null;
}

/**
 * Przybliżenie „chrome" z ControlTemplate: z pierwszego `<Border>` szablonu wyciąga literalne/zasobowe
 * CornerRadius/Background/BorderBrush/BorderThickness/Padding. Pomija `{TemplateBinding …}` (mapuje się na
 * właściwości kontrolki, zbierane osobno). To świadome przybliżenie — nie pełny silnik szablonów.
 */
function templateChrome(setterNode: XamlNode): Record<string, string> {
  const out: Record<string, string> = {};
  const border = findDescendant(setterNode, (e) => localName(e.tag ?? "") === "Border");
  if (!border) return out;
  for (const p of ["CornerRadius", "Background", "BorderBrush", "BorderThickness", "Padding"]) {
    const v = attr(border, p);
    if (v === undefined || /^\{\s*TemplateBinding\b/.test(v.trim())) continue;
    out[p] = v;
  }
  return out;
}

/** Buduje StyleDef z węzła <Style> (proste settery + przybliżenie chrome z ControlTemplate). */
function parseStyle(n: XamlNode): StyleDef | null {
  const targetType = typeFromTypeRef(attr(n, "TargetType"));
  if (!targetType) return null;
  const basedOnRaw = attr(n, "BasedOn");
  const def: StyleDef = { targetType, setters: {} };
  const key = attr(n, "x:Key");
  if (key && !/\{x:(Static|Type)/.test(key)) def.key = key;
  if (basedOnRaw) {
    const bKey = resourceKey(basedOnRaw); // {StaticResource X} → X (X może być {x:Type T})
    if (bKey) {
      const asType = typeFromTypeRef(bKey);
      if (/^\{\s*x:Type/.test(bKey)) def.basedOnType = asType;
      else def.basedOnKey = bKey;
    }
  }
  let chrome: Record<string, string> = {};
  for (const c of n.children) {
    if (c.kind !== "element" || localName(c.tag ?? "") !== "Setter") continue;
    const prop = attr(c, "Property");
    const val = attr(c, "Value"); // forma atrybutowa; Setter.Value (np. Template) nie ma atrybutu Value
    if (!prop) continue;
    const p = localName(prop);
    if (val !== undefined && SIMPLE_SETTERS.has(p)) def.setters[p] = val;
    else if (p === "Template" && val === undefined) chrome = templateChrome(c); // przybliżenie z szablonu
  }
  // syntetyczne settery z szablonu — tylko gdy brak realnego settera tej właściwości (realny ma priorytet)
  for (const [k, v] of Object.entries(chrome)) if (!(k in def.setters)) def.setters[k] = v;
  return def;
}

/**
 * Wyciąga zasoby z surowego XAML-a (plik, App.xaml lub słownik motywu).
 * Zbiera tylko węzły bezpośrednio w słownikach zasobów, więc style/pędzle zdefiniowane
 * wewnątrz ControlTemplate/DataTemplate nie zanieczyszczają modelu.
 */
export function extractResources(text: string): ResourceModel {
  const model: ResourceModel = { brushes: {}, brushImages: {}, styles: [], strings: {} };
  const { roots } = new XamlParser(text).parse();
  const visit = (n: XamlNode) => {
    if (n.kind === "element" && n.tag) {
      const name = localName(n.tag);
      if (isInResourceHolder(n)) {
        const key = attr(n, "x:Key");
        if (name === "SolidColorBrush" && key && !key.includes("{")) {
          const color = attr(n, "Color");
          if (color) model.brushes[key] = color;
        } else if (name === "ImageBrush" && key && !key.includes("{")) {
          const src = attr(n, "ImageSource");
          if (src) model.brushImages[key] = src;
        } else if (name === "Style") {
          const s = parseStyle(n);
          if (s) model.styles.push(s);
        }
      }
    }
    for (const c of n.children) visit(c);
  };
  for (const r of roots) visit(r);
  return model;
}

/** Scala wiele modeli (kolejność = rosnący priorytet: późniejsze nadpisują wcześniejsze). */
export function mergeModels(...models: ResourceModel[]): ResourceModel {
  const out: ResourceModel = { brushes: {}, brushImages: {}, styles: [], strings: {} };
  for (const m of models) {
    Object.assign(out.brushes, m.brushes);
    Object.assign(out.brushImages, m.brushImages);
    Object.assign(out.strings, m.strings);
    out.styles.push(...m.styles);
  }
  return out;
}

/**
 * Parsuje plik .resx (.NET) na mapę klucz→tekst. Bierze tylko wpisy łańcuchowe
 * (`<data name="K"><value>…</value></data>` bez atrybutu type/mimetype — pomija obrazy/binaria).
 */
export function parseResx(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /<data\b([^>]*)>\s*<value>([\s\S]*?)<\/value>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const attrs = m[1];
    if (/\b(?:type|mimetype)\s*=/.test(attrs)) continue; // nie-tekstowy zasób (obraz/binarne)
    const nameM = attrs.match(/\bname\s*=\s*"([^"]+)"/);
    if (!nameM) continue;
    out[nameM[1]] = decodeXmlText(m[2]);
  }
  return out;
}

/** Dekoduje podstawowe encje XML w treści tekstowej (resx). */
function decodeXmlText(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&");
}

/** Klucz lokalizacji z markupu typu {helpers:Loc Key} / {Loc Key=Foo} / {PreviewLoc Foo}; null gdy to nie Loc. */
export function locKey(v: string | undefined): string | null {
  if (!v) return null;
  const m = v.trim().match(/^\{\s*[\w.:]*Loc\s+(?:Key\s*=\s*)?([^,}]+?)\s*(?:,[^}]*)?\}$/);
  return m ? m[1].trim() : null;
}

/** Wartość FallbackValue z dowolnego bindingu (WPF pokazuje ją, gdy brak danych); null gdy brak. */
export function fallbackValue(v: string | undefined): string | null {
  if (!v) return null;
  const m = v.match(/\bFallbackValue\s*=\s*([^,}]+)/);
  return m ? m[1].trim() : null;
}

/** Indeksuje style po kluczu i po typie (ostatni implicit dla typu wygrywa). */
export function buildStyleIndex(styles: StyleDef[]): StyleIndex {
  const byKey = new Map<string, StyleDef>();
  const implicitByType = new Map<string, StyleDef>();
  for (const s of styles) {
    if (s.key) byKey.set(s.key, s);
    else implicitByType.set(s.targetType, s);
  }
  return { byKey, implicitByType };
}

/** Rozwija settery jednego stylu wraz z łańcuchem BasedOn (BasedOn jako baza, własne nadpisują). */
function resolveOne(index: StyleIndex, style: StyleDef, seen: Set<StyleDef>): Record<string, string> {
  if (seen.has(style)) return {};
  seen.add(style);
  let base: Record<string, string> = {};
  const parent = style.basedOnKey
    ? index.byKey.get(style.basedOnKey)
    : style.basedOnType
      ? index.implicitByType.get(style.basedOnType)
      : undefined;
  if (parent) base = resolveOne(index, parent, seen);
  return { ...base, ...style.setters };
}

/**
 * Efektywne settery dla węzła: gdy ma Style="{StaticResource K}" → ten styl (z BasedOn);
 * w przeciwnym razie styl domyślny (implicit) dla typu. Zgodnie z WPF styl jawny NIE łączy
 * się dodatkowo z implicit (chyba że wskazuje go przez BasedOn).
 */
export function resolveStyleSetters(index: StyleIndex, opts: { type: string; key?: string }): Record<string, string> {
  const style = opts.key ? index.byKey.get(opts.key) : index.implicitByType.get(opts.type);
  if (!style) return {};
  return resolveOne(index, style, new Set());
}
