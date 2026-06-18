import * as vscode from "vscode";
import { XamlDocument } from "../core/XamlDocument.ts";
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

  constructor(private readonly context: vscode.ExtensionContext) {}

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

    const sendDoc = () => {
      const doc = new XamlDocument(document.getText());
      post({
        type: "doc",
        tree: doc.toTree(),
        changed: this.changedAttributes(baselineText, document.getText()),
        dirty: document.isDirty,
        fileName: document.fileName,
      });
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
    panel.onDidDispose(() => {
      changeSub.dispose();
      saveSub.dispose();
    });

    panel.webview.onDidReceiveMessage(async (msg: any) => {
      switch (msg?.type) {
        case "ready":
          post({
            type: "init",
            l10n: dictionaryForIndex(currentLanguageIndex()),
            languages: LANGUAGES,
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
      }
    });
  }

  /** Mapa id → { atrybut: wartośćBaseline | null }. null = atrybut dodany (brak w baseline). */
  private changedAttributes(
    baselineText: string,
    currentText: string
  ): Record<number, Record<string, string | null>> {
    if (baselineText === currentText) return {};
    const base = new XamlDocument(baselineText);
    const cur = new XamlDocument(currentText);
    const out: Record<number, Record<string, string | null>> = {};
    const walk = (id: number) => {
      const node = cur.getNode(id);
      if (!node || node.kind !== "element") return;
      const baseNode = base.getNode(id);
      for (const a of node.attributes) {
        const baseAttr = baseNode?.attributes.find((b) => b.name === a.name);
        if (!baseNode || baseAttr === undefined) {
          (out[id] ??= {})[a.name] = null;
        } else if (baseAttr.value !== a.value) {
          (out[id] ??= {})[a.name] = baseAttr.value;
        }
      }
      for (const c of node.children) walk(c.id);
    };
    if (cur.root) walk(cur.root.id);
    return out;
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
      <main id="preview-pane"><div class="pane-title" data-l10n="View.Preview"></div><div id="surface-scroll"><div id="surface"></div><div id="sel-overlay"></div></div></main>
      <aside id="props-pane"><div class="pane-title" data-l10n="View.Properties"></div><div id="props"></div></aside>
    </div>
    <footer id="statusbar"></footer>
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
