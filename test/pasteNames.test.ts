import { test } from "node:test";
import assert from "node:assert/strict";
import { XamlDocument } from "../src/core/XamlDocument.ts";
import {
  validXamlFragment,
  collectNames,
  deduplicateNames,
  fragmentSummary,
} from "../src/core/PasteNames.ts";

// --- validXamlFragment ---

test("validXamlFragment: przepuszcza pojedynczy element (przycina whitespace)", () => {
  assert.equal(validXamlFragment("  <Button Content=\"OK\"/>\n"), "<Button Content=\"OK\"/>");
});

test("validXamlFragment: odrzuca tekst nie-XAML", () => {
  assert.equal(validXamlFragment("zwykły tekst"), null);
  assert.equal(validXamlFragment(""), null);
});

test("validXamlFragment: odrzuca wiele elementów na poziomie głównym", () => {
  assert.equal(validXamlFragment("<A/><B/>"), null);
});

test("validXamlFragment: dopuszcza komentarz obok jednego elementu", () => {
  const frag = "<!-- k --><Grid><Button/></Grid>";
  assert.equal(validXamlFragment(frag), frag);
});

// --- collectNames ---

test("collectNames: zbiera x:Name i Name z całego drzewa", () => {
  const doc = new XamlDocument(
    `<Window xmlns="x"><Grid x:Name="root"><Button Name="btn"/></Grid></Window>`
  );
  const names = collectNames(doc.roots);
  assert.deepEqual([...names].sort(), ["btn", "root"]);
});

// --- deduplicateNames ---

const existing = new Set(["btnOk", "root"]);

test("deduplicateNames: off zwraca fragment 1:1", () => {
  const frag = `<Button x:Name="btnOk"/>`;
  assert.equal(deduplicateNames(frag, existing, "off"), frag);
});

test("deduplicateNames: rename zmienia kolidującą nazwę na unikalną", () => {
  const out = deduplicateNames(`<Button x:Name="btnOk"/>`, existing, "rename");
  assert.equal(out, `<Button x:Name="btnOk_Copy"/>`);
});

test("deduplicateNames: nazwa nie-kolidująca pozostaje bez zmian", () => {
  const frag = `<Button x:Name="brandNew"/>`;
  assert.equal(deduplicateNames(frag, existing, "rename"), frag);
});

test("deduplicateNames: kolejne kolizje dostają unikalne przyrostki", () => {
  // btnOk i btnOk_Copy już zajęte → następny to btnOk_Copy1
  const taken = new Set(["btnOk", "btnOk_Copy"]);
  const out = deduplicateNames(`<Button x:Name="btnOk"/>`, taken, "rename");
  assert.equal(out, `<Button x:Name="btnOk_Copy1"/>`);
});

test("deduplicateNames: rename NIE rusza wewnętrznych odwołań", () => {
  const frag = `<StackPanel><TextBox x:Name="btnOk"/><Label Target="{Binding ElementName=btnOk}"/></StackPanel>`;
  const out = deduplicateNames(frag, existing, "rename");
  assert.match(out, /x:Name="btnOk_Copy"/);
  assert.match(out, /ElementName=btnOk\}/); // odwołanie nietknięte (tryb rename)
});

test("deduplicateNames: renameAndReferences aktualizuje ElementName i x:Reference", () => {
  const frag =
    `<StackPanel>` +
    `<TextBox x:Name="btnOk"/>` +
    `<Label Target="{Binding ElementName=btnOk}"/>` +
    `<Label Content="{x:Reference btnOk}"/>` +
    `</StackPanel>`;
  const out = deduplicateNames(frag, existing, "renameAndReferences");
  assert.match(out, /x:Name="btnOk_Copy"/);
  assert.match(out, /ElementName=btnOk_Copy\}/);
  assert.match(out, /x:Reference btnOk_Copy\}/);
  assert.doesNotMatch(out, /btnOk(?!_Copy)/); // nie zostało żadne stare "btnOk"
});

test("deduplicateNames: x:Reference Name=... jest aktualizowane (renameAndReferences)", () => {
  const frag =
    `<StackPanel><TextBox x:Name="root"/><Label Content="{x:Reference Name=root}"/></StackPanel>`;
  const out = deduplicateNames(frag, existing, "renameAndReferences");
  assert.match(out, /x:Name="root_Copy"/);
  assert.match(out, /x:Reference Name=root_Copy\}/);
});

// --- fragmentSummary ---

test("fragmentSummary: pojedynczy element ma 0 pod-elementów", () => {
  assert.deepEqual(fragmentSummary(`<Button Content="OK"/>`), { tag: "Button", count: 0 });
});

test("fragmentSummary: liczy wszystkie elementy potomne (rekurencyjnie)", () => {
  const frag = `<StackPanel><Grid><Button/><Button/></Grid><TextBox/></StackPanel>`;
  assert.deepEqual(fragmentSummary(frag), { tag: "StackPanel", count: 4 });
});

test("fragmentSummary: nie-element zwraca null", () => {
  assert.equal(fragmentSummary("zwykły tekst"), null);
});

// --- insertChildReturningId ---

test("insertChildReturningId: zwraca id wklejonego elementu (zaznaczenie po wklejeniu)", () => {
  const src = `<Window xmlns="x">\n\t<Grid>\n\t\t<Button x:Name="a"/>\n\t</Grid>\n</Window>`;
  const doc = new XamlDocument(src);
  const grid = doc.roots[0].children.find((c) => c.tag === "Grid")!;
  const id = doc.insertChildReturningId(grid.id, `<TextBox x:Name="b"/>`);
  assert.notEqual(id, null);
  // ten sam tekst → te same pozycyjne id; węzeł o zwróconym id to wstawiony TextBox
  const node = new XamlDocument(doc.getText()).getNode(id!);
  assert.equal(node?.tag, "TextBox");
  assert.equal(node?.attributes.find((a) => a.name === "x:Name")?.value, "b");
});

test("integracja: wklejenie z dedup nie zmienia oryginału, daje poprawny dokument", () => {
  const src = `<Window xmlns="x">\n\t<Grid x:Name="g">\n\t\t<Button x:Name="btnOk" Content="OK"/>\n\t</Grid>\n</Window>`;
  const doc = new XamlDocument(src);
  const grid = doc.roots[0].children.find((c) => c.tag === "Grid")!;
  const frag = deduplicateNames(`<Button x:Name="btnOk" Content="OK"/>`, collectNames(doc.roots), "rename");
  assert.equal(frag, `<Button x:Name="btnOk_Copy" Content="OK"/>`);
  assert.equal(doc.insertChild(grid.id, frag), true);
  const out = doc.getText();
  assert.match(out, /x:Name="btnOk"/); // oryginał nietknięty
  assert.match(out, /x:Name="btnOk_Copy"/); // kopia z unikalną nazwą
});
