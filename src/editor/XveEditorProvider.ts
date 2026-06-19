import * as vscode from "vscode";
import { XamlDocument } from "../core/XamlDocument.ts";
import { structuralDiff } from "../core/StructuralDiff.ts";
import type { Change } from "../core/StructuralDiff.ts";
import { changedLinesInB } from "../core/LineDiff.ts";
import { WpfHost } from "../host/WpfHost.ts";
import { dictionaryForIndex, currentLanguageIndex, LANGUAGES } from "../core/Localization.ts";

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

  constructor(private readonly context: vscode.ExtensionContext) {
    this.changedLineDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor("diffEditor.insertedLineBackground"),
      overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.addedForeground"),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    context.subscriptions.push(this.changedLineDecoration);
  }

  /** Proces hosta WPF (Windows) — tworzony leniwie i współdzielony. */
  private host?: WpfHost;
  private getHost(): WpfHost {
    if (!this.host) {
      const exe = vscode.Uri.joinPath(
        this.context.extensionUri,
        "wpf-host",
        "bin",
        "Release",
        "net10.0-windows",
        "xve-wpf-host.exe"
      ).fsPath;
      this.host = new WpfHost(exe);
      this.context.subscriptions.push({ dispose: () => this.host?.dispose() });
    }
    return this.host;
  }
  private useWpfHost(): boolean {
    if (process.platform !== "win32") return false;
    const cfg = vscode.workspace.getConfiguration("xve").get<string>("previewBackend") || "auto";
    return cfg === "wpf-host" || cfg === "auto"; // Auto na Windows = host WPF
  }

  /** Renderuje bieżący dokument przez host WPF i wysyła PNG + mapę hit-test do webview. */
  private async renderViaHost(
    document: vscode.TextDocument,
    post: (m: unknown) => void,
    width: number,
    height: number,
    opts: Record<string, unknown> = {}
  ): Promise<void> {
    try {
      const hostXaml = new XamlDocument(document.getText()).toHostXaml();
      const r = await this.getHost().request({ cmd: "render", xaml: hostXaml, width, height, ...opts });
      if (r.ok && r.png) this.postRender(post, r);
      else post({ type: "renderError", error: r.error ?? "render failed" });
    } catch (e) {
      post({ type: "renderError", error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** Wysyła wynik renderu hosta do webview (PNG + pełny rozmiar + wycinek + hit-test). */
  private postRender(post: (m: unknown) => void, r: import("../host/WpfHost.ts").RenderResult): void {
    post({
      type: "render",
      png: r.png,
      width: r.width,
      height: r.height,
      vx: r.vx ?? 0,
      vy: r.vy ?? 0,
      vw: r.vw ?? r.width,
      vh: r.vh ?? r.height,
      rects: r.rects ?? [],
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

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel
  ): Promise<void> {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist")],
    };
    panel.webview.html = this.html(panel.webview);

    const post = (msg: unknown) => panel.webview.postMessage(msg);

    // baseline = ostatnio zapisana zawartość (przy otwarciu == zawartość na dysku)
    let baselineText = document.getText();
    let showInlineDiff = true; // przełącznik z widoku Changes (domyślnie włączony)
    // realny rozmiar powierzchni podglądu (fallback dla korzeni bez Width/Height)
    let viewW = 1200;
    let viewH = 900;
    let useRealSize = true; // przełącznik z ustawień: realny viewport vs sztywne 1200×900
    let renderCap = 2560; // limit rozdzielczości renderu hosta (px); 0 = bez limitu
    const rW = () => (useRealSize ? viewW : 1200);
    const rH = () => (useRealSize ? viewH : 900);
    // render tylko widocznego obszaru (domyślnie wł.)
    let viewportRender = true;
    let vbX = 0;
    let vbY = 0;
    let vbW = 0;
    let vbH = 0;
    let curZoom = 1;
    let previewTheme = "none"; // motyw podglądu hosta: none | system | light | dark
    // slice tylko gdy webview przysłał realny prostokąt — inaczej pełny render
    const vbExtra = (): Record<string, unknown> =>
      viewportRender && vbW > 0 && vbH > 0
        ? { viewbox: { x: vbX, y: vbY, w: vbW, h: vbH }, zoom: curZoom }
        : {};
    // wspólne opcje renderu hosta (limit + motyw + ewentualny viewbox)
    const hostOpts = (): Record<string, unknown> => ({ cap: renderCap, theme: previewTheme, ...vbExtra() });

    const sendDoc = () => {
      const text = document.getText();
      const doc = new XamlDocument(text);
      const changes = text === baselineText ? [] : structuralDiff(new XamlDocument(baselineText), doc);
      post({
        type: "doc",
        tree: doc.toTree(),
        // mapa podświetleń wyprowadzona z TEGO SAMEGO dopasowania co Changes — spójna
        // i poprawnie przypisana (także dla wielu elementów tego samego typu)
        changed: changedFromDiff(changes),
        changes,
        dirty: document.isDirty,
        fileName: document.fileName,
        previewMode: this.useWpfHost() ? "wpf" : "web",
      });
      this.applyInlineDiff(document, baselineText, showInlineDiff);
      if (this.useWpfHost()) void this.renderViaHost(document, post, rW(), rH(), hostOpts());
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
    });
    panel.onDidDispose(() => {
      changeSub.dispose();
      saveSub.dispose();
      visSub.dispose();
    });

    panel.webview.onDidReceiveMessage(async (msg: any) => {
      switch (msg?.type) {
        case "ready":
          post({
            type: "init",
            l10n: dictionaryForIndex(currentLanguageIndex()),
            languages: LANGUAGES,
            isWindows: process.platform === "win32",
            backend: vscode.workspace.getConfiguration("xve").get<string>("previewBackend") || "auto",
          });
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
        case "deleteElement":
          await this.applyEdit(document, (doc) => doc.removeElement(msg.id));
          break;
        case "insertChild":
          await this.applyEdit(document, (doc) =>
            doc.insertChild(msg.parentId, msg.xml, msg.beforeId ?? null)
          );
          break;
        case "requestCopy": {
          const src = new XamlDocument(document.getText()).getElementSource(msg.id);
          if (src) post({ type: "clipboard", xml: src });
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
          break;
        case "revealNode":
          this.revealNode(document, msg.id);
          break;
        case "previewDrag":
          // podgląd przeciągania (pełny re-render na kopii dokumentu, bez commitu)
          if (this.useWpfHost()) {
            const doc = new XamlDocument(document.getText());
            doc.setAttributes(msg.id, msg.attrs);
            const r = await this.getHost().request({ cmd: "render", xaml: doc.toHostXaml(), width: rW(), height: rH(), ...hostOpts() });
            if (r.ok && r.png) this.postRender(post, r);
          }
          break;
        case "dragStart":
          // trwała sesja: host parsuje RAZ i cache'uje żywe drzewo
          if (this.useWpfHost()) {
            const hostXaml = new XamlDocument(document.getText()).toHostXaml();
            const r = await this.getHost().request({ cmd: "dragStart", xaml: hostXaml, width: rW(), height: rH(), ...hostOpts() });
            if (r.ok && r.png) this.postRender(post, r);
          }
          break;
        case "dragUpdate":
          if (this.useWpfHost()) {
            const r = await this.getHost().request({ cmd: "dragUpdate", uid: "u" + msg.id, attrs: msg.attrs, ...hostOpts() });
            if (r.ok && r.png) this.postRender(post, r);
          }
          break;
        case "dragEnd":
          if (this.useWpfHost()) void this.getHost().request({ cmd: "dragEnd" });
          break;
        case "viewport":
          if (msg.width > 0) viewW = msg.width;
          if (msg.height > 0) viewH = msg.height;
          break;
        case "setViewportRender":
          viewportRender = !!msg.enabled;
          sendDoc();
          break;
        case "viewbox":
          vbX = msg.x ?? 0;
          vbY = msg.y ?? 0;
          vbW = msg.w ?? 0;
          vbH = msg.h ?? 0;
          if (typeof msg.zoom === "number" && msg.zoom > 0) curZoom = msg.zoom;
          if (viewportRender && this.useWpfHost()) {
            void this.renderViaHost(document, post, rW(), rH(), hostOpts());
          }
          break;
        case "setPreviewTheme":
          previewTheme = ["none", "system", "light", "dark"].includes(msg.value) ? msg.value : "none";
          sendDoc();
          break;
        case "setRealSize":
          useRealSize = !!msg.enabled;
          sendDoc();
          break;
        case "setRenderCap":
          renderCap = typeof msg.value === "number" && msg.value >= 0 ? msg.value : 2560;
          sendDoc();
          break;
        case "setBackend": {
          const value = ["auto", "web", "wpf-host"].includes(msg.value) ? msg.value : "auto";
          // na innych platformach niż Windows zawsze cross-platform (web)
          const effective = process.platform === "win32" ? value : "web";
          await vscode.workspace
            .getConfiguration("xve")
            .update("previewBackend", effective, vscode.ConfigurationTarget.Global);
          sendDoc();
          break;
        }
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
  <link href="${styleUri}" rel="stylesheet" />
  <title>XAML Visual Editor</title>
</head>
<body>
  <div id="app">
    <div id="toolbar"></div>
    <div id="layout">
      <aside id="tree-pane"><div class="pane-title" data-l10n="View.Structure"></div><div id="tree"></div></aside>
      <main id="preview-pane">
        <div class="pane-title" data-l10n="View.Preview"></div>
        <div id="preview-tools"></div>
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
      </main>
      <aside id="props-pane"><div class="pane-title" data-l10n="View.Properties"></div><div id="props"></div></aside>
    </div>
    <footer id="statusbar"></footer>
    <div id="settings-overlay" class="hidden"><div id="settings-panel"></div></div>
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
