import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractResources,
  mergeModels,
  buildStyleIndex,
  resolveStyleSetters,
  resourceKey,
  plainText,
  isMarkup,
  parseResx,
  locKey,
  fallbackValue,
  resxLanguagesFromNames,
} from "../src/core/ResourceModel.ts";

test("plainText: markupy bez danych → '', escape {} → literał", () => {
  assert.equal(plainText("{Binding Title}"), "");
  assert.equal(plainText("{helpers:Loc AppName}"), "");
  assert.equal(plainText("{}{literalnie}"), "{literalnie}");
  assert.equal(plainText("Zwykły tekst"), "Zwykły tekst");
  assert.equal(plainText(undefined), "");
});

test("isMarkup / resourceKey: rozpoznanie {Static/DynamicResource K}", () => {
  assert.equal(isMarkup("{StaticResource X}"), true);
  assert.equal(isMarkup("{}literal"), false);
  assert.equal(isMarkup("#FF0000"), false);
  assert.equal(resourceKey("{StaticResource AccentBrush}"), "AccentBrush");
  assert.equal(resourceKey("{DynamicResource SubtleBrush}"), "SubtleBrush");
  assert.equal(resourceKey("{Binding Foo}"), null);
  assert.equal(resourceKey("#FF0000"), null);
});

test("extractResources: SolidColorBrush i ImageBrush ze słownika", () => {
  const xaml = `
    <ResourceDictionary xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
                        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
      <ImageBrush x:Key="WindowBackgroundBrush" ImageSource="pack://application:,,,/Assets/tlo.jpg" />
      <SolidColorBrush x:Key="AccentBrush" Color="#1C7ED6" />
      <SolidColorBrush x:Key="SubtleBrush" Color="#8FA6C1" />
    </ResourceDictionary>`;
  const m = extractResources(xaml);
  assert.equal(m.brushes.AccentBrush, "#1C7ED6");
  assert.equal(m.brushes.SubtleBrush, "#8FA6C1");
  assert.equal(m.brushImages.WindowBackgroundBrush, "pack://application:,,,/Assets/tlo.jpg");
});

test("extractResources: style implicit i nazwany z prostymi setterami; Template pominięty", () => {
  const xaml = `
    <Application xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
                 xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
      <Application.Resources>
        <Style TargetType="Button">
          <Setter Property="Background" Value="{DynamicResource AccentBrush}" />
          <Setter Property="Padding" Value="14,8" />
          <Setter Property="Template">
            <Setter.Value><ControlTemplate TargetType="Button" /></Setter.Value>
          </Setter>
        </Style>
        <Style x:Key="GhostButtonStyle" TargetType="Button" BasedOn="{StaticResource {x:Type Button}}">
          <Setter Property="Background" Value="{DynamicResource GhostButtonBackgroundBrush}" />
        </Style>
      </Application.Resources>
    </Application>`;
  const m = extractResources(xaml);
  const implicit = m.styles.find((s) => !s.key && s.targetType === "Button");
  assert.ok(implicit, "styl domyślny Button istnieje");
  assert.equal(implicit!.setters.Background, "{DynamicResource AccentBrush}");
  assert.equal(implicit!.setters.Padding, "14,8");
  assert.equal(implicit!.setters.Template, undefined, "Template (forma element-property) pominięty");
  const ghost = m.styles.find((s) => s.key === "GhostButtonStyle");
  assert.ok(ghost);
  assert.equal(ghost!.basedOnType, "Button");
  assert.equal(ghost!.setters.Background, "{DynamicResource GhostButtonBackgroundBrush}");
});

test("extractResources: chrome z ControlTemplate (CornerRadius/Background) jako syntetyczne settery", () => {
  const xaml = `
    <Application xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
                 xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
      <Application.Resources>
        <Style TargetType="Button">
          <Setter Property="Background" Value="{DynamicResource AccentBrush}" />
          <Setter Property="Template">
            <Setter.Value>
              <ControlTemplate TargetType="Button">
                <Border Background="{TemplateBinding Background}" CornerRadius="14" Padding="10,6">
                  <ContentPresenter />
                </Border>
              </ControlTemplate>
            </Setter.Value>
          </Setter>
        </Style>
      </Application.Resources>
    </Application>`;
  const s = extractResources(xaml).styles.find((s) => s.targetType === "Button")!;
  assert.equal(s.setters.CornerRadius, "14"); // literał z Border szablonu
  assert.equal(s.setters.Padding, "10,6");
  assert.equal(s.setters.Background, "{DynamicResource AccentBrush}"); // realny setter, NIE TemplateBinding
});

test("extractResources: realny setter ma priorytet nad chrome z szablonu", () => {
  const xaml = `
    <Window.Resources xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
                      xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
      <Style TargetType="Button">
        <Setter Property="CornerRadius" Value="3" />
        <Setter Property="Template">
          <Setter.Value>
            <ControlTemplate TargetType="Button"><Border CornerRadius="20" /></ControlTemplate>
          </Setter.Value>
        </Setter>
      </Style>
    </Window.Resources>`;
  const s = extractResources(xaml).styles[0];
  assert.equal(s.setters.CornerRadius, "3"); // realny setter wygrywa nad 20 z szablonu
});

test("resolveStyleSetters: BasedOn (nazwany→typ) scala settery, dziecko nadpisuje", () => {
  const xaml = `
    <Application xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
                 xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
      <Application.Resources>
        <Style TargetType="Button">
          <Setter Property="Padding" Value="14,8" />
          <Setter Property="Foreground" Value="#FFFFFF" />
        </Style>
        <Style x:Key="Ghost" TargetType="Button" BasedOn="{StaticResource {x:Type Button}}">
          <Setter Property="Background" Value="#111111" />
        </Style>
        <Style x:Key="Icon" TargetType="Button" BasedOn="{StaticResource Ghost}">
          <Setter Property="Width" Value="36" />
          <Setter Property="Padding" Value="0" />
        </Style>
      </Application.Resources>
    </Application>`;
  const index = buildStyleIndex(extractResources(xaml).styles);
  const ghost = resolveStyleSetters(index, { type: "Button", key: "Ghost" });
  assert.equal(ghost.Padding, "14,8"); // odziedziczone z implicit (przez BasedOn {x:Type Button})
  assert.equal(ghost.Background, "#111111");
  const icon = resolveStyleSetters(index, { type: "Button", key: "Icon" });
  assert.equal(icon.Width, "36");
  assert.equal(icon.Padding, "0"); // dziecko nadpisuje odziedziczone "14,8"
  assert.equal(icon.Background, "#111111"); // z Ghost
  assert.equal(icon.Foreground, "#FFFFFF"); // z implicit
});

test("resolveStyleSetters: bez klucza → styl implicit dla typu", () => {
  const xaml = `
    <Window.Resources xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
                      xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
      <Style TargetType="ToolBarTray"><Setter Property="Background" Value="#222" /></Style>
    </Window.Resources>`;
  const index = buildStyleIndex(extractResources(xaml).styles);
  assert.equal(resolveStyleSetters(index, { type: "ToolBarTray" }).Background, "#222");
  assert.deepEqual(resolveStyleSetters(index, { type: "Button" }), {}); // brak stylu dla typu
});

test("extractResources: styl wewnątrz ControlTemplate NIE jest zbierany jako zasób top-level", () => {
  const xaml = `
    <Window.Resources xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
                      xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml">
      <Style x:Key="Outer" TargetType="Button">
        <Setter Property="Template">
          <Setter.Value>
            <ControlTemplate TargetType="Button">
              <Border><Border.Style><Style TargetType="Border"><Setter Property="Width" Value="5" /></Style></Border.Style></Border>
            </ControlTemplate>
          </Setter.Value>
        </Setter>
      </Style>
    </Window.Resources>`;
  const m = extractResources(xaml);
  // tylko styl bezpośrednio w *.Resources; wewnętrzny Style w Border.Style pominięty
  assert.equal(m.styles.length, 1);
  assert.equal(m.styles[0].key, "Outer");
});

test("parseResx: bierze wpisy tekstowe, pomija obrazy/binaria, dekoduje encje", () => {
  const resx = `<?xml version="1.0" encoding="utf-8"?>
    <root>
      <data name="AppName" xml:space="preserve"><value>Duplikaty Zdjęć</value></data>
      <data name="Amp" xml:space="preserve"><value>Tak &amp; Nie</value></data>
      <data name="Logo" type="System.Resources.ResX.SomeImage"><value>BASE64HERE</value></data>
      <data name="Icon" mimetype="application/x-microsoft.net.object.bytearray.base64"><value>ZZ</value></data>
    </root>`;
  const m = parseResx(resx);
  assert.equal(m.AppName, "Duplikaty Zdjęć");
  assert.equal(m.Amp, "Tak & Nie");
  assert.equal(m.Logo, undefined); // type= → pominięty
  assert.equal(m.Icon, undefined); // mimetype= → pominięty
});

test("locKey: klucz z markupu Loc (positional, Key=, prefiks ns, PreviewLoc)", () => {
  assert.equal(locKey("{helpers:Loc AppName}"), "AppName");
  assert.equal(locKey("{Loc Key=Scan}"), "Scan");
  assert.equal(locKey("{helpers:PreviewLoc Foo}"), "Foo");
  assert.equal(locKey("{Binding Title}"), null);
  assert.equal(locKey("zwykły tekst"), null);
});

test("fallbackValue: wyciąga FallbackValue z bindingu", () => {
  assert.equal(fallbackValue("{Binding X, FallbackValue=Brak}"), "Brak");
  assert.equal(fallbackValue("{Binding X}"), null);
  assert.equal(fallbackValue("#FF0000"), null);
});

test("resxLanguagesFromNames: neutralny + warianty kulturowe (posortowane)", () => {
  const langs = resxLanguagesFromNames([
    "Resources.resx",
    "Resources.pl.resx",
    "Resources.zh-Hans.resx",
    "Resources.de.resx",
    "Strings.resx", // inny plik — pominięty
    "Resources.Designer.cs", // nie .resx — pominięty
  ]);
  assert.deepEqual(langs, [
    { value: "", label: "(neutral)" },
    { value: "de", label: "de" },
    { value: "pl", label: "pl" },
    { value: "zh-Hans", label: "zh-Hans" },
  ]);
  assert.deepEqual(resxLanguagesFromNames([]), []);
});

test("mergeModels: późniejsze źródła nadpisują pędzle (priorytet)", () => {
  const a = extractResources(
    `<ResourceDictionary xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"><SolidColorBrush x:Key="K" Color="#111" /></ResourceDictionary>`
  );
  const b = extractResources(
    `<ResourceDictionary xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"><SolidColorBrush x:Key="K" Color="#222" /></ResourceDictionary>`
  );
  assert.equal(mergeModels(a, b).brushes.K, "#222");
});
