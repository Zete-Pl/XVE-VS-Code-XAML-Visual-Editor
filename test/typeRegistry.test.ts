import { test } from "node:test";
import assert from "node:assert/strict";
import {
  inferKind,
  metaFor,
  knownProperties,
  defaultValue,
} from "../src/core/TypeRegistry.ts";

test("inferKind: heurystyki rodzaju edytora", () => {
  assert.equal(inferKind("Margin"), "thickness");
  assert.equal(inferKind("Background"), "brush");
  assert.equal(inferKind("IsChecked"), "bool");
  assert.equal(inferKind("IsSomethingCustom"), "bool"); // wzorzec Is*
  assert.equal(inferKind("Width"), "number");
  assert.equal(inferKind("HorizontalAlignment"), "enum");
  assert.equal(inferKind("Title"), "string");
});

test("metaFor: enum dostaje wartości", () => {
  const m = metaFor("Button", "HorizontalAlignment");
  assert.equal(m.kind, "enum");
  assert.ok(m.values?.includes("Stretch"));
});

test("metaFor: właściwość specyficzna dla typu", () => {
  assert.equal(metaFor("Slider", "Value").kind, "number");
  assert.equal(metaFor("TextBlock", "Text").kind, "string");
});

test("knownProperties: zawiera wspólne, typowe i attached", () => {
  const names = knownProperties("CheckBox").map((p) => p.name);
  assert.ok(names.includes("Margin")); // common
  assert.ok(names.includes("IsChecked")); // per-type
  assert.ok(names.includes("Grid.Row")); // attached
});

test("defaultValue: sensowne wartości startowe", () => {
  assert.equal(defaultValue({ name: "IsChecked", kind: "bool" }), "True");
  assert.equal(defaultValue({ name: "Margin", kind: "thickness" }), "0");
  assert.equal(
    defaultValue({ name: "HorizontalAlignment", kind: "enum", values: ["Left", "Right"] }),
    "Left"
  );
});
