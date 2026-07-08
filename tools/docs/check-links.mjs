// Weryfikator odnośników w dokumentacji: kotwice (#sekcja), obrazki i linki do plików.
//
// Kotwice zależą od języka — `#6-preview-backends` po japońsku wygląda inaczej — a przy siedmiu
// tłumaczeniach nikt tego nie sprawdzi wzrokiem. Skrypt odtwarza algorytm slugifikacji GitHuba
// (pakiet `github-slugger`) i sprawdza, że każdy link wskazuje na istniejący nagłówek/plik.
//
//   node tools/docs/check-links.mjs

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const FILES = [
  "README.md",
  "docs/en/DOCUMENTATION.md",
  "docs/pl/DOKUMENTACJA.md",
  "docs/es/DOCUMENTACION.md",
  "docs/de/DOKUMENTATION.md",
  "docs/fr/DOCUMENTATION.md",
  "docs/ja/DOCUMENTATION.md",
  "docs/zh/DOCUMENTATION.md",
];

// Dokładnie ten zestaw znaków usuwa github-slugger. Uwaga: NIE usuwa `-` ani `_`, a litery
// diakrytyczne (é, ü, ó) i znaki CJK zostają — dlatego kotwice w ja/zh są w ogóle możliwe.
// Zakres  -⁯ obejmuje m.in. `—` i `’`, więc typograficzne myślniki i apostrofy znikają.
// Pełnoszerokościowe nawiasy （） NIE są usuwane — w nagłówkach używamy wyłącznie ASCII.
const STRIP = /[\0-\x1F!-,./:-@[-^`{-~\xA0-\xBF -⁯⸀-⹿]/g;

function slug(heading) {
  return heading.toLowerCase().trim().replace(STRIP, "").replace(/ /g, "-");
}

/** Repo ma core.autocrlf=true — bez normalizacji `.` nie dopasuje końca linii i nagłówki znikają. */
function read(abs) {
  return fs.readFileSync(abs, "utf8").replace(/\r\n/g, "\n");
}

/** Nagłówki → slugi, z sufiksami -1/-2 dla duplikatów (tak samo jak GitHub). */
function anchorsOf(md) {
  const seen = new Map();
  const out = new Set();
  for (const line of md.split("\n")) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (!m) continue;
    // usuń inline-markdown z tekstu nagłówka: **bold**, `code`, [link](x)
    const text = m[2]
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[*_`]/g, "")
      .trim();
    const base = slug(text);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

/** Wszystkie cele linków: markdown `](target)` oraz HTML `src="target"`. */
function linksOf(md) {
  const out = [];
  for (const m of md.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) out.push(m[1]);
  for (const m of md.matchAll(/src="([^"]+)"/g)) out.push(m[1]);
  return out;
}

let errors = 0;
let checked = { anchors: 0, files: 0 };

for (const rel of FILES) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) {
    console.log(`  BRAK PLIKU  ${rel}`);
    errors++;
    continue;
  }
  const md = read(abs);
  const anchors = anchorsOf(md);
  const dir = path.dirname(abs);

  for (const target of linksOf(md)) {
    if (/^(https?|mailto):/.test(target)) continue; // linki zewnętrzne — poza zakresem

    const [pathPart, hash] = target.split("#");

    if (!pathPart) {
      // czysta kotwica w tym samym pliku
      checked.anchors++;
      if (!anchors.has(hash)) {
        console.log(`  ${rel}\n     kotwica #${hash} nie istnieje`);
        errors++;
      }
      continue;
    }

    const resolved = path.resolve(dir, decodeURIComponent(pathPart));
    checked.files++;
    if (!fs.existsSync(resolved)) {
      console.log(`  ${rel}\n     cel nie istnieje: ${pathPart}`);
      errors++;
      continue;
    }
    // kotwica w innym pliku markdown
    if (hash && resolved.endsWith(".md")) {
      checked.anchors++;
      const otherAnchors = anchorsOf(read(resolved));
      if (!otherAnchors.has(hash)) {
        console.log(`  ${rel}\n     kotwica #${hash} nie istnieje w ${pathPart}`);
        errors++;
      }
    }
  }
}

console.log(
  `\nSprawdzono ${FILES.length} plików: ${checked.anchors} kotwic, ${checked.files} odnośników do plików.`
);
if (errors) {
  console.log(`${errors} BŁĘDÓW.`);
  process.exit(1);
}
console.log("Wszystkie odnośniki rozwiązują się poprawnie.");
