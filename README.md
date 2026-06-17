# XAML Visual Editor (XVE) — wtyczka VS Code

Wizualny edytor plików XAML wewnątrz VS Code. Port koncepcji z aplikacji desktopowej
WPF [XamlVisualEditor](../XamlVisualEditor) — z naciskiem na **wierny ("surgical") zapis**:
edycja zmienia wyłącznie to, co trzeba, a reszta pliku pozostaje bajt-w-bajt nietknięta.

> Osobne repozytorium. Aplikacja WPF służy jako referencja zachowań, nie współdzielimy kodu.

## Status — Etap 0 (szkielet)

Zrobione:
- Custom Text Editor dla `*.xaml` (webview: drzewo struktury, źródło, panel właściwości).
- Rdzeń `XamlDocument` + pozycyjny tokenizer `XamlParser` z chirurgiczną edycją atrybutów.
- Port lokalizacji (7 języków, `[en, pl, es, de, fr, ja, zh]`), podzbiór kluczy.
- Edycja wartości atrybutu w panelu → zapis przez `WorkspaceEdit` (natywne undo/redo).
- Testy round-trip / surgical-save (`npm run test:unit`).

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
