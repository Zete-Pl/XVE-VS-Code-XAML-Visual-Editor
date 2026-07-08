import { test } from "node:test";
import assert from "node:assert/strict";
import { lineDiff, changedLinesInB } from "../src/core/LineDiff.ts";
import { structuralDiff } from "../src/core/StructuralDiff.ts";
import { XamlDocument } from "../src/core/XamlDocument.ts";

test("lineDiff: równe sekwencje → same eq", () => {
  const ops = lineDiff(["a", "b"], ["a", "b"]);
  assert.deepEqual(ops.map((o) => o.t), ["eq", "eq"]);
});

test("changedLinesInB: wskazuje nowe/zmienione linie w b", () => {
  // a: [x, y]; b: [x, Z, y] → wstawiona linia na indeksie 1
  assert.deepEqual(changedLinesInB(["x", "y"], ["x", "Z", "y"]), [1]);
  // zmiana linii: a:[x,y] b:[x,y2] → del y, add y2 → indeks 1
  assert.deepEqual(changedLinesInB(["x", "y"], ["x", "y2"]), [1]);
});

test("structuralDiff: zmiana atrybutu", () => {
  const base = new XamlDocument(`<Grid>\n  <Button Content="A" Width="100"/>\n</Grid>`);
  const cur = new XamlDocument(`<Grid>\n  <Button Content="A" Width="123"/>\n</Grid>`);
  const ch = structuralDiff(base, cur);
  assert.equal(ch.length, 1);
  assert.equal(ch[0].kind, "attrs");
  if (ch[0].kind === "attrs") {
    assert.equal(ch[0].tag, "Button");
    assert.deepEqual(ch[0].attrs, [{ name: "Width", baseline: "100", current: "123" }]);
  }
});

test("structuralDiff: dodany i usunięty element", () => {
  const base = new XamlDocument(`<Grid>\n  <A/>\n</Grid>`);
  const cur = new XamlDocument(`<Grid>\n  <B/>\n</Grid>`);
  const ch = structuralDiff(base, cur);
  // A zniknął, B doszedł (różne klucze → brak dopasowania)
  const kinds = ch.map((c) => c.kind).sort();
  assert.deepEqual(kinds, ["added", "removed"]);
  const removed = ch.find((c) => c.kind === "removed");
  const added = ch.find((c) => c.kind === "added");
  assert.ok(removed && removed.kind === "removed" && removed.tag === "A");
  assert.ok(added && added.kind === "added" && added.tag === "B");
  if (removed && removed.kind === "removed") assert.equal(removed.xml, "<A/>");
});

test("structuralDiff: dopasowanie po x:Name mimo zmiany atrybutu", () => {
  const base = new XamlDocument(`<Grid>\n  <Button x:Name="ok" Width="100"/>\n</Grid>`);
  const cur = new XamlDocument(`<Grid>\n  <Button x:Name="ok" Width="80"/>\n</Grid>`);
  const ch = structuralDiff(base, cur);
  assert.equal(ch.length, 1);
  assert.equal(ch[0].kind, "attrs");
});

test("structuralDiff: poprawna atrybucja przy wstawieniu przed elementami tego samego typu", () => {
  const base = new XamlDocument(
    `<S>\n  <CheckBox Content="one" IsChecked="True"/>\n  <CheckBox Content="two" IsChecked="False"/>\n</S>`
  );
  const cur = new XamlDocument(
    `<S>\n  <CheckBox Content="new" IsChecked="False"/>\n  <CheckBox Content="one" IsChecked="True"/>\n  <CheckBox Content="two" IsChecked="True"/>\n</S>`
  );
  const ch = structuralDiff(base, cur);
  const added = ch.filter((c) => c.kind === "added");
  const attrs = ch.filter((c) => c.kind === "attrs");
  // dokładnie: 1 dodany (new) + zmiana IsChecked na "two" — NIE na "one"
  assert.equal(added.length, 1);
  assert.equal(attrs.length, 1);
  if (attrs[0].kind === "attrs") {
    assert.deepEqual(attrs[0].attrs, [{ name: "IsChecked", baseline: "False", current: "True" }]);
  }
});

test("structuralDiff: brak zmian → pusta lista", () => {
  const src = `<Grid>\n  <Button Content="A"/>\n</Grid>`;
  assert.deepEqual(structuralDiff(new XamlDocument(src), new XamlDocument(src)), []);
});

test("structuralDiff: przeniesienie między rodzicami → event moved (nie removed+added)", () => {
  const base = new XamlDocument(
    `<Root>\n  <StackPanel x:Name="sp">\n    <Button x:Name="b"/>\n  </StackPanel>\n  <Grid x:Name="g">\n  </Grid>\n</Root>`
  );
  const cur = new XamlDocument(
    `<Root>\n  <StackPanel x:Name="sp">\n  </StackPanel>\n  <Grid x:Name="g">\n    <Button x:Name="b"/>\n  </Grid>\n</Root>`
  );
  const ch = structuralDiff(base, cur);
  const moved = ch.filter((c) => c.kind === "moved");
  assert.equal(moved.length, 1);
  assert.equal(ch.filter((c) => c.kind === "added").length, 0);
  assert.equal(ch.filter((c) => c.kind === "removed").length, 0);
  const mv = moved[0];
  if (mv.kind === "moved") {
    assert.equal(mv.tag, "Button");
    // revert wraca do StackPanel (rodzic bazowy) — w bieżącym drzewie to jego odpowiednik
    assert.equal(typeof mv.revertParentId, "number");
    assert.equal(mv.baseLine, 3); // <Button> w baseline jest w 3. linii
  }
});

test("structuralDiff: przestawienie rodzeństwa → moved", () => {
  const base = new XamlDocument(`<S>\n  <Button x:Name="a"/>\n  <Button x:Name="b"/>\n</S>`);
  const cur = new XamlDocument(`<S>\n  <Button x:Name="b"/>\n  <Button x:Name="a"/>\n</S>`);
  const ch = structuralDiff(base, cur);
  assert.equal(ch.filter((c) => c.kind === "moved").length, 1);
  assert.equal(ch.filter((c) => c.kind === "added" || c.kind === "removed" || c.kind === "attrs").length, 0);
});

test("structuralDiff: zmiana atrybutu niesie linię i pełne atrybuty obu stron", () => {
  const base = new XamlDocument(`<Grid>\n  <Button Content="A" Width="100"/>\n</Grid>`);
  const cur = new XamlDocument(`<Grid>\n  <Button Content="A" Width="123"/>\n</Grid>`);
  const ch = structuralDiff(base, cur);
  assert.equal(ch.length, 1);
  if (ch[0].kind === "attrs") {
    assert.equal(ch[0].line, 2); // <Button> w 2. linii
    assert.deepEqual(ch[0].baselineAttrs, [
      { name: "Content", value: "A" },
      { name: "Width", value: "100" },
    ]);
    assert.deepEqual(ch[0].currentAttrs, [
      { name: "Content", value: "A" },
      { name: "Width", value: "123" },
    ]);
  }
});

test("structuralDiff: zmiana treści tekstowej → pseudo-atrybut (content)", () => {
  const base = new XamlDocument(`<Grid>\n  <Button>OK</Button>\n</Grid>`);
  const cur = new XamlDocument(`<Grid>\n  <Button>Cancel</Button>\n</Grid>`);
  const ch = structuralDiff(base, cur);
  assert.equal(ch.length, 1);
  if (ch[0].kind === "attrs") {
    assert.deepEqual(ch[0].attrs, [{ name: "(content)", baseline: "OK", current: "Cancel" }]);
    assert.equal(ch[0].currentContent, "Cancel");
  }
});
