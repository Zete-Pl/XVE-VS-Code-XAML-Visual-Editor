import { test } from "node:test";
import assert from "node:assert/strict";
import {
  inferKind,
  metaFor,
  knownProperties,
  defaultValue,
  isKnownType,
  closestKnownType,
  closestKnownProperty,
  isContainer,
  isItemsHost,
  ADDABLE_GROUPS,
  ADDABLE_TYPES,
  defaultSnippet,
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

test("isItemsHost / isContainer: rozróżnia items-hosty od paneli i pozycji treści", () => {
  // items-hosty (dzieci to konkretne pozycje) — przyjmują pozycje jako kolejne dzieci
  for (const t of ["TabControl", "Menu", "MenuItem", "ComboBox", "ListBox", "TreeView", "TreeViewItem"])
    assert.equal(isItemsHost(t), true, t);
  assert.equal(isItemsHost("x:TabControl"), true); // ignoruje prefiks namespace
  // panele i pozycje treści NIE są items-hostami
  for (const t of ["StackPanel", "Grid", "TabItem", "Border", "ComboBoxItem"])
    assert.equal(isItemsHost(t), false, t);
  // items-host to osobna kategoria od „kontenera" panelowego
  assert.equal(isContainer("TabControl"), false);
  assert.equal(isContainer("StackPanel"), true);
});

test("isKnownType: rozpoznaje typy WPF i literówki (niezgodność znaczników)", () => {
  assert.equal(isKnownType("StackPanel"), true);
  assert.equal(isKnownType("StacPanel"), false); // literówka ze screena 3
  assert.equal(isKnownType("StckPanel"), false); // literówka ze screena 4
  assert.equal(isKnownType("Button"), true);
  assert.equal(isKnownType("x:StackPanel"), true); // ignoruje prefiks namespace
  assert.equal(isKnownType("MyCustomControl"), false);
});

test("closestKnownType / closestKnownProperty: auto-fix literówek", () => {
  assert.equal(closestKnownType("Buton"), "Button"); // screen 2
  assert.equal(closestKnownType("StacPanel"), "StackPanel"); // screen 3
  assert.equal(closestKnownType("StckPanel"), "StackPanel"); // screen 4
  assert.equal(closestKnownProperty("CheckBox", "Contet"), "Content"); // screen 1
  // za daleko / nonsens → brak pewnej podpowiedzi
  assert.equal(closestKnownType("Xyzzy"), null);
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

test("knownProperties: komplet podstawowych właściwości w COMMON", () => {
  const names = knownProperties("Button").map((p) => p.name);
  for (const p of [
    "Name",
    "MinWidth",
    "MinHeight",
    "MaxWidth",
    "MaxHeight",
    "HorizontalContentAlignment",
    "VerticalContentAlignment",
    "BorderBrush",
    "BorderThickness",
    "FontFamily",
  ]) {
    assert.ok(names.includes(p), `brak właściwości ${p}`);
  }
  // rodzaje edytorów wnioskowane poprawnie
  assert.equal(metaFor("Button", "BorderThickness").kind, "thickness");
  assert.equal(metaFor("Button", "BorderBrush").kind, "brush");
  assert.equal(metaFor("Button", "MinWidth").kind, "number");
  assert.equal(metaFor("Button", "HorizontalContentAlignment").kind, "enum");
});

test("defaultValue: sensowne wartości startowe", () => {
  assert.equal(defaultValue({ name: "IsChecked", kind: "bool" }), "True");
  assert.equal(defaultValue({ name: "Margin", kind: "thickness" }), "0");
  assert.equal(
    defaultValue({ name: "HorizontalAlignment", kind: "enum", values: ["Left", "Right"] }),
    "Left"
  );
  assert.equal(defaultValue({ name: "Source", kind: "image" }), ""); // picker startuje pusty
});

test("ADDABLE_GROUPS: spójne z ADDABLE_TYPES, bez duplikatów, etykiety to klucze l10n", () => {
  const flat = ADDABLE_GROUPS.flatMap((g) => g.types);
  assert.deepEqual(ADDABLE_TYPES, flat); // ADDABLE_TYPES to spłaszczenie grup
  assert.equal(new Set(flat).size, flat.length, "brak duplikatów typów między grupami");
  for (const g of ADDABLE_GROUPS) assert.match(g.label, /^Add\.Group\./); // klucz lokalizacji
  // nowe kategorie obecne
  const labels = ADDABLE_GROUPS.map((g) => g.label);
  for (const l of ["Add.Group.Containers", "Add.Group.Controls", "Add.Group.Lists", "Add.Group.Shapes"])
    assert.ok(labels.includes(l), l);
});

test("defaultSnippet: nowe typy dają poprawny XAML z dziećmi/parametrami", () => {
  // items-hosty dostają startowe pozycje
  assert.match(defaultSnippet("ComboBox"), /<ComboBox[^>]*SelectedIndex="0"[\s\S]*<ComboBoxItem/);
  assert.match(defaultSnippet("TabControl"), /<TabControl[\s\S]*<TabItem Header=/);
  assert.match(defaultSnippet("TreeView"), /<TreeViewItem[\s\S]*<TreeViewItem/); // zagnieżdżenie
  assert.match(defaultSnippet("Menu"), /<MenuItem Header="_File"/);
  assert.match(defaultSnippet("ListBox"), /<ListBoxItem/);
  // kontenery z nagłówkiem / rozmiarem
  assert.match(defaultSnippet("GroupBox"), /Header="GroupBox"/);
  assert.match(defaultSnippet("Expander"), /IsExpanded="True"/);
  assert.match(defaultSnippet("UniformGrid"), /Rows="2" Columns="2"/);
  // kształty
  assert.match(defaultSnippet("Line"), /X1="0" Y1="0" X2="120"/);
  assert.match(defaultSnippet("Polygon"), /Points="[^"]+"/);
  // każdy addable typ produkuje niepusty, otwierający właściwy znacznik
  for (const t of ADDABLE_TYPES) {
    const xml = defaultSnippet(t);
    assert.ok(xml.startsWith(`<${t}`), `snippet ${t} powinien otwierać <${t}`);
  }
});

test("nowe typy: metadane właściwości i kategorie kontenerów", () => {
  // Image.Source ma rodzaj „image" (picker), MediaElement też
  assert.equal(metaFor("Image", "Source").kind, "image");
  assert.equal(metaFor("MediaElement", "Source").kind, "image");
  // parametry konfiguracyjne nowych typów w „dodaj właściwość"
  assert.ok(knownProperties("ComboBox").some((p) => p.name === "SelectedIndex"));
  assert.ok(knownProperties("Expander").some((p) => p.name === "IsExpanded"));
  assert.ok(knownProperties("UniformGrid").some((p) => p.name === "Columns"));
  assert.equal(metaFor("Line", "X1").kind, "number");
  assert.equal(metaFor("TabControl", "TabStripPlacement").kind, "enum");
  // nowe kontenery rozpoznane jako panele
  for (const c of ["UniformGrid", "GroupBox", "Expander"]) assert.equal(isContainer(c), true, c);
  // listowe są items-hostami, nie panelami
  for (const h of ["ListView", "ToolBar", "StatusBar"]) assert.equal(isItemsHost(h), true, h);
});

test("Add property: rozbudowana lista możliwych parametrów", () => {
  // wspólne, świeżo dodane parametry widoczne dla każdego elementu
  const common = knownProperties("Button").map((p) => p.name);
  for (const p of ["Cursor", "TabIndex", "Tag", "ClipToBounds", "RenderTransformOrigin", "Panel.ZIndex"])
    assert.ok(common.includes(p), `brak wspólnego parametru ${p}`);
  // wzbogacone parametry per-typ
  const btn = knownProperties("Button").map((p) => p.name);
  for (const p of ["IsDefault", "IsCancel", "ClickMode"]) assert.ok(btn.includes(p), p);
  const tb = knownProperties("TextBlock").map((p) => p.name);
  for (const p of ["TextTrimming", "LineHeight"]) assert.ok(tb.includes(p), p);
  const win = knownProperties("Window").map((p) => p.name);
  for (const p of ["WindowStartupLocation", "ResizeMode", "Topmost", "Icon"]) assert.ok(win.includes(p), p);
  // Window.Icon używa pickera obrazka (jak Image.Source)
  assert.equal(metaFor("Window", "Icon").kind, "image");
});
