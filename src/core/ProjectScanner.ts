// Skan projektu .NET/WPF wokół edytowanego pliku XAML — wyszukuje zasoby, które host WPF
// może załadować dla pełnej wierności: biblioteki custom kontrolek (DLL z katalogu bin),
// App.xaml (style aplikacji) oraz pliki ResourceDictionary (motywy/słowniki).
//
// Wzorzec kategorii (Dll / AppResources / ResourceDict) z aplikacji desktopowej
// (XamlVisualEditor/ProjectLoadDialog.cs). Tu wykrywamy je z systemu plików — bez MSBuild.

import * as fs from "fs";
import * as path from "path";

export type ProjectItemKind = "dll" | "appResources" | "resourceDict";

export interface ProjectResourceItem {
  kind: ProjectItemKind;
  /** ścieżka bezwzględna */
  path: string;
  /** etykieta do wyboru (nazwa pliku) */
  label: string;
  /** opis (ścieżka względem projektu) */
  detail: string;
}

export interface ProjectScan {
  projectDir: string;
  projectName: string;
  items: ProjectResourceItem[];
}

/** Idzie w górę katalogów od pliku XAML, szukając pierwszego `*.csproj`. */
function findProjectFile(xamlPath: string): string | null {
  let dir = path.dirname(xamlPath);
  for (let i = 0; i < 12; i++) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return null;
    }
    const csproj = entries.find((e) => e.toLowerCase().endsWith(".csproj"));
    if (csproj) return path.join(dir, csproj);
    const parent = path.dirname(dir);
    if (parent === dir) return null; // korzeń systemu plików
    dir = parent;
  }
  return null;
}

/** Czy plik to „prawdziwa" biblioteka (nie assembly satelitarne z zasobami lokalizacji). */
function isRealDll(name: string): boolean {
  const n = name.toLowerCase();
  return n.endsWith(".dll") && !n.endsWith(".resources.dll");
}

/**
 * Najlepszy katalog wyjścia `bin/<Config>/<tfm>`: spośród katalogów zawierających prawdziwe DLL
 * preferuje ten z własną biblioteką projektu (`<projectName>.dll`), a dalej najświeższy.
 * Dzięki temu omijamy podkatalogi kultur (np. `pl/DuPli.App.resources.dll`).
 */
function bestOutputDir(projectDir: string, projectName: string): string | null {
  const bin = path.join(projectDir, "bin");
  const cands: { dir: string; mtime: number; hasMain: boolean }[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 3) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const dlls = entries.filter((e) => e.isFile() && isRealDll(e.name));
    if (dlls.length) {
      let mtime = -1;
      try {
        mtime = fs.statSync(dir).mtimeMs;
      } catch {
        /* pomiń */
      }
      const hasMain = dlls.some((e) => e.name.toLowerCase() === projectName.toLowerCase() + ".dll");
      cands.push({ dir, mtime, hasMain });
    }
    for (const e of entries) if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1);
  };
  walk(bin, 0);
  cands.sort((a, b) => (b.hasMain ? 1 : 0) - (a.hasMain ? 1 : 0) || b.mtime - a.mtime);
  return cands[0]?.dir ?? null;
}

/** Czy plik XAML to ResourceDictionary (po elemencie głównym, bez pełnego parsowania). */
function isResourceDictionaryFile(file: string): boolean {
  try {
    const head = fs.readFileSync(file, "utf8").slice(0, 4096);
    const noComments = head.replace(/<!--[\s\S]*?-->/g, "");
    return /<\s*ResourceDictionary[\s>]/.test(noComments);
  } catch {
    return false;
  }
}

/** Zbiera pliki .xaml w projekcie (z pominięciem bin/obj), ograniczone ilościowo. */
function collectXamlFiles(projectDir: string, limit = 600): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (out.length >= limit || depth > 8) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= limit) return;
      const name = e.name.toLowerCase();
      if (e.isDirectory()) {
        if (name === "bin" || name === "obj" || name === ".git" || name === "node_modules") continue;
        walk(path.join(dir, e.name), depth + 1);
      } else if (name.endsWith(".xaml")) {
        out.push(path.join(dir, e.name));
      }
    }
  };
  walk(projectDir, 0);
  return out;
}

/** Skanuje projekt wokół pliku XAML. Zwraca null, gdy brak `.csproj` (plik luźny). */
export function scanProject(xamlPath: string): ProjectScan | null {
  const csproj = findProjectFile(xamlPath);
  if (!csproj) return null;
  const projectDir = path.dirname(csproj);
  const projectName = path.basename(csproj, ".csproj");
  const rel = (p: string) => path.relative(projectDir, p) || path.basename(p);
  const items: ProjectResourceItem[] = [];

  // 1) DLL z najlepszego katalogu wyjścia (bez assembly satelitarnych *.resources.dll)
  const binDir = bestOutputDir(projectDir, projectName);
  if (binDir) {
    let dlls: string[] = [];
    try {
      dlls = fs
        .readdirSync(binDir)
        .filter((f) => isRealDll(f))
        .map((f) => path.join(binDir, f));
    } catch {
      /* pomiń */
    }
    // własna biblioteka projektu na początku listy
    dlls.sort((a, b) => {
      const an = path.basename(a, ".dll") === projectName ? 0 : 1;
      const bn = path.basename(b, ".dll") === projectName ? 0 : 1;
      return an - bn || path.basename(a).localeCompare(path.basename(b));
    });
    for (const d of dlls)
      items.push({ kind: "dll", path: d, label: path.basename(d), detail: rel(d) });
  }

  // 2) App.xaml (style aplikacji)
  const appXaml = path.join(projectDir, "App.xaml");
  if (fs.existsSync(appXaml))
    items.push({ kind: "appResources", path: appXaml, label: "App.xaml", detail: rel(appXaml) });

  // 3) pliki ResourceDictionary (motywy/słowniki)
  for (const f of collectXamlFiles(projectDir)) {
    if (path.resolve(f) === path.resolve(appXaml)) continue;
    if (isResourceDictionaryFile(f))
      items.push({ kind: "resourceDict", path: f, label: path.basename(f), detail: rel(f) });
  }

  return { projectDir, projectName, items };
}
