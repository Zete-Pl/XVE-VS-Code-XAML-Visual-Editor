# XAML Visual Editor (XVE) — wtyczka VS Code

Wizualny edytor plików XAML wewnątrz VS Code. Port koncepcji z aplikacji desktopowej
WPF [XamlVisualEditor](../XamlVisualEditor) — z naciskiem na **wierny ("surgical") zapis**:
edycja zmienia wyłącznie to, co trzeba, a reszta pliku pozostaje bajt-w-bajt nietknięta.

> Osobne repozytorium. Aplikacja WPF służy jako referencja zachowań, nie współdzielimy kodu.

## Status — Etap 3 (edycja wizualna)

Zrobione:
- **Edycja wizualna w podglądzie**: przeciąganie elementu (move → `Margin` lub `Canvas.Left/Top`
  wg layoutu rodzica), 8 uchwytów **resize** (z aktualizacją `Width/Height` i `Margin`),
  podgląd na żywo podczas gestu, commit jednym chirurgicznym zapisem (`setAttributes`).
- **Operacje strukturalne** w `XamlDocument`: `removeElement`, `insertChild`, `moveElement`,
  `getElementSource` (zachowanie wcięć/formatowania).
- **Pasek narzędzi**: dodawanie elementu (lista typów + domyślne snippety) do zaznaczonego
  kontenera, usuwanie. **Skróty**: Delete, Ctrl+C / Ctrl+V (kopiuj/wklej poddrzewo).

Wcześniej:
- Custom Text Editor dla `*.xaml` (webview: drzewo struktury, podgląd, panel właściwości).
- Rdzeń `XamlDocument` + pozycyjny tokenizer `XamlParser` z chirurgiczną edycją atrybutów.
- **Web renderer** subsetu XAML→DOM (`renderer.ts`): Window/Grid/Canvas/StackPanel/Border,
  TextBlock/Button/TextBox/CheckBox/RadioButton/Slider/ProgressBar/Image/Ellipse/Rectangle;
  nieznane typy → placeholder. Pozycjonowanie wg Margin/Alignment/Canvas.*, kolory `#AARRGGBB`.
- **Dwukierunkowa selekcja**: klik w podglądzie ↔ podświetlenie w drzewie + nakładka zaznaczenia.
- **Typowany panel właściwości** (`TypeRegistry`): bool→select, enum→lista, brush→próbnik koloru,
  number/thickness/string→pole; **dodawanie** (lista znanych właściwości) i **usuwanie** atrybutów;
  **podświetlenie atrybutów zmienionych** względem zapisanego pliku + **revert** per atrybut.
- Port lokalizacji (7 języków, `[en, pl, es, de, fr, ja, zh]`).
- Edycja w panelu → chirurgiczny zapis przez `WorkspaceEdit` (natywne undo/redo).
- Testy round-trip / surgical-save / konwersji kolorów / TypeRegistry (`npm run test:unit`, 17/17).

Plan kolejnych etapów: zobacz dokument planu migracji.

## Architektura (skrót)

```
Extension host (Node/TS)            Webview (HTML/CSS/TS)
  extension.ts                        main.ts  — drzewo, źródło, properties
  XveEditorProvider  ── postMessage ─ style.css
  core/XamlDocument  (surgical save)
  core/XamlParser    (tokenizer + offsety)
  core/Localization  (7 języków)
```

Backend podglądu w kolejnych etapach: **web renderer** (cross-platform) oraz opcjonalny
**WPF host** na Windows (wysoka wierność).

## Uruchomienie (dev)

```bash
npm install
npm run compile        # bundla extension + webview do dist/
npm run test:unit      # testy rdzenia (Node test runner, type stripping)
```

W VS Code: `F5` → „Run Extension" → w nowym oknie otwórz dowolny `.xaml`
(albo „XVE: Open in XAML Visual Editor").

## Wymagania

- VS Code ^1.90, Node ≥ 20 (testy używają type-stripping z Node ≥ 22/24).
