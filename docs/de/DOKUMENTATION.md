# XAML Visual Editor (XVE) — Dokumentation

[🇬🇧 English](../en/DOCUMENTATION.md) · [🇵🇱 Polski](../pl/DOKUMENTACJA.md) · [🇪🇸 Español](../es/DOCUMENTACION.md) · **🇩🇪 Deutsch** · [🇫🇷 Français](../fr/DOCUMENTATION.md) · [🇯🇵 日本語](../ja/DOCUMENTATION.md) · [🇨🇳 中文](../zh/DOCUMENTATION.md)

XVE ist eine Visual-Studio-Code-Erweiterung, die handgeschriebene **XAML**-Dateien in eine
lebendige, editierbare visuelle Oberfläche verwandelt — einen Strukturbaum, eine gerenderte Vorschau
und ein typisiertes Eigenschaftenpanel — während die Textdatei die einzige Quelle der Wahrheit
bleibt. Ihr prägendes Merkmal ist das **chirurgische Speichern**: eine Bearbeitung ändert nur das
Nötigste, der Rest der Datei bleibt Byte für Byte identisch (Formatierung, Kommentare und
Einrückung bleiben erhalten).

![Editor-Layout](../images/layout-overview.png)

---

## Inhaltsverzeichnis

1. [Einführung](#1-einführung)
2. [Installation & Ausführung](#2-installation--ausführung)
3. [Erste Schritte](#3-erste-schritte)
4. [Die Oberfläche](#4-die-oberfläche)
5. [Funktionen](#5-funktionen)
6. [Vorschau-Backends](#6-vorschau-backends)
7. [Projektressourcen (WPF-Host)](#7-projektressourcen-wpf-host)
8. [Fehlerbehandlung](#8-fehlerbehandlung)
9. [Einstellungsreferenz](#9-einstellungsreferenz)
10. [Tastenkürzel](#10-tastenkürzel)
11. [Architektur](#11-architektur)
12. [Beispieldateien](#12-beispieldateien)
13. [Fehlerbehebung / FAQ](#13-fehlerbehebung--faq)
14. [Entwicklungsgeschichte](#14-entwicklungsgeschichte)

---

## 1. Einführung

XVE ist für Entwickler gemacht, die WPF/XAML von Hand schreiben, aber trotzdem eine
designer-ähnliche Vorschau und schnelle visuelle Anpassungen wollen — ohne dass ein Werkzeug ihr
Markup umschreibt (und neu formatiert).

Kernideen:

- **Eigener Editor für `*.xaml`** — als *Option* registriert, sodass du jederzeit zwischen dem
  visuellen Editor und dem reinen Texteditor wechseln kannst.
- **Chirurgisches Speichern** — jede Änderung wird als kleinstmögliche Bearbeitung am Originaltext
  angewandt. Das native **Rückgängig/Wiederholen** von VS Code funktioniert, weil alle Bearbeitungen
  über das `TextDocument` laufen.
- **Zwei Vorschau-Engines** — ein plattformübergreifender **Web-Renderer** und ein nur unter Windows
  verfügbarer **WPF-Host** hoher Wiedergabetreue, der mit der echten WPF-Engine rendert.
- **Lokalisierte Oberfläche** — 7 Sprachen (English, Polski, Español, Deutsch, Français, 日本語, 中文).

---

## 2. Installation & Ausführung

### Voraussetzungen

| Komponente | Voraussetzung |
|------------|---------------|
| VS Code | `^1.90.0` |
| WPF-Host — *Verwendung* (optional) | Windows x64 oder ARM64 + **[.NET 10 Desktop Runtime](https://dotnet.microsoft.com/download/dotnet/10.0)** |
| WPF-Host — *Bauen* (nur Entwicklung) | Windows + **.NET 10 SDK** |
| Node.js (nur Entwicklung) | ≥ 20 (Unit-Tests nutzen Type-Stripping ab Node ≥ 22/24) |

Nach der Installation aus dem Marketplace muss nichts kompiliert werden: die Erweiterung liefert eine
vorgebaute `xve-wpf-host.exe` **sowohl für x64 als auch für ARM64** mit und wählt zur Laufzeit die
passende zu deinem VS Code.

Was du brauchst, ist die **Desktop**-Runtime (`Microsoft.WindowsDesktop.App`) — ein separater Download
gegenüber der einfachen .NET-Runtime — **in derselben Architektur wie VS Code**. Ein ARM64-VS-Code
braucht die ARM64-Desktop-Runtime. Fehlt sie, zeigt XVE eine Benachrichtigung mit Download-Link und
fällt auf den Web-Renderer zurück.

Die Erweiterung läuft überall dort, wo VS Code läuft. Der **WPF-Host ist optional** und nur für
Windows; auf anderen Plattformen (oder wenn der Host nicht verfügbar ist) wird der Web-Renderer
verwendet.

### Aus dem Quellcode starten (Entwicklung)

```bash
npm install
npm run compile        # bündelt Erweiterung + Webview nach dist/
npm run test:unit      # Unit-Tests des Kerns (Node test runner, Type Stripping)
npm run test:parity    # Render-Parität Web-Renderer vs. WPF-Host (Playwright)
npm run docs:images    # erzeugt die Diagramme und Toolbar-Icons in docs/images/ neu
```

`test:parity` rendert die Fixtures in `samples/parity/` über beide Backends und vergleicht die
resultierende Geometrie; es braucht den gebauten WPF-Host (siehe unten) und läuft daher nur unter
Windows.

`docs:images` rendert jedes `docs/images/*.svg` nach PNG, exportiert die Toolbar-Icons aus
`@vscode/codicons` und verkleinert die Screenshots an Ort und Stelle auf 1200 px Breite. Es ist
idempotent — ein Bild, das bereits innerhalb des Limits liegt, bleibt unangetastet — du kannst also
eine Aufnahme in voller Auflösung ablegen und es einfach erneut ausführen.

Drücke dann in VS Code **`F5`** → *Run Extension*. Öffne im neuen Extension-Development-Host-Fenster
eine beliebige `.xaml`-Datei (oder führe **„XVE: Open in XAML Visual Editor“** aus der Befehlspalette
aus).

### Den WPF-Host bauen (nur Windows)

```bash
npm run build:host     # dotnet build wpf-host -c Release  (benötigt das .NET 10 SDK)
```

Das erzeugt `xve-wpf-host.exe`, die die Erweiterung bei Bedarf für die Vorschau hoher
Wiedergabetreue startet.

---

## 3. Erste Schritte

1. **Öffne eine XAML-Datei.** Da der visuelle Editor mit `priority: "option"` registriert ist, öffnen
   sich `.xaml`-Dateien standardmäßig im normalen Texteditor.
2. **Wechsle zum visuellen Editor.** Klicke auf **„XVE: Open in XAML Visual Editor“** in der
   Editor-Titelleiste oder führe den Befehl `xve.openVisualEditor` aus der Befehlspalette aus.
3. **Zurück zum Text.** Klicke bei aktivem visuellem Editor auf **„XVE: Open XAML as Text“**
   (`xve.openTextEditor`) in der Titelleiste.

Die beiden Titelleisten-Schaltflächen sind kontextabhängig: die Schaltfläche „Visual Editor“
erscheint nur, wenn eine `.xaml`-Datei als Text geöffnet ist, und „as Text“ nur, wenn der visuelle
Editor aktiv ist.

(Der Screenshot am Anfang dieses Dokuments zeigt eine `.xaml`-Datei im visuellen Editor mit allen
drei sichtbaren Panels.)

---

## 4. Die Oberfläche

Der visuelle Editor ist ein Drei-Panel-Layout (siehe Diagramm oben):

| Panel | Was es zeigt |
|-------|--------------|
| **Strukturbaum** (links) | Die XAML-Elementhierarchie. Klicken zum Auswählen, ziehen zum Umsortieren. Größenveränderbar. |
| **Vorschau** (Mitte) | Die gerenderte Oberfläche mit Symbolleiste, Linealen/Hilfslinien, Zoom und Auswahl-Overlay. |
| **Eigenschaften** (rechts) | Typisierte Editoren für die Attribute des ausgewählten Elements, plus *Eigenschaft hinzufügen*. Größenveränderbar. |

Beide Seitenpanels lassen sich einklappen und in der Größe ändern; Panelbreiten und Position der
Symbolleiste werden pro Fenster gemerkt.

### Die Vorschau-Symbolleiste

Die Symbolleiste schwebt über der Vorschau. Sie kann angedockt (oben/unten/links/rechts) oder
schwebend gelassen werden und merkt sich ihren Platz pro Fenster. Zwei ihrer Schaltflächen sehen je
nach Zustand anders aus, deshalb hier beide üblichen Konfigurationen.

**Entwurfsansicht** — die Schaltfläche Entwurf ist aktiv und dehnt sich zu einer beschrifteten Pille
aus. Die Zoom-Bedienelemente sind sichtbar und der Statuspunkt des Hosts ist grün (der WPF-Host läuft
und rendert einwandfrei):

![Symbolleiste in der Entwurfsansicht](../images/toolbar-design.png)

**Änderungsansicht** — die Schaltfläche Änderungen ist aktiv und zeigt die Anzahl ausstehender
Änderungen. Die Zoom-Bedienelemente verschwinden (sie gehören zur Entwurfsoberfläche, nicht zum Diff),
das Werkzeug Verschieben ist ausgewählt, und der Punkt ist grau, weil dieses Fenster den Web-Renderer
verwendet:

![Symbolleiste in der Änderungsansicht](../images/toolbar-changes.png)

Diese beiden Unterschiede sind voneinander unabhängig: **das Zoom-Panel ist ausschließlich deshalb
verborgen, weil der Ansichtsmodus Änderungen ist**, und **die Farbe des Punkts hängt nur vom
Vorschau-Backend und vom Renderstatus des Hosts ab** — nicht vom Ansichtsmodus.

#### Jedes Bedienelement, von links nach rechts

| Icon | Bedienelement | Typ | Was es tut |
|:----:|---------------|-----|------------|
| ![](../images/icons/gripper.png) | **Symbolleiste verschieben** | Ziehgriff | Ziehe die Symbolleiste; lasse sie nahe einem Rand los, um sie anzudocken. |
| ![](../images/icons/layout-sidebar-left.png) | **Struktur anzeigen** | Schaltfläche *(bedingt)* | Öffnet das Struktur-Panel wieder. Nur sichtbar, solange dieses Panel eingeklappt ist. |
| ![](../images/icons/pan.png) | **Verschieben (Pan)** | Werkzeug | Ziehen scrollt die Vorschau. Jederzeit auch mit der mittleren Maustaste verfügbar. |
| ![](../images/icons/move.png) | **Auswählen / bewegen** | Werkzeug | Elemente auswählen, per Ziehen bewegen, mit den 8 Griffen in der Größe ändern. |
| ![](../images/icons/list-tree.png) | **Umsortieren** | Werkzeug | Ziehe Elemente in der Vorschau, um ihre Geschwisterreihenfolge zu ändern, wie im Baum. **Das ist das Standardwerkzeug.** |
| ![](../images/icons/eye.png) | **Auto-Aufklappen** | Umschalter | Öffnet automatisch die Liste/das Menü des ausgewählten Elements (ComboBox, Menu, …). **Standardmäßig an.** |
| ![](../images/icons/discard.png) | **Rückgängig** | Schaltfläche | Macht die letzte Bearbeitung rückgängig (der native Undo-Stack von VS Code). |
| ![](../images/icons/redo.png) | **Wiederholen** | Schaltfläche | Wiederholen. |
| ![](../images/icons/trash.png) | **Löschen** | Schaltfläche | Löscht das ausgewählte Element (wie die Taste <kbd>Entf</kbd>). |
| ![](../images/icons/edit.png) | **Entwurf** | Ansichts-Umschalter | Die Live-Entwurfsoberfläche. Dehnt sich bei Aktivierung zu einer beschrifteten Pille aus. |
| ![](../images/icons/git-compare.png) | **Änderungen** | Ansichts-Umschalter | Der Diff gegen die gespeicherte Datei. Aktiv zeigt er *Änderungen (n)*; inaktiv nur *n* als Abzeichen, und gar nichts, wenn es keine Änderungen gibt. |
| ![](../images/icons/symbol-numeric.png) | **Raster** | Umschalter | Das Punktraster-Overlay. Einschalten aktiviert auch das Einrasten am Raster — es gibt keine separate Magnet-Schaltfläche. **Standardmäßig aus.** |
| ![](../images/icons/symbol-ruler.png) | **Lineale** | Umschalter | Lineale, ziehbare Hilfslinien und Einrasten an Hilfslinien. **Standardmäßig an.** |
| ![](../images/icons/symbol-color.png) | **Vorschau-Design** | Menü | Alle im Projekt gefundenen Ressourcenwörterbuch-Designs, darunter der Standardsatz: Classic, Classic '98, System, Light, Dark, Native. Siehe [Abschnitt 6](#6-vorschau-backends). |
| ![](../images/icons/server-process.png) | **Vorschau-Engine** | Menü | `Auto`, `Web` und — nur unter Windows — `WPF host` und `WPF host — isolated`. Siehe [Abschnitt 6](#6-vorschau-backends). |
| ![](../images/icons/play.png) | **Fenster ausführen** | Menü | Öffnet das XAML in einem echten Windows-Fenster: *Snapshot* (einmalig) oder *Live* (folgt dem Projekt). WPF-Engine, nur unter Windows. |
| ![](../images/icons/package.png) | **Projektressourcen** | Dialog | Wähle aus, welche Steuerelement-DLLs, `App.xaml` und Ressourcenwörterbücher geladen werden. Siehe [Abschnitt 7](#7-projektressourcen-wpf-host). |
| ![](../images/icons/dot-ok.png) | **Host-Status** | Anzeige + Schaltfläche | Der Zustand des WPF-Hosts (siehe Tabelle unten). Klicken öffnet die Konsole/das Protokoll. |
| ![](../images/icons/layout-sidebar-right.png) | **Eigenschaften anzeigen** | Schaltfläche *(bedingt)* | Öffnet das Eigenschaften-Panel wieder. Nur sichtbar, solange dieses Panel eingeklappt ist. |
| ![](../images/icons/triangle-right.png) | **Symbolleiste skalieren** | Ziehgriff *(bedingt)* | Ziehen ändert die Größe der Symbolleiste. Nur sichtbar, solange sie schwebt (nicht angedockt). |

Verschieben, Auswählen und Umsortieren schließen sich gegenseitig aus — genau eines ist immer aktiv.

#### Der Host-Statuspunkt

| Punkt | Bedeutung |
|:-----:|-----------|
| ![](../images/icons/dot-ok.png) | Der WPF-Host läuft und der letzte Render war erfolgreich. |
| ![](../images/icons/dot-idle.png) | Der WPF-Host startet gerade. |
| ![](../images/icons/dot-error.png) | Der WPF-Host meldete einen Renderfehler. Die Konsole öffnet sich automatisch. |
| ![](../images/icons/dot-inactive.png) | Kein WPF-Host: entweder bist du nicht unter Windows, oder die Vorschau-Engine steht auf `Web`. Das ist kein Fehler. |

Ein **blauer Ring** um den Punkt bedeutet, dass gerade Projektressourcen geladen sind. Ein Klick auf
den Punkt öffnet immer die Konsole/das Protokoll, unabhängig von seiner Farbe. Ist der Host isoliert,
sagt das sein Tooltip.

#### Das Zoom-Panel

![](../images/icons/zoom-out.png) ![](../images/icons/zoom-in.png)
![](../images/icons/screen-full.png)

Der Zoom **gehört nicht zur Symbolleiste** — er ist ein eigenes kleines Panel in der unteren rechten
Ecke der Vorschau: *herauszoomen*, der aktuelle Prozentwert (Klick setzt auf 100 % zurück),
*hineinzoomen* und *Einpassen*. In der Änderungsansicht ist es verborgen. Ist die Symbolleiste am
unteren Rand angedockt und Platz vorhanden, dockt das Zoom-Panel an ihr rechtes Ende an — deshalb
wirkt es im obigen Entwurfs-Screenshot wie eine einzige Leiste.

---

## 5. Funktionen

### 5.1 Strukturbaum & Umsortieren

Der Baum spiegelt die XAML-Hierarchie. Klicke einen Knoten an, um ihn auszuwählen (das passende
Element wird in der Vorschau hervorgehoben). **Ziehe einen Knoten**, um ihn umzusortieren: Ablagezonen
zeigen *davor*, *hinein* oder *danach* an, und das Ablegen im eigenen Teilbaum ist blockiert. Der
Verschiebevorgang wird als chirurgisches `moveElement` angewandt und erhält die Einrückung.

### 5.2 Visuelles Bearbeiten — Bewegen & Skalieren

Klicke mit dem Werkzeug **Auswählen** ein Element in der Vorschau an. Dann:

- **Bewegen** durch Ziehen. Je nach Layout des Elternelements aktualisiert das Bewegen `Margin` (die
  meisten Panels) oder `Canvas.Left/Top` (innerhalb eines `Canvas`).
- **Skalieren** über die **8 Griffe** (Ecken + Kanten); das aktualisiert `Width`/`Height` (und wo
  nötig `Margin`).
- Eine **Live-Vorschau** folgt deiner Geste; beim Loslassen wird die Änderung als ein einziger
  chirurgischer Schreibvorgang (`setAttributes`) festgeschrieben.

![Ein ausgewähltes Element mit seinen 8 Skaliergriffen](../images/screen-drag-resize.png)

### 5.3 Elemente hinzufügen / löschen / kopieren

- **Hinzufügen** eines Elements über die Symbolleiste: wähle aus 15 gängigen Typen (Grid, StackPanel,
  Canvas, Border, TextBlock, Label, Button, TextBox, CheckBox, RadioButton, Slider, ProgressBar,
  Image, Ellipse, Rectangle). Ein Standard-Snippet wird in den ausgewählten Container eingefügt.
- **Löschen** des ausgewählten Elements mit der **Entf**-Taste.
- **Kopieren / Ausschneiden / Einfügen** eines Teilbaums mit **Strg+C / Strg+X / Strg+V** (als
  Geschwister oder Kind einfügen). Die Zwischenablage ist die **System-Zwischenablage** — das Element
  wird als XAML-Fragment kopiert, funktioniert also **zwischen XVE-Fenstern** und in beide Richtungen
  mit einem **Texteditor**. Die optionale `x:Name`-Deduplizierung beim Einfügen (Einstellung
  `xve.paste.nameDeduplication`, standardmäßig aus) benennt kollidierende Namen eindeutig um, ohne das
  Original anzutasten.

### 5.4 Eigenschaftenpanel

<img src="../images/screen-properties.png" align="right" width="280"
     alt="Das Eigenschaftenpanel mit geöffneter Farbauswahl und einem geänderten Attribut">

Das Panel zeigt **typisierte Editoren** je nach Art der Eigenschaft:

| Art | Editor |
|-----|--------|
| `bool` | Kontrollkästchen |
| `enum` | Auswahlliste |
| `number` | Zahlenfeld |
| `brush` | Farbauswahl |
| `thickness` | vier Felder L,T,R,B |
| `string` | Textfeld |

Es deckt gängige Eigenschaften ab (Name, Width/Height, Min/Max-Größen, Margin, Padding, Ausrichtung,
Background/Foreground, BorderBrush/Thickness, Schriften, Opacity, Visibility, IsEnabled…), angehängte
Eigenschaften (`Grid.Row/Column`, `Canvas.Left/Top`, `DockPanel.Dock`) sowie typspezifische (Text,
Content, IsChecked, Value/Minimum/Maximum usw.).

Nutze **„+ Eigenschaft hinzufügen“**, um eine beliebige bekannte Eigenschaft zu ergänzen, und die
Bedienelemente pro Attribut, um eine zu entfernen. **Seit dem letzten Speichern geänderte** Attribute
werden mit einem farbigen Balken hervorgehoben und erhalten eine **Zurücksetzen**-Schaltfläche pro
Attribut — im Screenshot wurde `BorderBrush` mit der Farbauswahl bearbeitet, während
`VerticalAlignment` unangetastet ist.

<br clear="right">

### 5.5 Änderungsansicht (Diff)

Schalte die Symbolleiste von **Entwurf** auf **Änderungen**, um alles zu sehen, was von der
**gespeicherten Datei** abweicht: geänderte Attribute, hinzugefügte Elemente, entfernte Elemente und
verschobene Elemente (erkannt über einen LCS-Baumabgleich, sodass eine Umsortierung nicht als
Hinzufügen+Löschen gemeldet wird). Jeder Eintrag hat eine **Zurücksetzen-pro-Block**-Schaltfläche, und
es gibt eine Aktion **Alles zurücksetzen**. Ein Klick auf einen Eintrag wählt das Element in der
Vorschau aus. Zurücksetzen nutzt dieselben chirurgischen Operationen wie das Bearbeiten.

![Die Änderungsansicht mit geänderten, hinzugefügten und entfernten Einträgen](../images/screen-changes.png)

### 5.6 Zoom & Navigation

Der Zoom reicht von **10 bis 800 %**. Nutze das Zoom-Panel in der unteren rechten Ecke der Vorschau,
**Strg+Scrollen** (am Cursor verankert) oder **Einpassen**, um die Vorschau ins Fenster einzupassen.
Standardmäßig (`xve.preview.fitOnOpen`) wird ein Dokument beim Öffnen eingepasst: verkleinert, wenn es
größer als die Ansicht ist, sonst bei 100 % gezeigt (nie vergrößert). **Verschiebe** mit dem
Verschieben-Werkzeug oder der mittleren Maustaste. Lineale, Hilfslinien und Einrasten berücksichtigen
den aktuellen Zoom.

### 5.7 Lineale, Hilfslinien & Rastereinrasten

Schalte **Lineale** (oben/links) und ein Punkt-**Raster**-Overlay über die Symbolleiste um. Füge eine
**Hilfslinie** durch Klick auf ein Lineal hinzu; ziehe sie zum Verschieben, Doppelklick zum Entfernen.
Beim Bewegen/Skalieren **rasten** Elemente am Raster und an Hilfslinien ein. Rasterschritt und
Einrastschwelle setzt `xve.canvas.gridStep` (Standard 8 px).

### 5.8 Auswahlsynchronisation mit dem Texteditor

Wenn ein Texteditor daneben geöffnet ist, ist die Auswahl **bidirektional**:

- **Visuell → Text** (`xve.sync.selectInTextEditor`): Das Auswählen eines Elements bewegt den
  Textcursor zu dessen öffnendem Tag. Unten springt der Editor zu Zeile 10, wenn die zweite
  `CheckBox` im Strukturbaum ausgewählt wird.

  ![Auswählen im Baum bewegt den Textcursor dorthin](../images/screen-sync1.png)

- **Text → visuell** (`xve.sync.selectFromTextCursor`): Das Bewegen des Cursors im Code wählt das
  passende Element in der Vorschau aus. Unten steht der Cursor in Zeile 9, und die erste `CheckBox`
  ist in der Vorschau mit ihren Skaliergriffen ausgewählt.

  ![Das Bewegen des Textcursors wählt das passende Element aus](../images/screen-sync2.png)

Beide Richtungen sind standardmäßig aktiv und lassen sich unabhängig umschalten. Der Texteditor kann
unter dem visuellen Editor geteilt oder daneben platziert werden — beide Anordnungen funktionieren.

### 5.9 Sprache der Oberfläche

Die Oberfläche ist in **7 Sprachen** lokalisiert. Setze `xve.language` (leer = VS Code folgen). Lade
danach das Webview mit **Strg+R** neu, damit es wirkt.

---

## 6. Vorschau-Backends

![Vorschau-Backends](../images/preview-backends.png)

XVE hat zwei Rendering-Engines, wählbar über **`xve.previewBackend`**:

- **`auto`** (Standard) — WPF-Host unter Windows, Web-Renderer überall sonst.
- **`web`** — der plattformübergreifende Web-Renderer (XAML-Teilmenge → HTML/CSS).
- **`wpf-host`** — der Windows-WPF-Host (echte WPF-Engine, hohe Wiedergabetreue).

Du kannst die Engine auch pro Fenster über die Engine-Auswahl der Symbolleiste überschreiben, die
einen vierten Eintrag bietet: *WPF host — isolated* (siehe [Isolation](#isolation-xvepreviewisolation)
weiter unten). Scheitert der WPF-Host oder läuft er in ein Timeout, fällt XVE automatisch auf den
Web-Renderer zurück; kann er überhaupt nicht starten — am häufigsten, weil die **.NET 10 Desktop
Runtime** fehlt — erhältst du eine Benachrichtigung mit Download-Link.

### Stile und Ressourcen im Web-Renderer

Der Web-Renderer ist mehr als eine Zuordnung von Tag zu `<div>`. Vor dem Rendern extrahiert XVE die
CSS-abbildbare Teilmenge der Dokumentressourcen und wendet sie an:

- **Pinsel** — `SolidColorBrush`- und `ImageBrush`-Ressourcen, per Schlüssel referenziert.
- **Stile** — ein `Style` mit einfachen `Setter`n (Eigenschaften, die der Renderer versteht),
  einschließlich **`BasedOn`-Ketten**, die abgeflacht werden.
- **Implizite Stile** — ein schlüsselloser `Style` mit `TargetType` gilt für jedes Element dieses Typs,
  genau wie in WPF.
- **Ressourcenauflösung** — `{StaticResource key}` und `{DynamicResource key}` werden gegen die
  Ressourcenwörterbücher des Dokuments aufgelöst.

Die Vorrangregel folgt WPF: impliziter Stil → benannter Stil (mit seiner `BasedOn`-Kette) →
Inline-Attribut, wobei das Inline-Attribut immer gewinnt. Alles außerhalb dieser Teilmenge (Trigger,
Templates, Konverter, Datenbindungen) ignoriert der Web-Renderer — nutze den WPF-Host, wenn du es
originalgetreu brauchst.

### Vorschau-Designs

Die Designauswahl (![](../images/icons/symbol-color.png)) bietet den Standardsatz — **Classic** (reines
WPF), **Classic '98** und die Fluent-Varianten **Light** / **Dark** / **System**, die der WPF-Host über
`ThemeMode` anwendet. Alle **im Projekt gefundenen Ressourcenwörterbuch-Designs** stehen darüber und
lassen sich genauso anwenden. `Native` ist eine GTK/Linux-Optik und betrifft nur den Web-Renderer (der
WPF-Host fällt auf Classic zurück).

![Dasselbe Formular in mehreren Vorschau-Designs, inkl. Projektwörterbüchern](../images/screen-themes.png)

### Optionen des WPF-Hosts

| Einstellung | Zweck |
|-------------|-------|
| `xve.preview.theme` | Vorschau-Design: `none` (Classic), `classic98`, `system`/`light`/`dark` (Fluent), `native` (GTK-Optik, nur Web). |
| `xve.preview.renderScale` | Supersampling: `auto` = Device Pixel Ratio (scharf auf HiDPI), oder `1`/`1.5`/`2`/`3`. |
| `xve.preview.maxResolution` | Obergrenze der Bitmapgröße (längere Seite, Gerätepixel). `0` = unbegrenzt. |
| `xve.preview.viewportRender` | Nur den sichtbaren Bereich rendern — schneller bei großen Entwürfen. |
| `xve.preview.capBasis` | Render des sichtbaren Bereichs: `maxResolution` nur am sichtbaren Bereich messen (`visible`, stabile Schärfe über Fenstergrößen hinweg) oder am ganzen Ausschnitt inkl. Overscan (`slice`, altes Verhalten). |
| `xve.preview.overscan` | Render des sichtbaren Bereichs: zusätzlicher Rand (Projekteinheiten), der um den sichtbaren Bereich als Scroll-Puffer gerendert wird. |
| `xve.preview.debugConsole` | Zeigt eine Debug-Konsole am unteren Rand der Vorschau mit Live-Render-Telemetrie. |
| `xve.preview.consoleOnStart` | Dockt die Konsole an, während der Host startet. Ausgeschaltet öffnet sie sich dennoch bei einem Renderfehler von selbst. |
| `xve.preview.isolation` | Ob eine Datei einen eigenen Hostprozess und eigene Ressourcen erhält (siehe unten). |

### Adaptive Auflösung

Eine große Oberfläche bei jedem Frame eines Ziehvorgangs in voller HiDPI-Auflösung zu rendern, ist
teuer. Mit **`xve.preview.adaptiveRes`** (**standardmäßig an**) rendert der Host in reduzierter
Auflösung (`xve.preview.motionResolution`, Standard 512 px an der längeren Seite), *während du ziehst,
scrollst oder zoomst*, und rendert einmal in voller `maxResolution` neu, sobald die Bewegung stoppt.
Schnelle Bewegung bleibt flüssig, das ruhende Bild bleibt scharf.

Die Verschlechterung ist nicht bedingungslos: sie greift nur, wenn der Render in voller Auflösung
unter **`xve.preview.adaptiveFpsThreshold`** Bilder pro Sekunde fällt (Standard 30). Auf einer
schnellen Maschine mit kleinem Entwurf verlässt du daher nie die volle Auflösung. Setze die Schwelle
auf `0`, um bei Bewegung immer die Bewegungsauflösung zu nutzen.

### Live-Vorschau-Strategie beim Ziehen/Skalieren

Beim Ziehen/Skalieren im WPF-Host-Modus wird das Live-Neurendern gesteuert durch:

- `xve.preview.dragStrategy` — `overlay` (kein Live-Neurendern), `frames` (alle N Frames) oder `ms`
  (alle N Millisekunden, der Standard).
- `xve.preview.dragIntervalMs` (Standard 25), `xve.preview.dragFrames` (Standard 2).
- `xve.preview.dragCoalesce` — höchstens einen Render „in flight“ halten (veraltete Frames verwerfen).
- `xve.preview.dragSession` — einmal parsen und einen gecachten Baum mutieren statt neu zu parsen.
- `xve.preview.dragOnChange` — nur dann einen neuen Frame rendern, wenn sich die Attribute des
  gezogenen Elements tatsächlich ändern; den Zeiger stillzuhalten kostet also nichts.
- `xve.preview.debugLiveDrag` — auch die Telemetrie der Debug-Konsole bei jedem Ziehframe auffrischen.

### Isolation (`xve.preview.isolation`)

Der WPF-Host kann Projektressourcen laden, die beeinflussen, wie benutzerdefinierte Typen gerendert
werden. Die Isolation steuert, ob eine Datei einen Host teilt oder einen eigenen bekommt:

- `ask` — bei einer Datei aus einem anderen Projekt (oder ohne Projekt) nachfragen, ob isoliert wird.
- `auto` (Standard) — solche Dateien automatisch isolieren; innerhalb des offenen Projekts einen Host
  teilen.
- `shared` — nie isolieren (ein Host für alles).
- `isolated` — immer isolieren (ein eigener Host pro Datei).

---

## 7. Projektressourcen (WPF-Host)

Für eine originalgetreue Vorschau von **benutzerdefinierten Steuerelementen** und Projektdesigns kann
der WPF-Host die Ressourcen deines Projekts laden. XVE sucht von der XAML-Datei aufwärts nach einer
`.csproj`, findet dann die beste Ausgabe `bin/<Config>/<tfm>` sowie `App.xaml` und
Ressourcenwörterbücher.

- Die Auswahl wird in einem **QuickPick** angeboten und pro Projekt gemerkt; die Richtlinie setzt
  **`xve.project.autoLoadResources`** (`ask` / `always` / `never`).
- Der Host lädt die **DLLs** benutzerdefinierter Steuerelemente (über `AssemblyResolve` für
  `clr-namespace`-Typen) und führt `App.xaml` / Wörterbücher in `Application.Resources` zusammen.
- Nutze die Schaltfläche **Projektressourcen** (![](../images/icons/package.png)) in der
  Vorschau-Symbolleiste, um die Ressourcen jederzeit neu zu wählen.

![Ein benutzerdefiniertes Steuerelement, gerendert vom WPF-Host, mit der Ressourcenauswahl](../images/screen-wpf-host.png)

---

## 8. Fehlerbehandlung

Wenn XAML nicht geparst oder gerendert werden kann, hilft XVE beim Finden und Beheben:

- **Änderungen im Code hervorheben** (`xve.editor.highlightChanges`) — geänderte Zeilen werden im
  danebenliegenden Texteditor eingefärbt (spiegelt den Umschalter des Änderungen-Panels).
- **Fehler im Code hervorheben** (`xve.editor.highlightErrors`) — die Fehlerzeile wird eingefärbt und
  das beanstandete Token unterstrichen. Ein Klick auf den Fehler zeigt ihn im Texteditor.
- **Auto-Fix-Vorschläge** — bei einem unbekannten Typ oder einer unbekannten Eigenschaft schlägt XVE
  über Editierdistanz den nächstliegenden bekannten Namen vor (z. B. `Buton` → `Button`).
- **Die Konsole** — klicke auf den Host-Statuspunkt, um sie zu öffnen. Bei einem Renderfehler öffnet
  sie sich von selbst, egal was `xve.preview.consoleOnStart` sagt.

![Die Host-Konsole zeigt einen Renderfehler](../images/screen-host-console.png)

### Wenn der WPF-Host nicht starten kann

Fehlt die Host-Binärdatei, ist die **.NET 10 Desktop Runtime** nicht installiert, oder stirbt der
Prozess beim Start, zeigt XVE eine Benachrichtigung, welcher der drei Fälle eingetreten ist, und fällt
stillschweigend auf den Web-Renderer zurück. Die Benachrichtigung bietet an, die Runtime
herunterzuladen oder `xve.previewBackend` auf `web` zu setzen, damit der Host gar nicht mehr versucht
wird. Jede Fehlerart wird einmal pro Sitzung gemeldet.

---

## 9. Einstellungsreferenz

Alle Einstellungen liegen unter **`xve.*`**. Die meisten sind fensterbezogen, verschiedene
VS-Code-Fenster können sich also unterscheiden. Die Standardwerte unten entsprechen `package.json`.

| Einstellung | Typ | Standard | Beschreibung |
|-------------|-----|----------|--------------|
| `xve.language` | enum | `""` | Sprache der Oberfläche (`""`=VS Code folgen, `en`,`pl`,`es`,`de`,`fr`,`ja`,`zh`). Mit Strg+R neu laden. |
| `xve.project.autoLoadResources` | enum | `ask` | Wie Projektressourcen für den WPF-Host geladen werden: `ask` / `always` / `never`. |
| `xve.sync.selectInTextEditor` | bool | `true` | Das Auswählen eines Elements bewegt den Textcursor dorthin. |
| `xve.sync.selectFromTextCursor` | bool | `true` | Das Bewegen des Textcursors wählt das passende Element aus. |
| `xve.editor.highlightChanges` | bool | `true` | Geänderte Zeilen im Texteditor einfärben. |
| `xve.editor.highlightErrors` | bool | `true` | Fehlerzeile im Texteditor einfärben/unterstreichen. |
| `xve.paste.nameDeduplication` | enum | `off` | `x:Name`-Kollisionen beim Einfügen: `off` (unverändert einfügen) / `rename` / `renameAndReferences` (korrigiert zusätzlich `ElementName`, `x:Reference` im eingefügten Teilbaum). |
| `xve.previewBackend` | enum | `auto` | Vorschau-Engine: `auto` / `web` / `wpf-host`. |
| `xve.preview.isolation` | enum | `auto` | Isolation des WPF-Hosts: `ask` / `auto` / `shared` / `isolated`. |
| `xve.preview.renderScale` | enum | `auto` | Supersampling: `auto` / `1` / `1.5` / `2` / `3`. |
| `xve.preview.maxResolution` | number | `1536` | Maximale Bitmapgröße (längere Seite, Gerätepixel). `0`=unbegrenzt. |
| `xve.preview.theme` | enum | `none` | Vorschau-Design: `none` / `classic98` / `system` / `light` / `dark` / `native`. |
| `xve.preview.viewportRender` | bool | `true` | Nur den sichtbaren Bereich rendern. |
| `xve.preview.capBasis` | enum | `visible` | Render des sichtbaren Bereichs: Grenzbasis — `visible` / `slice`. |
| `xve.preview.overscan` | number | `100` | Render des sichtbaren Bereichs: Rand (Projekteinheiten) um den sichtbaren Bereich. |
| `xve.preview.debugConsole` | bool | `false` | Debug-Konsole mit Render-Telemetrie am unteren Rand der Vorschau. |
| `xve.preview.consoleOnStart` | bool | `true` | Konsole andocken, während der Host startet. Aus = beim Start verborgen, aber bei Renderfehler dennoch gezeigt. |
| `xve.preview.debugLiveDrag` | bool | `false` | Konsolen-Telemetrie auch bei jedem Ziehframe auffrischen. |
| `xve.preview.dragStrategy` | enum | `ms` | Live-Zieh-Strategie: `overlay` / `frames` / `ms`. |
| `xve.preview.dragIntervalMs` | number | `25` | Für `ms`: minimaler Abstand zwischen Live-Neurenderungen (ms). |
| `xve.preview.dragFrames` | number | `2` | Für `frames`: alle N Frames neu rendern. |
| `xve.preview.dragCoalesce` | bool | `true` | Während Ziehen/Scrollen höchstens einen Render „in flight“ halten. |
| `xve.preview.dragSession` | bool | `true` | Persistente Ziehsitzung (einmal parsen, gecachten Baum mutieren). |
| `xve.preview.dragOnChange` | bool | `true` | Während eines Ziehvorgangs nur rendern, wenn sich die Attribute wirklich ändern. |
| `xve.preview.adaptiveRes` | bool | `true` | Adaptive Auflösung: bei Bewegung mit `motionResolution` rendern, danach einmal mit voller `maxResolution`. |
| `xve.preview.motionResolution` | number | `512` | Auflösung (längere Seite, Gerätepixel) bei Bewegung, wenn adaptive Auflösung an ist. |
| `xve.preview.adaptiveFpsThreshold` | number | `30` | Nur dann auf `motionResolution` heruntergehen, wenn der Voll-Render unter diese FPS fällt. `0` = immer. |
| `xve.preview.fitOnOpen` | bool | `true` | Vorschau beim Öffnen ins Fenster einpassen (nie vergrößern). |
| `xve.canvas.gridStep` | number | `8` | Rasterschritt & Einrastschwelle, in Pixeln. |
| `xve.canvas.showGrid` | bool | `false` | Voreinstellung für das Punktraster-Overlay. |
| `xve.canvas.showRulers` | bool | `true` | Voreinstellung für Lineale/Hilfslinien. |

### Befehle

| Befehl | Titel | Wann |
|--------|-------|------|
| `xve.openVisualEditor` | XVE: Open in XAML Visual Editor | `.xaml` als Text geöffnet |
| `xve.openTextEditor` | XVE: Open XAML as Text | `.xaml` im visuellen Editor geöffnet |

---

## 10. Tastenkürzel

| Kürzel | Aktion |
|--------|--------|
| **Strg+Z / Strg+Y** | Rückgängig / Wiederholen (nativ von VS Code, über das TextDocument) |
| **Entf** | Ausgewähltes Element löschen |
| **Strg+C / Strg+X / Strg+V** | Ausgewählten Teilbaum kopieren / ausschneiden / einfügen (System-Zwischenablage, XAML) |
| **Strg+Scrollen** | Hinein-/Herauszoomen, am Cursor verankert |
| **Mittlere Maustaste / Verschieben-Werkzeug** | Die Zeichenfläche verschieben |
| **Strg+R** | Webview neu laden (z. B. um einen Sprachwechsel anzuwenden) |

XVE registriert keine eigenen Tastenbelegungen; es stützt sich auf die eingebauten Editorbefehle von
VS Code.

---

## 11. Architektur

![Architektur](../images/architecture.png)

Die Erweiterung läuft in zwei zusammenarbeitenden Kontexten, plus einem optionalen nativen Host:

- **Extension Host (Node/TS)** — `extension.ts` aktiviert die Erweiterung und registriert die Befehle;
  `XveEditorProvider` ist der `CustomTextEditorProvider`. Die Module in `core/` leisten die eigentliche
  Arbeit: `XamlDocument` (chirurgisches Speichern), `XamlParser` (positionsbewusster Tokenizer),
  `StructuralDiff` / `LineDiff`, `TypeRegistry` (Typen & Eigenschafts-Metadaten), `ResourceModel`
  (Pinsel, Stile, `BasedOn`), `ProjectScanner` (`.csproj` → DLLs und Wörterbücher), `PasteNames`
  (`x:Name`-Deduplizierung) und `Localization`. `host/WpfHost` verwaltet den WPF-Host-Prozess und
  meldet fatale Startfehler.
- **Webview (HTML/CSS/TS)** — `main.ts` steuert Baum, Eigenschaften, Symbolleiste und Oberfläche;
  `renderer.ts` ist der Web-Renderer XAML→DOM; `styleResolver.ts` wendet die extrahierten
  XAML-Stile/-Ressourcen als CSS an; `style.css` ist das Drei-Panel-Layout. Es spricht über
  `postMessage` mit dem Extension Host.
- **WPF-Host (Windows)** — `xve-wpf-host.exe` (.NET 10) rendert XAML mit der echten WPF-Engine zu einem
  PNG plus einer Hit-Test-Karte (über injizierte `x:Uid`), über ein JSON-lines-Protokoll auf stdio. Er
  kann projektweit geteilt oder pro Datei isoliert laufen.

### Bearbeitungsfluss

![Bearbeitungsfluss](../images/edit-flow.png)

Jede Bearbeitung — eine Eigenschaftsänderung, ein Ziehen/Skalieren, eine Umsortierung — wird von
`XamlDocument` in die kleinstmögliche Menge von Textbearbeitungen übersetzt, über einen
`WorkspaceEdit` angewandt; danach wird das Dokument neu geparst und die Vorschau neu gerendert. Weil
das `TextDocument` stets die Quelle der Wahrheit ist, sind Rückgängig/Wiederholen nativ, und
unangetastete Regionen ändern sich nie.

---

## 12. Beispieldateien

Der Ordner `samples/` enthält XAML-Dateien, die du zum Erkunden des Editors öffnen kannst:

| Datei | Zeigt |
|-------|-------|
| [`samples/SampleGrid.xaml`](../../samples/SampleGrid.xaml) | Ein Formular-Layout mit `Grid`, `RowDefinitions`/`ColumnDefinitions`, Spans und Ausrichtung. |
| [`samples/SampleControls.xaml`](../../samples/SampleControls.xaml) | `Menu`, `ComboBox` und ein `ScrollViewer` — gut zum Testen des Auto-Aufklappens und des bereichsweisen Scrollens. |
| `samples/Sample.xaml`, `Sample2.xaml` | Einfache Beispiele mit `Window` + `StackPanel`. |

Wähle in `SampleControls.xaml` bei eingeschaltetem Auto-Aufklappen ein `MenuItem` oder eine `ComboBox`,
um Untermenü/Liste aufzuklappen; fahre über den `ScrollViewer` und scrolle mit dem Rad nur diesen
Bereich.

---

## 13. Fehlerbehebung / FAQ

**Die `.xaml`-Datei öffnet sich als reiner Text, nicht im visuellen Editor.**
Das ist Absicht — der visuelle Editor ist eine *Option*. Nutze die Schaltfläche in der Titelleiste oder
`xve.openVisualEditor` zum Wechseln.

**Die Vorschau wirkt ungefähr / benutzerdefinierte Steuerelemente erscheinen als Platzhalter.**
Du bist vermutlich im Web-Renderer. Setze unter Windows `xve.previewBackend` auf `auto` oder
`wpf-host` und lade dann die [Projektressourcen](#7-projektressourcen-wpf-host) über die Schaltfläche
**Projektressourcen**.

**Der Host-Statuspunkt bleibt grau und die Vorschau nutzt nie WPF.**
Grau heißt, der Host ist nicht aktiv — entweder bist du nicht unter Windows, oder
`xve.previewBackend` steht auf `web`. Hast du auf `wpf-host` umgestellt und es bleibt grau, achte auf
die Fehlerbenachrichtigung: die häufigste Ursache ist eine fehlende
[.NET 10 Desktop Runtime](https://dotnet.microsoft.com/download/dotnet/10.0). Beachte, dass die
*Desktop*-Runtime ein separater Download gegenüber der einfachen .NET-Runtime ist.

**Benutzerdefinierte Typen rendern im WPF-Host immer noch nicht.**
Stelle sicher, dass das Projekt gebaut ist (damit die DLLs unter `bin/...` liegen) und dass du die
richtigen Ressourcen ausgewählt hast. Klicke auf den Host-Statuspunkt, um das Protokoll zu lesen.

**Die Oberfläche ist in der falschen Sprache.**
Setze `xve.language` und lade das Webview mit **Strg+R** neu.

**Große Entwürfe fühlen sich beim Ziehen langsam an.**
Lass `xve.preview.viewportRender` und `xve.preview.adaptiveRes` an — zusammen rendern sie nur den
sichtbaren Bereich, und während der Bewegung in reduzierter Auflösung. Ist es weiterhin schwer, senke
`xve.preview.motionResolution` (z. B. auf 384) oder erhöhe `xve.preview.adaptiveFpsThreshold`, damit
der Niedrigauflösungsmodus früher greift. Auf `0` gesetzt, wird bei Bewegung immer die
Bewegungsauflösung verwendet. Lass `dragStrategy` auf `ms`.

---

## 14. Entwicklungsgeschichte

XVE entstand in Etappen. Eine verdichtete Geschichte:

- **Etappe 8** — Layout-Treue & Eigenschaften: WPF-ähnliche Größenkoerzierung im Web-Renderer, ein
  vollständiger Satz gängiger Eigenschaften, ein originalgetreues `Grid`
  (`RowDefinitions`/`ColumnDefinitions`, Spans, Zellausrichtung), **Umsortieren** im Baum und
  **Projektressourcen** für den WPF-Host.
- **Etappe 7** — Rendern in Bildschirmauflösung (`renderScale`, Standard `auto`=Device Pixel Ratio),
  VS Code als Quelle der Wahrheit für `xve.preview.*`, und Performance-Arbeit am Host (Debounce +
  Coalescing, gecachter `ThemeMode`, wiederverwendete `RenderTargetBitmap`, Host-Vorwärmen).
- **Etappe 6** — **Zoom** (10–800 %, Strg+Scrollen, Einpassen), der **WPF-Host** (`wpf-host/`, .NET 10,
  JSON-lines), Viewport-Rendering, die Auflösungsgrenze und das Einstellungspanel.
- **Etappe 4** — `LineDiff` + `StructuralDiff` und die **Änderungen**-Ansicht mit Zurücksetzen pro
  Block und Alles zurücksetzen.
- **Etappe 3** — visuelles Bearbeiten (Ziehen/Skalieren), strukturelle Operationen in `XamlDocument`,
  die Hinzufügen/Löschen-Symbolleiste und Lineale/Hilfslinien/Einrasten mit stabilem Viewport.
- **Davor** — der eigene Texteditor für `*.xaml`, `XamlDocument` + positionsbewusster `XamlParser`, der
  Web-Renderer, die bidirektionale Auswahl, das typisierte Eigenschaftenpanel, die Lokalisierung
  (7 Sprachen) sowie Round-Trip-/Chirurgisches-Speichern-Tests.
