// Czysty komparator prostokątów układu (web ↔ WPF). Bez I/O i bez zależności od przeglądarki/hosta,
// dzięki czemu logikę da się jednostkowo przetestować (test/parityDiff.test.ts).
//
// Wejście: dwie listy prostokątów (id → x,y,w,h) w tych samych jednostkach (logical px) i tym samym
// układzie współrzędnych (względem lewego-górnego rogu korzenia). Wyjście: per element delty rozmiaru
// (priorytet) i pozycji, posortowane malejąco po największym rozjeździe, oraz id obecne tylko po jednej
// stronie.

export interface Rect {
  id: number;
  tag?: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ElementDiff {
  id: number;
  tag: string;
  wpf: { x: number; y: number; w: number; h: number };
  web: { x: number; y: number; w: number; h: number };
  dx: number;
  dy: number;
  dw: number;
  dh: number;
  /** Największa z |dx|,|dy|,|dw|,|dh| — klucz sortowania. */
  maxDelta: number;
  /** Czy rozjazd przekracza próg tolerancji (do raportu/„red flag"). */
  flagged: boolean;
}

export interface SampleDiff {
  elements: ElementDiff[];
  onlyWpf: number[];
  onlyWeb: number[];
  /** Id pominięte: host WPF zwrócił zdegenerowany prostokąt (0×0), np. korzeń Window — nieporównywalne. */
  skipped: number[];
  /** Liczba elementów z flagged=true. */
  flaggedCount: number;
  /** Największy rozjazd w całej próbce (px). */
  worst: number;
}

export interface DiffOpts {
  /** Próg bezwzględny w px (delta poniżej nie jest flagowana). */
  tolPx?: number;
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Porównuje prostokąty WPF (ground truth) z web po id. */
export function diffRects(wpf: Rect[], web: Rect[], opts: DiffOpts = {}): SampleDiff {
  const tolPx = opts.tolPx ?? 1;
  const wpfById = new Map(wpf.map((r) => [r.id, r]));
  const webById = new Map(web.map((r) => [r.id, r]));

  const elements: ElementDiff[] = [];
  const skipped: number[] = [];
  for (const [id, a] of wpfById) {
    const b = webById.get(id);
    if (!b) continue;
    if (a.w <= 0.5 || a.h <= 0.5) {
      // host nie zmierzył elementu (np. korzeń Window renderowany przez treść) — nieporównywalne
      skipped.push(id);
      continue;
    }
    const dx = r2(b.x - a.x);
    const dy = r2(b.y - a.y);
    const dw = r2(b.w - a.w);
    const dh = r2(b.h - a.h);
    const maxDelta = r2(Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dw), Math.abs(dh)));
    elements.push({
      id,
      tag: a.tag ?? b.tag ?? "?",
      wpf: { x: r2(a.x), y: r2(a.y), w: r2(a.w), h: r2(a.h) },
      web: { x: r2(b.x), y: r2(b.y), w: r2(b.w), h: r2(b.h) },
      dx,
      dy,
      dw,
      dh,
      maxDelta,
      flagged: maxDelta > tolPx,
    });
  }
  elements.sort((p, q) => q.maxDelta - p.maxDelta);

  const onlyWpf = [...wpfById.keys()].filter((id) => !webById.has(id)).sort((a, b) => a - b);
  const onlyWeb = [...webById.keys()].filter((id) => !wpfById.has(id)).sort((a, b) => a - b);

  return {
    elements,
    onlyWpf,
    onlyWeb,
    skipped: skipped.sort((a, b) => a - b),
    flaggedCount: elements.filter((e) => e.flagged).length,
    worst: elements.length ? elements[0].maxDelta : 0,
  };
}
