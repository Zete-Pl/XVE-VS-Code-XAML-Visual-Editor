import * as esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

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

async function run() {
  if (watch) {
    const ctxA = await esbuild.context(extensionConfig);
    const ctxB = await esbuild.context(webviewConfig);
    await Promise.all([ctxA.watch(), ctxB.watch()]);
    console.log("watching…");
  } else {
    await esbuild.build(extensionConfig);
    await esbuild.build(webviewConfig);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
