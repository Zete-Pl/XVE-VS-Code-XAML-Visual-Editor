# XAML Visual Editor (XVE) — wtyczka VS Code

Wizualny edytor plików XAML wewnątrz VS Code. Port koncepcji z aplikacji desktopowej
WPF [XamlVisualEditor](../XamlVisualEditor) — z naciskiem na **wierny ("surgical") zapis**:
edycja zmienia wyłącznie to, co trzeba, a reszta pliku pozostaje bajt-w-bajt nietknięta.

> Osobne repozytorium. Aplikacja WPF służy jako referencja zachowań, nie współdzielimy kodu.

## Status — Etap 6 (zoom + host WPF + ustawienia)

Zrobione:
- **Zoom** (oba tryby): kontrolka **− / % / + / Dopasuj** w pasku oraz **Ctrl+scroll**
  (z zakotwiczeniem na kursorze); zakres 10–800%. Linijki/snap/prowadnice respektują zoom.
- **Host WPF** (`wpf-host/`, .NET 10): `xve-wpf-host.exe` renderuje XAML **prawdziwym silnikiem
  WPF** → PNG + mapa hit‑test (`x:Uid`). Protokół JSON‑lines.
- **Wydajność hosta**: trwała sesja przeciągania (cache drzewa), koalescencja in‑flight,
  **render tylko widocznego obszaru** (`viewbox`, 1:1, ostro niezależnie od rozmiaru okna),
  konfigurowalny **limit rozdzielczości**.
- **Panel Ustawień** (⚙): wybór silnika (Auto / Web / WPF host — host tylko Windows) oraz
  opcje trybu host (strategia podglądu przeciągania, trwała sesja, koalescencja, realny
  rozmiar, limit rozdzielczości, render widocznego obszaru).
- **Domyślnie**: render widocznego obszaru + podgląd przeciągania „co 25 ms" (wł.).
- Ikona wtyczki: `Assets/iconXVE2.ico` (przy publikacji do Marketplace wymagany PNG 128×128).
- Budowa hosta: `npm run build:host` (wymaga .NET 10 SDK, Windows).

Wcześniej — Etap 4 (diff / Changes):
- **`LineDiff`** (LCS) i **`StructuralDiff`** (dopasowanie drzew keyed‑LCS po tag + x:Name)
  w TS — porty z aplikacji WPF, czyste i otestowane.
- **Widok Changes** (przełącznik Design/Changes w pasku, licznik): lista zmian względem
  **zapisanego pliku** — zmiany atrybutów, dodane i usunięte elementy — z **revert per‑hunk**
  oraz **Revert all**. Klik w pozycję zaznacza element w podglądzie.
- Revert chirurgiczny przez te same operacje co edycja (set/remove/insert/delete),
  Revert all = przywrócenie tekstu baseline.

Wcześniej — Etap 3 (edycja wizualna):
- **Edycja wizualna w podglądzie**: przeciąganie elementu (move → `Margin` lub `Canvas.Left/Top`
  wg layoutu rodzica), 8 uchwytów **resize** (z aktualizacją `Width/Height` i `Margin`),
  podgląd na żywo podczas gestu, commit jednym chirurgicznym zapisem (`setAttributes`).
- **Operacje strukturalne** w `XamlDocument`: `removeElement`, `insertChild`, `moveElement`,
  `getElementSource` (zachowanie wcięć/formatowania).
- **Pasek narzędzi**: dodawanie elementu (lista typów + domyślne snippety) do zaznaczonego
  kontenera, usuwanie. **Skróty**: Delete, Ctrl+C / Ctrl+V (kopiuj/wklej poddrzewo).
- **3b — linijki, prowadnice, snap**: linijki (góra/lewo) z podziałką, **prowadnice** dodawane
  klikiem w linijkę (przeciąganie / podwójny klik = usuń), **snap‑grid** o konfigurowalnym
  kroku (move/resize przyciąga do siatki i prowadnic), opcjonalna **widoczna siatka**,
  pasek **narzędzi Select / Pan**.
- **3b‑rebuild — stabilny viewport**: układ podglądu przepisany — `#surface-scroll` jest
  `position:absolute; inset:0` (rozmiar niezależny od linijek), linijki to paski **CSS/DOM**
  (podziałka = gradient, etykiety = DOM; bez canvas/DPI), `ResizeObserver` przerysowuje przy
  zmianie rozmiaru okna. Działają **scrollbary** (Window > widok) i **Pan** (narzędzie + środkowy
  przycisk myszy). Przełączniki Linijki/Prowadnice stabilne. Zoom: planowany na Etap 6.

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
