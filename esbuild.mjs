import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync } from "fs";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** Kopiuje font ikon VS Code (Codicons) do dist/ — webview ładuje go przez <link>. */
function copyCodicons() {
  mkdirSync("dist", { recursive: true });
  for (const f of ["codicon.css", "codicon.ttf"]) {
    copyFileSync(`node_modules/@vscode/codicons/dist/${f}`, `dist/${f}`);
  }
  console.log("copied codicons → dist/");
}

/** Extension host bundle (Node / CommonJS, `vscode` is external). */
const extensionConfig = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  outfile: "dist/extension.js",
  external: ["vscode"],
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

/** Webview bundle (browser / IIFE, runs inside the webview iframe). */
const webviewConfig = {
  entryPoints: ["webview/main.ts"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  outfile: "dist/webview.js",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

/** Harness testera parzystości web↔WPF (browser / IIFE) — wystawia window.xveMeasure.
    Ładowany w headless Chromium przez tools/parity/web-runner.ts. */
const parityHarnessConfig = {
  entryPoints: ["tools/parity/harness.ts"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  outfile: "dist/parity-harness.js",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

async function run() {
  copyCodicons();
  if (watch) {
    const ctxA = await esbuild.context(extensionConfig);
    const ctxB = await esbuild.context(webviewConfig);
    const ctxC = await esbuild.context(parityHarnessConfig);
    await Promise.all([ctxA.watch(), ctxB.watch(), ctxC.watch()]);
    console.log("watching…");
  } else {
    await esbuild.build(extensionConfig);
    await esbuild.build(webviewConfig);
    await esbuild.build(parityHarnessConfig);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
