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

test("toHostXaml: x:Class na korzeniu zamienione na x:Uid bez korupcji XML", () => {
  // regresja: insert(x:Uid)+remove(x:Class) tworzyły nakładające się edycje → `<WindowMainWindow"...`
  const src = `<Window x:Class="My.App.MainWindow" xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" Width="100"><Grid/></Window>`;
  const out = new XamlDocument(src).toHostXaml();
  assert.match(out, /^<Window x:Uid="u\d+" xmlns="http/); // poprawny początek, brak korupcji
  assert.ok(!out.includes("x:Class"), "x:Class powinno zniknąć");
  assert.ok(out.includes('Width="100"'), "reszta atrybutów nietknięta");
  assert.ok(/<Grid x:Uid="u\d+"\s*\/>/.test(out), "dzieci też dostają x:Uid");
});

test("nodeIdAtOffset: zwraca najgłębszy element pod offsetem (kursor → zaznaczenie)", () => {
  const src = `<Grid>\n  <StackPanel>\n    <Button Content="OK"/>\n  </StackPanel>\n</Grid>`;
  const doc = new XamlDocument(src);
  const grid = findByTag(doc, "Grid")!;
  const stack = findByTag(doc, "StackPanel")!;
  const btn = findByTag(doc, "Button")!;

  // offset wewnątrz atrybutu Buttona → Button (najgłębszy), nie StackPanel/Grid
  const inButton = src.indexOf('Content="OK"') + 2;
  assert.equal(doc.nodeIdAtOffset(inButton), btn.id);

  // offset na otwierającym znaczniku StackPanel → StackPanel
  const inStack = src.indexOf("<StackPanel") + 2;
  assert.equal(doc.nodeIdAtOffset(inStack), stack.id);

  // offset na korzeniu → Grid
  assert.equal(doc.nodeIdAtOffset(src.indexOf("<Grid") + 1), grid.id);

  // poza dokumentem → null
  assert.equal(doc.nodeIdAtOffset(src.length + 10), null);
});

test("moveElementReturningId: przenosi do kontenera i zwraca NOWE id zaznaczenia", () => {
  const src = `<Grid>\n  <Button Content="OK"/>\n  <StackPanel>\n  </StackPanel>\n</Grid>`;
  const doc = new XamlDocument(src);
  const btn = findByTag(doc, "Button")!;
  const stack = findByTag(doc, "StackPanel")!;
  const newId = doc.moveElementReturningId(btn.id, stack.id, null);
  assert.ok(newId !== null, "powinno zwrócić nowe id");
  // nowe id wskazuje przeniesiony Button w zaktualizowanym tekście
  const after = new XamlDocument(doc.getText());
  assert.equal(after.getNode(newId!)?.tag, "Button");
  // Button jest teraz dzieckiem StackPanel
  const stackAfter = findByTag(after, "StackPanel")!;
  assert.ok(stackAfter.children.some((c) => c.id === newId), "Button trafił do StackPanel");
});

test("moveElementReturningId: przy duplikatach zaznacza PRZENIESIONY, nie wcześniejszy bliźniak", () => {
  // dwa identyczne <Button Content="OK"/>; przenosimy DRUGI do StackPanel
  const src = `<Grid>\n  <Button Content="OK"/>\n  <Button Content="OK"/>\n  <StackPanel>\n  </StackPanel>\n</Grid>`;
  // id są pozycyjne i deterministyczne między instancjami tego samego tekstu — policz raz
  const probe = new XamlDocument(src);
  const moved = probe.root!.children.filter((c) => c.tag === "Button")[1]; // drugi Button
  const stackId = findByTag(probe, "StackPanel")!.id;

  // jak XveEditorProvider: kopia jednorazowa służy WYŁĄCZNIE do przewidzenia nowego id
  const newId = new XamlDocument(src).moveElementReturningId(moved.id, stackId, null);
  assert.ok(newId !== null, "powinno zwrócić nowe id");

  // realna edycja to osobne moveElement (bez markera) na właściwym dokumencie
  const real = new XamlDocument(src);
  assert.equal(real.moveElement(moved.id, stackId, null), true);
  const after = new XamlDocument(real.getText());
  const stackAfter = findByTag(after, "StackPanel")!;
  // KLUCZ: przewidziane id to Button wewnątrz StackPanel, a NIE pierwszy bliźniak w Grid
  assert.ok(
    stackAfter.children.some((c) => c.id === newId),
    "zaznaczony Button musi być tym przeniesionym do StackPanel"
  );
  // zapisany tekst nie zawiera markera (kotwica żyje tylko w kopii jednorazowej)
  assert.ok(!real.getText().includes("_xveSel"), "marker nie może wyciec do zapisanego tekstu");
});

test("insertChild: rozwija self-closing rodzica (MenuItem-liść → submenu)", () => {
  const src = `<Menu>\n\t<MenuItem Header="Plik"/>\n\t<MenuItem Header="Widok"/>\n</Menu>`;
  const doc = new XamlDocument(src);
  const plik = findByTag(doc, "MenuItem")!;
  assert.equal(doc.insertChild(plik.id, `<MenuItem Header="Nowy"/>`), true);
  const out = doc.getText();
  assert.match(out, /<MenuItem Header="Plik">\s*<MenuItem Header="Nowy"\/>\s*<\/MenuItem>/);
  // Widok nietknięty
  assert.ok(out.includes(`<MenuItem Header="Widok"/>`));
});

test("tree: parsuje atrybuty i dzieci", () => {
  const doc = new XamlDocument(sample);
  const tree = doc.toTree()!;
  assert.equal(tree.tag, "Window");
  assert.ok(tree.children.length >= 1);
  const grid = tree.children.find((c) => c.tag === "Grid");
  assert.ok(grid);
});

test("toTree: mieszana treść inline (tekst + <LineBreak/>) zachowuje kolejność w inlines", () => {
  const doc = new XamlDocument(
    `<Window xmlns="x"><TextBlock>Tekst<LineBreak />dalej</TextBlock></Window>`
  );
  const tree = doc.toTree()!;
  const tb = tree.children.find((c) => c.tag === "TextBlock")!;
  assert.ok(tb.inlines, "powinny powstać inlines dla mieszanej treści");
  assert.equal(tb.inlines!.length, 3);
  assert.deepEqual(tb.inlines!.map((p) => ("text" in p ? p.text : p.node.tag)), [
    "Tekst",
    "LineBreak",
    "dalej",
  ]);
});

test("toTree: czysty tekst (bez elementów inline) nie tworzy inlines", () => {
  const doc = new XamlDocument(`<Window xmlns="x"><TextBlock>Sam tekst</TextBlock></Window>`);
  const tb = doc.toTree()!.children.find((c) => c.tag === "TextBlock")!;
  assert.equal(tb.inlines, undefined);
  assert.equal(tb.text, "Sam tekst");
});

test("toTree: encje w treści tekstowej są dekodowane (parytet z wartościami atrybutów)", () => {
  // regresja: renderer robi createTextNode(text), więc surowe `&amp;` wyświetlało się dosłownie
  const doc = new XamlDocument(`<Window xmlns="x"><TextBlock>a &amp; b &lt;c&gt; &#39;d&#39;</TextBlock></Window>`);
  const tb = doc.toTree()!.children.find((c) => c.tag === "TextBlock")!;
  assert.equal(tb.text, "a & b <c> 'd'");
});

test("toTree: encje w mieszanej treści inline są dekodowane", () => {
  const doc = new XamlDocument(
    `<Window xmlns="x"><TextBlock>a &amp; b<LineBreak />c &lt; d</TextBlock></Window>`
  );
  const tb = doc.toTree()!.children.find((c) => c.tag === "TextBlock")!;
  assert.deepEqual(tb.inlines!.map((p) => ("text" in p ? p.text : p.node.tag)), [
    "a & b",
    "LineBreak",
    "c < d",
  ]);
});

test("toTree: encje nie są dekodowane dwukrotnie", () => {
  // `&amp;lt;` to literalny tekst `&lt;`, a nie znak `<`
  const doc = new XamlDocument(`<Window xmlns="x"><TextBlock>&amp;lt; &amp;amp;</TextBlock></Window>`);
  const tb = doc.toTree()!.children.find((c) => c.tag === "TextBlock")!;
  assert.equal(tb.text, "&lt; &amp;");
});

test("toTree: segment czysto-biały z encji (&#32;) nie tworzy wpisu w inlines", () => {
  const doc = new XamlDocument(`<Window xmlns="x"><TextBlock>x<LineBreak />&#32;</TextBlock></Window>`);
  const tb = doc.toTree()!.children.find((c) => c.tag === "TextBlock")!;
  assert.deepEqual(tb.inlines!.map((p) => ("text" in p ? p.text : p.node.tag)), ["x", "LineBreak"]);
});

test("toTree: dekodowanie encji nie rusza dokumentu (chirurgiczny zapis)", () => {
  const src = `<Window xmlns="x"><TextBlock Text="p &amp; q">a &amp; b</TextBlock></Window>`;
  const doc = new XamlDocument(src);
  doc.toTree();
  assert.equal(doc.getText(), src, "toTree() jest tylko odczytem — tekst źródłowy bez zmian");

  // edycja atrybutu nie może „przepisać" encji w treści tekstowej elementu
  const tbId = doc.toTree()!.children.find((c) => c.tag === "TextBlock")!.id;
  doc.setAttribute(tbId, "Width", "10");
  const out = doc.getText();
  assert.ok(out.includes(`>a &amp; b</TextBlock>`), `treść nadal zakodowana, a jest: ${out}`);
  assert.ok(out.includes(`Text="p &amp; q"`), "atrybut nietknięty przez edycję sąsiada");
  assert.ok(out.includes(`Width="10"`), "edycja faktycznie się zaaplikowała");
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
