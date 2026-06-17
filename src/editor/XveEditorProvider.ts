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

    const sendDoc = () => {
      const doc = new XamlDocument(document.getText());
      post({
        type: "doc",
        tree: doc.toTree(),
        source: document.getText(),
        fileName: document.fileName,
      });
    };

    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() === document.uri.toString()) sendDoc();
    });
    panel.onDidDispose(() => changeSub.dispose());

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
          await this.applyAttribute(document, msg.id, msg.name, msg.value);
          break;
      }
    });
  }

  private async applyAttribute(
    document: vscode.TextDocument,
    id: number,
    name: string,
    value: string
  ): Promise<void> {
    const doc = new XamlDocument(document.getText());
    if (!doc.setAttribute(id, name, value)) return;
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
      <main id="preview-pane"><div class="pane-title" data-l10n="View.Preview"></div><pre id="source"></pre></main>
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
