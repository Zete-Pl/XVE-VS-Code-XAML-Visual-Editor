// Port lekkiej lokalizacji z Localization.cs (aplikacja WPF).
// Stała kolejność języków: [en, pl, es, de, fr, ja, zh]. Brakujący wpis → angielski.
// W Etapie 0 portujemy podzbiór kluczy; kolejne dochodzą wraz z funkcjami.

export const LANGUAGES: { code: string; nativeName: string }[] = [
  { code: "en", nativeName: "English" },
  { code: "pl", nativeName: "Polski" },
  { code: "es", nativeName: "Español" },
  { code: "de", nativeName: "Deutsch" },
  { code: "fr", nativeName: "Français" },
  { code: "ja", nativeName: "日本語" },
  { code: "zh", nativeName: "中文" },
];

// [en, pl, es, de, fr, ja, zh]
const MAP: Record<string, string[]> = {
  "View.Structure": ["Structure", "Struktura", "Estructura", "Struktur", "Structure", "構造", "结构"],
  "View.Properties": ["Properties", "Właściwości", "Propiedades", "Eigenschaften", "Propriétés", "プロパティ", "属性"],
  "View.Preview": ["Preview", "Podgląd", "Vista previa", "Vorschau", "Aperçu", "プレビュー", "预览"],
  "View.Source": ["Source", "Źródło", "Código", "Quelltext", "Source", "ソース", "源代码"],
  "View.NoSelection": ["No element selected", "Nie wybrano elementu", "Ningún elemento seleccionado", "Kein Element ausgewählt", "Aucun élément sélectionné", "要素が選択されていません", "未选择元素"],
  "Prop.Add": ["Add property…", "Dodaj właściwość…", "Agregar propiedad…", "Eigenschaft hinzufügen…", "Ajouter une propriété…", "プロパティを追加…", "添加属性…"],
  "Prop.Remove": ["Remove property", "Usuń właściwość", "Quitar propiedad", "Eigenschaft entfernen", "Supprimer la propriété", "プロパティを削除", "删除属性"],
  "Prop.Revert": ["Revert to saved value", "Przywróć zapisaną wartość", "Revertir al valor guardado", "Auf gespeicherten Wert zurücksetzen", "Rétablir la valeur enregistrée", "保存値に戻す", "还原为已保存的值"],
  "Status.ParsedElements": ["{0} elements", "{0} elementów", "{0} elementos", "{0} Elemente", "{0} éléments", "{0} 個の要素", "{0} 个元素"],
  "Status.PreviewSoon": [
    "Visual preview arrives in stage 1 — structure & source available now",
    "Podgląd wizualny w etapie 1 — na razie struktura i źródło",
    "La vista previa visual llega en la etapa 1 — estructura y código disponibles",
    "Visuelle Vorschau folgt in Stufe 1 — Struktur und Quelltext verfügbar",
    "L'aperçu visuel arrive à l'étape 1 — structure et source disponibles",
    "ビジュアルプレビューはステージ1で — 現在は構造とソース",
    "可视化预览将在第 1 阶段提供 — 当前可用结构与源代码",
  ],
};

let langIndex = 0;

/** Ustawia język po kodzie; pusty/nieznany = pierwszy z `fallbackChain` lub angielski. */
export function applyLanguage(code: string | undefined, fallbackChain: string[] = []): void {
  const candidates = [code, ...fallbackChain].filter(Boolean) as string[];
  for (const c of candidates) {
    const idx = LANGUAGES.findIndex((l) => l.code === c);
    if (idx >= 0) {
      langIndex = idx;
      return;
    }
  }
  langIndex = 0;
}

export function t(key: string): string {
  const v = MAP[key];
  if (!v) return key;
  const s = langIndex < v.length ? v[langIndex] : "";
  return s.length > 0 ? s : v[0];
}

export function f(key: string, ...args: unknown[]): string {
  return t(key).replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? ""));
}

/** Eksport całej mapy dla webview (żeby nie duplikować tłumaczeń po stronie iframe). */
export function dictionaryForIndex(index: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(MAP)) out[k] = index < v.length && v[index] ? v[index] : v[0];
  return out;
}

export function currentLanguageIndex(): number {
  return langIndex;
}
