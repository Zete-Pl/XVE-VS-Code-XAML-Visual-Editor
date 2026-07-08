// Orkiestrator testera parzystości web↔WPF.
//
// Dla każdej próbki samples/parity/*.xaml: renderuje ją hostem WPF (ground truth) i rendererem web
// (headless Chromium), łączy zmierzone prostokąty po id i wypisuje rozjazdy. Wynik:
//   • tmp/parity/report.md   — raport czytelny (tabela zbiorcza + top rozjazdy per próbka),
//   • tmp/parity/report.json — dane maszynowe (do diffowania między uruchomieniami),
//   • tmp/parity/<sample>.wpf.png / .web.png — zrzuty do porównania wizualnego.
//
// Uruchom: npm run test:parity   (wymaga: npm run compile, zbudowany host, npx playwright install chromium)
//
// Opcjonalnie:
//   npm run test:parity -- --themes none,light C:\ścieżka\Plik.xaml
//   --themes: motywy hosta (none|classic98|light|dark), każdy porównywany z odpowiadającą klasą web;
//   ścieżki plików .xaml zastępują domyślny katalog samples/parity.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { WpfRunner } from "./wpf-runner.ts";
import { WebRunner } from "./web-runner.ts";
import { diffRects, type SampleDiff } from "./diff.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const SAMPLES_DIR = path.join(ROOT, "samples", "parity");
const OUT_DIR = path.join(ROOT, "tmp", "parity");

/**
 * Zamienia elementy z prefiksem przestrzeni nazw (typy projektu, np. `local:RulerBar`,
 * `avalonedit:TextEditor`) na stub `<Border>` z whitelistą atrybutów układu. Host WPF nie umie
 * tworzyć takich typów bez DLL projektu, a web pokazuje placeholder — po stubie OBIE strony
 * renderują to samo (stub robimy PRZED parsowaniem, więc id węzłów zostają spójne) i porównanie
 * dotyczy standardowych kontrolek. Prefiks `x:` zostaje (część języka XAML).
 */
function stubUnknownTypes(text: string): string {
  const KEEP = /^(x:Name|x:Uid|Name|Width|Height|MinWidth|MinHeight|MaxWidth|MaxHeight|Margin|Visibility|Opacity|Background|HorizontalAlignment|VerticalAlignment|Grid\.\w+|DockPanel\.\w+|Canvas\.\w+|Panel\.ZIndex)$/;
  return text
    .replace(/<(?!x:)(\w+):([\w.]+)((?:[^>"]|"[^"]*")*?)(\/?)>/g, (_m, _pfx, _type, attrs: string, selfClose: string) => {
      const kept: string[] = [];
      for (const am of attrs.matchAll(/([\w.:]+)\s*=\s*("[^"]*")/g)) {
        if (KEEP.test(am[1])) kept.push(`${am[1]}=${am[2]}`);
      }
      return `<Border${kept.length ? " " + kept.join(" ") : ""}${selfClose ? " /" : ""}>`;
    })
    .replace(/<\/(?!x:)\w+:[\w.]+>/g, "</Border>");
}

/** Wyłuskuje Width/Height z otwierającego tagu korzenia (fallback 800×600). */
function rootSize(text: string): { width: number; height: number } {
  const open = text.slice(0, text.indexOf(">") + 1);
  const w = /\bWidth="(\d+(?:\.\d+)?)"/.exec(open);
  const h = /\bHeight="(\d+(?:\.\d+)?)"/.exec(open);
  return { width: w ? Math.round(+w[1]) : 800, height: h ? Math.round(+h[1]) : 600 };
}

interface SampleReport {
  name: string;
  theme: string;
  width: number;
  height: number;
  ok: boolean;
  error?: string;
  diff?: SampleDiff;
}

/** Motyw hosta → klasa motywu web (ta sama mapa co webThemeClass w webview/main.ts). */
const THEME_CLASS: Record<string, string> = {
  none: "xve-theme-classic",
  classic: "xve-theme-classic",
  classic98: "xve-theme-classic98",
  light: "xve-theme-light",
  dark: "xve-theme-dark",
};

function mdTable(rows: string[][], header: string[]): string {
  const line = (cols: string[]) => `| ${cols.join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n");
}

function writeReport(reports: SampleReport[]): void {
  const lines: string[] = [];
  lines.push("# Raport parzystości web ↔ WPF", "");
  lines.push(`Wygenerowano: ${new Date().toISOString()}`, "");
  const themes = [...new Set(reports.map((r) => r.theme))].join(", ");
  lines.push(`Ground truth = host WPF. Δ = web − WPF (px). Motywy: ${themes}. Skala: 1×.`, "");

  // tabela zbiorcza
  const summary = reports.map((r) =>
    r.ok && r.diff
      ? [r.name, String(r.diff.elements.length), String(r.diff.flaggedCount), r.diff.worst.toFixed(1)]
      : [r.name, "—", "—", `BŁĄD: ${r.error ?? "?"}`]
  );
  lines.push("## Podsumowanie", "");
  lines.push(mdTable(summary, ["Próbka", "Elementów", "Rozjazdów (>1px)", "Najgorszy Δ (px)"]), "");

  // szczegóły per próbka
  for (const r of reports) {
    lines.push(`## ${r.name}  (${r.width}×${r.height})`, "");
    if (!r.ok || !r.diff) {
      lines.push(`> BŁĄD: ${r.error ?? "nieznany"}`, "");
      continue;
    }
    const d = r.diff;
    lines.push(`Zrzuty: \`${r.name}.wpf.png\` vs \`${r.name}.web.png\``, "");
    const flagged = d.elements.filter((e) => e.flagged).slice(0, 15);
    if (flagged.length) {
      const rows = flagged.map((e) => [
        String(e.id),
        e.tag,
        `${e.wpf.w}×${e.wpf.h} @(${e.wpf.x},${e.wpf.y})`,
        `${e.web.w}×${e.web.h} @(${e.web.x},${e.web.y})`,
        e.dw.toFixed(1),
        e.dh.toFixed(1),
        e.dx.toFixed(1),
        e.dy.toFixed(1),
      ]);
      lines.push(
        mdTable(rows, ["id", "tag", "WPF w×h @xy", "web w×h @xy", "Δw", "Δh", "Δx", "Δy"]),
        ""
      );
    } else {
      lines.push("✔ Brak rozjazdów powyżej 1px.", "");
    }
    if (d.onlyWpf.length) lines.push(`Tylko w WPF (id): ${d.onlyWpf.join(", ")}`, "");
    if (d.onlyWeb.length) lines.push(`Tylko w web (id): ${d.onlyWeb.join(", ")}`, "");
    if (d.skipped.length) lines.push(`Pominięte (host 0×0, np. Window): ${d.skipped.join(", ")}`, "");
  }

  fs.writeFileSync(path.join(OUT_DIR, "report.md"), lines.join("\n"));
  fs.writeFileSync(path.join(OUT_DIR, "report.json"), JSON.stringify(reports, null, 2));
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // CLI: --themes a,b + opcjonalne ścieżki plików .xaml (zamiast samples/parity)
  const argv = process.argv.slice(2);
  let themes = ["none"];
  const argFiles: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--themes") themes = (argv[++i] ?? "none").split(",").map((t) => t.trim());
    else argFiles.push(argv[i]);
  }
  for (const t of themes) {
    if (!THEME_CLASS[t]) {
      console.error(`Nieznany motyw "${t}" (obsługiwane: ${Object.keys(THEME_CLASS).join(", ")})`);
      process.exit(1);
    }
  }

  const files = argFiles.length
    ? argFiles.map((f) => path.resolve(f))
    : fs
        .readdirSync(SAMPLES_DIR)
        .filter((f) => f.endsWith(".xaml"))
        .sort()
        .map((f) => path.join(SAMPLES_DIR, f));
  if (!files.length) {
    console.error(`Brak próbek w ${SAMPLES_DIR}`);
    process.exit(1);
  }

  const wpf = new WpfRunner();
  const web = new WebRunner();
  await web.start();

  const reports: SampleReport[] = [];
  for (const file of files) {
    const base = path.basename(file).replace(/\.xaml$/, "");
    const text = stubUnknownTypes(fs.readFileSync(file, "utf8"));
    const { width, height } = rootSize(text);
    for (const theme of themes) {
      const name = themes.length > 1 || theme !== "none" ? `${base}@${theme}` : base;
      process.stdout.write(`• ${name} (${width}×${height}) … `);

      const wpfRes = await wpf.measure(text, width, height, theme, path.dirname(file));
      if (!wpfRes.ok) {
        console.log(`WPF błąd: ${wpfRes.error}`);
        reports.push({ name, theme, width, height, ok: false, error: `WPF: ${wpfRes.error}` });
        continue;
      }
      const webRects = await web.measure(text, { themeClass: THEME_CLASS[theme] });

      if (wpfRes.png) fs.writeFileSync(path.join(OUT_DIR, `${name}.wpf.png`), Buffer.from(wpfRes.png, "base64"));
      await web.screenshot(path.join(OUT_DIR, `${name}.web.png`));

      const diff = diffRects(wpfRes.rects, webRects);
      reports.push({ name, theme, width, height, ok: true, diff });
      console.log(`rozjazdów ${diff.flaggedCount}/${diff.elements.length}, najgorszy ${diff.worst.toFixed(1)}px`);
    }
  }

  wpf.dispose();
  await web.stop();
  writeReport(reports);

  const totalFlagged = reports.reduce((s, r) => s + (r.diff?.flaggedCount ?? 0), 0);
  console.log(`\nRaport: ${path.relative(ROOT, path.join(OUT_DIR, "report.md"))}  (rozjazdów łącznie: ${totalFlagged})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
