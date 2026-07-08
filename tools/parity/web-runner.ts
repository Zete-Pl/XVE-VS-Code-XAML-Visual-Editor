// Runner web: renderuje XAML w headless Chromium (Playwright) tym samym kodem co webview (bundle
// dist/parity-harness.js + webview/style.css) i mierzy układ przez getBoundingClientRect.
//
// Jedna instancja przeglądarki/strony jest reużywana między próbkami — strona ładuje CSS + harness raz,
// a każda próbka woła window.xveMeasure(xamlText).

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import type { Rect } from "./diff.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");

interface WebRect extends Rect {
  tag: string;
}
interface MeasureOpts {
  themeClass?: string;
}
declare global {
  interface Window {
    xveMeasure: (xamlText: string, opts?: MeasureOpts) => WebRect[];
  }
}

export class WebRunner {
  private browser?: Browser;
  private page?: Page;

  async start(): Promise<void> {
    const harnessJs = fs.readFileSync(path.join(ROOT, "dist", "parity-harness.js"), "utf8");
    const css = fs.readFileSync(path.join(ROOT, "webview", "style.css"), "utf8");
    this.browser = await chromium.launch();
    this.page = await this.browser.newPage({ deviceScaleFactor: 1 });
    await this.page.setContent(
      `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style>` +
        // Zmienne, które w prawdziwym webview wstrzykuje VS Code — bez nich font-family w .xve-el
        // (zawiera var(--vscode-font-family)) stawałby się nieprawidłowy i tekst leciał na serif.
        `<style>:root{--vscode-font-family:"Segoe UI",sans-serif;--vscode-font-size:13px;` +
        `--vscode-foreground:#000;--vscode-editor-background:#fff}` +
        // body bez marginesu i tła, #surface inline-block (wymiar = korzeń Window)
        `html,body{margin:0;padding:0;background:#fff}#surface{position:relative;display:inline-block}</style>` +
        `</head><body><div id="surface"></div></body></html>`,
      { waitUntil: "load" }
    );
    await this.page.addScriptTag({ content: harnessJs });
  }

  /** Mierzy układ próbki. themeClass domyślnie pusty (= classic, parność z theme:"none" hosta). */
  async measure(xamlText: string, opts: MeasureOpts = {}): Promise<Rect[]> {
    if (!this.page) throw new Error("WebRunner not started");
    const rects = await this.page.evaluate(
      ([text, o]) => window.xveMeasure(text as string, o as MeasureOpts),
      [xamlText, opts] as const
    );
    return rects as Rect[];
  }

  /** Zrzut #surface do pliku PNG (do raportu wizualnego). */
  async screenshot(outPath: string): Promise<void> {
    if (!this.page) throw new Error("WebRunner not started");
    const el = await this.page.$("#surface");
    if (el) await el.screenshot({ path: outPath });
  }

  async stop(): Promise<void> {
    await this.browser?.close();
  }
}
