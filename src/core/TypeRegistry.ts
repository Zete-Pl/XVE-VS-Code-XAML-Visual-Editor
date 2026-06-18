// Kuratorowane metadane typów XAML/WPF dla panelu właściwości (Etap 2).
//
// To wyselekcjonowany podzbiór; docelowo generowany skryptem z reflection .NET
// (tools/gen-type-metadata → JSON). Tu wystarcza, by panel pokazał typowane edytory
// i listę „dodaj właściwość" dla najczęstszych kontrolek.

export type EditorKind = "bool" | "enum" | "number" | "brush" | "thickness" | "string";

export interface PropMeta {
  name: string;
  kind: EditorKind;
  /** dozwolone wartości dla kind === "enum" */
  values?: string[];
}

const ENUMS: Record<string, string[]> = {
  HorizontalAlignment: ["Left", "Center", "Right", "Stretch"],
  VerticalAlignment: ["Top", "Center", "Bottom", "Stretch"],
  HorizontalContentAlignment: ["Left", "Center", "Right", "Stretch"],
  VerticalContentAlignment: ["Top", "Center", "Bottom", "Stretch"],
  Visibility: ["Visible", "Hidden", "Collapsed"],
  FontWeight: ["Thin", "Light", "Normal", "Medium", "SemiBold", "Bold", "Black"],
  FontStyle: ["Normal", "Italic", "Oblique"],
  TextAlignment: ["Left", "Center", "Right", "Justify"],
  TextWrapping: ["NoWrap", "Wrap", "WrapWithOverflow"],
  Orientation: ["Horizontal", "Vertical"],
  Stretch: ["None", "Fill", "Uniform", "UniformToFill"],
  "DockPanel.Dock": ["Left", "Top", "Right", "Bottom"],
  ScrollBarVisibility: ["Disabled", "Auto", "Hidden", "Visible"],
};

const BRUSH_PROPS = new Set([
  "Background",
  "Foreground",
  "BorderBrush",
  "Fill",
  "Stroke",
  "OpacityMask",
]);
const THICKNESS_PROPS = new Set(["Margin", "Padding", "BorderThickness"]);
const BOOL_PROPS = new Set([
  "IsChecked",
  "IsEnabled",
  "IsReadOnly",
  "IsTabStop",
  "Focusable",
  "ClipToBounds",
  "IsHitTestVisible",
  "AllowDrop",
  "IsThreeState",
  "SnapsToDevicePixels",
]);
const NUMBER_PROPS = new Set([
  "Width",
  "Height",
  "MinWidth",
  "MinHeight",
  "MaxWidth",
  "MaxHeight",
  "Opacity",
  "FontSize",
  "StrokeThickness",
  "Value",
  "Minimum",
  "Maximum",
  "CornerRadius",
  "RowSpan",
  "ColumnSpan",
  "Canvas.Left",
  "Canvas.Top",
  "Canvas.Right",
  "Canvas.Bottom",
  "Grid.Row",
  "Grid.Column",
  "Grid.RowSpan",
  "Grid.ColumnSpan",
]);

/** Wspólne właściwości FrameworkElement/Control widoczne w „dodaj właściwość". */
const COMMON: PropMeta[] = [
  { name: "Width", kind: "number" },
  { name: "Height", kind: "number" },
  { name: "Margin", kind: "thickness" },
  { name: "Padding", kind: "thickness" },
  { name: "HorizontalAlignment", kind: "enum", values: ENUMS.HorizontalAlignment },
  { name: "VerticalAlignment", kind: "enum", values: ENUMS.VerticalAlignment },
  { name: "Visibility", kind: "enum", values: ENUMS.Visibility },
  { name: "Opacity", kind: "number" },
  { name: "Background", kind: "brush" },
  { name: "Foreground", kind: "brush" },
  { name: "FontSize", kind: "number" },
  { name: "FontWeight", kind: "enum", values: ENUMS.FontWeight },
  { name: "FontStyle", kind: "enum", values: ENUMS.FontStyle },
  { name: "IsEnabled", kind: "bool" },
  { name: "ToolTip", kind: "string" },
];

const ATTACHED: PropMeta[] = [
  { name: "Grid.Row", kind: "number" },
  { name: "Grid.Column", kind: "number" },
  { name: "Grid.RowSpan", kind: "number" },
  { name: "Grid.ColumnSpan", kind: "number" },
  { name: "Canvas.Left", kind: "number" },
  { name: "Canvas.Top", kind: "number" },
  { name: "Canvas.Right", kind: "number" },
  { name: "Canvas.Bottom", kind: "number" },
  { name: "DockPanel.Dock", kind: "enum", values: ENUMS["DockPanel.Dock"] },
];

const PER_TYPE: Record<string, PropMeta[]> = {
  TextBlock: [
    { name: "Text", kind: "string" },
    { name: "TextAlignment", kind: "enum", values: ENUMS.TextAlignment },
    { name: "TextWrapping", kind: "enum", values: ENUMS.TextWrapping },
  ],
  Label: [{ name: "Content", kind: "string" }],
  Button: [{ name: "Content", kind: "string" }],
  CheckBox: [
    { name: "Content", kind: "string" },
    { name: "IsChecked", kind: "bool" },
    { name: "IsThreeState", kind: "bool" },
  ],
  RadioButton: [
    { name: "Content", kind: "string" },
    { name: "IsChecked", kind: "bool" },
    { name: "GroupName", kind: "string" },
  ],
  TextBox: [
    { name: "Text", kind: "string" },
    { name: "IsReadOnly", kind: "bool" },
    { name: "TextWrapping", kind: "enum", values: ENUMS.TextWrapping },
  ],
  Slider: [
    { name: "Value", kind: "number" },
    { name: "Minimum", kind: "number" },
    { name: "Maximum", kind: "number" },
    { name: "Orientation", kind: "enum", values: ENUMS.Orientation },
  ],
  ProgressBar: [
    { name: "Value", kind: "number" },
    { name: "Minimum", kind: "number" },
    { name: "Maximum", kind: "number" },
  ],
  StackPanel: [{ name: "Orientation", kind: "enum", values: ENUMS.Orientation }],
  Border: [
    { name: "BorderBrush", kind: "brush" },
    { name: "BorderThickness", kind: "thickness" },
    { name: "CornerRadius", kind: "number" },
  ],
  Image: [
    { name: "Source", kind: "string" },
    { name: "Stretch", kind: "enum", values: ENUMS.Stretch },
  ],
  Ellipse: [
    { name: "Fill", kind: "brush" },
    { name: "Stroke", kind: "brush" },
    { name: "StrokeThickness", kind: "number" },
  ],
  Rectangle: [
    { name: "Fill", kind: "brush" },
    { name: "Stroke", kind: "brush" },
    { name: "StrokeThickness", kind: "number" },
    { name: "RadiusX", kind: "number" },
    { name: "RadiusY", kind: "number" },
  ],
  Window: [
    { name: "Title", kind: "string" },
    { name: "Width", kind: "number" },
    { name: "Height", kind: "number" },
  ],
};

function localName(tag: string): string {
  const i = tag.indexOf(":");
  return i >= 0 ? tag.slice(i + 1) : tag;
}

/** Wnioskuje rodzaj edytora dla dowolnej nazwy atrybutu (także spoza rejestru). */
export function inferKind(name: string): EditorKind {
  if (ENUMS[name]) return "enum";
  if (BRUSH_PROPS.has(name)) return "brush";
  if (THICKNESS_PROPS.has(name)) return "thickness";
  if (BOOL_PROPS.has(name) || /^Is[A-Z]/.test(name) || /^Has[A-Z]/.test(name)) return "bool";
  if (NUMBER_PROPS.has(name)) return "number";
  return "string";
}

export function enumValuesFor(name: string): string[] | undefined {
  return ENUMS[name];
}

/** Pełna lista znanych właściwości dla typu (do „dodaj właściwość"). */
export function knownProperties(tag: string): PropMeta[] {
  const name = localName(tag);
  const merged = new Map<string, PropMeta>();
  for (const p of [...COMMON, ...(PER_TYPE[name] ?? []), ...ATTACHED]) merged.set(p.name, p);
  return [...merged.values()];
}

/** Metadane dla konkretnego atrybutu — z rejestru typu lub z heurystyki. */
export function metaFor(tag: string, attrName: string): PropMeta {
  const known = knownProperties(tag).find((p) => p.name === attrName);
  if (known) return known;
  const kind = inferKind(attrName);
  return kind === "enum" ? { name: attrName, kind, values: enumValuesFor(attrName) } : { name: attrName, kind };
}

/** Typy oferowane w pasku „dodaj element". */
export const ADDABLE_TYPES = [
  "Grid",
  "StackPanel",
  "Canvas",
  "Border",
  "TextBlock",
  "Label",
  "Button",
  "TextBox",
  "CheckBox",
  "RadioButton",
  "Slider",
  "ProgressBar",
  "Image",
  "Ellipse",
  "Rectangle",
];

const POS = `Margin="10,10,0,0" HorizontalAlignment="Left" VerticalAlignment="Top"`;

/** Domyślny snippet XAML dla nowo wstawianego elementu. */
export function defaultSnippet(type: string): string {
  switch (type) {
    case "Button":
      return `<Button Content="Button" Width="100" Height="32" ${POS} />`;
    case "TextBlock":
      return `<TextBlock Text="TextBlock" ${POS} />`;
    case "Label":
      return `<Label Content="Label" ${POS} />`;
    case "TextBox":
      return `<TextBox Text="" Width="160" Height="28" ${POS} />`;
    case "CheckBox":
      return `<CheckBox Content="CheckBox" IsChecked="False" ${POS} />`;
    case "RadioButton":
      return `<RadioButton Content="RadioButton" IsChecked="False" ${POS} />`;
    case "Slider":
      return `<Slider Width="180" Minimum="0" Maximum="100" Value="50" ${POS} />`;
    case "ProgressBar":
      return `<ProgressBar Width="180" Height="16" Minimum="0" Maximum="100" Value="50" ${POS} />`;
    case "Image":
      return `<Image Width="120" Height="120" Stretch="Uniform" ${POS} />`;
    case "Ellipse":
      return `<Ellipse Fill="LightGray" Stroke="Gray" StrokeThickness="1" Width="80" Height="80" ${POS} />`;
    case "Rectangle":
      return `<Rectangle Fill="LightGray" Stroke="Gray" StrokeThickness="1" Width="120" Height="80" ${POS} />`;
    case "Border":
      return `<Border BorderBrush="Gray" BorderThickness="1" CornerRadius="4" Width="160" Height="120" ${POS} />`;
    case "Canvas":
      return `<Canvas Width="200" Height="160" Background="#11000000" ${POS} />`;
    case "StackPanel":
      return `<StackPanel Width="160" ${POS} />`;
    case "Grid":
      return `<Grid Width="200" Height="160" ${POS} />`;
    default:
      return `<${type} Width="100" Height="60" ${POS} />`;
  }
}

/** Czy typ może zawierać dzieci (kontener). */
export function isContainer(tag: string): boolean {
  const n = localName(tag);
  return [
    "Grid",
    "StackPanel",
    "Canvas",
    "Border",
    "DockPanel",
    "WrapPanel",
    "Viewbox",
    "ScrollViewer",
    "Window",
    "UserControl",
    "Page",
  ].includes(n);
}

/** Domyślna wartość dla nowo dodawanej właściwości. */
export function defaultValue(meta: PropMeta): string {
  switch (meta.kind) {
    case "bool":
      return "True";
    case "enum":
      return meta.values?.[0] ?? "";
    case "number":
      return "0";
    case "brush":
      return "Black";
    case "thickness":
      return "0";
    default:
      return "";
  }
}
