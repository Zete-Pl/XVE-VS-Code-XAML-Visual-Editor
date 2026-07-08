// Runner WPF: renderuje XAML prawdziwym silnikiem WPF przez proces-pomocnik xve-wpf-host i zwraca
// zmierzony układ (rects) jako ground truth. Reużywa menedżera procesu WpfHost z rozszerzenia.
//
// Używa REALNYCH (nieprzyciętych) prostokątów rx,ry,rw,rh, gdy host je poda — odpowiadają one pełnemu
// pudełku elementu (ActualWidth/ActualHeight w układzie korzenia), tak jak getBoundingClientRect po
// stronie web (który nie przycina do overflow rodzica).

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { WpfHost } from "../../src/host/WpfHost.ts";
import { XamlDocument } from "../../src/core/XamlDocument.ts";
import type { Rect } from "./diff.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Domyślna ścieżka do zbudowanego hosta (Release). */
export function defaultHostExe(): string {
  return path.resolve(__dirname, "..", "..", "wpf-host", "bin", "Release", "net10.0-windows", "xve-wpf-host.exe");
}

// Host wysyła więcej pól niż deklaruje HostRect — czytamy też realne (nieprzycięte) bounds.
interface RawRect {
  uid: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rx?: number;
  ry?: number;
  rw?: number;
  rh?: number;
}

export interface WpfRenderResult {
  ok: boolean;
  error?: string;
  rects: Rect[];
  /** base64 PNG całej powierzchni (do raportu wizualnego). */
  png?: string;
  width?: number;
  height?: number;
}

export class WpfRunner {
  private host: WpfHost;
  constructor(exePath: string = defaultHostExe()) {
    this.host = new WpfHost(exePath);
  }

  /** Renderuje XAML i zwraca prostokąty układu w jednostkach logicznych (design px). */
  async measure(xamlText: string, width: number, height: number, theme = "none", baseDir?: string): Promise<WpfRenderResult> {
    const hostXaml = new XamlDocument(xamlText).toHostXaml();
    const res = await this.host.request(
      // baseDir: katalog pliku — host rozwiązuje względne URI (Icon="Assets/…", Image Source, słowniki)
      { cmd: "render", xaml: hostXaml, width, height, theme, scale: 1, zoom: 1, ...(baseDir ? { baseDir } : {}) },
      20000
    );
    if (!res.ok) return { ok: false, error: res.error, rects: [] };
    const raw = (res.rects ?? []) as unknown as RawRect[];
    const rects: Rect[] = raw.map((r) => ({
      id: Number(r.uid.replace(/^u/, "")),
      x: r.rx ?? r.x,
      y: r.ry ?? r.y,
      w: r.rw ?? r.w,
      h: r.rh ?? r.h,
    }));
    return { ok: true, rects, png: res.png, width: res.width, height: res.height };
  }

  dispose(): void {
    this.host.dispose();
  }
}
