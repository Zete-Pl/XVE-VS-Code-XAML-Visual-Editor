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
  "View.Design": ["Design", "Projekt", "Diseño", "Entwurf", "Conception", "デザイン", "设计"],
  "View.Changes": ["Changes", "Zmiany", "Cambios", "Änderungen", "Modifications", "変更", "更改"],
  "Changes.Title": ["Changes", "Zmiany", "Cambios", "Änderungen", "Modifications", "変更", "更改"],
  "Changes.Empty": ["No changes since last save", "Brak zmian od ostatniego zapisu", "Sin cambios desde el último guardado", "Keine Änderungen seit dem letzten Speichern", "Aucune modification depuis le dernier enregistrement", "前回の保存以降の変更はありません", "自上次保存以来没有更改"],
  "Changes.RevertAll": ["Revert all", "Cofnij wszystko", "Revertir todo", "Alle zurücksetzen", "Tout annuler", "すべて元に戻す", "全部还原"],
  "Changes.InlineDiff": ["Show changes in code", "Pokaż zmiany w kodzie", "Mostrar cambios en el código", "Änderungen im Code anzeigen", "Afficher les modifications dans le code", "コードに変更を表示", "在代码中显示更改"],
  "Settings.Title": ["Settings", "Ustawienia", "Configuración", "Einstellungen", "Paramètres", "設定", "设置"],
  "Settings.Backend": ["Preview backend", "Silnik podglądu", "Motor de vista previa", "Vorschau-Engine", "Moteur d'aperçu", "プレビューエンジン", "预览引擎"],
  "Backend.Auto": ["Auto", "Automatyczny", "Automático", "Automatisch", "Automatique", "自動", "自动"],
  "Backend.Web": ["Web (cross-platform)", "Web (wieloplatformowy)", "Web (multiplataforma)", "Web (plattformübergreifend)", "Web (multiplateforme)", "Web（クロスプラットフォーム）", "Web（跨平台）"],
  "Backend.WpfHost": ["WPF host (Windows, high fidelity)", "Host WPF (Windows, wysoka wierność)", "Host WPF (Windows, alta fidelidad)", "WPF-Host (Windows, hohe Treue)", "Hôte WPF (Windows, haute fidélité)", "WPF ホスト（Windows、高忠実度）", "WPF 宿主（Windows，高保真）"],
  "Backend.WindowsOnly": ["WPF host is available only on Windows.", "Host WPF jest dostępny tylko na Windows.", "El host WPF solo está disponible en Windows.", "WPF-Host ist nur unter Windows verfügbar.", "L'hôte WPF n'est disponible que sous Windows.", "WPF ホストは Windows でのみ利用できます。", "WPF 宿主仅在 Windows 上可用。"],
  "View.NoSelection": ["No element selected", "Nie wybrano elementu", "Ningún elemento seleccionado", "Kein Element ausgewählt", "Aucun élément sélectionné", "要素が選択されていません", "未选择元素"],
  "Prop.Add": ["Add property…", "Dodaj właściwość…", "Agregar propiedad…", "Eigenschaft hinzufügen…", "Ajouter une propriété…", "プロパティを追加…", "添加属性…"],
  "Prop.Remove": ["Remove property", "Usuń właściwość", "Quitar propiedad", "Eigenschaft entfernen", "Supprimer la propriété", "プロパティを削除", "删除属性"],
  "Prop.Revert": ["Revert to saved value", "Przywróć zapisaną wartość", "Revertir al valor guardado", "Auf gespeicherten Wert zurücksetzen", "Rétablir la valeur enregistrée", "保存値に戻す", "还原为已保存的值"],
  "Tb.Add": ["Add", "Dodaj", "Agregar", "Hinzufügen", "Ajouter", "追加", "添加"],
  "Tb.AddTip": ["Add element into the selected container", "Dodaj element do zaznaczonego kontenera", "Agregar elemento al contenedor seleccionado", "Element zum ausgewählten Container hinzufügen", "Ajouter un élément au conteneur sélectionné", "選択したコンテナーに要素を追加", "将元素添加到所选容器"],
  "Tb.Delete": ["Delete", "Usuń", "Eliminar", "Löschen", "Supprimer", "削除", "删除"],
  "Tb.DeleteTip": ["Delete the selected element (Del)", "Usuń zaznaczony element (Del)", "Eliminar el elemento seleccionado (Supr)", "Ausgewähltes Element löschen (Entf)", "Supprimer l'élément sélectionné (Suppr)", "選択した要素を削除 (Del)", "删除所选元素 (Del)"],
  "Tool.Select": ["Select", "Zaznacz", "Seleccionar", "Auswählen", "Sélection", "選択", "选择"],
  "Tool.SelectTip": ["Select / move / resize elements", "Zaznaczaj / przesuwaj / skaluj elementy", "Seleccionar / mover / redimensionar", "Auswählen / verschieben / skalieren", "Sélectionner / déplacer / redimensionner", "選択／移動／サイズ変更", "选择/移动/缩放元素"],
  "Tool.Pan": ["Pan", "Przesuń widok", "Desplazar", "Verschieben", "Déplacer la vue", "パン", "平移"],
  "Tool.PanTip": ["Drag to scroll the preview", "Przeciągnij, aby przewinąć podgląd", "Arrastra para desplazar la vista previa", "Ziehen, um die Vorschau zu scrollen", "Faites glisser pour faire défiler l'aperçu", "ドラッグでプレビューをスクロール", "拖动以滚动预览"],
  "Tool.Snap": ["Snap", "Przyciąganie", "Ajustar", "Einrasten", "Aligner", "スナップ", "对齐"],
  "Tool.Grid": ["Grid", "Siatka", "Cuadrícula", "Raster", "Grille", "グリッド", "网格"],
  "Tool.ShowGrid": ["Show grid", "Pokaż siatkę", "Mostrar cuadrícula", "Raster anzeigen", "Afficher la grille", "グリッドを表示", "显示网格"],
  "Tool.Rulers": ["Rulers", "Linijki", "Reglas", "Lineale", "Règles", "ルーラー", "标尺"],
  "Tool.Guides": ["Guides", "Prowadnice", "Guías", "Hilfslinien", "Repères", "ガイド", "参考线"],
  "Guides.Title": ["Guides", "Prowadnice", "Guías", "Hilfslinien", "Repères", "ガイド", "参考线"],
  "Guides.Vertical": ["Vertical (from horizontal ruler)", "Pionowe (z linijki poziomej)", "Verticales (de la regla horizontal)", "Vertikal (vom horizontalen Lineal)", "Verticaux (de la règle horizontale)", "縦（水平ルーラーから）", "垂直（来自水平标尺）"],
  "Guides.Horizontal": ["Horizontal (from vertical ruler)", "Poziome (z linijki pionowej)", "Horizontales (de la regla vertical)", "Horizontal (vom vertikalen Lineal)", "Horizontaux (de la règle verticale)", "横（垂直ルーラーから）", "水平（来自垂直标尺）"],
  "Guides.AddV": ["Add vertical", "Dodaj pionową", "Agregar vertical", "Vertikale hinzufügen", "Ajouter vertical", "縦を追加", "添加垂直"],
  "Guides.AddH": ["Add horizontal", "Dodaj poziomą", "Agregar horizontal", "Horizontale hinzufügen", "Ajouter horizontal", "横を追加", "添加水平"],
  "Tool.ClearGuides": ["Clear guides", "Wyczyść prowadnice", "Borrar guías", "Hilfslinien löschen", "Effacer les repères", "ガイドを消去", "清除参考线"],
  "Tool.ClearGuidesTip": ["Remove all guides (click a ruler to add one)", "Usuń wszystkie prowadnice (kliknij linijkę, by dodać)", "Quitar todas las guías (haz clic en una regla para añadir)", "Alle Hilfslinien entfernen (Lineal anklicken zum Hinzufügen)", "Supprimer tous les repères (cliquez sur une règle pour en ajouter)", "すべてのガイドを削除（ルーラーをクリックで追加）", "移除所有参考线（点击标尺添加）"],
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
