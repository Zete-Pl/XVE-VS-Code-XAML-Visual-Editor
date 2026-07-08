// Renderuje obrazki dokumentacji: diagramy SVG → PNG, ikony Codicons → PNG, kropki statusu hosta.
// Marketplace VS Code nie akceptuje SVG w README, a GitHub nie skaluje ich spójnie — dlatego
// SVG trzymamy jako edytowalne źródło, a do dokumentacji wchodzą wyrenderowane PNG-i.
//
// Playwright + chromium są już w devDependencies (testy parity), więc render jest offline.
//
//   node tools/docs/render-images.mjs

import { chromium } from "playwright";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const IMAGES = path.join(ROOT, "docs", "images");
const ICONS = path.join(IMAGES, "icons");
const CODICONS = path.join(ROOT, "node_modules", "@vscode", "codicons", "src", "icons");

/** Diagramy renderowane z SVG obok nich (docs/images/*.svg → docs/images/*.png). */
const DIAGRAMS = ["architecture", "edit-flow", "preview-backends"];

/** Ikony paska narzędzi (nazwy Codicons), w kolejności występowania w toolbarze. */
const TOOLBAR_ICONS = [
  "gripper",
  "layout-sidebar-left",
  "move",
  "list-tree",
  "eye",
  "discard",
  "redo",
  "trash",
  "edit",
  "git-compare",
  "symbol-numeric",
  "symbol-ruler",
  "symbol-color",
  "server-process",
  "play",
  "package",
  "layout-sidebar-right",
  "triangle-right",
  // panel zoomu (osobny widget, prawy dolny róg podglądu)
  "zoom-out",
  "zoom-in",
  "screen-full",
];

// Narzędzie Pan nie ma Codicona — webview/main.ts wstawia własny SVG (Material „pan_tool").
// Kopia musi zostać zsynchronizowana ręcznie, jeśli tam się zmieni.
const PAN_ICON =
  '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="ICON_COLOR">' +
  '<path d="M23 5.5V20c0 2.2-1.8 4-4 4h-7.3c-1.08 0-2.1-.43-2.85-1.19L1 14.83s1.26-1.23 1.3-1.25' +
  "c.22-.19.49-.29.79-.29.22 0 .42.06.6.16.04.01 4.31 2.46 4.31 2.46V4c0-.83.67-1.5 1.5-1.5S11 3.17 11 4" +
  "v7h1V1.5c0-.83.67-1.5 1.5-1.5S15 .67 15 1.5V11h1V2.5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5V11h1V5.5" +
  'c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5z"/></svg>';

// Szarość czytelna zarówno na jasnym, jak i ciemnym tle GitHuba/Marketplace
// (obrazki w Markdownie nie reagują na prefers-color-scheme).
const ICON_COLOR = "#8a919b";

/** Kolory kropki statusu hosta — muszą odpowiadać .host-dot.* w webview/style.css. */
const HOST_DOTS = {
  "dot-ok": "#2ea043",
  "dot-idle": "#d2a000",
  "dot-error": "#f04747",
  "dot-inactive": "#555555",
};

function viewBoxSize(svg) {
  const m = /viewBox\s*=\s*"([\d.\-\s]+)"/.exec(svg);
  if (!m) throw new Error("brak viewBox");
  const [, , w, h] = m[1].trim().split(/\s+/).map(Number);
  return { width: Math.ceil(w), height: Math.ceil(h) };
}

async function shoot(browser, { html, width, height, scale, out, transparent }) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale });
  const page = await ctx.newPage();
  await page.setContent(`<body style="margin:0;padding:0">${html}</body>`, { waitUntil: "load" });
  await page.screenshot({ path: out, omitBackground: !!transparent });
  await ctx.close();
  console.log(`  ${path.relative(ROOT, out)}  ${width}×${height} @${scale}x`);
}

async function renderDiagrams(browser) {
  console.log("Diagramy:");
  for (const name of DIAGRAMS) {
    const src = path.join(IMAGES, `${name}.svg`);
    const svg = fs.readFileSync(src, "utf8");
    const { width, height } = viewBoxSize(svg);
    await shoot(browser, { html: svg, width, height, scale: 2, out: path.join(IMAGES, `${name}.png`) });
  }
}

async function renderIcons(browser) {
  console.log("Ikony paska narzędzi:");
  fs.mkdirSync(ICONS, { recursive: true });

  for (const name of TOOLBAR_ICONS) {
    const src = path.join(CODICONS, `${name}.svg`);
    if (!fs.existsSync(src)) throw new Error(`brak codicona: ${name}`);
    // Codicony mają fill="currentColor" na elemencie <svg>; podmiana wystarczy.
    const svg = fs.readFileSync(src, "utf8").replace('fill="currentColor"', `fill="${ICON_COLOR}"`);
    await shoot(browser, {
      html: svg,
      width: 16,
      height: 16,
      scale: 3,
      transparent: true,
      out: path.join(ICONS, `${name}.png`),
    });
  }

  await shoot(browser, {
    html: PAN_ICON.replace("ICON_COLOR", ICON_COLOR),
    width: 16,
    height: 16,
    scale: 3,
    transparent: true,
    out: path.join(ICONS, "pan.png"),
  });

  for (const [name, color] of Object.entries(HOST_DOTS)) {
    const glow = name === "dot-inactive" ? "" : `box-shadow:0 0 5px ${color};`;
    await shoot(browser, {
      html: `<div style="width:10px;height:10px;margin:3px;border-radius:50%;background:${color};${glow}"></div>`,
      width: 16,
      height: 16,
      scale: 3,
      transparent: true,
      out: path.join(ICONS, `${name}.png`),
    });
  }
}

/**
 * Zrzuty ekranu bywają w rozdzielczości monitora — dokumentacja nie potrzebuje więcej niż 1200 px.
 * Skrypt jest idempotentny: plik już mieszczący się w limicie zostaje nietknięty.
 *
 * `screen-properties.png` celowo pominięty — to wąski, wysoki panel osadzany w dokumentacji
 * z opływającym tekstem, więc jego natywna szerokość (595 px) jest już właściwa.
 */
async function downscaleScreenshots(browser) {
  const MAX_WIDTH = 1200;
  const targets = [
    "layout-overview.png",
    "screen-changes.png",
    "screen-drag-resize.png",
    "screen-host-console.png",
    "screen-wpf-host.png",
    "screen-sync1.png",
    "screen-sync2.png",
    "screen-themes.png",
  ];
  console.log("Skalowanie zrzutów:");
  for (const file of targets) {
    const abs = path.join(IMAGES, file);
    if (!fs.existsSync(abs)) {
      console.log(`  (pominięto — brak ${file})`);
      continue;
    }
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const dataUri = `data:image/png;base64,${fs.readFileSync(abs).toString("base64")}`;
    const size = await page.evaluate(
      (uri) =>
        new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
          img.src = uri;
        }),
      dataUri
    );
    await ctx.close();

    if (size.w <= MAX_WIDTH) {
      console.log(`  ${file}  ${size.w}×${size.h} — bez zmian`);
      continue;
    }
    const width = MAX_WIDTH;
    const height = Math.round((size.h * MAX_WIDTH) / size.w);
    await shoot(browser, {
      html: `<img src="${dataUri}" style="display:block;width:${width}px;height:${height}px">`,
      width,
      height,
      scale: 1,
      out: abs,
    });
  }
}

const browser = await chromium.launch();
try {
  await renderDiagrams(browser);
  await renderIcons(browser);
  await downscaleScreenshots(browser);
} finally {
  await browser.close();
}
console.log("Gotowe.");
