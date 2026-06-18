// Menedżer procesu xve-wpf-host (Windows). Spawnuje exe, prowadzi protokół JSON-lines
// (jedno żądanie/odpowiedź na linię), koreluje odpowiedzi po id. Leniwy start, reużycie
// procesu między renderami. Przy błędzie/timeout zwraca { ok:false } — wołający może
// spaść z powrotem na renderer web.

import * as cp from "child_process";

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
  png?: string;
  width?: number;
  height?: number;
  rects?: HostRect[];
}

export class WpfHost {
  private proc: cp.ChildProcessWithoutNullStreams | null = null;
  private seq = 1;
  private pending = new Map<number, (r: RenderResult) => void>();
  private buffer = "";
  private failed = false;

  constructor(private readonly exePath: string) {}

  private ensure(): boolean {
    if (this.proc) return true;
    if (this.failed) return false;
    try {
      this.proc = cp.spawn(this.exePath, [], { stdio: ["pipe", "pipe", "pipe"] });
      this.proc.stdout.setEncoding("utf8");
      this.proc.stdout.on("data", (d: string) => this.onData(d));
      this.proc.on("error", () => {
        this.failed = true;
        this.rejectAll("host spawn error");
      });
      this.proc.on("exit", () => {
        this.proc = null;
        this.rejectAll("host exited");
      });
      return true;
    } catch {
      this.failed = true;
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
