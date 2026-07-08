// Kuratorowane metadane typów XAML/WPF dla panelu właściwości (Etap 2).
//
// To wyselekcjonowany podzbiór; docelowo generowany skryptem z reflection .NET
// (tools/gen-type-metadata → JSON). Tu wystarcza, by panel pokazał typowane edytory
// i listę „dodaj właściwość" dla najczęstszych kontrolek.

export type EditorKind = "bool" | "enum" | "number" | "brush" | "thickness" | "string" | "image";

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
  StretchDirection: ["UpOnly", "DownOnly", "Both"],
  "DockPanel.Dock": ["Left", "Top", "Right", "Bottom"],
  Dock: ["Left", "Top", "Right", "Bottom"],
  ScrollBarVisibility: ["Disabled", "Auto", "Hidden", "Visible"],
  HorizontalScrollBarVisibility: ["Disabled", "Auto", "Hidden", "Visible"],
  VerticalScrollBarVisibility: ["Disabled", "Auto", "Hidden", "Visible"],
  FlowDirection: ["LeftToRight", "RightToLeft"],
  SelectionMode: ["Single", "Multiple", "Extended"],
  ClickMode: ["Release", "Press", "Hover"],
  ExpandDirection: ["Down", "Up", "Left", "Right"],
  TabStripPlacement: ["Top", "Bottom", "Left", "Right"],
  CalendarMode: ["Month", "Year", "Decade"],
  GridResizeDirection: ["Auto", "Columns", "Rows"],
  GridResizeBehavior: ["BasedOnAlignment", "CurrentAndNext", "PreviousAndCurrent", "PreviousAndNext"],
  LineStackingStrategy: ["MaxHeight", "BlockLineHeight"],
  TextTrimming: ["None", "CharacterEllipsis", "WordEllipsis"],
  ResizeMode: ["NoResize", "CanMinimize", "CanResize", "CanResizeWithGrip"],
  WindowStartupLocation: ["Manual", "CenterScreen", "CenterOwner"],
  WindowState: ["Normal", "Minimized", "Maximized"],
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
  "LastChildFill",
  "ShowsPreview",
  "ShowGridLines",
  "AcceptsReturn",
  "AcceptsTab",
  "IsEditable",
  "IsExpanded",
  "IsCheckable",
  "IsTodayHighlighted",
  "Topmost",
  "ShowInTaskbar",
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
  "SmallChange",
  "LargeChange",
  "TickFrequency",
  "CornerRadius",
  "LineHeight",
  "ZIndex",
  "Panel.ZIndex",
  "RowSpan",
  "ColumnSpan",
  "SelectedIndex",
  "MaxLength",
  "MaxLines",
  "MinLines",
  "TabIndex",
  "Rows",
  "Columns",
  "RadiusX",
  "RadiusY",
  "X1",
  "Y1",
  "X2",
  "Y2",
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
  { name: "Name", kind: "string" },
  { name: "ToolTip", kind: "string" },
  { name: "Width", kind: "number" },
  { name: "Height", kind: "number" },
  { name: "MinWidth", kind: "number" },
  { name: "MinHeight", kind: "number" },
  { name: "MaxWidth", kind: "number" },
  { name: "MaxHeight", kind: "number" },
  { name: "Margin", kind: "thickness" },
  { name: "Padding", kind: "thickness" },
  { name: "HorizontalAlignment", kind: "enum", values: ENUMS.HorizontalAlignment },
  { name: "VerticalAlignment", kind: "enum", values: ENUMS.VerticalAlignment },
  { name: "HorizontalContentAlignment", kind: "enum", values: ENUMS.HorizontalContentAlignment },
  { name: "VerticalContentAlignment", kind: "enum", values: ENUMS.VerticalContentAlignment },
  { name: "Background", kind: "brush" },
  { name: "Foreground", kind: "brush" },
  { name: "BorderBrush", kind: "brush" },
  { name: "BorderThickness", kind: "thickness" },
  { name: "FontFamily", kind: "string" },
  { name: "FontSize", kind: "number" },
  { name: "FontWeight", kind: "enum", values: ENUMS.FontWeight },
  { name: "FontStyle", kind: "enum", values: ENUMS.FontStyle },
  { name: "Opacity", kind: "number" },
  { name: "Visibility", kind: "enum", values: ENUMS.Visibility },
  { name: "IsEnabled", kind: "bool" },
  { name: "Cursor", kind: "string" },
  { name: "TabIndex", kind: "number" },
  { name: "Tag", kind: "string" },
  { name: "Focusable", kind: "bool" },
  { name: "ClipToBounds", kind: "bool" },
  { name: "SnapsToDevicePixels", kind: "bool" },
  { name: "RenderTransformOrigin", kind: "string" },
  { name: "FlowDirection", kind: "enum", values: ENUMS.FlowDirection },
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
  { name: "Panel.ZIndex", kind: "number" },
];

const PER_TYPE: Record<string, PropMeta[]> = {
  TextBlock: [
    { name: "Text", kind: "string" },
    { name: "TextAlignment", kind: "enum", values: ENUMS.TextAlignment },
    { name: "TextWrapping", kind: "enum", values: ENUMS.TextWrapping },
    { name: "TextTrimming", kind: "enum", values: ENUMS.TextTrimming },
    { name: "LineHeight", kind: "number" },
    { name: "Padding", kind: "thickness" },
  ],
  Label: [{ name: "Content", kind: "string" }],
  Button: [
    { name: "Content", kind: "string" },
    { name: "IsDefault", kind: "bool" },
    { name: "IsCancel", kind: "bool" },
    { name: "ClickMode", kind: "enum", values: ENUMS.ClickMode },
  ],
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
    { name: "TextAlignment", kind: "enum", values: ENUMS.TextAlignment },
    { name: "MaxLength", kind: "number" },
    { name: "AcceptsReturn", kind: "bool" },
    { name: "AcceptsTab", kind: "bool" },
  ],
  PasswordBox: [
    { name: "MaxLength", kind: "number" },
    { name: "PasswordChar", kind: "string" },
  ],
  Slider: [
    { name: "Value", kind: "number" },
    { name: "Minimum", kind: "number" },
    { name: "Maximum", kind: "number" },
    { name: "Orientation", kind: "enum", values: ENUMS.Orientation },
    { name: "SmallChange", kind: "number" },
    { name: "LargeChange", kind: "number" },
    { name: "TickFrequency", kind: "number" },
  ],
  ToggleButton: [
    { name: "Content", kind: "string" },
    { name: "IsChecked", kind: "bool" },
    { name: "IsThreeState", kind: "bool" },
    { name: "ClickMode", kind: "enum", values: ENUMS.ClickMode },
  ],
  RepeatButton: [
    { name: "Content", kind: "string" },
    { name: "ClickMode", kind: "enum", values: ENUMS.ClickMode },
  ],
  ProgressBar: [
    { name: "Value", kind: "number" },
    { name: "Minimum", kind: "number" },
    { name: "Maximum", kind: "number" },
  ],
  StackPanel: [{ name: "Orientation", kind: "enum", values: ENUMS.Orientation }],
  WrapPanel: [
    { name: "Orientation", kind: "enum", values: ENUMS.Orientation },
    { name: "ItemWidth", kind: "number" },
    { name: "ItemHeight", kind: "number" },
  ],
  DockPanel: [{ name: "LastChildFill", kind: "bool" }],
  UniformGrid: [
    { name: "Rows", kind: "number" },
    { name: "Columns", kind: "number" },
  ],
  Border: [
    { name: "BorderBrush", kind: "brush" },
    { name: "BorderThickness", kind: "thickness" },
    { name: "CornerRadius", kind: "number" },
  ],
  Viewbox: [
    { name: "Stretch", kind: "enum", values: ENUMS.Stretch },
    { name: "StretchDirection", kind: "enum", values: ENUMS.StretchDirection },
  ],
  ScrollViewer: [
    { name: "HorizontalScrollBarVisibility", kind: "enum", values: ENUMS.HorizontalScrollBarVisibility },
    { name: "VerticalScrollBarVisibility", kind: "enum", values: ENUMS.VerticalScrollBarVisibility },
  ],
  GroupBox: [{ name: "Header", kind: "string" }],
  Expander: [
    { name: "Header", kind: "string" },
    { name: "IsExpanded", kind: "bool" },
    { name: "ExpandDirection", kind: "enum", values: ENUMS.ExpandDirection },
  ],
  ComboBox: [
    { name: "SelectedIndex", kind: "number" },
    { name: "IsEditable", kind: "bool" },
    { name: "Text", kind: "string" },
  ],
  ListBox: [
    { name: "SelectedIndex", kind: "number" },
    { name: "SelectionMode", kind: "enum", values: ENUMS.SelectionMode },
  ],
  ListView: [
    { name: "SelectedIndex", kind: "number" },
    { name: "SelectionMode", kind: "enum", values: ENUMS.SelectionMode },
  ],
  TreeView: [],
  TabControl: [
    { name: "SelectedIndex", kind: "number" },
    { name: "TabStripPlacement", kind: "enum", values: ENUMS.TabStripPlacement },
  ],
  TabItem: [{ name: "Header", kind: "string" }],
  MenuItem: [
    { name: "Header", kind: "string" },
    { name: "IsCheckable", kind: "bool" },
    { name: "IsChecked", kind: "bool" },
    { name: "InputGestureText", kind: "string" },
  ],
  DatePicker: [
    { name: "SelectedDate", kind: "string" },
    { name: "DisplayDate", kind: "string" },
  ],
  Calendar: [
    { name: "SelectedDate", kind: "string" },
    { name: "DisplayMode", kind: "enum", values: ENUMS.CalendarMode },
  ],
  GridSplitter: [
    { name: "ResizeDirection", kind: "enum", values: ENUMS.GridResizeDirection },
    { name: "ResizeBehavior", kind: "enum", values: ENUMS.GridResizeBehavior },
    { name: "ShowsPreview", kind: "bool" },
  ],
  Line: [
    { name: "X1", kind: "number" },
    { name: "Y1", kind: "number" },
    { name: "X2", kind: "number" },
    { name: "Y2", kind: "number" },
    { name: "Stroke", kind: "brush" },
    { name: "StrokeThickness", kind: "number" },
  ],
  Polygon: [
    { name: "Points", kind: "string" },
    { name: "Fill", kind: "brush" },
    { name: "Stroke", kind: "brush" },
    { name: "StrokeThickness", kind: "number" },
  ],
  Polyline: [
    { name: "Points", kind: "string" },
    { name: "Fill", kind: "brush" },
    { name: "Stroke", kind: "brush" },
    { name: "StrokeThickness", kind: "number" },
  ],
  Image: [
    { name: "Source", kind: "image" },
    { name: "Stretch", kind: "enum", values: ENUMS.Stretch },
  ],
  MediaElement: [
    { name: "Source", kind: "image" },
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
    { name: "Icon", kind: "image" },
    { name: "WindowStartupLocation", kind: "enum", values: ENUMS.WindowStartupLocation },
    { name: "WindowState", kind: "enum", values: ENUMS.WindowState },
    { name: "ResizeMode", kind: "enum", values: ENUMS.ResizeMode },
    { name: "Topmost", kind: "bool" },
    { name: "ShowInTaskbar", kind: "bool" },
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

/** Grupa typów w pasku „dodaj element". `label` to klucz lokalizacji (T() w webview). */
export interface AddableGroup {
  label: string;
  types: string[];
}

/** Typy oferowane w pasku „dodaj element", pogrupowane kategoriami. */
export const ADDABLE_GROUPS: AddableGroup[] = [
  {
    label: "Add.Group.Containers",
    types: [
      "Grid",
      "StackPanel",
      "DockPanel",
      "WrapPanel",
      "UniformGrid",
      "Canvas",
      "Border",
      "Viewbox",
      "ScrollViewer",
      "GroupBox",
      "Expander",
    ],
  },
  {
    label: "Add.Group.Controls",
    types: [
      "Button",
      "ToggleButton",
      "RepeatButton",
      "TextBlock",
      "Label",
      "TextBox",
      "PasswordBox",
      "CheckBox",
      "RadioButton",
      "Slider",
      "ProgressBar",
      "Image",
      "DatePicker",
      "Calendar",
      "Separator",
      "GridSplitter",
    ],
  },
  {
    label: "Add.Group.Lists",
    types: ["ComboBox", "ListBox", "ListView", "TreeView", "TabControl", "Menu", "ToolBar", "StatusBar"],
  },
  {
    label: "Add.Group.Shapes",
    types: ["Ellipse", "Rectangle", "Line", "Polygon", "Polyline"],
  },
];

/** Płaska lista typów (spłaszczenie ADDABLE_GROUPS; zgodność wsteczna). */
export const ADDABLE_TYPES = ADDABLE_GROUPS.flatMap((g) => g.types);

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
    case "DockPanel":
      return `<DockPanel Width="200" Height="160" LastChildFill="True" ${POS} />`;
    case "WrapPanel":
      return `<WrapPanel Width="200" Height="120" ${POS} />`;
    case "UniformGrid":
      return `<UniformGrid Rows="2" Columns="2" Width="200" Height="160" ${POS} />`;
    case "Viewbox":
      return `<Viewbox Width="160" Height="120" Stretch="Uniform" ${POS} />`;
    case "ScrollViewer":
      return `<ScrollViewer Width="200" Height="160" VerticalScrollBarVisibility="Auto" ${POS} />`;
    case "GroupBox":
      return `<GroupBox Header="GroupBox" Width="200" Height="140" ${POS} />`;
    case "Expander":
      return `<Expander Header="Expander" IsExpanded="True" Width="200" Height="120" ${POS} />`;
    case "ToggleButton":
      return `<ToggleButton Content="ToggleButton" Width="120" Height="32" ${POS} />`;
    case "RepeatButton":
      return `<RepeatButton Content="RepeatButton" Width="120" Height="32" ${POS} />`;
    case "PasswordBox":
      return `<PasswordBox Width="160" Height="28" ${POS} />`;
    case "DatePicker":
      return `<DatePicker Width="160" ${POS} />`;
    case "Calendar":
      return `<Calendar ${POS} />`;
    case "Separator":
      return `<Separator Width="160" Height="2" ${POS} />`;
    case "GridSplitter":
      return `<GridSplitter Width="6" Height="120" ShowsPreview="True" ${POS} />`;
    case "ComboBox":
      return (
        `<ComboBox Width="160" Height="28" SelectedIndex="0" ${POS}>\n` +
        `  <ComboBoxItem Content="Item 1" />\n` +
        `  <ComboBoxItem Content="Item 2" />\n` +
        `  <ComboBoxItem Content="Item 3" />\n` +
        `</ComboBox>`
      );
    case "ListBox":
      return (
        `<ListBox Width="160" Height="120" ${POS}>\n` +
        `  <ListBoxItem Content="Item 1" />\n` +
        `  <ListBoxItem Content="Item 2" />\n` +
        `  <ListBoxItem Content="Item 3" />\n` +
        `</ListBox>`
      );
    case "ListView":
      return (
        `<ListView Width="200" Height="120" ${POS}>\n` +
        `  <ListViewItem Content="Item 1" />\n` +
        `  <ListViewItem Content="Item 2" />\n` +
        `  <ListViewItem Content="Item 3" />\n` +
        `</ListView>`
      );
    case "TreeView":
      return (
        `<TreeView Width="180" Height="140" ${POS}>\n` +
        `  <TreeViewItem Header="Node 1">\n` +
        `    <TreeViewItem Header="Child 1.1" />\n` +
        `    <TreeViewItem Header="Child 1.2" />\n` +
        `  </TreeViewItem>\n` +
        `  <TreeViewItem Header="Node 2" />\n` +
        `</TreeView>`
      );
    case "TabControl":
      return (
        `<TabControl Width="240" Height="160" SelectedIndex="0" ${POS}>\n` +
        `  <TabItem Header="Tab 1" />\n` +
        `  <TabItem Header="Tab 2" />\n` +
        `</TabControl>`
      );
    case "Menu":
      return (
        `<Menu ${POS}>\n` +
        `  <MenuItem Header="_File">\n` +
        `    <MenuItem Header="_New" />\n` +
        `    <MenuItem Header="_Open" />\n` +
        `    <Separator />\n` +
        `    <MenuItem Header="E_xit" />\n` +
        `  </MenuItem>\n` +
        `  <MenuItem Header="_Edit" />\n` +
        `</Menu>`
      );
    case "ToolBar":
      return (
        `<ToolBar Width="240" Height="32" ${POS}>\n` +
        `  <Button Content="New" />\n` +
        `  <Button Content="Open" />\n` +
        `  <Separator />\n` +
        `  <Button Content="Save" />\n` +
        `</ToolBar>`
      );
    case "StatusBar":
      return (
        `<StatusBar Width="240" Height="24" ${POS}>\n` +
        `  <StatusBarItem Content="Ready" />\n` +
        `</StatusBar>`
      );
    case "Line":
      return `<Line X1="0" Y1="0" X2="120" Y2="0" Stroke="Black" StrokeThickness="2" ${POS} />`;
    case "Polygon":
      return `<Polygon Points="0,0 60,0 30,60" Fill="LightGray" Stroke="Gray" StrokeThickness="1" ${POS} />`;
    case "Polyline":
      return `<Polyline Points="0,0 30,40 60,10 90,50" Stroke="Gray" StrokeThickness="2" ${POS} />`;
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
    "UniformGrid",
    "Viewbox",
    "ScrollViewer",
    "GroupBox",
    "Expander",
    "Window",
    "UserControl",
    "Page",
  ].includes(n);
}

// Kontrolki, których DZIECI muszą być konkretnym typem pozycji (TabItem, MenuItem, ComboBoxItem…).
// Nie wolno do nich wklejać dowolnego elementu jako bezpośredniego dziecka — wklejać należy do
// pozycji (np. TabItem), nie do hosta (TabControl). MenuItem/TreeViewItem same hostują pozycje.
const ITEMS_HOSTS = new Set<string>([
  "TabControl",
  "Menu",
  "ContextMenu",
  "MenuItem",
  "ComboBox",
  "ListBox",
  "ListView",
  "TreeView",
  "TreeViewItem",
  "ToolBar",
  "ToolBarTray",
  "StatusBar",
  "ItemsControl",
  "DataGrid",
]);

/** Czy typ jest „items-hostem" — jego bezpośrednie dzieci to wyłącznie konkretne pozycje. */
export function isItemsHost(tag: string): boolean {
  return ITEMS_HOSTS.has(localName(tag));
}

// Zbiór najczęstszych typów WPF — używany m.in. do rozpoznania literówki w niezgodności
// znaczników (z dwóch nazw ta nieznana jest błędem). Nie musi być kompletny: gdy żadna ze
// stron nie jest znana, wołający degraduje się łagodnie (podkreśla oba znaczniki).
const KNOWN_TYPES = new Set<string>([
  // panele / kontenery
  "Grid", "StackPanel", "Canvas", "DockPanel", "WrapPanel", "UniformGrid", "Border", "Viewbox",
  "ScrollViewer", "GroupBox", "Expander", "TabControl", "TabItem", "Decorator", "AdornerDecorator",
  // kontrolki
  "Button", "RepeatButton", "ToggleButton", "CheckBox", "RadioButton", "TextBox", "RichTextBox",
  "PasswordBox", "Label", "TextBlock", "ComboBox", "ComboBoxItem", "ListBox", "ListBoxItem",
  "ListView", "ListViewItem", "GridView", "GridViewColumn", "TreeView", "TreeViewItem", "DataGrid",
  "Slider", "ProgressBar", "ScrollBar", "Menu", "MenuItem", "ContextMenu", "ToolBar", "ToolBarTray",
  "StatusBar", "StatusBarItem", "Separator", "Image", "MediaElement", "Calendar", "DatePicker",
  "Popup", "ToolTip", "Frame", "Thumb", "GridSplitter", "ContentControl", "ContentPresenter",
  "ItemsControl", "ItemsPresenter", "UserControl", "Window", "Page", "NavigationWindow", "Viewport3D",
  // kształty
  "Ellipse", "Rectangle", "Line", "Polygon", "Polyline", "Path",
  // dokumenty / tekst inline
  "Run", "Span", "Bold", "Italic", "Underline", "Paragraph", "LineBreak", "Hyperlink",
  "FlowDocument", "List", "ListItem", "Table",
  // definicje układu
  "RowDefinition", "ColumnDefinition",
]);

/** Czy `tag` to rozpoznawalny typ WPF (po nazwie lokalnej, bez prefiksu namespace). */
export function isKnownType(tag: string): boolean {
  return KNOWN_TYPES.has(localName(tag));
}

/** Odległość edycyjna Levenshteina — do podpowiedzi „czy chodziło o…" (auto-fix literówek). */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[n];
}

/** Najbliższy kandydat (literówka) albo null, gdy żaden nie jest wystarczająco blisko. */
function nearest(target: string, candidates: Iterable<string>): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const c of candidates) {
    if (c === target) return c; // dokładne trafienie — brak literówki do poprawienia
    const d = levenshtein(target.toLowerCase(), c.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  const limit = Math.max(1, Math.min(2, Math.floor(target.length / 2)));
  return best && bestD <= limit ? best : null;
}

/** Najbliższy znany typ WPF dla (prawdopodobnie błędnej) nazwy; null gdy brak bliskiego. */
export function closestKnownType(name: string): string | null {
  return nearest(localName(name), KNOWN_TYPES);
}

/** Najbliższa znana właściwość typu `tag` dla (prawdopodobnie błędnej) nazwy atrybutu. */
export function closestKnownProperty(tag: string, name: string): string | null {
  return nearest(name, knownProperties(tag).map((p) => p.name));
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
