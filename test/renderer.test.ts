import { test } from "node:test";
import assert from "node:assert/strict";
import { cssColor } from "../webview/renderer.ts";

test("cssColor: #AARRGGBB → rgba()", () => {
  // #2F777777 → alpha 0x2F/255 ≈ 0.184, rgb 119,119,119
  assert.equal(cssColor("#2F777777"), "rgba(119,119,119,0.184)");
});

test("cssColor: #RRGGBB i #RGB przepuszczane do CSS", () => {
  assert.equal(cssColor("#777777"), "#777777");
  assert.equal(cssColor("#abc"), "#abc");
});

test("cssColor: #ARGB → rgba()", () => {
  // #8F00 → a=0x88/255, r=0xFF, g=0x00, b=0x00
  assert.equal(cssColor("#8F00"), "rgba(255,0,0,0.533)");
});

test("cssColor: nazwy kolorów i undefined", () => {
  assert.equal(cssColor("LightGreen"), "LightGreen");
  assert.equal(cssColor(undefined), undefined);
});
