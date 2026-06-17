import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { XamlDocument } from "../src/core/XamlDocument.ts";

const here = dirname(fileURLToPath(import.meta.url));
const sample = readFileSync(join(here, "..", "samples", "Sample.xaml"), "utf8");

test("round-trip: bez zmian getText() === oryginał (bajt-w-bajt)", () => {
  const doc = new XamlDocument(sample);
  assert.equal(doc.getText(), sample);
  assert.equal(doc.isDirty(), false);
});

test("round-trip: zachowuje komentarze, whitespace i samozamykające znaczniki", () => {
  const src = `<Window xmlns="x">\r\n\t<!-- komentarz -->\r\n\t<Grid>\r\n\t\t<Button Content="OK" />\r\n\t</Grid>\r\n</Window>`;
  const doc = new XamlDocument(src);
  assert.equal(doc.getText(), src);
});

test("surgical: zmiana jednego atrybutu nie rusza reszty pliku", () => {
  const doc = new XamlDocument(sample);
  // znajdź pierwszy Button i zmień Width
  const button = findByTag(doc, "Button");
  assert.ok(button, "Button powinien istnieć");
  const ok = doc.setAttribute(button!.id, "Width", "123");
  assert.equal(ok, true);

  const out = doc.getText();
  assert.notEqual(out, sample);
  // dokładnie jedna różnica: 100 -> 123 w pierwszym Button (Width="100")
  assert.ok(out.includes('Width="123"'));
  // liczba zmienionych znaków minimalna: różnica długości = 1 ("100" -> "123" ta sama długość)
  assert.equal(out.length, sample.length);
  // reszta pliku identyczna poza tym fragmentem
  const idx = out.indexOf('Width="123"');
  assert.equal(out.slice(0, idx), sample.slice(0, idx));
  assert.equal(out.slice(idx + 11), sample.slice(idx + 11));
});

test("surgical: dodanie nowego atrybutu wstawia tuż za nazwą znacznika", () => {
  const src = `<Grid><Button Content="OK"/></Grid>`;
  const doc = new XamlDocument(src);
  const btn = findByTag(doc, "Button")!;
  doc.setAttribute(btn.id, "Tag", "x");
  assert.equal(doc.getText(), `<Grid><Button Tag="x" Content="OK"/></Grid>`);
});

test("surgical: usunięcie atrybutu usuwa też poprzedzający whitespace", () => {
  const src = `<Button Content="OK" Width="100"/>`;
  const doc = new XamlDocument(src);
  const btn = findByTag(doc, "Button")!;
  doc.removeAttribute(btn.id, "Width");
  assert.equal(doc.getText(), `<Button Content="OK"/>`);
});

test("encoding: wartości z & < \" są poprawnie escapowane", () => {
  const src = `<TextBlock Text="a"/>`;
  const doc = new XamlDocument(src);
  const tb = findByTag(doc, "TextBlock")!;
  doc.setAttribute(tb.id, "Text", `x & y < z "q"`);
  assert.equal(doc.getText(), `<TextBlock Text="x &amp; y &lt; z &quot;q&quot;"/>`);
});

test("ponowna edycja tego samego atrybutu nadpisuje poprzednią", () => {
  const doc = new XamlDocument(`<Button Width="1"/>`);
  const btn = findByTag(doc, "Button")!;
  doc.setAttribute(btn.id, "Width", "2");
  doc.setAttribute(btn.id, "Width", "3");
  assert.equal(doc.getText(), `<Button Width="3"/>`);
});

test("tree: parsuje atrybuty i dzieci", () => {
  const doc = new XamlDocument(sample);
  const tree = doc.toTree()!;
  assert.equal(tree.tag, "Window");
  assert.ok(tree.children.length >= 1);
  const grid = tree.children.find((c) => c.tag === "Grid");
  assert.ok(grid);
});

// helper
import type { XamlNode } from "../src/core/XamlParser.ts";
function findByTag(doc: XamlDocument, tag: string): XamlNode | undefined {
  const walk = (n: XamlNode): XamlNode | undefined => {
    if (n.tag === tag) return n;
    for (const c of n.children) {
      const r = walk(c);
      if (r) return r;
    }
    return undefined;
  };
  return doc.root ? walk(doc.root) : undefined;
}
