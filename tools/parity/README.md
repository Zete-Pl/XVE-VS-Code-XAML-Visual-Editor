# Tester parzystości web ↔ WPF

Porównuje układ (rozmiary i pozycje elementów) renderera **web** (DOM/CSS) z **hostem WPF**
(prawdziwy silnik WPF = ground truth) dla trudnych próbek XAML. Służy do wykrywania i pilnowania
rozjazdów wyglądu między oboma backendami podglądu.

## Jak uruchomić

```bash
npm run compile                  # buduje dist/parity-harness.js (i resztę)
npm run build:host               # buduje xve-wpf-host.exe (zamknij wcześniej Extension Dev Host!)
npx playwright install chromium  # jednorazowo
npm run test:parity              # uruchamia porównanie → tmp/parity/
```

Opcjonalnie konkretny plik i motywy (host `none|classic98|light|dark` ↔ odpowiadająca klasa web):

```bash
npm run test:parity -- --themes none,light "C:\ścieżka\MainWindow.xaml"
```

Elementy z prefiksowanych przestrzeni nazw (typy projektu, np. `local:RulerBar`) są przed porównaniem
zamieniane na stub `<Border>` z whitelistą atrybutów układu — host nie umie ich tworzyć bez DLL,
a web pokazuje placeholder; po stubie obie strony renderują to samo i id węzłów zostają spójne.

Wyniki w `tmp/parity/`:

- `report.md` — tabela zbiorcza + top rozjazdy per próbka (Δ = web − WPF, px),
- `report.json` — dane maszynowe (do diffowania między uruchomieniami),
- `<próbka>.wpf.png` / `<próbka>.web.png` — zrzuty do porównania wizualnego.

## Jak to działa

- **Próbki**: `samples/parity/*.xaml` — każda celuje w jeden mechanizm układu.
- **wpf-runner.ts**: reużywa `WpfHost`, renderuje `XamlDocument.toHostXaml()` i czyta zmierzone
  prostokąty (realne, nieprzycięte `rx,ry,rw,rh` = ActualWidth/Height w układzie korzenia).
- **harness.ts** (`dist/parity-harness.js`): w headless Chromium renderuje ten sam XAML tym samym
  kodem co webview (`XamlDocument.toTree` + `extractResources` + `renderTreeToDom`) i mierzy
  `getBoundingClientRect`.
- **diff.ts**: czysta funkcja `diffRects` (pokryta `test/parityDiff.test.ts`) — łączy po `id`
  (host `uid="u<id>"` = web `data-xve-id`, oba z tego samego `XamlParser`), liczy delty i sortuje.

Korzeń `Window` jest **pomijany**: host renderuje treść okna, nie samo okno, więc zwraca dla niego
prostokąt 0×0 (nieporównywalny).

## Znane rozjazdy (stan po dopracowaniu)

Łączna liczba rozjazdów >1px (poza korzeniem Window): **48 → 15 → 1** po poprawkach. 11/12 próbek
piksel-w-piksel; jedyny pozostały wpis to artefakt semantyki pomiaru (patrz niżej), nie różnica wyglądu.

Naprawione:

- **TextWrapping** (`Wrap`/`WrapWithOverflow`) — web zawija tekst zgodnie z WPF (wcześniej `white-space:pre`
  dawało jedną linię). `webview/renderer.ts` (case TextBlock).
- **WrapPanel** — domyślnie Horizontal: elementy płyną w prawo i zawijają do następnego wiersza
  (wcześniej `flex-direction:column` dawał błędne kolumny); elementy wyśrodkowane w poprzek wiersza jak WPF.
  wrappanel-flow: 216px → 0px.
- **TextBlock z mieszaną treścią `tekst<LineBreak/>tekst`** — `TreeNodeDto.inlines` zachowuje kolejność
  tekstu i elementów inline (wcześniej tekst wokół `<LineBreak/>` znikał). `XamlDocument.toTree` +
  `webview/renderer.ts` (`appendInline`). font-metrics: 18.6px → ~3px.
- **Metryki tekstu** — okazały się artefaktem testera: harness nie definiował `--vscode-font-family`,
  więc `font-family` w `.xve-el` stawał się nieprawidłowy i tekst leciał na serif (~6% węższy). Po
  zdefiniowaniu zmiennych VS Code w `web-runner.ts` tekst i szerokości zgadzają się. W prawdziwym webview
  problemu nie było.
- **Viewbox** — `scaleViewboxes()` (po layoucie) skaluje treść transformem wg Stretch
  (Uniform/Fill/UniformToFill/None) i centruje jak WPF. viewbox-scale: 204px → ~0px.
- **Grid SharedSizeGroup** — `applySharedSizes()` (po layoucie) wyrównuje ścieżki o wspólnej grupie w
  obrębie `Grid.IsSharedSizeScope`. Kolumny etykiet są teraz wyrównane. grid-shared-size: 122px → ~4px
  (resztka = wysokość pola, niżej).
- **Auto-szerokość przycisków** — `--xve-btn-px` (classic 1px, Fluent/98/native 10px) dociąga ciasny
  przycisk WPF „none". stackpanel-autosize: 54px → ~0px.
- **VerticalAlignment w Borderze** — dziecko z `VerticalAlignment≠Stretch` (np. TextBlock Center) ma
  naturalną wysokość i jest wyśrodkowane, zamiast rozciągać się na całą wysokość Bordera.
- **TextWrapping="NoWrap" z jawną szerokością** — web przycina nadmiar tekstu (`overflow:hidden`) jak WPF.

- **Domyślne wysokości kontrolek (classic)** — reguły `#surface.xve-theme-classic …` w `style.css`
  dociągają intrinsic metryki do hosta WPF: TextBox 18px (bez pionowego paddingu), ComboBox 22px,
  CheckBox/RadioButton bez `min-height` (wysokość tekstu ~15px), Label z domyślnym `Padding=5` jak w WPF
  (klasa `.xve-label`, wszystkie motywy). Motywy Fluent/98/native nietknięte (selektor scoped do classic).
  default-control-sizes: 14.1px → 0.1px; grid-shared-size: 4px → 0px. Harness nadaje teraz na `#surface`
  klasę `xve-theme-classic` (jak prawdziwy webview), żeby te reguły działały też w testerze.
- **Wysokość linii innych czcionek** — WPF liczy auto-wysokość TextBlocka z metryk czcionki
  (`FontFamily.LineSpacing`), web miał stałe 1.333333 (= Segoe UI). `renderer.ts` ma tabelę
  `FONT_LINE_SPACING` popularnych czcionek Windows (Consolas 1.17, Calibri 1.22, Tahoma 1.207, …)
  i ustawia `line-height` przy jawnym `FontFamily`. font-metrics: 2.9px → 0.2px.

### Realny plik: MainWindow.xaml (XamlVisualEditor2), motywy classic + Fluent

Rozjazdy >1px: **classic 84 → 2, Fluent 92 → 6** (pozostałe = artefakty pomiaru, patrz niżej).
Naprawione przy tej okazji (wszystko w `webview/renderer.ts` + `webview/style.css`):

- **`Visibility="Collapsed"` nie działał dla kontenerów** — gałęzie case'ów (Border/Grid/StackPanel…)
  ustawiały `display:flex/grid` PO `applyCommon`, nadpisując `display:none`; ukryty element zajmował
  miejsce (np. collapsed `RulerBar` 22px poszerzał kolumnę Auto). Teraz klasa `.xve-collapsed`
  z `!important`. **To był realny bug web-podglądu, nie tylko testera.**
- **ToolBar**: grip (10px) i przycisk overflow (14px) jako części szablonu (niezależne od `Padding="0"`
  z XAML), bez ramki, przyciski w pasku płaskie (WPF `ToolBar.ButtonStyleKey`), ComboBox w pasku classic
  20px wysokości i 1px marginesu, Fluent: pasek 49px (grip wymusza min-height), overflow schowany (2px),
  tekstowe przyciski wysokie na cały pasek (ikonowe zostają 24×24 — selektor `:not(:has(.xve-el))`).
- **Separator w poziomym przepływie** (ToolBar/StatusBar/dock) — pionowa kreska na wysokość rzędu
  (wcześniej linia 1×1); marginesy per kontener/motyw wg pomiarów hosta.
- **Menu/MenuItem**: top-level nagłówki z paddingiem 7.5px/stronę (Fluent 15px), bez gapów; podkreślenia
  akceleratorów (`_Plik`) ukryte jak w WPF (pokazuje je dopiero Alt); Fluent: pozycje menu wysokie (46px).
- **TabControl**: metryki TabItem classic (padding 1.5/5px, wys. 19.96), zaznaczona zakładka ROŚNIE
  (+4/+2px, wystaje 2px ponad rząd — ujemne marginesy); treść z 2px odstępem przez **margin** (nie
  padding — dzieci zakładki pozycjonują się absolutnie od pudełka paddingu); Fluent: zakładki 32px,
  strip bez paddingu, TabControl bez ramki.
- **StatusBar/StatusBarItem**: pozycje z paddingiem 3px (Fluent 3×4px), treść wyśrodkowana w pionie
  (nie rozciągnięta), pasek bez ramki w classic; Fluent: min. 40px wysokości, 1px chromu ramką szablonu
  (padding zbiłoby XAML-owe `Padding="0"`), separator 13px z linią pośrodku, ComboBox/Slider 30px.
- **ScrollViewer**: `min-height:100%` dziecka odejmuje jego pionowe marginesy (dziecko z `Margin`
  sztucznie przewijało/rosło).
- **ComboBox bez `SelectedIndex`/`IsSelected`** — puste pole jak w WPF (web pokazywał pierwszą pozycję).
- **Czcionki ikon** (`Segoe MDL2 Assets`, `Segoe Fluent Icons`, `Marlett`) w tabeli `FONT_LINE_SPACING`
  z mnożnikiem 1.0 (wysokość linii = FontSize, jak w WPF).
- **Emoji** — `font-variant-emoji: text` na `.xve-el`: znaki typu ✋⛶⊞ renderują się monochromatycznie
  (glify tekstowe), jak w WPF, zamiast kolorowych emoji Chromium.
- **Domyślny FontSize we Fluent = 14px** (SKORYGOWANE — patrz sekcja „FontSize we Fluent" niżej).
- **RadioButton/CheckBox z własną treścią i `IsChecked=True`** — stan „wciśnięty" (`.xve-toggled`),
  jak triggery szablonów przycisków narzędziowych.

### FontSize we Fluent: 14px (nie 12px) — korekta hosta i web

Typografia WinUI/Fluent dla Windows 11: „Body" = **14/20 epx**, `ContentControlThemeFontSize` = 14.
W prawdziwej aplikacji Fluent motywowane okno dziedziczy FontSize=14 na całe drzewo, więc goły
`<TextBlock>` bez własnego FontSize renderuje się na 14px. **Host XVE renderuje treść w gołym
`Border` (odrzuca `Window`)**, więc bez korekty goły TextBlock spadał do domyślnej czcionki WPF
(≈12px) — i tester błędnie „potwierdzał" 12px. Poprawki (host + web, bo inaczej web≠host):

- **host `Program.cs` → `ApplyClassicFontDefault`**: dla Fluent (light/dark) ustawia na korzeniu
  `TextElement.FontSize = 14` (odtworzenie dziedziczenia z okna Fluent), classic98 = 12, classic/none
  = domyślne WPF (12). Kontrolki z własnym FontSize (szablony Fluent, chrom) nadpisują.
- **web `style.css`**: `--xve-font-size: 14px` na `#surface.xve-theme-light/dark` (czyta `.xve-el`).
  Chrom Fluent, który w hoście NIE dziedziczy 14: **StatusBar → 12px** (zmierzone). ToolBar/Menu/zakładki
  dziedziczą 14px jak host. Zakładki Fluent mają STAŁĄ wysokość 32px (14px tekst nie rozpycha paska),
  pasek narzędzi ~51.6px (14px treść), combo w StatusBarze 32px.
- classic (`none`) zostaje przy 12px w hoście i web — bez zmian.

Po korekcie SampleElems@light: domyślny TextBlock/Label = 14px w hoście i web (piksel-w-piksel);
MainWindow@light: 6 → 12 rozjazdów, ale wszystkie ≤2.6px na chromie klamrowanym do paska (desired-
height) lub artefakty szerokości glifów/GridSplittera — wizualnie bez zmian.

- **Image `Stretch`** — `Stretch` → `object-fit` (Uniform=contain, Fill=fill, UniformToFill=cover,
  None=none). Uniform: po załadowaniu obrazu web KURCZY element do wpisanego (letterbox) rozmiaru jak
  WPF (`ActualWidth/Height`), zamiast zostawiać pełne pudełko `Width×Height`. Zweryfikowane: obraz
  500×131 w slocie 139×77 → element 139×36.41 (host 139×36.42). Tester pokazuje pełne 139×77, bo
  headless Chromium nie ładuje obrazu (placeholder) — w realnym webview element się kurczy.

### Realny plik: SampleElems.xaml (przegląd kontrolek), motywy classic + Fluent

Rozjazdy >1px: **classic 5 → 2, Fluent 9 → 1** (resztki = artefakty, patrz niżej). Naprawione:

- **Calendar** — stały SLOT układu jak w WPF (classic 179×265, Fluent 296×348 przez zmienne
  `--xve-calendar-w/h`), przy czym w classic WIDOCZNY chrom to kompaktowy box (~160px) u góry slotu
  — WPF zajmuje 265px układu, ale rysuje mały kalendarz (Fluent wypełnia slot w całości,
  `--xve-calendar-boxh`). Pełny widok miesiąca: nagłówek (classic: pas #e6ecf1, ◀ ▶ po bokach;
  Fluent: tytuł po lewej, ▲▼ po prawej, bez pasa), wiersz dni tygodnia i 6 tygodni z dniami
  sąsiednich miesięcy (classic przygasza, Fluent nie). Kultura = locale przeglądarki, pierwszy
  dzień tygodnia z `Intl.Locale.weekInfo`. Wcześniej: goła siatka 1–31 o szerokości treści.
- **CheckBox/RadioButton classic** — odstęp box↔tekst 5px (jak BulletDecorator), nie 8px.
- **Fluent CheckBox/RadioButton** — `MinWidth: 120px` (styl WinUI).
- **Fluent Label** — padding 2px/0 (Fluent redefiniuje classicowe `Padding=5`).
- **Fluent TextBox** — `min-height: 32px !important`: w WPF MinHeight ze stylu KLAMRUJE nawet jawnie
  mniejsze `Height` (zmierzone: `Height="28"` → 32), a renderer zeruje inline'owo min-height przy
  jawnym rozmiarze.
- **Fluent Slider** — 30px tylko w StatusBarze; standalone wraca do 32 (`--xve-ctl-h`).
- **Kultura Calendara jak w hoście** — provider wysyła webview tę samą kulturę co hostowi WPF
  (`previewCulture` w configu = `cultureForHost()`), a renderer odwzorowuje quirk WPF: kultura
  NEUTRALNA (bez regionu, np. "en"/"pl" z `vscode.env.language`) → format InvariantCulture
  („2026 July", dni „Su Mo Tu We Th Fr Sa", tydzień od niedzieli); kultura specyficzna („pl-PL") →
  Intl z tą kulturą; brak parametru (tester) → locale przeglądarki = kultura OS, jak host bez
  `culture`. Harness przyjmuje `culture` w `MeasureOpts`.
- **Kolory spróbkowane z hosta** — classic: tor Slidera #e7eaea z ramką #d6d6d6 (był #888);
  Fluent light: tło okna #fafafa (było #f3f3f3), tor ProgressBara #8a8a8a (był #d6d6d6).
- **Kratka CheckBox/RadioButton z `box-sizing: border-box`** — rozmiar liczony Z ramką jak w WPF:
  classic 15px łącznie, Fluent 20px łącznie (zmierzone skanem pikseli hosta).

Pozostałe (artefakt pomiaru — wygląd identyczny):

- **TextWrapping="NoWrap" z nadmiarem** — wizualnie OK (web przycina), ale tester nadal flaguje ~206px:
  host podaje pełną szerokość *tuszu* wystającego tekstu (rw), a `getBoundingClientRect` zwraca pudełko
  elementu. Różnica semantyki pomiaru, nie wyglądu.
- **Desired vs arranged** — host raportuje NIEprzycięte rozmiary (rw/rh): ToolBarTray z `MaxHeight=40`
  pokazuje 48.96 (desired), choć układa na 40; GridSplitter Fluent „ma" 8px w kolumnie o szerokości 4.
  Web mierzy pudełko po układzie, więc te wpisy zostają (wygląd zgodny z arrange hosta).
- **Szerokości glifów emoji/symboli** (✋ ⊞) — inne metryki fallbacku czcionki w Chromium niż w WPF
  (Δ2–5px na pojedynczych TextBlockach z symbolami); analogicznie ±1px na szerokości tekstu
  (np. RadioButton „RadioButton" 85.9 vs 84.9).
- **Image Stretch="Uniform"** — host raportuje prostokąt narysowanej bitmapy (letterbox wewnątrz
  slotu Width×Height, np. 139×36 w slocie 139×77), web pudełko elementu; wizualnie to samo
  (`object-fit: contain` centruje tak samo).
