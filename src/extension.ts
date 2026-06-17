import * as vscode from "vscode";
import { XveEditorProvider } from "./editor/XveEditorProvider.ts";
import { applyLanguage } from "./core/Localization.ts";

export function activate(context: vscode.ExtensionContext): void {
  // język UI: ustawienie wtyczki → język VS Code → angielski
  const configured = vscode.workspace.getConfiguration("xve").get<string>("language") || "";
  applyLanguage(configured, [vscode.env.language?.split("-")[0] ?? "en"]);

  context.subscriptions.push(XveEditorProvider.register(context));

  context.subscriptions.push(
    vscode.commands.registerCommand("xve.openVisualEditor", async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        vscode.window.showInformationMessage("XVE: open a .xaml file first.");
        return;
      }
      await vscode.commands.executeCommand("vscode.openWith", target, XveEditorProvider.viewType);
    })
  );

  // reaguj na zmianę języka w ustawieniach
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("xve.language")) {
        const code = vscode.workspace.getConfiguration("xve").get<string>("language") || "";
        applyLanguage(code, [vscode.env.language?.split("-")[0] ?? "en"]);
      }
    })
  );
}

export function deactivate(): void {
  /* nic do sprzątania */
}
