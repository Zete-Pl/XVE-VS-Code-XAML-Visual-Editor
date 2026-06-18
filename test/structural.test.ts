import { test } from "node:test";
import assert from "node:assert/strict";
import { XamlDocument } from "../src/core/XamlDocument.ts";
import type { XamlNode } from "../src/core/XamlParser.ts";

function find(doc: XamlDocument, tag: string): XamlNode {
  const walk = (n: XamlNode): XamlNode | undefined => {
    if (n.tag === tag) return n;
    for (const c of n.children) {
      const r = walk(c);
      if (r) return r;
    }
    return undefined;
  };
  const r = doc.root ? walk(doc.root) : undefined;
  assert.ok(r, `nie znaleziono <${tag}>`);
  return r!;
}

test("getElementSource: dokładny wycinek oryginału", () => {
  const doc = new XamlDocument(`<Grid>\n  <Button Content="A" />\n</Grid>`);
  const b = find(doc, "Button");
  assert.equal(doc.getElementSource(b.id), `<Button Content="A" />`);
});

test("removeElement: usuwa element wraz z linią i wcięciem", () => {
  const doc = new XamlDocument(`<Grid>\n  <A/>\n</Grid>`);
  doc.removeElement(find(doc, "A").id);
  assert.equal(doc.getText(), `<Grid>\n</Grid>`);
});

test("insertChild: dopisuje na końcu z wcięciem rodzeństwa", () => {
  const doc = new XamlDocument(`<Grid>\n  <A/>\n</Grid>`);
  doc.insertChild(doc.root!.id, `<B/>`);
  assert.equal(doc.getText(), `<Grid>\n  <A/>\n  <B/>\n</Grid>`);
});

test("insertChild: do pustego kontenera tworzy wcięte ciało", () => {
  const doc = new XamlDocument(`<Grid></Grid>`);
  doc.insertChild(doc.root!.id, `<B/>`);
  assert.equal(doc.getText(), `<Grid>\n\t<B/>\n</Grid>`);
});

test("insertChild: przed wskazanym rodzeństwem", () => {
  const doc = new XamlDocument(`<Grid>\n  <A/>\n  <C/>\n</Grid>`);
  const c = find(doc, "C");
  doc.insertChild(doc.root!.id, `<B/>`, c.id);
  assert.equal(doc.getText(), `<Grid>\n  <A/>\n  <B/>\n  <C/>\n</Grid>`);
});

test("moveElement: przenosi element między kontenerami", () => {
  const doc = new XamlDocument(`<Root>\n  <Box>\n    <A/>\n  </Box>\n  <Dest>\n  </Dest>\n</Root>`);
  doc.moveElement(find(doc, "A").id, find(doc, "Dest").id);
  assert.equal(
    doc.getText(),
    `<Root>\n  <Box>\n  </Box>\n  <Dest>\n  \t<A/>\n  </Dest>\n</Root>`
  );
});

test("setAttributes: atomowo ustawia/ dodaje wiele atrybutów", () => {
  const doc = new XamlDocument(`<B x="1"/>`);
  doc.setAttributes(find(doc, "B").id, { x: "2", y: "3" });
  assert.equal(doc.getText(), `<B y="3" x="2"/>`);
});
