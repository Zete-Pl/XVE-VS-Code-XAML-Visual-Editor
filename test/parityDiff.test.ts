import { test } from "node:test";
import assert from "node:assert/strict";
import { diffRects, type Rect } from "../tools/parity/diff.ts";

test("diffRects: zgodne prostokąty → brak rozjazdów", () => {
  const wpf: Rect[] = [{ id: 1, x: 0, y: 0, w: 100, h: 50 }];
  const web: Rect[] = [{ id: 1, x: 0, y: 0, w: 100, h: 50 }];
  const d = diffRects(wpf, web);
  assert.equal(d.flaggedCount, 0);
  assert.equal(d.worst, 0);
  assert.equal(d.elements[0].flagged, false);
});

test("diffRects: delta poniżej tolerancji (1px) nie jest flagowana", () => {
  const wpf: Rect[] = [{ id: 1, x: 0, y: 0, w: 100, h: 50 }];
  const web: Rect[] = [{ id: 1, x: 0.5, y: 0, w: 100.4, h: 50 }];
  const d = diffRects(wpf, web);
  assert.equal(d.flaggedCount, 0);
});

test("diffRects: rozjazd rozmiaru flagowany; Δ = web − WPF", () => {
  const wpf: Rect[] = [{ id: 1, x: 10, y: 20, w: 100, h: 50, tag: "TextBlock" }];
  const web: Rect[] = [{ id: 1, x: 10, y: 20, w: 100, h: 16 }];
  const d = diffRects(wpf, web);
  assert.equal(d.flaggedCount, 1);
  const e = d.elements[0];
  assert.equal(e.tag, "TextBlock"); // tag z WPF (ground truth) gdy dostępny
  assert.equal(e.dh, -34); // web niższy niż WPF
  assert.equal(e.maxDelta, 34);
  assert.equal(d.worst, 34);
});

test("diffRects: sortowanie malejąco po maxDelta", () => {
  const wpf: Rect[] = [
    { id: 1, x: 0, y: 0, w: 100, h: 50 },
    { id: 2, x: 0, y: 0, w: 100, h: 50 },
  ];
  const web: Rect[] = [
    { id: 1, x: 0, y: 0, w: 105, h: 50 }, // Δ 5
    { id: 2, x: 0, y: 0, w: 100, h: 70 }, // Δ 20
  ];
  const d = diffRects(wpf, web);
  assert.deepEqual(
    d.elements.map((e) => e.id),
    [2, 1]
  );
});

test("diffRects: zdegenerowany prostokąt WPF (0×0) jest pomijany, nie flagowany", () => {
  const wpf: Rect[] = [
    { id: 0, x: 0, y: 0, w: 0, h: 0, tag: "Window" }, // host renderuje treść, nie okno
    { id: 1, x: 0, y: 0, w: 100, h: 50 },
  ];
  const web: Rect[] = [
    { id: 0, x: 0, y: 0, w: 420, h: 360, tag: "Window" },
    { id: 1, x: 0, y: 0, w: 100, h: 50 },
  ];
  const d = diffRects(wpf, web);
  assert.deepEqual(d.skipped, [0]);
  assert.equal(d.elements.length, 1); // tylko id=1
  assert.equal(d.flaggedCount, 0);
  assert.equal(d.worst, 0);
});

test("diffRects: elementy obecne tylko po jednej stronie", () => {
  const wpf: Rect[] = [
    { id: 1, x: 0, y: 0, w: 10, h: 10 },
    { id: 2, x: 0, y: 0, w: 10, h: 10 },
  ];
  const web: Rect[] = [
    { id: 1, x: 0, y: 0, w: 10, h: 10 },
    { id: 3, x: 0, y: 0, w: 10, h: 10 },
  ];
  const d = diffRects(wpf, web);
  assert.deepEqual(d.onlyWpf, [2]);
  assert.deepEqual(d.onlyWeb, [3]);
  assert.equal(d.elements.length, 1); // tylko id=1 wspólny
});
