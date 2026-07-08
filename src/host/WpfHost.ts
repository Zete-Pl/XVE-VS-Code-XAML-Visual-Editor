// Menedżer procesu xve-wpf-host (Windows). Spawnuje exe, prowadzi protokół JSON-lines
// (jedno żądanie/odpowiedź na linię), koreluje odpowiedzi po id. Leniwy start, reużycie
// procesu między renderami. Przy błędzie/timeout zwraca { ok:false } — wołający może
// spaść z powrotem na renderer web.
//
// Awarie „twarde" (brak exe, brak .NET Desktop Runtime, crash przy starcie) raportujemy
// przez onFatal — inaczej użytkownik widzi tylko szarą kropkę i nie wie, dlaczego host
// nie działa. Host jest procesem konsolowym, więc apphost przy braku runtime'u pisze
// diagnostykę na stderr; bez odczytu stderr ta informacja przepadała.

import * as cp from "child_process";
import * as fs from "fs";

export interface HostRect {
  uid: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface RenderResult {
  ok: boolean;
  error?: string;
  line?: number; // wiersz błędu (1-based, 0/undefined = nieznany)
  col?: number; // kolumna błędu (1-based)
  info?: string; // podsumowanie ładowania zasobów projektu (loadProject) — zaszłość; etykiety buduje TS
  resAsm?: string[]; // załadowane biblioteki (nazwy assembly) — dane strukturalne, formatowane po stronie TS
  resDict?: { st: "ok" | "skip" | "err"; name: string; n?: number; err?: string }[]; // wynik ładowania słowników
  locTarget?: string; // wykryty singleton lokalizacji do refleksji kultury (lub brak)
  png?: string;
  width?: number; // pełny logiczny rozmiar powierzchni (design px)
  height?: number;
  vx?: number; // wycinek (slice) w jednostkach projektu (tryb „widoczny obszar")
  vy?: number;
  vw?: number;
  vh?: number;
  rpw?: number; // realnie wyrenderowana bitmapa (px urządzenia) — dla konsoli debug
  rph?: number;
  rects?: HostRect[];
  // offsety ScrollViewerów po jednorazowym „przewiń, by element był widoczny" (auto-podgląd)
  scrolled?: { uid: string; h: number; v: number }[];
}

/** Rodzaj awarii uniemożliwiającej pracę hosta — determinuje komunikat dla użytkownika. */
export type HostFatalKind = "exe-missing" | "runtime-missing" | "crash";

/** Callback wołany raz na awarię; `detail` to surowy stderr / ścieżka (do logu). */
export type HostFatalHandler = (kind: HostFatalKind, detail: string) => void;

/**
 * Rozpoznaje po stderr, czy proces padł z braku .NET Desktop Runtime, czy z innego powodu.
 * Czysta funkcja — testowana bez uruchamiania procesu (test/wpfHost.test.ts).
 *
 * Apphost .NET przy braku frameworka wypisuje np.:
 *   You must install or update .NET to run this application.
 *   Framework: 'Microsoft.WindowsDesktop.App', version '10.0.0' (x64)
 */
export function classifyHostFailure(stderr: string): Exclude<HostFatalKind, "exe-missing"> {
  const s = stderr || "";
  if (
    /Microsoft\.WindowsDesktop\.App/i.test(s) ||
    /You must install or update \.NET/i.test(s) ||
    /The framework .* was not found/i.test(s) ||
    /Framework not found/i.test(s) ||
    /host_probe|hostfxr|A fatal error occurred.*runtime/i.test(s)
  ) {
    return "runtime-missing";
  }
  return "crash";
}

export class WpfHost {
  private proc: cp.ChildProcessWithoutNullStreams | null = null;
  private seq = 1;
  private pending = new Map<number, (r: RenderResult) => void>();
  private buffer = "";
  private stderrBuffer = "";
  private everResponded = false;
  private failed = false;
  private readonly exePath: string;
  private readonly onFatal?: HostFatalHandler;

  constructor(exePath: string, onFatal?: HostFatalHandler) {
    this.exePath = exePath;
    this.onFatal = onFatal;
  }

  private ensure(): boolean {
    if (this.proc) return true;
    if (this.failed) return false;
    if (!fs.existsSync(this.exePath)) {
      this.failed = true;
      this.onFatal?.("exe-missing", this.exePath);
      return false;
    }
    try {
      this.stderrBuffer = "";
      this.proc = cp.spawn(this.exePath, [], { stdio: ["pipe", "pipe", "pipe"] });
      this.proc.stdout.setEncoding("utf8");
      this.proc.stdout.on("data", (d: string) => this.onData(d));
      this.proc.stderr.setEncoding("utf8");
      this.proc.stderr.on("data", (d: string) => {
        // Ogranicznik: diagnostyka apphosta ma ~kilkaset znaków, crash-dump bywa ogromny.
        if (this.stderrBuffer.length < 4096) this.stderrBuffer += d;
      });
      this.proc.on("error", (e) => {
        this.failed = true;
        this.onFatal?.("crash", String(e));
        this.rejectAll("host spawn error");
      });
      this.proc.on("exit", (code) => {
        this.proc = null;
        // Padł, zanim cokolwiek odpowiedział → to nie jest zwykły restart, tylko awaria startu.
        if (!this.everResponded && code !== 0) {
          this.failed = true;
          this.onFatal?.(classifyHostFailure(this.stderrBuffer), this.stderrBuffer.trim());
        }
        this.rejectAll("host exited");
      });
      return true;
    } catch (e) {
      this.failed = true;
      this.onFatal?.("crash", String(e));
      return false;
    }
  }

  private rejectAll(error: string) {
    for (const [, res] of this.pending) res({ ok: false, error });
    this.pending.clear();
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const r = JSON.parse(line) as RenderResult & { id: number };
        this.everResponded = true;
        const res = this.pending.get(r.id);
        if (res) {
          this.pending.delete(r.id);
          res(r);
        }
      } catch {
        /* niekompletna/nie-JSON linia — ignoruj */
      }
    }
  }

  /** Wysyła dowolne żądanie (cmd + payload), koreluje odpowiedź po id. */
  request(payload: Record<string, unknown>, timeoutMs = 6000): Promise<RenderResult> {
    if (!this.ensure() || !this.proc) return Promise.resolve({ ok: false, error: "host unavailable" });
    const id = this.seq++;
    const req = JSON.stringify({ id, ...payload }) + "\n";
    return new Promise<RenderResult>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) resolve({ ok: false, error: "host timeout" });
      }, timeoutMs);
      this.pending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      try {
        this.proc!.stdin.write(req);
      } catch {
        this.pending.delete(id);
        clearTimeout(timer);
        resolve({ ok: false, error: "host write failed" });
      }
    });
  }

  render(xaml: string, width: number, height: number): Promise<RenderResult> {
    return this.request({ cmd: "render", xaml, width, height });
  }

  dispose() {
    try {
      this.proc?.kill();
    } catch {
      /* ignore */
    }
    this.proc = null;
  }
}
