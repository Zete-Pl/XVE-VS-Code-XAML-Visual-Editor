import * as vscode from "vscode";
import { XveEditorProvider } from "./editor/XveEditorProvider.ts";
import { applyLanguage, t } from "./core/Localization.ts";

export function activate(context: vscode.ExtensionContext): void {
  // język UI: ustawienie wtyczki → język VS Code → angielski
  const configured = vscode.workspace.getConfiguration("xve").get<string>("language") || "";
  applyLanguage(configured, [vscode.env.language?.split("-")[0] ?? "en"]);

  context.subscriptions.push(XveEditorProvider.register(context));

  context.subscriptions.push(
    vscode.commands.registerCommand("xve.openVisualEditor", async (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        vscode.window.showInformationMessage(t("Editor.OpenXamlFirst"));
        return;
      }
      await vscode.commands.executeCommand("vscode.openWith", target, XveEditorProvider.viewType);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("xve.openTextEditor", async (uri?: vscode.Uri) => {
      // Wywoływana z paska tytułu, gdy aktywny jest edytor XVE — TextDocument nie jest
      // wtedy aktywnym edytorem, więc URI bierzemy z argumentu menu lub z aktywnej karty.
      const tabInput = vscode.window.tabGroups.activeTabGroup.activeTab?.input as { uri?: vscode.Uri } | undefined;
      const target = uri ?? tabInput?.uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        vscode.window.showInformationMessage(t("Editor.OpenXamlFirst"));
        return;
      }
      // "default" = wbudowany edytor tekstu VS Code
      await vscode.commands.executeCommand("vscode.openWith", target, "default");
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
