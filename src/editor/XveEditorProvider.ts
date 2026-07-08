import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import { XamlDocument } from "../core/XamlDocument.ts";
import type { TreeNodeDto } from "../core/XamlDocument.ts";
import { structuralDiff } from "../core/StructuralDiff.ts";
import type { Change } from "../core/StructuralDiff.ts";
import { changedLinesInB } from "../core/LineDiff.ts";
import { WpfHost } from "../host/WpfHost.ts";
import type { HostFatalKind } from "../host/WpfHost.ts";
import { scanProject, ProjectScan, ProjectItemKind } from "../core/ProjectScanner.ts";
import { extractResources, mergeModels, parseResx, resxLanguagesFromNames } from "../core/ResourceModel.ts";
import type { ResourceModel, ResourceState, ResourceStateItem } from "../core/ResourceModel.ts";
import { dictionaryForIndex, currentLanguageIndex, LANGUAGES, t, f } from "../core/Localization.ts";
import { isKnownType, closestKnownType, closestKnownProperty } from "../core/TypeRegistry.ts";
import { validXamlFragment, collectNames, deduplicateNames, fragmentSummary } from "../core/PasteNames.ts";
import type { DedupMode } from "../core/PasteNames.ts";

/** Strona pobierania środowiska uruchomieniowego wymaganego przez host WPF. */
const DOTNET_RUNTIME_URL = "https://dotnet.microsoft.com/download/dotnet/10.0";

/**
 * Custom *Text* Editor dla plików .xaml. Źródłem prawdy pozostaje TextDocument VS Code
 * (dzięki temu undo/redo, dirty i zapis działają natywnie). Webview pokazuje drzewo
 * struktury + źródło, a edycje atrybutów aplikujemy jako WorkspaceEdit — przy czym
 * nowy tekst liczymy chirurgicznie przez XamlDocument (nietknięte regiony bajt-w-bajt).
 */
export class XveEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = "xve.xamlEditor";

  static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      XveEditorProvider.viewType,
      new XveEditorProvider(context),
      { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false }
    );
  }

  /** Dekoracja zmienionych linii w edytorze tekstu (diff inline względem zapisanego pliku). */
  private readonly changedLineDecoration: vscode.TextEditorDecorationType;
  /** Dekoracja linii błędu renderu (czerwone tło całej linii). */
  private readonly errorLineDecoration: vscode.TextEditorDecorationType;
  /** Dekoracja podkreślenia błędu (czerwona falista linia na fragmencie). */
  private readonly errorRangeDecoration: vscode.TextEditorDecorationType;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.changedLineDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor("diffEditor.insertedLineBackground"),
      overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.addedForeground"),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    this.errorLineDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor("inputValidation.errorBackground"),
      overviewRulerColor: new vscode.ThemeColor("editorError.foreground"),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });
    this.errorRangeDecoration = vscode.window.createTextEditorDecorationType({
      textDecoration: "underline wavy var(--vscode-editorError-foreground)",
    });
    context.subscriptions.push(
      this.changedLineDecoration,
      this.errorLineDecoration,
      this.errorRangeDecoration,
      { dispose: () => this.disposeAllHosts() }
    );
  }

  private disposeAllHosts(): void {
    for (const h of this.hosts.values()) h.dispose();
    this.hosts.clear();
  }

  // --- izolacja hosta WPF (osobny proces + zasoby dla pliku spoza projektu) ---

  /** Klucz stanu (workspaceState) przechowujący per-okno nadpisanie izolacji. */
  private isoKey(uri: vscode.Uri): string {
    return "xve.isolation:" + uri.toString();
  }
  /**
   * Per-okno nadpisanie izolacji ustawione wprost z selektora silnika (WPF host / WPF host —
   * izolowany). `shared`/`isolated` rozstrzyga wprost; brak (lub „auto") = podążaj za globalną
   * polityką `xve.preview.isolation`.
   */
  private readIsolationOverride(document: vscode.TextDocument): "shared" | "isolated" | undefined {
    const ov = this.context.workspaceState.get<string>(this.isoKey(document.uri));
    return ov === "shared" || ov === "isolated" ? ov : undefined;
  }
  private async setIsolationOverride(
    uri: vscode.Uri,
    value: "auto" | "shared" | "isolated"
  ): Promise<void> {
    await this.context.workspaceState.update(this.isoKey(uri), value);
  }
  /**
   * Globalna polityka izolacji hosta WPF (`xve.preview.isolation`):
   *  - `ask`      — pytaj, czy izolować plik spoza projektu (domyślne)
   *  - `auto`     — izoluj automatycznie, gdy trzeba (plik spoza projektu), bez pytania
   *  - `shared`   — nigdy nie izoluj (jeden wspólny host)
   *  - `isolated` — zawsze izoluj (osobny host na każdy plik)
   */
  private isolationPolicy(): "ask" | "auto" | "shared" | "isolated" {
    const g = vscode.workspace.getConfiguration("xve").get<string>("preview.isolation") || "ask";
    return g === "auto" || g === "shared" || g === "isolated" ? g : "ask";
  }
  /** Czy plik należy do otwartego projektu/obszaru roboczego (jest w którymś folderze workspace). */
  private isInOpenProject(document: vscode.TextDocument): boolean {
    return !!vscode.workspace.getWorkspaceFolder(document.uri);
  }
  /**
   * Decyzja, czy dany panel ma używać hosta IZOLOWANEGO. Najpierw per-okno nadpisanie (selektor
   * silnika), potem globalna polityka. Dla `ask` + pliku spoza projektu pyta (jednorazowo, gdy
   * `interactive`); poza tym `auto`/`ask` + plik obcy → izoluj (domyślnie, bezpiecznie).
   */
  private async decideIsolated(
    document: vscode.TextDocument,
    interactive = true
  ): Promise<boolean> {
    if (!this.useWpfHost()) return false; // izolacja to pojęcie hosta WPF
    const override = this.readIsolationOverride(document);
    if (override === "isolated") return true;
    if (override === "shared") return false;
    const policy = this.isolationPolicy();
    if (policy === "isolated") return true;
    if (policy === "shared") return false;
    if (this.isInOpenProject(document)) return false; // auto/ask + w projekcie → współdziel
    if (policy === "auto") return true; // auto + plik obcy → izoluj bez pytania
    if (!interactive) return true; // ask, ale bez interakcji (zmiana trybu) → izoluj
    return this.proposeIsolation(document); // ask + plik obcy → zapytaj
  }
  /**
   * Pyta o izolację pliku spoza projektu. Trzy opcje: izoluj (raz, per-okno), izoluj zawsze gdy
   * trzeba i nie pytaj więcej (ustawia globalną politykę `auto`), albo wspólny host. Esc = izoluj.
   */
  private async proposeIsolation(document: vscode.TextDocument): Promise<boolean> {
    const name = document.fileName.split(/[\\/]/).pop() || "XAML";
    const isolate = t("Isolation.ProposeIsolate");
    const autoAlways = t("Isolation.ProposeAuto");
    const share = t("Isolation.ProposeShare");
    const pick = await vscode.window.showInformationMessage(
      f("Isolation.ProposeMsg", name),
      isolate,
      autoAlways,
      share
    );
    if (pick === autoAlways) {
      // od teraz izoluj automatycznie, gdy trzeba — bez pytania (cfgSub przeliczy resztę okien)
      await vscode.workspace
        .getConfiguration("xve")
        .update("preview.isolation", "auto", vscode.ConfigurationTarget.Global);
      return true;
    }
    const useIsolated = pick !== share; // dismiss/Esc → izoluj
    await this.setIsolationOverride(document.uri, useIsolated ? "isolated" : "shared");
    return useIsolated;
  }
  /** Migawka stanu izolacji dla webview (selektor silnika + sekcja ustawień + status hosta). */
  private isolationInfo(document: vscode.TextDocument, isolated: boolean) {
    return {
      effective: this.useWpfHost() ? (isolated ? "isolated" : "shared") : "off",
      policy: this.isolationPolicy(), // ask | auto | shared | isolated (sekcja Ustawień)
      override: this.readIsolationOverride(document) ?? "auto", // per-okno (informacyjnie)
      inProject: this.isInOpenProject(document),
    };
  }

  /**
   * Pula procesów hosta WPF (Windows). Klucz {@link SHARED} = host współdzielony przez wszystkie
   * okna należące do otwartego projektu/obszaru roboczego (te same zasoby). Klucz = URI dokumentu
   * = host IZOLOWANY: świeży proces z osobnymi zasobami dla pliku spoza projektu, dzięki czemu
   * zasoby załadowane w innych oknach/projektach nie wpływają na jego wygląd. Host izolowany jest
   * ubijany przy zamknięciu panelu (lub przy powrocie do trybu współdzielonego).
   */
  private readonly hosts = new Map<string, WpfHost>();
  private static readonly SHARED = "shared";
  // Zasoby aktualnie wczytane do danego procesu hosta (klucz puli → ostatni ładujący). Pozwala
  // oknu współdzielącemu host wykryć, że zasoby z innego okna wpływają na jego render (Etap 2 #3).
  private readonly hostResourceLoaded = new Map<
    string,
    { name: string; summary: string; key: string; uri: string }
  >();
  // klucze workspaceState
  private static selectionKey(projectDir: string): string {
    return "xve.project.selection:" + projectDir;
  }
  private static langKey(uri: vscode.Uri): string {
    return "xve.resxLanguage:" + uri.toString();
  }
  private static reflectKey(uri: vscode.Uri): string {
    return "xve.resxReflectCulture:" + uri.toString();
  }
  /** Zapisana selekcja zasobów projektu (null = brak jawnego wyboru → domyślnie wszystko). */
  private projectSelection(projectDir: string): Set<string> | null {
    const saved = this.context.workspaceState.get<string[]>(XveEditorProvider.selectionKey(projectDir));
    return saved === undefined ? null : new Set(saved);
  }
  /** Per-plik override języka resx ("" = neutralny, "off" = bez resx, undefined = język VS Code). */
  private resxLangOverride(uri: vscode.Uri): string | undefined {
    return this.context.workspaceState.get<string>(XveEditorProvider.langKey(uri));
  }
  // cache scanProject (klucz = fsPath) — buildResourceState woła go przy każdym sendDoc (per-edycja);
  // skład plików projektu rzadko się zmienia, więc cache; bust przy ręcznym (prze)ładowaniu zasobów.
  private scanCache = new Map<string, ProjectScan | null>();
  private scanCached(fsPath: string): ProjectScan | null {
    if (!this.scanCache.has(fsPath)) this.scanCache.set(fsPath, scanProject(fsPath));
    return this.scanCache.get(fsPath) ?? null;
  }

  /** Wykryte warianty językowe resx z `Properties/Resources*.resx`. */
  private detectResxLanguages(projectDir: string | null): { value: string; label: string }[] {
    if (!projectDir) return [];
    try {
      return resxLanguagesFromNames(fs.readdirSync(path.join(projectDir, "Properties")));
    } catch {
      return [];
    }
  }

  /**
   * Apphost jest architekturo-zależny: paczka niesie warianty win-x64 i win-arm64, bo x64 exe na
   * Windows on ARM chodziłby pod emulacją i żądał *x64* Desktop Runtime'u (nawet gdy zainstalowany
   * jest natywny arm64). Fallback na dev-build pozwala pracować z F5 po samym `npm run build:host`,
   * bez kroku `publish`.
   */
  private hostExePath(): string {
    const rid = process.arch === "arm64" ? "win-arm64" : "win-x64";
    const dist = vscode.Uri.joinPath(
      this.context.extensionUri,
      "wpf-host",
      "dist",
      rid,
      "xve-wpf-host.exe"
    ).fsPath;
    if (fs.existsSync(dist)) return dist;
    return vscode.Uri.joinPath(
      this.context.extensionUri,
      "wpf-host",
      "bin",
      "Release",
      "net10.0-windows",
      "xve-wpf-host.exe"
    ).fsPath;
  }
  /** Zwraca (leniwie tworząc) proces hosta dla danego klucza puli. */
  private getHostFor(key: string): WpfHost {
    let h = this.hosts.get(key);
    if (!h) {
      h = new WpfHost(this.hostExePath(), (kind, detail) => this.reportHostFatal(kind, detail));
      this.hosts.set(key, h);
    }
    return h;
  }

  /** Rodzaje awarii hosta już zgłoszone w tej sesji — jedno powiadomienie na rodzaj. */
  private fatalShown = new Set<HostFatalKind>();

  /**
   * Twarda awaria hosta WPF: bez tego użytkownik widzi tylko szarą kropkę i cichy fallback
   * na renderer web. Pokazujemy powód i drogę wyjścia (instalacja runtime'u albo świadome
   * przełączenie się na renderer web, żeby host nie próbował startować przy każdym pliku).
   */
  private reportHostFatal(kind: HostFatalKind, detail: string): void {
    if (this.fatalShown.has(kind)) return;
    this.fatalShown.add(kind);

    const message =
      kind === "runtime-missing" ? t("Host.RuntimeMissing") : kind === "exe-missing" ? t("Host.ExeMissing") : t("Host.Crashed");
    const actions: string[] = [];
    if (kind === "runtime-missing") actions.push(t("Host.Download"));
    actions.push(t("Host.SwitchWeb"));
    if (detail) actions.push(t("Host.ShowDetails"));

    void vscode.window.showErrorMessage(message, ...actions).then((choice) => {
      if (choice === t("Host.Download")) {
        void vscode.env.openExternal(vscode.Uri.parse(DOTNET_RUNTIME_URL));
      } else if (choice === t("Host.SwitchWeb")) {
        void vscode.workspace
          .getConfiguration("xve")
          .update("previewBackend", "web", vscode.ConfigurationTarget.Global);
      } else if (choice === t("Host.ShowDetails")) {
        void vscode.window.showErrorMessage(message, { modal: true, detail });
      }
    });
  }
  /** Ubija i usuwa z puli proces hosta o danym kluczu (np. izolowany przy zamknięciu panelu). */
  private disposeHost(key: string): void {
    const h = this.hosts.get(key);
    if (h) {
      h.dispose();
      this.hosts.delete(key);
    }
  }
  private useWpfHost(): boolean {
    if (process.platform !== "win32") return false;
    // Apphost budujemy tylko dla x64 i arm64 — na innych architekturach (np. 32-bitowy ia32)
    // po cichu zostajemy przy rendererze web, zamiast straszyć błędem „brak exe".
    if (process.arch !== "x64" && process.arch !== "arm64") return false;
    const cfg = vscode.workspace.getConfiguration("xve").get<string>("previewBackend") || "auto";
    return cfg === "wpf-host" || cfg === "auto"; // Auto na Windows = host WPF
  }

  /** Migawka ustawień podglądu (`xve.preview.*`) — źródło prawdy dla renderu i panelu webview. */
  private readPreviewConfig() {
    const c = vscode.workspace.getConfiguration("xve.preview");
    return {
      language: vscode.workspace.getConfiguration("xve").get<string>("language", ""),
      renderScale: c.get<string>("renderScale", "auto"),
      maxResolution: c.get<number>("maxResolution", 4096),
      theme: c.get<string>("theme", "none"),
      viewportRender: c.get<boolean>("viewportRender", true),
      overscan: c.get<number>("overscan", 100),
      capBasis: c.get<string>("capBasis", "visible"),
      debugConsole: c.get<boolean>("debugConsole", false),
      consoleOnStart: c.get<boolean>("consoleOnStart", true),
      debugLiveDrag: c.get<boolean>("debugLiveDrag", false),
      dragStrategy: c.get<string>("dragStrategy", "ms"),
      dragIntervalMs: c.get<number>("dragIntervalMs", 25),
      dragFrames: c.get<number>("dragFrames", 2),
      dragCoalesce: c.get<boolean>("dragCoalesce", true),
      dragSession: c.get<boolean>("dragSession", true),
      dragOnChange: c.get<boolean>("dragOnChange", true),
      adaptiveRes: c.get<boolean>("adaptiveRes", true),
      motionResolution: c.get<number>("motionResolution", 512),
      adaptiveFpsThreshold: c.get<number>("adaptiveFpsThreshold", 30),
    };
  }

  /** Migawka ustawień synchronizacji zaznaczenia (`xve.sync.*`). */
  private readSyncConfig() {
    const c = vscode.workspace.getConfiguration("xve.sync");
    return {
      selectInTextEditor: c.get<boolean>("selectInTextEditor", true),
      selectFromTextCursor: c.get<boolean>("selectFromTextCursor", true),
    };
  }

  /** Tryb deduplikacji x:Name przy wklejaniu (`xve.paste.nameDeduplication`). */
  private readPasteConfig(): DedupMode {
    const m = vscode.workspace.getConfiguration("xve.paste").get<string>("nameDeduplication", "off");
    return m === "rename" || m === "renameAndReferences" ? m : "off";
  }

  /** Migawka ustawień podświetlania w edytorze tekstu (`xve.editor.*`). */
  private readEditorConfig() {
    const c = vscode.workspace.getConfiguration("xve.editor");
    return {
      highlightChanges: c.get<boolean>("highlightChanges", true),
      highlightErrors: c.get<boolean>("highlightErrors", true),
    };
  }

  /** Domyślne ustawienia płótna podglądu (`xve.canvas.*` + `xve.preview.fitOnOpen`) — stan
   * live trzyma webview, te wartości to początkowe domyślne (gdy brak zapamiętanego stanu). */
  private readCanvasConfig() {
    const c = vscode.workspace.getConfiguration("xve.canvas");
    return {
      gridStep: c.get<number>("gridStep", 8),
      showGrid: c.get<boolean>("showGrid", false),
      showRulers: c.get<boolean>("showRulers", true),
      fitOnOpen: vscode.workspace.getConfiguration("xve.preview").get<boolean>("fitOnOpen", true),
    };
  }

  /** Renderuje bieżący dokument przez host WPF i wysyła PNG + mapę hit-test do webview. */
  private async renderViaHost(
    document: vscode.TextDocument,
    host: WpfHost,
    post: (m: unknown) => void,
    width: number,
    height: number,
    opts: Record<string, unknown> = {},
    debug?: Record<string, unknown>
  ): Promise<{ ok: boolean; error?: string; line?: number; col?: number; scrolled?: { uid: string; h: number; v: number }[] }> {
    try {
      const hostXaml = new XamlDocument(document.getText()).toHostXaml();
      const t0 = Date.now();
      const r = await host.request({ cmd: "render", xaml: hostXaml, width, height, ...opts });
      const ms = Date.now() - t0; // czas renderu (round-trip hosta) — dla konsoli debug
      if (r.ok && r.png) {
        this.postRender(post, r, debug ? { ...debug, ms } : undefined);
        return { ok: true, scrolled: r.scrolled };
      }
      post({ type: "renderError", error: r.error ?? "render failed" });
      return { ok: false, error: r.error ?? "render failed", line: r.line, col: r.col };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      post({ type: "renderError", error: msg });
      return { ok: false, error: msg };
    }
  }

  /** Wysyła wynik renderu hosta do webview (PNG + pełny rozmiar + wycinek + hit-test). */
  private postRender(
    post: (m: unknown) => void,
    r: import("../host/WpfHost.ts").RenderResult,
    debug?: Record<string, unknown>
  ): void {
    post({
      type: "render",
      png: r.png,
      width: r.width,
      height: r.height,
      vx: r.vx ?? 0,
      vy: r.vy ?? 0,
      vw: r.vw ?? r.width,
      vh: r.vh ?? r.height,
      // null = brak aktualizacji mapy hit-test (klatka drag) → webview zachowuje poprzednią
      rects: r.rects ?? null,
      // telemetria konsoli debug: realnie wyrenderowana bitmapa + reszta parametrów z doHostRender
      debug: debug ? { ...debug, rpw: r.rpw ?? 0, rph: r.rph ?? 0, surfW: r.width, surfH: r.height } : undefined,
    });
  }

  /** Podświetla w widocznych edytorach tekstu linie zmienione względem `baselineText`. */
  private applyInlineDiff(document: vscode.TextDocument, baselineText: string, show: boolean): void {
    const editors = vscode.window.visibleTextEditors.filter(
      (e) => e.document.uri.toString() === document.uri.toString()
    );
    if (editors.length === 0) return;
    let ranges: vscode.Range[] = [];
    if (show && document.getText() !== baselineText) {
      const baseLines = baselineText.split(/\r?\n/);
      const curLines = document.getText().split(/\r?\n/);
      ranges = changedLinesInB(baseLines, curLines).map(
        (i) => new vscode.Range(i, 0, i, (curLines[i] ?? "").length)
      );
    }
    for (const e of editors) e.setDecorations(this.changedLineDecoration, ranges);
  }

  /**
   * Podświetla w widocznych edytorach tekstu błąd renderu: czerwone tło linii + faliste
   * podkreślenie konkretnego tokenu. `error=null` lub `show=false` czyści dekoracje.
   */
  private applyErrorDecoration(
    document: vscode.TextDocument,
    error: { line: number; col: number; message: string } | null,
    show: boolean
  ): void {
    const editors = vscode.window.visibleTextEditors.filter(
      (e) => e.document.uri.toString() === document.uri.toString()
    );
    if (editors.length === 0) return;
    const active = show && !!error && error.line > 0;
    for (const e of editors) {
      if (!active) {
        e.setDecorations(this.errorLineDecoration, []);
        e.setDecorations(this.errorRangeDecoration, []);
        continue;
      }
      const { underlines, lines } = this.errorDecoRanges(e.document, error!);
      e.setDecorations(
        this.errorLineDecoration,
        lines.map((ln) => e.document.lineAt(ln).range)
      );
      e.setDecorations(
        this.errorRangeDecoration,
        underlines.map((r) => ({ range: r, hoverMessage: error!.message }))
      );
    }
  }

  /**
   * Wylicza zakresy dekoracji błędu: `underlines` (faliste podkreślenie konkretnego tokenu)
   * i `lines` (czerwone tło całych wierszy). Kolumna z hosta jest NIEWIARYGODNA (toHostXaml
   * wstrzykuje `x:Uid`, przesuwając kolumny), więc szukamy w ORYGINALNYM tekście nazwy z
   * komunikatu (typ / właściwość / znacznik). Dla niezgodności znaczników XML kolorujemy tło
   * OBU znaczników, a podkreślamy tylko literówkę (nazwę, która nie jest znanym typem); gdy nie
   * da się rozstrzygnąć — podkreślamy oba. Fallback = cała linia błędu.
   */
  private errorDecoRanges(
    doc: vscode.TextDocument,
    error: { line: number; col: number; message: string }
  ): { underlines: vscode.Range[]; lines: number[] } {
    const clamp = (l: number) => Math.min(Math.max(0, l - 1), doc.lineCount - 1);
    const eLine = clamp(error.line);

    // (A) Niezgodność znaczników: komunikat ma pozycję znacznika OTWIERAJĄCEGO + nazwy obu
    //     (pierwsza = otwierający, druga = zamykający).
    const startTag = error.message.match(/(?:line|wiersz\w*)\s+(\d+)/i);
    const quoted = [...error.message.matchAll(/['"„”]([A-Za-z_][\w.:\-]*)['"„”]/g)].map((m) => m[1]);
    if (startTag && quoted.length >= 2) {
      const sLine = clamp(parseInt(startTag[1], 10));
      const [openName, closeName] = quoted;
      const lines = sLine === eLine ? [eLine] : [sLine, eLine];
      // literówka = nazwa, która NIE jest znanym typem (drugą zostawiamy)
      const openKnown = isKnownType(openName);
      const closeKnown = isKnownType(closeName);
      let underlines: vscode.Range[] = [];
      if (openKnown !== closeKnown) {
        const r = openKnown
          ? this.findTokenOnLine(doc, eLine, [closeName])
          : this.findTokenOnLine(doc, sLine, [openName]);
        if (r) underlines = [r];
      }
      if (underlines.length === 0) {
        // nie umiemy wskazać literówki → podkreśl oba znaczniki
        const r1 = this.findTokenOnLine(doc, sLine, [openName, closeName]);
        const r2 = this.findTokenOnLine(doc, eLine, [closeName, openName]);
        if (r1) underlines.push(r1);
        if (r2 && (!r1 || r2.start.line !== r1.start.line)) underlines.push(r2);
      }
      if (underlines.length) return { underlines, lines };
    }

    // (B) Nieznany typ / właściwość: wyłuskaj identyfikator z komunikatu i znajdź go w linii błędu.
    const ident = this.offendingIdentifier(error.message);
    if (ident) {
      const r = this.findTokenOnLine(doc, eLine, [ident]);
      if (r) return { underlines: [r], lines: [eLine] };
    }

    // (C) Fallback: cała (przycięta) treść linii błędu.
    const tl = doc.lineAt(eLine);
    const full = new vscode.Range(eLine, tl.firstNonWhitespaceCharacterIndex, eLine, tl.range.end.character);
    return { underlines: [full], lines: [eLine] };
  }

  /** Pierwszy z `candidates` znaleziony w danej linii → jego zakres; inaczej null. */
  private findTokenOnLine(
    doc: vscode.TextDocument,
    lineIdx: number,
    candidates: string[]
  ): vscode.Range | null {
    const text = doc.lineAt(lineIdx).text;
    for (const c of candidates) {
      if (!c) continue;
      const i = text.indexOf(c);
      if (i >= 0) return new vscode.Range(lineIdx, i, lineIdx, i + c.length);
    }
    return null;
  }

  /** Identyfikator z komunikatu: `{ns}Type` lub `A.B.Member` → ostatni segment. */
  private offendingIdentifier(message: string): string | null {
    const m =
      message.match(/\}([A-Za-z_]\w*)/) ||
      message.match(/[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+\.([A-Za-z_]\w*)/);
    return m ? (m[1] ?? null) : null;
  }

  /** Pokazuje błąd w edytorze tekstu: otwiera dokument obok (jeśli trzeba) i ustawia kursor. */
  private async revealError(
    document: vscode.TextDocument,
    line1: number,
    col1: number,
    message?: string
  ): Promise<void> {
    let editor = vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.toString() === document.uri.toString()
    );
    if (!editor) {
      editor = await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: false,
      });
    }
    const lineIdx = Math.min(Math.max(0, (line1 || 1) - 1), editor.document.lineCount - 1);
    // mając komunikat celujemy w token (kolumna z hosta jest przesunięta przez x:Uid)
    const ranges = message
      ? this.errorDecoRanges(editor.document, { line: line1, col: col1, message }).underlines
      : [];
    const pick = ranges.find((r) => r.start.line === lineIdx) ?? ranges[0];
    let pos: vscode.Position;
    if (pick) {
      pos = pick.start;
    } else {
      const lineLen = editor.document.lineAt(lineIdx).text.length;
      pos = new vscode.Position(lineIdx, Math.min(Math.max(0, (col1 || 1) - 1), lineLen));
    }
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  }

  /**
   * Wylicza poprawkę literówki: zakres błędnego tokenu i nazwę docelową. Obsługuje
   * niezgodność znaczników (literówka → poprawny znacznik), nieznany typ (→ najbliższy
   * znany typ) i nieznaną właściwość (→ najbliższa właściwość typu). null = brak pewnej poprawki.
   */
  private computeAutoFix(
    doc: vscode.TextDocument,
    error: { line: number; col: number; message: string }
  ): { range: vscode.Range; to: string } | null {
    const clamp = (l: number) => Math.min(Math.max(0, l - 1), doc.lineCount - 1);
    const eLine = clamp(error.line);

    // (A) Niezgodność znaczników: zamień literówkę (nieznany typ) na poprawny znacznik (znany).
    const startTag = error.message.match(/(?:line|wiersz\w*)\s+(\d+)/i);
    const quoted = [...error.message.matchAll(/['"„”]([A-Za-z_][\w.:\-]*)['"„”]/g)].map((m) => m[1]);
    if (startTag && quoted.length >= 2) {
      const sLine = clamp(parseInt(startTag[1], 10));
      const [openName, closeName] = quoted;
      const openKnown = isKnownType(openName);
      const closeKnown = isKnownType(closeName);
      if (openKnown !== closeKnown) {
        const to = openKnown ? openName : closeName; // poprawna nazwa
        const typoName = openKnown ? closeName : openName;
        const typoLine = openKnown ? eLine : sLine;
        const r = this.findTokenOnLine(doc, typoLine, [typoName]);
        if (r && to !== typoName) return { range: r, to };
      }
      return null;
    }

    // (B) Nieznany typ: `{ns}Buton` → najbliższy znany typ (Button).
    const typeM = error.message.match(/\}([A-Za-z_]\w*)/);
    if (typeM) {
      const bad = typeM[1];
      const to = closestKnownType(bad);
      const r = this.findTokenOnLine(doc, eLine, [bad]);
      if (r && to && to !== bad) return { range: r, to };
      return null;
    }

    // (C) Nieznana właściwość: `CheckBox.Contet` → najbliższa właściwość typu (Content).
    const om = this.dottedOwnerMember(error.message);
    if (om) {
      const to = closestKnownProperty(om.owner, om.member);
      const r = this.findTokenOnLine(doc, eLine, [om.member]);
      if (r && to && to !== om.member) return { range: r, to };
    }
    return null;
  }

  /** Z dotted-name w komunikacie (`A.B.Owner.Member`) wyłuskuje właściciela i składową. */
  private dottedOwnerMember(message: string): { owner: string; member: string } | null {
    const m = message.match(/([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+)/);
    if (!m) return null;
    const parts = m[1].split(".");
    if (parts.length < 2) return null;
    return { owner: parts[parts.length - 2], member: parts[parts.length - 1] };
  }

  // cache obrazków → data-URI (klucz = ścieżka bezwzględna); unieważniany po mtime/rozmiarze pliku
  private imageCache = new Map<string, { mtimeMs: number; size: number; data: string }>();
  // cache sparsowanych .resx (klucz = ścieżka); unieważniany po mtime — by nie parsować przy każdej edycji
  private resxCache = new Map<string, { mtimeMs: number; data: Record<string, string> }>();
  private static readonly IMG_MIME: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    bmp: "image/bmp",
    ico: "image/x-icon",
    webp: "image/webp",
    tif: "image/tiff",
    tiff: "image/tiff",
    svg: "image/svg+xml",
  };
  private static readonly IMG_MAX_BYTES = 8_000_000; // pomiń ogromne pliki (nie wysyłaj megabajtów w data-URI)

  /** Czyta plik obrazka i zwraca data-URI (z cache wg mtime). null = brak/niewspierany/za duży. */
  private imageDataUri(abs: string): string | null {
    try {
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > XveEditorProvider.IMG_MAX_BYTES) return null;
      const ext = path.extname(abs).toLowerCase().slice(1);
      const mime = XveEditorProvider.IMG_MIME[ext];
      if (!mime) return null;
      const cached = this.imageCache.get(abs);
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.data;
      const data = `data:${mime};base64,` + fs.readFileSync(abs).toString("base64");
      this.imageCache.set(abs, { mtimeMs: st.mtimeMs, size: st.size, data });
      return data;
    } catch {
      return null;
    }
  }

  /**
   * Mapuje wartości Image/MediaElement.Source (oraz Window.Icon) na data-URI, by renderer web mógł
   * wyświetlić obraz z dysku niezależnie od localResourceRoots/CSP. Zewnętrzne (http/data/pack) i
   * już-URI zostawia bez zmian. Klucz mapy = surowa wartość atrybutu z XAML.
   */
  private buildImageMap(tree: TreeNodeDto | null, baseDir: string): Record<string, string> {
    const map: Record<string, string> = {};
    const isExternal = (s: string) => /^(https?:|data:|pack:|vscode-)/i.test(s);
    const local = (tag: string) => {
      const i = tag.indexOf(":");
      return i >= 0 ? tag.slice(i + 1) : tag;
    };
    const walk = (n: TreeNodeDto) => {
      const t = local(n.tag);
      const attr = t === "Window" || t === "UserControl" || t === "Page" ? "Icon" : "Source";
      if (t === "Image" || t === "MediaElement" || attr === "Icon") {
        const raw = n.attributes.find((a) => a.name === attr)?.value;
        if (raw && !map[raw] && !isExternal(raw)) {
          // obsłuż file:-URI oraz ścieżki względne/bezwzględne
          let p = raw;
          if (/^file:/i.test(p)) {
            try {
              p = vscode.Uri.parse(p).fsPath;
            } catch {
              /* zostaw jak jest */
            }
          }
          const abs = path.isAbsolute(p) ? p : path.resolve(baseDir, p);
          const data = this.imageDataUri(abs);
          if (data) map[raw] = data;
        }
      }
      for (const c of n.children) walk(c);
    };
    if (tree) walk(tree);
    return map;
  }

  /** Idzie w górę od pliku, szukając katalogu z `*.csproj` (korzeń projektu). */
  private findProjectDir(file: string): string | null {
    let dir = path.dirname(file);
    for (let i = 0; i < 12; i++) {
      try {
        if (fs.readdirSync(dir).some((e) => e.toLowerCase().endsWith(".csproj"))) return dir;
      } catch {
        return null;
      }
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
    return null;
  }

  /** Rozwiązuje ImageSource pędzla (pack://, file:, względny/bezwzględny) na data-URI. */
  private resolveResourceImage(raw: string, projectDir: string, baseDir: string): string | null {
    let p = raw.trim();
    if (/^(https?:|data:)/i.test(p)) return p; // zewnętrzne — przepuść bez zmian
    const pack = p.match(/^pack:\/\/application:,,,\/(?:[^;]+;component\/)?(.+)$/i);
    if (pack) p = pack[1];
    else if (/^pack:/i.test(p)) return null; // inne pack: (np. siteoforigin) — nieobsługiwane
    if (/^file:/i.test(p)) {
      try {
        p = vscode.Uri.parse(p).fsPath;
      } catch {
        /* zostaw */
      }
    }
    if (path.isAbsolute(p)) return this.imageDataUri(p);
    // ścieżka względna: próbuj korzenia projektu (pack), potem katalogu pliku
    return this.imageDataUri(path.resolve(projectDir, p)) ?? this.imageDataUri(path.resolve(baseDir, p));
  }

  /**
   * Buduje model zasobów dla renderera web z trzech źródeł (rosnący priorytet):
   * App.xaml → wybrany słownik motywu (`resource:…`) → `*.Resources` samego pliku.
   * Obrazy pędzli (ImageBrush) rozwiązuje na data-URI.
   */
  private buildResourceModel(
    document: vscode.TextDocument,
    previewTheme: string,
    baseDir: string
  ): ResourceModel {
    const sources: ResourceModel[] = [];
    const projectDir = this.findProjectDir(document.uri.fsPath);
    const selection = projectDir ? this.projectSelection(projectDir) : null; // null = domyślnie wszystko
    const appXaml = projectDir ? path.join(projectDir, "App.xaml") : null;
    const appSelected = !selection || (!!appXaml && selection.has(appXaml));
    if (appXaml && appSelected && fs.existsSync(appXaml)) {
      try {
        sources.push(extractResources(fs.readFileSync(appXaml, "utf8")));
      } catch {
        /* pomiń */
      }
    }
    if (previewTheme.startsWith("resource:")) {
      const themePath = previewTheme.slice("resource:".length);
      try {
        sources.push(extractResources(fs.readFileSync(themePath, "utf8")));
      } catch {
        /* pomiń */
      }
    }
    sources.push(extractResources(document.getText())); // zasoby pliku — najwyższy priorytet
    const model = mergeModels(...sources);
    const lang = this.resxLangOverride(document.uri); // "off" → bez resx
    model.strings = lang === "off" ? {} : this.loadProjectStrings(projectDir, lang);
    const imgBase = projectDir ?? baseDir;
    const images: Record<string, string> = {};
    for (const [k, raw] of Object.entries(model.brushImages)) {
      const uri = this.resolveResourceImage(raw, imgBase, baseDir);
      if (uri) images[k] = uri;
    }
    model.brushImages = images;
    return model;
  }

  /** Parsuje .resx z cache (wg mtime) — pusty obiekt gdy brak/błąd. */
  private resx(file: string): Record<string, string> {
    try {
      const st = fs.statSync(file);
      const cached = this.resxCache.get(file);
      if (cached && cached.mtimeMs === st.mtimeMs) return cached.data;
      const data = parseResx(fs.readFileSync(file, "utf8"));
      this.resxCache.set(file, { mtimeMs: st.mtimeMs, data });
      return data;
    } catch {
      return {};
    }
  }

  /**
   * Wczytuje lokalizację z `Properties/Resources.resx` (neutralny) z nałożeniem wariantu języka
   * VS Code (np. `Resources.en.resx`) — by `{helpers:Loc Key}` pokazał tekst jak w aplikacji.
   */
  private loadProjectStrings(projectDir: string | null, override?: string): Record<string, string> {
    if (!projectDir) return {};
    const propsDir = path.join(projectDir, "Properties");
    const neutral = path.join(propsDir, "Resources.resx");
    if (!fs.existsSync(neutral)) return {};
    const strings = { ...this.resx(neutral) };
    // override: "" = neutralny (bez wariantu), kultura = ten wariant; undefined = język VS Code
    const lang = (override !== undefined ? override : vscode.env.language || "").toLowerCase();
    const variants = lang ? [lang, lang.split("-")[0]].filter((v, i, a) => v && a.indexOf(v) === i) : [];
    for (const v of variants) {
      const f = path.join(propsDir, `Resources.${v}.resx`);
      if (fs.existsSync(f)) {
        Object.assign(strings, this.resx(f)); // wariant językowy nadpisuje neutralny
        break;
      }
    }
    return strings;
  }

  /** Słowniki motywów (ResourceDictionary) do combo motywów — także w trybie web (bez hosta). */
  private scanThemes(fsPath: string, previewTheme: string): { value: string; label: string }[] {
    const scan = scanProject(fsPath);
    const list = scan
      ? scan.items
          .filter((i) => i.kind === "resourceDict")
          .map((i) => ({ value: "resource:" + i.path, label: i.label }))
      : [];
    if (previewTheme.startsWith("resource:") && !list.some((t) => t.value === previewTheme)) {
      const p = previewTheme.slice("resource:".length);
      list.push({ value: previewTheme, label: p.split(/[\\/]/).pop() || p });
    }
    return list;
  }

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel
  ): Promise<void> {
    // korzeń zasobów dla obrazków: katalog pliku .xaml + folder workspace (Image Source w trybie web
    // ładuje się tylko spod localResourceRoots — host WPF rozwiązuje ścieżki niezależnie)
    const docDir = vscode.Uri.joinPath(document.uri, "..");
    const wsFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "dist"),
        docDir,
        ...(wsFolder ? [wsFolder.uri] : []),
      ],
    };
    // ikona XVE na zakładce edytora (zamiast domyślnej ikony pliku wg motywu ikon)
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, "Assets", "iconXVE128.png");
    panel.webview.html = this.html(panel.webview);

    const post = (msg: unknown) => panel.webview.postMessage(msg);
    // Cache schowka w webview (włącza „Wklej" + pokazuje skrót skopiowanego elementu w menu).
    const postClipboard = (xml: string | null) =>
      post({ type: "clipboard", xml, info: xml ? fragmentSummary(xml) : null });

    // --- izolacja hosta WPF: który proces obsługuje TEN panel ---
    // hostKey === SHARED → host współdzielony; hostKey === URI → świeży host izolowany tego pliku.
    // Decyzję podejmujemy w obsłudze „ready" (może pokazać propozycję dla pliku spoza projektu).
    let isolated = false;
    let hostKey = XveEditorProvider.SHARED;
    const host = (): WpfHost => this.getHostFor(hostKey);

    // --- status hosta WPF (kropka + log w pasku webview) ---
    type HostLevel = "info" | "ok" | "error";
    let hostStatus: "inactive" | "ok" | "error" = "inactive";
    // wpisy logu; przy błędzie renderu dołączamy line/col → klikalny skok w edytorze tekstu
    type HostLogEntry = { t: number; level: HostLevel; msg: string; line?: number; col?: number };
    const hostLog: HostLogEntry[] = [];
    const pushLog = (level: HostLevel, msg: string, line?: number, col?: number) => {
      hostLog.push({ t: Date.now(), level, msg, line, col });
      if (hostLog.length > 60) hostLog.shift();
    };
    // aktywny (blokujący) błąd renderu → zakładka „Console"; info o zasobach → osobna sekcja.
    // Log (zakładka „Log") trzyma chronologiczną historię; Console pokazuje tylko bieżący błąd.
    let currentError: { line: number; col: number; message: string } | null = null;
    let currentErrorFix: string | null = null; // nazwa docelowa auto-fixu (lub null)
    let resourceInfo: { level: HostLevel; msg: string } | null = null;
    const postHostStatus = () =>
      post({
        type: "hostStatus",
        status: hostStatus,
        active: this.useWpfHost(),
        log: hostLog,
        error: currentError
          ? { ...currentError, fixTo: currentErrorFix } // „Auto fix to <typ>" (gdy da się naprawić)
          : null,
        resources: resourceInfo,
        resourceState: buildResourceState(), // wspólny stan (web + WPF) dla okienka/logu/kropki
        // silnik + izolacja — by selektor w pasku narzędzi odzwierciedlał stan po decyzji/zmianie
        backend: vscode.workspace.getConfiguration("xve").get<string>("previewBackend") || "auto",
        isolation: this.isolationInfo(document, isolated),
      });
    const setHostStatus = (
      s: "inactive" | "ok" | "error",
      log?: { level: HostLevel; msg: string; line?: number; col?: number }
    ) => {
      hostStatus = s;
      if (log) pushLog(log.level, log.msg, log.line, log.col);
      postHostStatus();
    };

    // baseline = ostatnio zapisana zawartość (przy otwarciu == zawartość na dysku)
    let baselineText = document.getText();
    // podświetlanie zmian / błędów w edytorze tekstu (źródło prawdy: xve.editor.*)
    let editorCfg = this.readEditorConfig();
    let showInlineDiff = editorCfg.highlightChanges; // przełącznik z widoku Changes
    let showErrors = editorCfg.highlightErrors; // przełącznik „Show errors in code" (log hosta)
    const refreshErrorDecoration = () =>
      this.applyErrorDecoration(document, currentError, showErrors);

    // --- ustawienia podglądu: źródło prawdy = konfiguracja `xve.preview.*` ---
    let cfg = this.readPreviewConfig();
    let renderCap = cfg.maxResolution; // limit rozdzielczości (px URZĄDZENIA); 0 = bez limitu
    // Motyw podglądu: standardowy (none|classic98|system|light|dark|native) z `xve.preview.theme`,
    // ALBO motyw projektu „resource:<ścieżka>" (słownik z zasobów pliku) — nadpisanie per-plik.
    const themeKey = "xve.previewThemeResource:" + document.uri.toString();
    const readThemeOverride = (): string | undefined => {
      const v = this.context.workspaceState.get<string>(themeKey);
      return typeof v === "string" && v.startsWith("resource:") ? v : undefined;
    };
    let previewTheme = readThemeOverride() ?? cfg.theme; // motyw efektywny (standard lub resource:…)
    // motywy projektu (pliki ResourceDictionary z zasobów) dostępne do wyboru w combo motywów
    let projectThemes: { value: string; label: string }[] = [];
    let viewportRender = cfg.viewportRender; // render tylko widocznego obszaru
    let capBasis = cfg.capBasis; // podstawa limitu rozdzielczości w trybie viewbox: "visible" | "slice"
    let debugConsole = cfg.debugConsole; // konsola debug na dole podglądu
    let debugLiveDrag = cfg.debugLiveDrag; // aktualizuj telemetrię także podczas przeciągania
    let adaptiveRes = cfg.adaptiveRes; // niższa rozdzielczość w ruchu, pełna po ustaniu ruchu
    let motionCap = cfg.motionResolution; // limit rozdzielczości w ruchu (px urządzenia)
    let adaptiveFps = cfg.adaptiveFpsThreshold; // próg: degraduj dopiero gdy pełny render < X FPS; 0 = zawsze
    let lastFullMs = 0; // czas ostatniego pełnego renderu (do decyzji o degradacji)
    // wybór limitu dla danej klatki: degraduj do motionCap tylko w ruchu, gdy adaptacja wł. i pełny
    // render jest realnie zbyt wolny (FPS poniżej progu); 0 = zawsze, nieznany czas = degraduj.
    const capFor = (lowRes: boolean): number => {
      if (!(adaptiveRes && lowRes && motionCap > 0)) return renderCap;
      const shouldDowngrade = adaptiveFps <= 0 || lastFullMs <= 0 || lastFullMs > 1000 / adaptiveFps;
      return shouldDowngrade ? motionCap : renderCap;
    };
    let renderScale = cfg.renderScale; // "auto" | "1" | "1.5" | "2" | "3"
    let dpr = 1; // device pixel ratio zgłoszony przez webview (dla renderScale="auto")

    // realny rozmiar powierzchni podglądu (fallback dla korzeni bez Width/Height)
    let viewW = 1200;
    let viewH = 900;
    const rW = () => viewW;
    const rH = () => viewH;

    // widoczny obszar (slice) w jednostkach projektu + sam widoczny obszar bez overscanu
    let vbX = 0;
    let vbY = 0;
    let vbW = 0;
    let vbH = 0;
    let vbVisW = 0;
    let vbVisH = 0;
    let curZoom = 1;
    // efektywna skala renderu: "auto" → devicePixelRatio (render w rozdzielczości ekranu)
    const effScale = (): number => {
      const s = renderScale === "auto" ? dpr : Number(renderScale);
      return Number.isFinite(s) && s > 0 ? s : 1;
    };
    // slice tylko gdy webview przysłał realny prostokąt — inaczej pełny render
    const vbExtra = (): Record<string, unknown> =>
      viewportRender && vbW > 0 && vbH > 0
        ? {
            viewbox: { x: vbX, y: vbY, w: vbW, h: vbH, visW: vbVisW, visH: vbVisH },
            zoom: curZoom,
            capBasis,
          }
        : {};
    // auto-podgląd menu/list (funkcja 2): uid wybranego elementu + flaga
    let autoReveal = false;
    let revealUid: string | null = null;
    // jednorazowe „przewiń, by zaznaczony element był widoczny" (ustawiane przy zmianie zaznaczenia)
    let pendingRevealScroll = false;
    const revealExtra = (): Record<string, unknown> =>
      autoReveal
        ? { autoReveal: true, ...(revealUid ? { reveal: revealUid } : {}), ...(pendingRevealScroll ? { revealScroll: true } : {}) }
        : {};
    // pamięć aktywnych zakładek TabControl (uid wybranych TabItem) — stosowana przy KAŻDYM renderze,
    // niezależnie od auto-podglądu, by widok zakładki trwał przy zaznaczaniu elementów spoza TabControl.
    let tabUids: string[] = [];
    // zawsze wysyłamy (także pustą listę), by wyczyszczenie/zmiana pamięci docierały do hosta
    const tabsExtra = (): Record<string, unknown> => ({ tabs: tabUids });
    // przewinięcia ScrollViewer (funkcja 3): uid → {h,v} (offset w jednostkach projektu)
    const scrolls: Record<string, { h: number; v: number }> = {};
    const scrollExtra = (): Record<string, unknown> =>
      Object.keys(scrolls).length ? { scrolls } : {};
    // zasoby projektu dla hosta WPF (DLL custom kontrolek + App.xaml/słowniki). Wysyłane przy
    // każdym renderze; host stosuje „apply-if-changed" wg `key`, więc powtórki są tanie.
    let projectPayload: { key: string; assemblies: string[]; dictionaries: string[] } = {
      key: "",
      assemblies: [],
      dictionaries: [],
    };
    let projectResolved = false;
    /**
     * Stosuje wybór zasobów: payload + lista motywów (+ auto-wybór #4) + (WPF) loadProject ze śladem
     * w `hostResourceLoaded`. Używane przez `resolveProject` (po pickerze) oraz przez okienko zasobów.
     */
    const applySelection = async (scan: ProjectScan, selected: Set<string>): Promise<void> => {
      projectPayload = buildProjectPayload(scan, selected);
      // motywy projektu = wybrane słowniki ResourceDictionary (do combo motywów)
      projectThemes = scan.items
        .filter((i) => i.kind === "resourceDict" && selected.has(i.path))
        .map((i) => ({ value: "resource:" + i.path, label: i.label }));
      if (previewTheme.startsWith("resource:") && !projectThemes.some((t) => t.value === previewTheme)) {
        const p = previewTheme.slice("resource:".length);
        projectThemes.push({ value: previewTheme, label: p.split(/[\\/]/).pop() || p });
      }
      // #4 auto-wybór: brak preferencji motywu (none) + są motywy → pierwszy jako podgląd (zapis per-plik)
      if (previewTheme === "none" && projectThemes.length) {
        previewTheme = projectThemes[0].value;
        await this.context.workspaceState.update(themeKey, previewTheme);
      }
      if (this.useWpfHost()) {
        const uri = document.uri.toString();
        if (projectPayload.key) {
          const r = await host().request({ cmd: "loadProject", baseDir, project: projectPayload });
          resourceInfo = r.ok
            ? { level: "info", msg: f("Resources.Loaded", scan.projectName) + "\n" + formatResourceSummary(r) }
            : { level: "error", msg: f("Resources.LoadFailed", r.error ?? t("Common.Error")) };
          if (r.ok)
            this.hostResourceLoaded.set(hostKey, {
              name: document.fileName.split(/[\\/]/).pop() || document.fileName,
              summary: formatResourceSummary(r),
              key: projectPayload.key,
              uri,
            });
        } else {
          resourceInfo = { level: "info", msg: t("Resources.Skip") };
          if (this.hostResourceLoaded.get(hostKey)?.uri === uri) this.hostResourceLoaded.delete(hostKey);
        }
      }
      postHostStatus();
    };
    const resolveProject = async (force = false): Promise<void> => {
      if (!this.useWpfHost()) return;
      if (projectResolved && !force) return;
      projectResolved = true;
      const scan = scanProject(document.uri.fsPath);
      if (!scan || scan.items.length === 0) {
        projectThemes = [];
        projectPayload = { key: "", assemblies: [], dictionaries: [] };
        return;
      }
      const selected = await this.pickProjectResources(scan, force);
      await applySelection(scan, selected);
    };

    // katalog pliku — baza dla względnych URI w hoście (Icon, Image Source, słowniki)
    const baseDir = document.uri.fsPath.replace(/[\\/][^\\/]*$/, "");

    /** Wspólny stan zasobów (web + WPF) dla okienka / logu / kropki. */
    const buildResourceState = (): ResourceState => {
      const engine: "web" | "wpf" = this.useWpfHost() ? "wpf" : "web";
      const projectDir = this.findProjectDir(document.uri.fsPath);
      const scan = this.scanCached(document.uri.fsPath);
      const selection = projectDir ? this.projectSelection(projectDir) : null;
      const items: ResourceStateItem[] = (scan?.items ?? []).map((i) => ({
        path: i.path,
        label: i.label,
        kind: i.kind,
        selected: !selection || selection.has(i.path),
      }));
      const languages = this.detectResxLanguages(projectDir);
      const langOverride = this.resxLangOverride(document.uri);
      const language = langOverride ?? "";
      const reflectCulture = !!this.context.workspaceState.get<boolean>(
        XveEditorProvider.reflectKey(document.uri)
      );
      const parts: string[] = [];
      let loaded = false;
      if (engine === "wpf") {
        loaded = projectPayload.key !== "";
        if (resourceInfo?.msg) parts.push(resourceInfo.msg);
        else parts.push(t("Resources.Skip"));
      } else {
        // tani opis bez ponownego parsowania modelu (sendDoc i tak buduje model do renderu)
        const appXaml = projectDir ? path.join(projectDir, "App.xaml") : null;
        const appOn = !!appXaml && fs.existsSync(appXaml) && (!selection || selection.has(appXaml));
        const themeOn = previewTheme.startsWith("resource:");
        const resxOn = langOverride !== "off" && languages.length > 0;
        if (appOn) parts.push("App.xaml ✓");
        if (themeOn) parts.push(previewTheme.slice("resource:".length).split(/[\\/]/).pop() || "");
        if (resxOn) parts.push("resx " + (langOverride || "auto"));
        loaded = appOn || themeOn || resxOn;
      }
      let sharedByOther: { name: string } | null = null;
      if (!isolated) {
        const entry = this.hostResourceLoaded.get(hostKey);
        if (entry && entry.uri !== document.uri.toString()) {
          sharedByOther = { name: entry.name };
          loaded = true;
        }
      }
      return {
        engine,
        loaded,
        summary: parts.filter(Boolean).join(" · "),
        items,
        languages,
        language,
        reflectCulture,
        sharedByOther,
      };
    };

    // wspólne opcje renderu hosta (limit + motyw + skala + baza URI + zasoby projektu + viewbox).
    // capOverride pozwala wymusić niższy limit dla klatek „w ruchu" (adaptacyjna rozdzielczość).
    // noViewbox=true → render pełnej powierzchni (bez wycinka) — przy zmianie rozmiaru korzenia.
    // efektywna kultura dla hosta WPF (lokalizacja {Loc}): override per-plik, inaczej język VS Code;
    // "off" (unload) → "" = neutralny. Apki czytające CurrentUICulture odzwierciedlą wybór.
    const cultureForHost = (): string => {
      const o = this.resxLangOverride(document.uri);
      if (o === undefined) return vscode.env.language || "";
      return o === "off" ? "" : o;
    };
    const hostOpts = (capOverride?: number, noViewbox = false): Record<string, unknown> => ({
      cap: capOverride ?? renderCap,
      theme: previewTheme,
      culture: cultureForHost(),
      cultureReflect: !!this.context.workspaceState.get<boolean>(
        XveEditorProvider.reflectKey(document.uri)
      ),
      scale: effScale(),
      baseDir,
      ...(projectPayload.key ? { project: projectPayload } : {}),
      ...(noViewbox ? {} : vbExtra()),
      ...revealExtra(),
      ...scrollExtra(),
      ...tabsExtra(),
    });

    // telemetria konsoli debug — zbierana tylko gdy konsola włączona (parametry znane w tym domknięciu).
    // `ms` dolicza renderViaHost/handlery (zmierzony round-trip). Zwraca undefined → bez telemetrii.
    const debugBlock = (capUsed: number = renderCap): Record<string, unknown> | undefined =>
      debugConsole
        ? {
            backend: "wpf-host",
            renderScale,
            scale: effScale(),
            dpr,
            cap: capUsed,
            capBasis,
            viewportRender,
            vbX,
            vbY,
            vbW,
            vbH,
            visW: vbVisW,
            visH: vbVisH,
            zoom: curZoom,
          }
        : undefined;
    // telemetria dla klatek przeciągania — tylko gdy „Live when drag" włączone (i konsola debug aktywna)
    const dragDebug = (t0: number, capUsed: number): Record<string, unknown> | undefined => {
      if (!debugLiveDrag) return undefined;
      const d = debugBlock(capUsed);
      return d ? { ...d, ms: Date.now() - t0 } : undefined;
    };

    // Tryb „na żywo" (play z aktualizacją): gdy ustawiony winId, każda zmiana dokumentu jest dosyłana
    // do otwartego okna (updateWindow → podmiana treści). winId = URI dokumentu (jeden live per plik).
    let liveWinId: string | null = null;
    let liveTimer: ReturnType<typeof setTimeout> | undefined;
    const pushLiveUpdate = (): void => {
      if (!liveWinId || !this.useWpfHost()) return;
      const winId = liveWinId;
      const xaml = new XamlDocument(document.getText()).toHostXaml();
      void host()
        .request({ cmd: "updateWindow", winId, xaml, ...hostOpts() })
        .then((r) => {
          // okno zamknięte przez użytkownika → przestań dosyłać aktualizacje (błąd parsowania zostawia live)
          if (!r.ok && r.error === "window-closed" && liveWinId === winId) liveWinId = null;
        });
    };
    const scheduleLiveUpdate = (delay = 150): void => {
      if (!liveWinId) return;
      if (liveTimer) clearTimeout(liveTimer);
      liveTimer = setTimeout(() => {
        liveTimer = undefined;
        pushLiveUpdate();
      }, delay);
    };

    // Render dokumentu przez host jest DEBOUNCE'OWANY i KOALESCOWANY: przy burzy zmian
    // (pisanie) nie kolejkujemy pełnych renderów — trzymamy najwyżej 1 „w locie", a najnowszy
    // stan dosyłamy po jego powrocie. Drag/viewbox mają własną koalescencję po stronie webview.
    let hostInFlight = false;
    let hostDirty = false;
    let hostPendingCap: number | undefined; // limit do przeniesienia na zakoalescowany re-render
    let hostTimer: ReturnType<typeof setTimeout> | undefined;
    const doHostRender = async (capOverride?: number): Promise<void> => {
      if (!this.useWpfHost()) return;
      if (hostInFlight) {
        hostDirty = true;
        hostPendingCap = capOverride; // zachowaj limit najnowszego żądania (np. niska rozdz. w ruchu)
        return;
      }
      hostInFlight = true;
      hostDirty = false;
      const wasRevealScroll = pendingRevealScroll;
      const capUsed = capOverride ?? renderCap;
      const t0 = Date.now();
      const res = await this.renderViaHost(document, host(), post, rW(), rH(), hostOpts(capOverride), debugBlock(capUsed));
      if (capUsed === renderCap) lastFullMs = Date.now() - t0; // próg adaptacji liczony z pełnych renderów
      if (wasRevealScroll) pendingRevealScroll = false; // jednorazowe — zużyte tym renderem
      // utrwal offsety reveal-scroll w mapie (kolejne rendery trzymają element widoczny) + zsynchronizuj webview
      if (res.scrolled && res.scrolled.length) {
        for (const s of res.scrolled) scrolls[s.uid] = { h: s.h, v: s.v };
        post({ type: "scrolled", offsets: res.scrolled });
      }
      if (res.ok) {
        currentError = null;
        currentErrorFix = null;
        refreshErrorDecoration();
        if (hostStatus !== "ok") setHostStatus("ok");
      } else {
        currentError = { message: res.error ?? "render failed", line: res.line ?? 0, col: res.col ?? 0 };
        currentErrorFix = this.computeAutoFix(document, currentError)?.to ?? null;
        refreshErrorDecoration();
        if (res.error !== lastHostError) {
          lastHostError = res.error;
          setHostStatus("error", {
            level: "error",
            msg: f("Host.RenderError", res.error ?? t("Common.Error")),
            line: res.line,
            col: res.col,
          });
        } else {
          hostStatus = "error";
          postHostStatus();
        }
      }
      hostInFlight = false;
      if (hostDirty) {
        const c = hostPendingCap;
        hostPendingCap = undefined;
        void doHostRender(c); // re-render najnowszego stanu z zachowanym limitem
      }
    };
    let lastHostError: string | undefined;
    const scheduleHostRender = (delay = 80): void => {
      if (!this.useWpfHost()) return;
      if (hostTimer) clearTimeout(hostTimer);
      hostTimer = setTimeout(() => {
        hostTimer = undefined;
        void doHostRender();
      }, delay);
    };

    const sendDoc = () => {
      const text = document.getText();
      const doc = new XamlDocument(text);
      const changes = text === baselineText ? [] : structuralDiff(new XamlDocument(baselineText), doc);
      const tree = doc.toTree();
      post({
        type: "doc",
        tree,
        imageMap: this.buildImageMap(tree, baseDir),
        resources: this.buildResourceModel(document, previewTheme, baseDir),
        resourceState: buildResourceState(), // stan dla okienka/logu/kropki (web + WPF)
        // mapa podświetleń wyprowadzona z TEGO SAMEGO dopasowania co Changes — spójna
        // i poprawnie przypisana (także dla wielu elementów tego samego typu)
        changed: changedFromDiff(changes),
        changes,
        dirty: document.isDirty,
        fileName: document.fileName,
        previewMode: this.useWpfHost() ? "wpf" : "web",
        projectThemes, // motywy projektu (combo motywów) — aktualne po skanie zasobów
        previewTheme, // motyw efektywny (standard lub resource:<ścieżka>)
      });
      this.applyInlineDiff(document, baselineText, showInlineDiff);
      if (this.useWpfHost()) scheduleHostRender();
      else {
        // renderer web jest pobłażliwy — brak błędów hosta; wyczyść ewentualną dekorację
        currentError = null;
        currentErrorFix = null;
        refreshErrorDecoration();
      }
      scheduleLiveUpdate(); // okno „na żywo" (jeśli otwarte) dostaje nową treść
    };

    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() === document.uri.toString()) sendDoc();
    });
    const saveSub = vscode.workspace.onDidSaveTextDocument((d) => {
      if (d.uri.toString() === document.uri.toString()) {
        baselineText = document.getText();
        sendDoc();
      }
    });
    // gdy plik zostanie otwarty w zwykłym edytorze tekstu obok — nałóż dekoracje
    const visSub = vscode.window.onDidChangeVisibleTextEditors(() => {
      this.applyInlineDiff(document, baselineText, showInlineDiff);
      refreshErrorDecoration();
    });
    // kursor w edytorze tekstu (otwartym obok) → zaznacz odpowiadający element w XVE.
    // Druga strona (XVE → kursor) działa przez `revealNode`. Webview ignoruje powtórne
    // id, więc pętla się nie tworzy.
    const selSub = vscode.window.onDidChangeTextEditorSelection((e) => {
      if (!this.readSyncConfig().selectFromTextCursor) return;
      if (e.textEditor.document.uri.toString() !== document.uri.toString()) return;
      // Synchronizuj tylko zmiany WYWOŁANE przez użytkownika (Keyboard/Mouse/Command). Zmiana
      // zaznaczenia spowodowana EDYCJĄ dokumentu ma `kind === undefined` — m.in. gdy edycja z XVE
      // (WorkspaceEdit zastępujący całą treść) zresetuje kursor edytora tekstu do offsetu 0. Bez
      // tego filtra taki reset wybierałby korzeń (Window), gubiąc zaznaczenie wybrane w XVE.
      if (e.kind === undefined) return;
      const offset = e.textEditor.document.offsetAt(e.selections[0].active);
      const id = new XamlDocument(document.getText()).nodeIdAtOffset(offset);
      if (id !== null) post({ type: "selectNode", id });
    });
    // zmiana ustawień `xve.preview.*` (np. z UI Settings) → przeładuj wartości, odśwież panel i render
    const cfgSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("xve.sync")) post({ type: "syncConfig", sync: this.readSyncConfig() });
      if (e.affectsConfiguration("xve.editor")) {
        editorCfg = this.readEditorConfig();
        showInlineDiff = editorCfg.highlightChanges;
        showErrors = editorCfg.highlightErrors;
        this.applyInlineDiff(document, baselineText, showInlineDiff);
        refreshErrorDecoration();
        post({ type: "editorConfig", editor: editorCfg }); // zsynchronizuj checkboxy w webview
      }
      // zmiana globalnego domyślnego trybu izolacji → przelicz host dla okien bez per-okno nadpisania
      if (e.affectsConfiguration("xve.preview.isolation")) void applyIsolation();
      if (!e.affectsConfiguration("xve.preview")) return;
      cfg = this.readPreviewConfig();
      renderCap = cfg.maxResolution;
      previewTheme = readThemeOverride() ?? cfg.theme; // zachowaj motyw projektu, jeśli aktywny
      viewportRender = cfg.viewportRender;
      capBasis = cfg.capBasis;
      debugConsole = cfg.debugConsole;
      debugLiveDrag = cfg.debugLiveDrag;
      adaptiveRes = cfg.adaptiveRes;
      motionCap = cfg.motionResolution;
      adaptiveFps = cfg.adaptiveFpsThreshold;
      renderScale = cfg.renderScale;
      // wyślij motyw efektywny osobno — `cfg.theme` to tylko standardowy domyślny;
      // previewCulture = ta sama kultura co dla hosta WPF (web renderer, np. Calendar)
      post({ type: "config", config: { ...cfg, previewCulture: cultureForHost() }, previewTheme });
      sendDoc();
    });
    // Gdy panel staje się aktywny, odśwież cache schowka (włącza/wyłącza „Wklej" w menu) ze
    // schowka systemowego — dzięki temu skopiowanie w jednym oknie XVE jest widoczne w drugim.
    const refreshClipboard = async () => {
      postClipboard(validXamlFragment(await vscode.env.clipboard.readText()));
    };
    const viewSub = panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) {
        void refreshClipboard();
        // Przy aktywacji okna odśwież podgląd hosta WPF — współdzielony proces mógł w międzyczasie
        // renderować inne okno, więc ostatnia klatka tego panelu bywa nieaktualna po powrocie.
        if (this.useWpfHost()) scheduleHostRender(0);
      }
    });
    panel.onDidDispose(() => {
      changeSub.dispose();
      saveSub.dispose();
      visSub.dispose();
      selSub.dispose();
      cfgSub.dispose();
      viewSub.dispose();
      // host izolowany żyje tak długo jak panel — ubij jego proces, by zwolnić zasoby
      if (isolated) this.disposeHost(document.uri.toString());
      // sprzątanie dekoracji w ewentualnym edytorze tekstu, który zostaje otwarty
      this.applyInlineDiff(document, baselineText, false);
      this.applyErrorDecoration(document, null, false);
    });

    // Przelicza izolację po zmianie trybu/silnika (bez ponownej propozycji), przełącza proces hosta
    // i wczytuje zasoby na właściwym hoście. Wywoływane z obsługi „setEngineMode".
    const applyIsolation = async (): Promise<void> => {
      const want = await this.decideIsolated(document, false);
      const switched = want !== isolated;
      if (switched && isolated) this.disposeHost(document.uri.toString()); // zwolnij stary izolowany
      isolated = want;
      hostKey = isolated ? document.uri.toString() : XveEditorProvider.SHARED;
      if (this.useWpfHost()) {
        projectResolved = false; // wczytaj zasoby na (potencjalnie nowym) hoście
        if (switched) void host().request({ cmd: "ping" }); // rozgrzej świeży proces
        await resolveProject(); // używa zapamiętanego wyboru — bez ponownego QuickPicka
      }
      postHostStatus();
      sendDoc();
    };

    panel.webview.onDidReceiveMessage(async (msg: any) => {
      switch (msg?.type) {
        case "ready":
          // 1) od razu zapełnij UI (l10n, ustawienia) — NIE blokuj na ewentualnym dialogu propozycji
          post({
            type: "init",
            l10n: dictionaryForIndex(currentLanguageIndex()),
            languages: LANGUAGES,
            isWindows: process.platform === "win32",
            backend: vscode.workspace.getConfiguration("xve").get<string>("previewBackend") || "auto",
            isolation: this.isolationInfo(document, isolated), // prowizorycznie (przed decyzją)
            config: { ...cfg, previewCulture: cultureForHost() }, // ustawienia podglądu (kultura = jak dla hosta WPF)
            sync: this.readSyncConfig(), // ustawienia synchronizacji zaznaczenia
            editor: editorCfg, // podświetlanie zmian/błędów w edytorze tekstu
            canvas: this.readCanvasConfig(), // domyślne snap/siatka/linijki + fit-on-open

            projectThemes, // motywy projektu (combo motywów); dosyłane też w „doc" po skanie
            previewTheme, // motyw efektywny (standard lub resource:<ścieżka>)
          });
          postHostStatus(); // początkowy stan kropki (inactive/web lub host przed 1. renderem)
          // 2) zdecyduj o izolacji (może pokazać propozycję dla pliku spoza projektu) PRZED 1. renderem
          //    hosta — by pierwsza klatka poszła już na właściwy (izolowany/wspólny) proces.
          isolated = await this.decideIsolated(document);
          hostKey = isolated ? document.uri.toString() : XveEditorProvider.SHARED;
          if (this.useWpfHost()) void host().request({ cmd: "ping" }); // pre-warm właściwego procesu
          postHostStatus(); // zaktualizuj selektor/izolację po decyzji
          sendDoc(); // pierwszy render dokumentu na zdecydowanym hoście
          // zasoby projektu (host WPF): rozwiąż w tle (może pokazać QuickPick) i przerysuj
          if (this.useWpfHost()) {
            void resolveProject().then(() => sendDoc());
          } else {
            // web: zeskanuj słowniki motywów, by combo motywów działało bez hosta, i przerysuj
            projectThemes = this.scanThemes(document.uri.fsPath, previewTheme);
            // #4 auto-wybór: brak preferencji motywu + są motywy → pierwszy jako podgląd (per-plik)
            if (previewTheme === "none" && projectThemes.length) {
              previewTheme = projectThemes[0].value;
              await this.context.workspaceState.update(themeKey, previewTheme);
            }
            sendDoc();
          }
          break;
        case "reloadProjectResources":
          this.scanCache.delete(document.uri.fsPath); // odśwież listę plików projektu
          await resolveProject(true);
          sendDoc();
          break;
        // okienko zasobów: natywny QuickPick (web + WPF) — zaznaczenie zapisuje pickProjectResources
        case "openResourcePicker": {
          this.scanCache.delete(document.uri.fsPath);
          const scan = scanProject(document.uri.fsPath);
          if (scan && scan.items.length) {
            const selected = await this.pickProjectResources(scan, true);
            await applySelection(scan, selected);
          }
          sendDoc();
          break;
        }
        // okienko zasobów: zastosuj checklisty (bez natywnego pickera)
        case "setResourceSelection": {
          const projectDir = this.findProjectDir(document.uri.fsPath);
          const sel = new Set<string>(Array.isArray(msg.paths) ? msg.paths : []);
          if (projectDir)
            await this.context.workspaceState.update(XveEditorProvider.selectionKey(projectDir), [...sel]);
          const scan = scanProject(document.uri.fsPath);
          if (scan) await applySelection(scan, sel);
          sendDoc();
          break;
        }
        // okienko zasobów: „Unload" → tylko typy wbudowane (bez App.xaml/motywu/resx)
        case "unloadResources": {
          const projectDir = this.findProjectDir(document.uri.fsPath);
          if (projectDir)
            await this.context.workspaceState.update(XveEditorProvider.selectionKey(projectDir), []);
          await this.context.workspaceState.update(XveEditorProvider.langKey(document.uri), "off");
          await this.context.workspaceState.update(themeKey, undefined);
          previewTheme = "none";
          const scan = scanProject(document.uri.fsPath);
          if (scan) await applySelection(scan, new Set());
          this.hostResourceLoaded.delete(hostKey);
          // #2: zresetuj proces hosta WPF — assembly (DLL kontrolek) nie da się odładować inaczej
          // niż przez restart; świeży host startuje bez żadnych wczytanych zasobów.
          if (this.useWpfHost()) {
            this.disposeHost(hostKey);
            projectResolved = false; // pozwól ponownie rozwiązać zasoby przy następnym żądaniu
          }
          sendDoc();
          break;
        }
        // okienko zasobów: zmiana języka resx ("" neutralny, kultura, "off" wyłączony)
        case "setResourceLanguage":
          await this.context.workspaceState.update(XveEditorProvider.langKey(document.uri), String(msg.lang ?? ""));
          sendDoc();
          break;
        // okienko zasobów: wymuś kulturę w hoście przez refleksję (TranslationSource.Instance)
        case "setResourceReflectCulture":
          await this.context.workspaceState.update(XveEditorProvider.reflectKey(document.uri), !!msg.enabled);
          sendDoc();
          break;
        case "setAttribute":
          await this.applyEdit(document, (doc) => doc.setAttribute(msg.id, msg.name, msg.value));
          break;
        case "setAttributes":
          await this.applyEdit(document, (doc) => doc.setAttributes(msg.id, msg.attrs));
          break;
        case "removeAttribute":
          await this.applyEdit(document, (doc) => doc.removeAttribute(msg.id, msg.name));
          break;
        case "browseImage": {
          // wybór pliku obrazka → ścieżka względna do katalogu pliku .xaml (fallback: bezwzględna przy innym dysku)
          const picked = await vscode.window.showOpenDialog({
            canSelectMany: false,
            openLabel: t("Prop.BrowseImage"),
            filters: { Images: ["png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "tiff"] },
          });
          if (picked && picked[0]) {
            const abs = picked[0].fsPath;
            let rel = path.relative(baseDir, abs);
            if (!rel || path.isAbsolute(rel)) rel = abs; // inny dysk / brak relacji → ścieżka bezwzględna
            rel = rel.replace(/\\/g, "/"); // XAML/WPF akceptuje ukośniki, przenośne między systemami
            await this.applyEdit(document, (doc) => doc.setAttribute(msg.id, msg.name, rel));
          }
          break;
        }
        case "deleteElement":
          await this.applyEdit(document, (doc) => doc.removeElement(msg.id));
          break;
        case "insertChild": {
          // Wstaw i wylicz NOWE id wstawionego elementu, by webview go zaznaczył (jak przy wklejaniu).
          let newId: number | null = null;
          await this.applyEdit(document, (doc) => {
            newId = doc.insertChildReturningId(msg.parentId, msg.xml, msg.beforeId ?? null);
            return newId !== null;
          });
          if (newId !== null) post({ type: "selectNode", id: newId });
          break;
        }
        case "moveElement": {
          // Ids są pozycyjne → po przeniesieniu element dostaje nowy numer. Wyliczamy go z góry
          // (na kopii dokumentu), aplikujemy edycję, a potem odsyłamy `selectNode`, by webview
          // odtworzył zaznaczenie na przeniesionym elemencie (drzewko + podgląd + właściwości).
          const newId = new XamlDocument(document.getText()).moveElementReturningId(
            msg.id,
            msg.newParentId,
            msg.beforeId ?? null
          );
          await this.applyEdit(document, (doc) =>
            doc.moveElement(msg.id, msg.newParentId, msg.beforeId ?? null)
          );
          if (newId !== null) post({ type: "selectNode", id: newId });
          break;
        }
        case "requestCopy": {
          // Schowek SYSTEMOWY jest źródłem prawdy (kopiowanie między oknami XVE i do edytora
          // tekstu). `clipboard` do webview to tylko cache UI do włączania pozycji „Wklej".
          const src = new XamlDocument(document.getText()).getElementSource(msg.id);
          if (src) {
            await vscode.env.clipboard.writeText(src);
            postClipboard(src);
          }
          break;
        }
        case "requestCut": {
          // Kopiuj do schowka, a następnie usuń element (jak Kopiuj + Usuń, atomowo z punktu
          // widzenia użytkownika). Bramka na korzeń jest w webview (analogicznie do Usuń).
          const src = new XamlDocument(document.getText()).getElementSource(msg.id);
          if (src) {
            await vscode.env.clipboard.writeText(src);
            postClipboard(src);
            await this.applyEdit(document, (doc) => doc.removeElement(msg.id));
          }
          break;
        }
        case "requestPaste": {
          // Autorytatywny odczyt schowka systemowego w chwili wklejania. Waliduje (pojedynczy
          // element XAML — przepuszcza też obcy XAML z edytora) i opcjonalnie deduplikuje x:Name.
          const raw = await vscode.env.clipboard.readText();
          const frag = validXamlFragment(raw);
          if (!frag) break;
          const mode = this.readPasteConfig();
          // Wstaw i wylicz NOWE id wklejonego elementu, by webview go zaznaczył (jak przy moveElement).
          let newId: number | null = null;
          await this.applyEdit(document, (doc) => {
            const xml = mode === "off" ? frag : deduplicateNames(frag, collectNames(doc.roots), mode);
            newId = doc.insertChildReturningId(msg.parentId, xml, msg.beforeId ?? null);
            return newId !== null;
          });
          if (newId !== null) post({ type: "selectNode", id: newId });
          break;
        }
        case "revertAttrs":
          await this.applyEdit(document, (doc) => {
            let any = false;
            for (const s of msg.sets ?? []) if (doc.setAttribute(msg.id, s.name, s.value)) any = true;
            for (const n of msg.removes ?? []) if (doc.removeAttribute(msg.id, n)) any = true;
            return any;
          });
          break;
        case "revertRemoved":
          await this.applyEdit(document, (doc) => {
            const p = doc.getNode(msg.parentId);
            const before = p
              ? (p.children.filter((c) => c.kind === "element")[msg.index]?.id ?? null)
              : null;
            return doc.insertChild(msg.parentId, msg.xml, before);
          });
          break;
        case "setInlineDiff":
          showInlineDiff = !!msg.enabled;
          this.applyInlineDiff(document, baselineText, showInlineDiff);
          // utrwal jako ustawienie (źródło prawdy dzielone z VS Code Settings)
          await vscode.workspace
            .getConfiguration("xve")
            .update("editor.highlightChanges", showInlineDiff, vscode.ConfigurationTarget.Global);
          break;
        case "setShowErrors":
          showErrors = !!msg.enabled;
          refreshErrorDecoration();
          await vscode.workspace
            .getConfiguration("xve")
            .update("editor.highlightErrors", showErrors, vscode.ConfigurationTarget.Global);
          break;
        case "revealError":
          await this.revealError(document, msg.line, msg.col, msg.message);
          break;
        case "autoFix": {
          // popraw literówkę chirurgicznym WorkspaceEdit (np. Buton → Button)
          if (!currentError) break;
          const fix = this.computeAutoFix(document, currentError);
          if (!fix) break;
          const edit = new vscode.WorkspaceEdit();
          edit.replace(document.uri, fix.range, fix.to);
          await vscode.workspace.applyEdit(edit);
          break;
        }
        case "revealNode":
          if (this.readSyncConfig().selectInTextEditor) this.revealNode(document, msg.id);
          break;
        case "undo":
          // dokument to TextDocument — edycje XVE idą przez WorkspaceEdit, więc cofają się
          // natywnym stosem undo (gdy webview/edytor jest aktywny)
          await vscode.commands.executeCommand("undo");
          break;
        case "redo":
          await vscode.commands.executeCommand("redo");
          break;
        case "previewDrag":
          // podgląd przeciągania (pełny re-render na kopii dokumentu, bez commitu)
          if (this.useWpfHost()) {
            const doc = new XamlDocument(document.getText());
            doc.setAttributes(msg.id, msg.attrs);
            const cap = capFor(!!msg.lowRes);
            const t0 = Date.now();
            const r = await host().request({ cmd: "render", xaml: doc.toHostXaml(), width: rW(), height: rH(), ...hostOpts(cap, !!msg.rootDrag) });
            if (cap === renderCap) lastFullMs = Date.now() - t0;
            if (r.ok && r.png) this.postRender(post, r, dragDebug(t0, cap));
          }
          break;
        case "dragStart":
          // trwała sesja: host parsuje RAZ i cache'uje żywe drzewo
          if (this.useWpfHost()) {
            const hostXaml = new XamlDocument(document.getText()).toHostXaml();
            const cap = capFor(!!msg.lowRes);
            const t0 = Date.now();
            const r = await host().request({ cmd: "dragStart", xaml: hostXaml, width: rW(), height: rH(), ...hostOpts(cap, !!msg.rootDrag) });
            if (cap === renderCap) lastFullMs = Date.now() - t0;
            if (r.ok && r.png) this.postRender(post, r, dragDebug(t0, cap));
          }
          break;
        case "dragUpdate":
          if (this.useWpfHost()) {
            const cap = capFor(!!msg.lowRes);
            const t0 = Date.now();
            const r = await host().request({ cmd: "dragUpdate", uid: "u" + msg.id, attrs: msg.attrs, ...hostOpts(cap, !!msg.rootDrag) });
            if (cap === renderCap) lastFullMs = Date.now() - t0;
            if (r.ok && r.png) this.postRender(post, r, dragDebug(t0, cap));
          }
          break;
        case "dragEnd":
          if (this.useWpfHost()) void host().request({ cmd: "dragEnd" });
          break;
        case "showWindow":
          if (this.useWpfHost()) {
            const hostXaml = new XamlDocument(document.getText()).toHostXaml();
            const filename = document.fileName.split(/[\\/]/).pop() || "Preview.xaml";
            const iconPath = vscode.Uri.joinPath(this.context.extensionUri, "Assets", "iconXVE2.ico").fsPath;
            const live = !!msg.live;
            const winId = document.uri.toString();
            void host().request({
              cmd: "showWindow",
              xaml: hostXaml,
              filename,
              iconPath,
              live,
              winId,
              liveLabel: t("Run.LiveBadge"),
              ...hostOpts(),
            });
            // otwarcie w trybie live podpina to okno pod aktualizacje; snapshot nie rusza istniejącego live
            if (live) liveWinId = winId;
          } else {
            vscode.window.showWarningMessage(t("Run.WindowsOnly"));
          }
          break;
        case "viewport":
          if (msg.width > 0) viewW = msg.width;
          if (msg.height > 0) viewH = msg.height;
          break;
        case "setViewportRender":
          viewportRender = !!msg.enabled;
          void vscode.workspace
            .getConfiguration("xve")
            .update("preview.viewportRender", viewportRender, vscode.ConfigurationTarget.Global);
          sendDoc();
          break;
        case "viewbox":
          vbX = msg.x ?? 0;
          vbY = msg.y ?? 0;
          vbW = msg.w ?? 0;
          vbH = msg.h ?? 0;
          vbVisW = typeof msg.visW === "number" ? msg.visW : vbW;
          vbVisH = typeof msg.visH === "number" ? msg.visH : vbH;
          if (typeof msg.zoom === "number" && msg.zoom > 0) curZoom = msg.zoom;
          // viewbox jest responsywny na scroll → bez debounce, ale dzieli „in-flight" z renderem dok.
          // lowRes (scroll/zoom w ruchu) → niższy limit; settle (po ustaniu) → pełny.
          if (viewportRender && this.useWpfHost()) void doHostRender(capFor(!!msg.lowRes));
          break;
        case "setAutoReveal":
          autoReveal = !!msg.enabled;
          if (this.useWpfHost()) scheduleHostRender(0);
          break;
        case "setTabs":
          // pełna lista aktywnych TabItem (uid) z webview — zastępuje poprzednią; re-render utrwala widok
          tabUids = Array.isArray(msg.uids) ? msg.uids.filter((u: unknown) => typeof u === "string") : [];
          if (this.useWpfHost()) scheduleHostRender(0);
          break;
        case "setReveal":
          revealUid = typeof msg.uid === "string" ? msg.uid : null;
          if (autoReveal) {
            // jednorazowo przewiń ScrollViewery do elementu przy zaznaczeniu; spring-load w reorderze
            // przekazuje noScroll, by nie przesuwać podglądu w trakcie gestu przeciągania.
            if (!msg.noScroll) pendingRevealScroll = true;
            if (this.useWpfHost()) scheduleHostRender(0);
          }
          break;
        case "scrollViewer":
          if (typeof msg.uid === "string") {
            scrolls[msg.uid] = { h: msg.h ?? 0, v: msg.v ?? 0 };
            // przewijanie ScrollViewer w projekcie = ruch → niska rozdzielczość, pełna po ustaniu (settle)
            if (this.useWpfHost()) void doHostRender(capFor(!!msg.lowRes));
          }
          break;
        case "dpr":
          if (typeof msg.value === "number" && msg.value > 0 && msg.value !== dpr) {
            dpr = msg.value;
            if (renderScale === "auto") scheduleHostRender(0);
          }
          break;
        case "setPreviewTheme": {
          const v = String(msg.value ?? "");
          if (v.startsWith("resource:")) {
            // motyw projektu (słownik) — zapamiętaj per-plik; NIE ruszaj globalnego ustawienia
            await this.context.workspaceState.update(themeKey, v);
            previewTheme = v;
            sendDoc();
          } else {
            // standardowy motyw — wyczyść nadpisanie projektu i zapisz globalnie
            const std = ["none", "classic98", "system", "light", "dark", "native"].includes(v) ? v : "none";
            await this.context.workspaceState.update(themeKey, undefined);
            previewTheme = std;
            await vscode.workspace
              .getConfiguration("xve")
              .update("preview.theme", std, vscode.ConfigurationTarget.Global);
            sendDoc();
          }
          break;
        }
        case "setRenderCap":
          renderCap = typeof msg.value === "number" && msg.value >= 0 ? msg.value : cfg.maxResolution;
          void vscode.workspace
            .getConfiguration("xve")
            .update("preview.maxResolution", renderCap, vscode.ConfigurationTarget.Global);
          sendDoc();
          break;
        case "setConfig": {
          // generyczny zapis ustawień podglądu z webview do konfiguracji (źródło prawdy)
          const keyMap: Record<string, string> = {
            renderScale: "preview.renderScale",
            dragStrategy: "preview.dragStrategy",
            dragIntervalMs: "preview.dragIntervalMs",
            dragFrames: "preview.dragFrames",
            dragCoalesce: "preview.dragCoalesce",
            dragSession: "preview.dragSession",
            dragOnChange: "preview.dragOnChange",
            adaptiveRes: "preview.adaptiveRes",
            motionResolution: "preview.motionResolution",
            adaptiveFpsThreshold: "preview.adaptiveFpsThreshold",
            overscan: "preview.overscan",
            capBasis: "preview.capBasis",
            debugConsole: "preview.debugConsole",
            consoleOnStart: "preview.consoleOnStart",
            debugLiveDrag: "preview.debugLiveDrag",
          };
          const key = keyMap[msg.key];
          if (key) {
            await vscode.workspace
              .getConfiguration("xve")
              .update(key, msg.value, vscode.ConfigurationTarget.Global);
            if (msg.key === "renderScale") {
              renderScale = String(msg.value);
              scheduleHostRender(0);
            } else if (msg.key === "capBasis") {
              capBasis = String(msg.value);
              scheduleHostRender(0);
            } else if (msg.key === "debugConsole") {
              debugConsole = !!msg.value;
              scheduleHostRender(0); // pierwsze włączenie → dosyłamy telemetrię od razu
            } else if (msg.key === "debugLiveDrag") {
              debugLiveDrag = !!msg.value; // dotyczy następnych klatek drag — bez re-renderu
            } else if (msg.key === "adaptiveRes") {
              adaptiveRes = !!msg.value;
            } else if (msg.key === "motionResolution") {
              motionCap = typeof msg.value === "number" && msg.value >= 0 ? msg.value : motionCap;
            } else if (msg.key === "adaptiveFpsThreshold") {
              adaptiveFps = typeof msg.value === "number" && msg.value >= 0 ? msg.value : adaptiveFps;
            }
            // overscan jest stosowany po stronie webview (sendViewbox); zapis wystarczy
          }
          break;
        }
        case "setSync": {
          const keyMap: Record<string, string> = {
            selectInTextEditor: "sync.selectInTextEditor",
            selectFromTextCursor: "sync.selectFromTextCursor",
          };
          const key = keyMap[msg.key];
          if (key)
            await vscode.workspace
              .getConfiguration("xve")
              .update(key, !!msg.value, vscode.ConfigurationTarget.Global);
          break;
        }
        case "setEngineMode": {
          // jeden selektor obejmuje silnik (globalny) + izolację tego okna (per-okno):
          //  auto/web/wpf-host → silnik;  wpf-host-isolated → silnik wpf-host + izolacja „isolated".
          const v = ["auto", "web", "wpf-host", "wpf-host-isolated"].includes(msg.value)
            ? msg.value
            : "auto";
          const backendVal = v === "web" ? "web" : v === "auto" ? "auto" : "wpf-host";
          const effective = process.platform === "win32" ? backendVal : "web"; // poza Windows zawsze web
          await vscode.workspace
            .getConfiguration("xve")
            .update("previewBackend", effective, vscode.ConfigurationTarget.Global);
          const isoVal = v === "wpf-host-isolated" ? "isolated" : v === "wpf-host" ? "shared" : "auto";
          await this.setIsolationOverride(document.uri, isoVal);
          if (!this.useWpfHost()) {
            if (isolated) this.disposeHost(document.uri.toString()); // web → zwolnij izolowany proces
            isolated = false;
            hostKey = XveEditorProvider.SHARED;
            setHostStatus("inactive");
            sendDoc();
          } else {
            await applyIsolation(); // przelicz izolację, przełącz proces, wczytaj zasoby, przerysuj
          }
          break;
        }
        case "setIsolationPolicy": {
          // globalna polityka izolacji hosta WPF (ask | auto | shared | isolated) z panelu Ustawień
          const v = ["ask", "auto", "shared", "isolated"].includes(msg.value) ? msg.value : "ask";
          await vscode.workspace
            .getConfiguration("xve")
            .update("preview.isolation", v, vscode.ConfigurationTarget.Global);
          // cfgSub (xve.preview.isolation) przeliczy izolację i odeśle stan do webview
          break;
        }
        case "setLanguage": {
          // język UI rozszerzenia (xve.language) — globalny; zastosuje się po przeładowaniu webview (Ctrl+R)
          const allowed = ["", "en", "pl", "es", "de", "fr", "ja", "zh"];
          const v = allowed.includes(msg.value) ? msg.value : "";
          await vscode.workspace
            .getConfiguration("xve")
            .update("language", v, vscode.ConfigurationTarget.Global);
          break;
        }
        case "openExtensionSettings":
          // otwórz natywne ustawienia VS Code przefiltrowane do tego rozszerzenia
          await vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "@ext:zete.xve-vscode"
          );
          break;
        case "revertAll":
          if (document.getText() !== baselineText) {
            const edit = new vscode.WorkspaceEdit();
            const full = new vscode.Range(
              document.positionAt(0),
              document.positionAt(document.getText().length)
            );
            edit.replace(document.uri, full, baselineText);
            await vscode.workspace.applyEdit(edit);
          }
          break;
      }
    });
  }

  /** Przewija widoczne edytory tekstu do pierwszego wiersza danego elementu. */
  private revealNode(document: vscode.TextDocument, id: number): void {
    const editors = vscode.window.visibleTextEditors.filter(
      (e) => e.document.uri.toString() === document.uri.toString()
    );
    if (editors.length === 0) return;
    const node = new XamlDocument(document.getText()).getNode(id);
    if (!node) return;
    const off = node.openTagSpan?.start ?? node.span.start;
    const pos = document.positionAt(off);
    const range = new vscode.Range(pos, pos);
    for (const e of editors) {
      e.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      e.selection = new vscode.Selection(pos, pos);
    }
  }

  /**
   * Wybór zasobów projektu do załadowania w hoście. Zapamiętuje wybór per projekt
   * (`workspaceState`), więc pyta tylko raz; `force` wymusza ponowny QuickPick.
   * Tryb `xve.project.autoLoadResources`: ask (pytaj) | always (wszystko) | never (nic).
   */
  private async pickProjectResources(scan: ProjectScan, force: boolean): Promise<Set<string>> {
    const mode = vscode.workspace.getConfiguration("xve").get<string>("project.autoLoadResources") || "ask";
    const stateKey = "xve.project.selection:" + scan.projectDir;
    const saved = this.context.workspaceState.get<string[]>(stateKey);
    if (!force && saved !== undefined) return new Set(saved);

    let selectedPaths: string[];
    if (!force && mode === "never") {
      selectedPaths = [];
    } else if (!force && mode === "always") {
      selectedPaths = scan.items.map((i) => i.path);
    } else {
      type Pick = vscode.QuickPickItem & { path: string };
      const picks = await vscode.window.showQuickPick<Pick>(
        scan.items.map((i) => ({
          label: i.label,
          description: kindLabel(i.kind),
          detail: i.detail,
          picked: true,
          path: i.path,
        })),
        {
          canPickMany: true,
          title: f("Resources.PickTitle", scan.projectName),
          placeHolder: t("Resources.PickPlaceholder"),
        }
      );
      selectedPaths = picks ? picks.map((p) => p.path) : [];
    }
    await this.context.workspaceState.update(stateKey, selectedPaths);
    return new Set(selectedPaths);
  }

  /** Aplikuje chirurgiczną mutację na świeżym XamlDocument i zapisuje jako WorkspaceEdit. */
  private async applyEdit(
    document: vscode.TextDocument,
    mutate: (doc: XamlDocument) => boolean
  ): Promise<void> {
    const doc = new XamlDocument(document.getText());
    if (!mutate(doc)) return;
    const newText = doc.getText();
    if (newText === document.getText()) return;

    const edit = new vscode.WorkspaceEdit();
    const full = new vscode.Range(
      document.positionAt(0),
      document.positionAt(document.getText().length)
    );
    edit.replace(document.uri, full, newText);
    await vscode.workspace.applyEdit(edit);
  }

  private html(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.css")
    );
    const codiconUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "codicon.css")
    );
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join("; ");

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${codiconUri}" rel="stylesheet" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>XAML Visual Editor</title>
</head>
<body>
  <div id="app">
    <div id="layout">
      <aside id="tree-pane">
        <div class="pane-title"><span data-l10n="View.Structure"></span><button id="tree-close" class="pane-close" type="button"><span class="codicon codicon-close"></span></button></div>
        <div id="tree-add"></div>
        <div id="tree"></div>
        <footer id="statusbar"></footer>
      </aside>
      <div class="splitter" id="splitter-tree"></div>
      <div id="preview-col">
      <main id="preview-pane">
        <div id="preview-viewport" class="rulers-on">
          <div id="surface-scroll">
            <div id="zoom-sizer"></div>
            <div id="zoom">
              <div id="grid-layer"></div>
              <div id="surface"></div>
              <div id="guide-layer"></div>
            </div>
            <div id="sel-overlay"></div>
          </div>
          <div id="ruler-top"><div id="ruler-top-ticks"></div><div id="ruler-top-labels"></div><div id="ruler-top-guides"></div></div>
          <div id="ruler-left"><div id="ruler-left-ticks"></div><div id="ruler-left-labels"></div><div id="ruler-left-guides"></div></div>
          <div id="ruler-corner"></div>
        </div>
        <div id="changes-view"></div>
        <div id="float-toolbar"></div>
        <div id="zoom-panel"></div>
      </main>
      <div id="host-console-dock"></div>
      <div id="debug-console-dock"></div>
      </div>
      <div class="splitter" id="splitter-props"></div>
      <aside id="props-pane">
        <div class="pane-title" id="props-header"></div>
        <div id="props"></div>
      </aside>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}

/** Buduje payload zasobów dla hosta z zaznaczenia użytkownika (assemblies + dictionaries + key). */
function buildProjectPayload(
  scan: ProjectScan,
  selected: Set<string>
): { key: string; assemblies: string[]; dictionaries: string[] } {
  const assemblies = scan.items
    .filter((i) => i.kind === "dll" && selected.has(i.path))
    .map((i) => i.path);
  // Tylko App.xaml na stałe (Application.Resources). Słowniki motywów (resourceDict) NIE są tu
  // mergowane — obsługuje je mechanizm motywu (ApplyTheme), więc przełączenie na motyw standardowy
  // (Classic/Fluent) faktycznie je zdejmuje (Etap 2 #5).
  const dictionaries = scan.items
    .filter((i) => i.kind === "appResources" && selected.has(i.path))
    .map((i) => i.path);
  const key = [...assemblies, ...dictionaries].sort().join("|");
  return { key, assemblies, dictionaries };
}

/** Buduje zlokalizowane podsumowanie załadowanych zasobów z danych strukturalnych hosta. */
function formatResourceSummary(r: import("../host/WpfHost.ts").RenderResult): string {
  const asm = r.resAsm && r.resAsm.length > 0 ? r.resAsm.join(", ") : "—";
  const dicts = (r.resDict ?? []).map((d) => {
    if (d.st === "ok") return "✓ " + d.name + " (" + (d.n ?? 0) + ")";
    if (d.st === "skip") return "— " + d.name + " (" + t("Resources.Skipped") + ")";
    return "✗ " + d.name + ": " + (d.err ?? "");
  });
  return (
    f("Resources.Libraries", asm) +
    "\n" +
    f("Resources.Dictionaries", dicts.length > 0 ? dicts.join("\n  ") : "—") +
    (r.locTarget ? "\n" + f("Resources.Localization", r.locTarget) : "")
  );
}

function kindLabel(kind: ProjectItemKind): string {
  switch (kind) {
    case "dll":
      return t("Resource.Kind.Dll");
    case "appResources":
      return t("Resource.Kind.AppResources");
    case "resourceDict":
      return t("Resource.Kind.ResourceDict");
  }
}

/** Mapa podświetleń id → { atrybut: wartośćBaseline|null } wyprowadzona z diffu strukturalnego. */
function changedFromDiff(changes: Change[]): Record<number, Record<string, string | null>> {
  const out: Record<number, Record<string, string | null>> = {};
  for (const c of changes) {
    if (c.kind === "attrs") {
      const m: Record<string, string | null> = {};
      for (const a of c.attrs) m[a.name] = a.baseline;
      out[c.id] = m;
    }
  }
  return out;
}
