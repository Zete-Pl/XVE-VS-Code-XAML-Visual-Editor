# XAML Visual Editor (XVE) — Documentation

**🇬🇧 English** · [🇵🇱 Polski](../pl/DOKUMENTACJA.md)

> Other languages (Español, Deutsch, Français, 日本語, 中文) are planned and will be added as
> translations of this document.

XVE is a Visual Studio Code extension that turns hand-written **XAML** files into a live,
editable visual surface — a structure tree, a rendered preview, and a typed properties
panel — while keeping the text file as the single source of truth. Its defining feature is
**surgical save**: an edit changes only what it must, and the rest of the file stays
byte-for-byte identical (formatting, comments and indentation are preserved).

![Editor layout](../images/layout-overview.png)

---

## Table of contents

1. [Introduction](#1-introduction)
2. [Installation & running](#2-installation--running)
3. [First steps](#3-first-steps)
4. [The interface](#4-the-interface)
5. [Features](#5-features)
6. [Preview backends](#6-preview-backends)
7. [Project resources (WPF host)](#7-project-resources-wpf-host)
8. [Error handling](#8-error-handling)
9. [Settings reference](#9-settings-reference)
10. [Keyboard shortcuts](#10-keyboard-shortcuts)
11. [Architecture](#11-architecture)
12. [Sample files](#12-sample-files)
13. [Troubleshooting / FAQ](#13-troubleshooting--faq)
14. [Development history](#14-development-history)

---

## 1. Introduction

XVE is built for developers who write WPF/XAML by hand but still want a designer-like
preview and quick visual tweaks — without a tool rewriting (and reformatting) their markup.

Key ideas:

- **Custom editor for `*.xaml`** — registered as an *option*, so you can switch between the
  visual editor and the plain text editor at any time.
- **Surgical save** — every change is applied as the smallest possible edit to the original
  text. Native VS Code **undo/redo** works because all edits go through the `TextDocument`.
- **Two preview engines** — a cross-platform **web renderer** and a Windows-only,
  high-fidelity **WPF host** that renders with the real WPF engine.
- **Localized UI** — 7 languages (English, Polski, Español, Deutsch, Français, 日本語, 中文).

---

## 2. Installation & running

### Requirements

| Component | Requirement |
|-----------|-------------|
| VS Code | `^1.90.0` |
| WPF host — *using* it (optional) | Windows x64 or ARM64 + **[.NET 10 Desktop Runtime](https://dotnet.microsoft.com/download/dotnet/10.0)** |
| WPF host — *building* it (dev only) | Windows + **.NET 10 SDK** |
| Node.js (dev only) | ≥ 20 (unit tests use type-stripping from Node ≥ 22/24) |

Nothing has to be compiled after installing from the Marketplace: the extension ships a prebuilt
`xve-wpf-host.exe` for **both x64 and ARM64**, and picks the one matching your VS Code at runtime.

What you do need is the **Desktop** runtime (`Microsoft.WindowsDesktop.App`) — a separate download
from the plain .NET runtime — **in the same architecture as VS Code**. An ARM64 VS Code needs the
ARM64 Desktop runtime. If it is missing, XVE shows a notification with a download link and falls
back to the web renderer.

The extension runs everywhere VS Code does. The **WPF host is optional** and Windows-only; on
other platforms (or when the host is unavailable) the web renderer is used.

### Run from source (dev)

```bash
npm install
npm run compile        # bundles the extension + webview into dist/
npm run test:unit      # core unit tests (Node test runner, type stripping)
npm run test:parity    # web renderer vs WPF host rendering parity (Playwright)
npm run docs:images    # regenerate the diagrams and toolbar icons in docs/images/
```

`test:parity` renders the fixtures in `samples/parity/` through both backends and compares the
resulting geometry; it needs the WPF host built (see below) and therefore runs on Windows only.

`docs:images` renders every `docs/images/*.svg` to PNG, exports the toolbar icons from
`@vscode/codicons`, and downscales the screenshots to a 1200 px width in place. It is idempotent —
an image already within the limit is left untouched — so you can drop in a full-resolution capture
and simply re-run it.

Then in VS Code press **`F5`** → *Run Extension*. In the new Extension Development Host window,
open any `.xaml` file (or run **“XVE: Open in XAML Visual Editor”** from the command palette).

### Build the WPF host (Windows only)

```bash
npm run build:host     # dotnet build wpf-host -c Release  (requires .NET 10 SDK)
```

This produces `xve-wpf-host.exe`, which the extension spawns on demand for high-fidelity preview.

---

## 3. First steps

1. **Open a XAML file.** Because the visual editor is registered with `priority: "option"`,
   `.xaml` files open in the normal text editor by default.
2. **Switch to the visual editor.** Click **“XVE: Open in XAML Visual Editor”** in the editor
   title bar, or run the command `xve.openVisualEditor` from the command palette.
3. **Switch back to text.** With the visual editor active, click **“XVE: Open XAML as Text”**
   (`xve.openTextEditor`) in the title bar.

The two title-bar buttons are context-aware: the “Visual Editor” button appears only when a
`.xaml` file is open as text, and the “as Text” button only when the visual editor is active.

(The screenshot at the top of this document shows a `.xaml` file open in the visual editor with
all three panels visible.)

---

## 4. The interface

The visual editor is a three-panel layout (see the diagram at the top):

| Panel | What it shows |
|-------|---------------|
| **Structure tree** (left) | The XAML element hierarchy. Click to select, drag to reorder. Resizable. |
| **Preview** (center) | The rendered surface, with a toolbar, rulers/guides, zoom and selection overlay. |
| **Properties** (right) | Typed editors for the selected element’s attributes, plus *Add property*. Resizable. |

Both side panels can be collapsed and resized; panel widths and the toolbar position are
remembered per window.

### The preview toolbar

The toolbar floats over the preview. It can be docked (top/bottom/left/right) or left floating,
and remembers its place per window. Two of its buttons look different depending on state, so
here it is in both of its usual configurations.

**Design view** — the Design button is active and expands into a labelled pill. The zoom controls
are visible, and the host status dot is green (the WPF host is running and rendering fine):

![Preview toolbar in Design view](../images/toolbar-design.png)

**Changes view** — the Changes button is active and shows the number of pending changes. The
zoom controls disappear (they belong to the design surface, not the diff), the Pan tool is
selected, and the dot is grey because this window uses the web renderer:

![Preview toolbar in Changes view](../images/toolbar-changes.png)

These two differences are independent of each other: **the zoom panel is hidden purely because
the view mode is Changes**, and **the dot colour depends only on the preview backend and the
host's render status** — not on the view mode.

#### Every control, left to right

| Icon | Control | Type | What it does |
|:----:|---------|------|--------------|
| ![](../images/icons/gripper.png) | **Move toolbar** | drag handle | Drag the toolbar around; drop it near an edge to dock it. |
| ![](../images/icons/layout-sidebar-left.png) | **Show Structure** | button *(conditional)* | Re-opens the Structure pane. Only shown while that pane is collapsed. |
| ![](../images/icons/pan.png) | **Pan** | tool | Drag to scroll the preview. Also available at any time with the middle mouse button. |
| ![](../images/icons/move.png) | **Select / move** | tool | Select elements, drag to move them, resize with the 8 handles. |
| ![](../images/icons/list-tree.png) | **Reorder** | tool | Drag elements in the preview to change their sibling order, like in the tree. **This is the default tool.** |
| ![](../images/icons/eye.png) | **Auto-reveal** | toggle | Automatically opens the dropdown/menu of the selected element (ComboBox, Menu, …). **On by default.** |
| ![](../images/icons/discard.png) | **Undo** | button | Undo the last edit (the native VS Code undo stack). |
| ![](../images/icons/redo.png) | **Redo** | button | Redo. |
| ![](../images/icons/trash.png) | **Delete** | button | Delete the selected element (same as the <kbd>Del</kbd> key). |
| ![](../images/icons/edit.png) | **Design** | view toggle | The live design surface. Expands to a labelled pill when active. |
| ![](../images/icons/git-compare.png) | **Changes** | view toggle | The diff against the saved file. When active it reads *Changes (n)*; when inactive it shows just *n* as a badge, and nothing at all when there are no changes. |
| ![](../images/icons/symbol-numeric.png) | **Grid** | toggle | The dot-grid overlay. Turning it on also enables snap-to-grid — there is no separate magnet button. **Off by default.** |
| ![](../images/icons/symbol-ruler.png) | **Rulers** | toggle | Rulers, draggable guides and snap-to-guide. **On by default.** |
| ![](../images/icons/symbol-color.png) | **Preview theme** | menu | Any resource-dictionary themes found in the project, then the standard set: Classic, Classic '98, System, Light, Dark, Native. See [section 6](#6-preview-backends). |
| ![](../images/icons/server-process.png) | **Preview engine** | menu | `Auto`, `Web`, and — on Windows only — `WPF host` and `WPF host — isolated`. See [section 6](#6-preview-backends). |
| ![](../images/icons/play.png) | **Run window** | menu | Opens the XAML in a real Windows window: *Snapshot* (one-time) or *Live* (follows the project). WPF engine on Windows only. |
| ![](../images/icons/package.png) | **Project resources** | dialog | Pick which custom-control DLLs, `App.xaml` and resource dictionaries to load. See [section 7](#7-project-resources-wpf-host). |
| ![](../images/icons/dot-ok.png) | **Host status** | indicator + button | The WPF host's state (see the table below). Click it to open the console/log. |
| ![](../images/icons/layout-sidebar-right.png) | **Show Properties** | button *(conditional)* | Re-opens the Properties pane. Only shown while that pane is collapsed. |
| ![](../images/icons/triangle-right.png) | **Resize toolbar** | drag handle *(conditional)* | Drag to resize the toolbar. Only shown while the toolbar is floating (not docked). |

Pan, Select and Reorder are mutually exclusive — exactly one of them is always the active tool.

#### The host status dot

| Dot | Meaning |
|:---:|---------|
| ![](../images/icons/dot-ok.png) | The WPF host is running and the last render succeeded. |
| ![](../images/icons/dot-idle.png) | The WPF host is starting up. |
| ![](../images/icons/dot-error.png) | The WPF host reported a render error. The console opens automatically. |
| ![](../images/icons/dot-inactive.png) | No WPF host: either you are not on Windows, or the preview engine is set to `Web`. This is not an error. |

A **blue ring** around the dot means project resources are currently loaded. Clicking the dot
always opens the console/log, whatever its colour. If the host is isolated, its tooltip says so.

#### The zoom panel

![](../images/icons/zoom-out.png) ![](../images/icons/zoom-in.png)
![](../images/icons/screen-full.png)

Zoom is **not part of the toolbar** — it is a separate little panel in the bottom-right corner of
the preview: *zoom out*, the current percentage (click to reset to 100 %), *zoom in*, and *Fit*.
It is hidden in the Changes view. When the toolbar is docked to the bottom edge and there is room,
the zoom panel docks into the toolbar's right-hand end, which is why it looks like one bar in the
Design screenshot above.

---

## 5. Features

### 5.1 Structure tree & reorder

The tree mirrors the XAML hierarchy. Click a node to select it (the matching element is
highlighted in the preview). **Drag a node** to reorder it: drop zones indicate *before*,
*inside* or *after* a target, and dropping into your own subtree is blocked. The move is
committed as a surgical `moveElement`, preserving indentation.

### 5.2 Visual editing — move & resize

With the **Select** tool, click an element in the preview to select it. Then:

- **Move** by dragging. Depending on the parent layout, the move updates `Margin` (most
  panels) or `Canvas.Left/Top` (inside a `Canvas`).
- **Resize** using the **8 handles** (corners + edges); this updates `Width`/`Height` (and
  `Margin` where needed).
- A **live preview** follows your gesture; on release the change is committed as a single
  surgical write (`setAttributes`).

![An element selected with its 8 resize handles](../images/screen-drag-resize.png)

### 5.3 Add / delete / copy elements

- **Add** an element from the toolbar: pick from 15 common types (Grid, StackPanel, Canvas,
  Border, TextBlock, Label, Button, TextBox, CheckBox, RadioButton, Slider, ProgressBar,
  Image, Ellipse, Rectangle). A default snippet is inserted into the selected container.
- **Delete** the selected element with the **Delete** key.
- **Copy / cut / paste** a subtree with **Ctrl+C / Ctrl+X / Ctrl+V** (paste as sibling or child).
  The clipboard is the **system clipboard** — the element is copied as a XAML fragment, so it works
  **between XVE windows** and both ways with a **text editor**. Optional `x:Name` deduplication on paste
  (setting `xve.paste.nameDeduplication`, off by default) renames colliding names to unique ones without
  touching the original.

### 5.4 Properties panel

<img src="../images/screen-properties.png" align="right" width="280"
     alt="The properties panel with a brush color picker open and a changed attribute">

The panel shows **typed editors** based on each property’s kind:

| Kind | Editor |
|------|--------|
| `bool` | checkbox |
| `enum` | dropdown |
| `number` | numeric field |
| `brush` | color picker |
| `thickness` | four-field L,T,R,B input |
| `string` | text field |

It covers common properties (Name, Width/Height, Min/Max sizes, Margin, Padding, alignment,
Background/Foreground, BorderBrush/Thickness, fonts, Opacity, Visibility, IsEnabled…),
attached properties (`Grid.Row/Column`, `Canvas.Left/Top`, `DockPanel.Dock`), and
type-specific ones (Text, Content, IsChecked, Value/Minimum/Maximum, etc.).

Use **“+ Add property”** to add any known property, and the per-attribute controls to remove
one. Attributes **changed since the last save** are highlighted with a coloured bar and get a
per-attribute **revert** button — in the screenshot, `BorderBrush` has been edited with the brush
picker, while `VerticalAlignment` is untouched.

<br clear="right">

### 5.5 Changes view (diff)

Switch the toolbar from **Design** to **Changes** to see everything that differs from the
**saved file**: changed attributes, added elements, removed elements and moved elements
(detected with an LCS tree match, so a reorder is not reported as add+delete). Each entry has
a **revert per-hunk** button, and there is a **Revert all** action. Clicking an entry selects
the element in the preview. Reverts use the same surgical operations as editing.

![The Changes view with changed, added and removed entries](../images/screen-changes.png)

### 5.6 Zoom & navigation

Zoom ranges **10–800 %**. Use the zoom panel in the bottom-right corner of the preview,
**Ctrl+scroll** (anchored at the cursor), or **Fit** to fit the preview to the window. By default (`xve.preview.fitOnOpen`) a
document is fitted on open: shrunk if larger than the view, otherwise shown at 100 % (never
magnified). **Pan** with the Pan tool or the middle mouse button. Rulers, guides and snapping
all respect the current zoom.

### 5.7 Rulers, guides & grid snap

Toggle **rulers** (top/left) and a dot **grid** overlay from the toolbar. Add a **guide** by
clicking a ruler; drag it to move, double-click to remove. During move/resize, elements
**snap** to the grid and to guides. The grid step and snap threshold are set by
`xve.canvas.gridStep` (default 8 px).

### 5.8 Selection sync with the text editor

When a text editor is open side-by-side, selection is **two-way**:

- **Visual → text** (`xve.sync.selectInTextEditor`): selecting an element moves the text
  cursor to its opening tag. Below, picking the second `CheckBox` in the structure tree jumps
  the editor to line 10.

  ![Selecting an element in the tree moves the text cursor to it](../images/screen-sync1.png)

- **Text → visual** (`xve.sync.selectFromTextCursor`): moving the cursor in the code selects
  the matching element in the preview. Below, the cursor sits on line 9 and the first `CheckBox`
  is selected in the preview, with its resize handles.

  ![Moving the text cursor selects the matching element in the preview](../images/screen-sync2.png)

Both directions are on by default and can be toggled independently. The text editor can be split
below the visual editor or placed beside it — either arrangement works.

### 5.9 UI language

The interface is localized into **7 languages**. Set `xve.language` (empty = follow VS Code).
After changing it, reload the webview with **Ctrl+R** to apply.

---

## 6. Preview backends

![Preview backends](../images/preview-backends.png)

XVE has two rendering engines, selected with **`xve.previewBackend`**:

- **`auto`** (default) — WPF host on Windows, web renderer everywhere else.
- **`web`** — the cross-platform web renderer (XAML subset → HTML/CSS).
- **`wpf-host`** — the Windows WPF host (real WPF engine, high fidelity).

You can also override the engine per window from the toolbar’s engine selector, which offers a
fourth entry, *WPF host — isolated* (see [Isolation](#isolation-xvepreviewisolation) below).
If the WPF host fails or times out, XVE falls back to the web renderer automatically; if it
cannot start at all — most commonly because the **.NET 10 Desktop Runtime** is not installed —
you get a notification with a download link.

### Styles and resources in the web renderer

The web renderer is more than a tag-to-`<div>` mapping. Before rendering, XVE extracts the
CSS-mappable subset of the document's resources and applies them:

- **Brushes** — `SolidColorBrush` and `ImageBrush` resources referenced by key.
- **Styles** — a `Style` with simple `Setter`s (properties the renderer understands), including
  **`BasedOn` chains**, which are flattened.
- **Implicit styles** — a keyless `Style` with a `TargetType` applies to every element of that
  type, exactly as in WPF.
- **Resource lookup** — `{StaticResource key}` and `{DynamicResource key}` are resolved against
  the document's resource dictionaries.

Precedence follows WPF: implicit style → named style (with its `BasedOn` chain) → inline
attribute, with the inline attribute always winning. Anything outside this subset (triggers,
templates, converters, bindings to data) is ignored by the web renderer — use the WPF host when
you need it faithfully.

### Preview themes

The theme picker (![](../images/icons/symbol-color.png)) offers the standard set — **Classic**
(plain WPF), **Classic '98**, and the Fluent **Light** / **Dark** / **System** variants, which the
WPF host applies through `ThemeMode`. Any **resource-dictionary themes found in your project** are
listed above them and can be applied the same way. `Native` is a GTK/Linux look and only affects
the web renderer (the WPF host falls back to Classic).

![The same form in several preview themes, including project resource dictionaries](../images/screen-themes.png)

### WPF host options

| Setting | Purpose |
|---------|---------|
| `xve.preview.theme` | Preview theme: `none` (Classic), `classic98`, `system`/`light`/`dark` (Fluent), `native` (web-only GTK look). |
| `xve.preview.renderScale` | Supersampling: `auto` = device pixel ratio (crisp on HiDPI), or `1`/`1.5`/`2`/`3`. |
| `xve.preview.maxResolution` | Cap on bitmap size (longer side, device pixels). `0` = unlimited. |
| `xve.preview.viewportRender` | Render only the visible region — faster for large designs. |
| `xve.preview.capBasis` | Visible-area render: measure `maxResolution` against the visible area only (`visible`, stable sharpness across window sizes) or the whole slice incl. overscan (`slice`, legacy). |
| `xve.preview.overscan` | Visible-area render: extra margin (project units) rendered around the visible region as a scroll buffer. |
| `xve.preview.debugConsole` | Show a debug console at the bottom of the preview with live render telemetry. |
| `xve.preview.consoleOnStart` | Dock the console while the host starts up. When off, it still opens automatically on a render error. |
| `xve.preview.isolation` | Whether a file gets its own host process & resources (see below). |

### Adaptive resolution

Rendering a large surface at full HiDPI resolution on every frame of a drag is expensive. With
**`xve.preview.adaptiveRes`** (**on by default**) the host renders at a reduced resolution
(`xve.preview.motionResolution`, default 512 px on the longer side) *while you are dragging,
scrolling or zooming*, then re-renders once at the full `maxResolution` as soon as the motion
stops. Fast motion stays smooth, and the idle image stays sharp.

The degradation is not unconditional: it only kicks in when the full-resolution render is
running below **`xve.preview.adaptiveFpsThreshold`** frames per second (default 30). On a fast
machine with a small design you therefore never leave full resolution. Set the threshold to `0`
to always use the motion resolution while moving.

### Drag/resize live-preview strategy

While dragging/resizing in WPF-host mode, the live re-render is governed by:

- `xve.preview.dragStrategy` — `overlay` (no live re-render), `frames` (every N frames) or
  `ms` (every N milliseconds, the default).
- `xve.preview.dragIntervalMs` (default 25), `xve.preview.dragFrames` (default 2).
- `xve.preview.dragCoalesce` — keep at most one render in flight (drop stale frames).
- `xve.preview.dragSession` — parse once and mutate a cached tree instead of re-parsing.
- `xve.preview.dragOnChange` — render a new frame only when the dragged element's attributes
  actually change, so holding the pointer still costs nothing.
- `xve.preview.debugLiveDrag` — also refresh the debug console's telemetry on every drag frame.

### Isolation (`xve.preview.isolation`)

The WPF host can load project resources, which affect how custom types render. Isolation
controls whether a file shares a host or gets its own:

- `ask` — for a file from another project (or with no project), ask whether to isolate it.
- `auto` (default) — isolate such files automatically; share one host within the open project.
- `shared` — never isolate (one host for everything).
- `isolated` — always isolate (a separate host per file).

---

## 7. Project resources (WPF host)

For a faithful preview of **custom controls** and project themes, the WPF host can load your
project’s resources. XVE scans upward from the XAML file for a `.csproj`, then finds the best
`bin/<Config>/<tfm>` output, plus `App.xaml` and resource dictionaries.

- The choice is offered in a **QuickPick** and remembered per project; the policy is set by
  **`xve.project.autoLoadResources`** (`ask` / `always` / `never`).
- The host loads custom-control **DLLs** (via `AssemblyResolve` for `clr-namespace` types) and
  merges `App.xaml` / dictionaries into `Application.Resources`.
- Use the **Project resources** button (![](../images/icons/package.png)) in the preview toolbar
  to re-pick resources at any time.

![A custom control rendered by the WPF host, with the project-resources picker](../images/screen-wpf-host.png)

---

## 8. Error handling

When XAML fails to parse or render, XVE helps you locate and fix it:

- **Highlight changes in code** (`xve.editor.highlightChanges`) — changed lines are colored in
  the side-by-side text editor (mirrors the Changes panel toggle).
- **Highlight errors in code** (`xve.editor.highlightErrors`) — the error line is colored and
  the offending token underlined. Clicking the error reveals it in the text editor.
- **Auto-fix suggestions** — for an unknown type or property, XVE suggests the closest known
  name (e.g. `Buton` → `Button`) using edit-distance matching.
- **The console** — click the host status dot to open it. On a render error it opens by itself,
  whatever `xve.preview.consoleOnStart` says.

![The host console showing a render error](../images/screen-host-console.png)

### When the WPF host cannot start

If the host binary is missing, or the **.NET 10 Desktop Runtime** is not installed, or the
process dies on start-up, XVE shows a notification explaining which of the three happened, and
silently falls back to the web renderer. The notification offers to download the runtime, or to
switch `xve.previewBackend` to `web` so the host stops being attempted at all. Each kind of
failure is reported once per session.

---

## 9. Settings reference

All settings live under **`xve.*`**. Most are window-scoped, so different VS Code windows can
differ. Defaults below match `package.json`.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `xve.language` | enum | `""` | UI language (`""`=follow VS Code, `en`,`pl`,`es`,`de`,`fr`,`ja`,`zh`). Reload with Ctrl+R. |
| `xve.project.autoLoadResources` | enum | `ask` | How to load project resources for the WPF host: `ask` / `always` / `never`. |
| `xve.sync.selectInTextEditor` | bool | `true` | Selecting an element moves the text cursor to it. |
| `xve.sync.selectFromTextCursor` | bool | `true` | Moving the text cursor selects the matching element. |
| `xve.editor.highlightChanges` | bool | `true` | Color changed lines in the text editor. |
| `xve.editor.highlightErrors` | bool | `true` | Color/underline the error line in the text editor. |
| `xve.paste.nameDeduplication` | enum | `off` | `x:Name` collisions on paste: `off` (paste as-is) / `rename` / `renameAndReferences` (also fix `ElementName`, `x:Reference` inside the pasted subtree). |
| `xve.previewBackend` | enum | `auto` | Preview engine: `auto` / `web` / `wpf-host`. |
| `xve.preview.isolation` | enum | `auto` | WPF host isolation: `ask` / `auto` / `shared` / `isolated`. |
| `xve.preview.renderScale` | enum | `auto` | Supersampling: `auto` / `1` / `1.5` / `2` / `3`. |
| `xve.preview.maxResolution` | number | `1536` | Max bitmap size (longer side, device px). `0`=unlimited. |
| `xve.preview.theme` | enum | `none` | Preview theme: `none` / `classic98` / `system` / `light` / `dark` / `native`. |
| `xve.preview.viewportRender` | bool | `true` | Render only the visible region. |
| `xve.preview.capBasis` | enum | `visible` | Visible-area render: cap basis — `visible` / `slice`. |
| `xve.preview.overscan` | number | `100` | Visible-area render: margin (project units) around the visible region. |
| `xve.preview.debugConsole` | bool | `false` | Debug console with live render telemetry at the bottom of the preview. |
| `xve.preview.consoleOnStart` | bool | `true` | Dock the console while the host starts up. Off = hidden during start-up, but still shown on a render error. |
| `xve.preview.debugLiveDrag` | bool | `false` | Also refresh the console telemetry on every drag frame. |
| `xve.preview.dragStrategy` | enum | `ms` | Live-drag strategy: `overlay` / `frames` / `ms`. |
| `xve.preview.dragIntervalMs` | number | `25` | For `ms`: min interval between live re-renders (ms). |
| `xve.preview.dragFrames` | number | `2` | For `frames`: re-render every N frames. |
| `xve.preview.dragCoalesce` | bool | `true` | Keep at most one render in flight during drag/scroll. |
| `xve.preview.dragSession` | bool | `true` | Persistent drag session (parse once, mutate cached tree). |
| `xve.preview.dragOnChange` | bool | `true` | During a drag, render only when the dragged element's attributes actually change. |
| `xve.preview.adaptiveRes` | bool | `true` | Adaptive resolution: render at `motionResolution` while moving, then once at full `maxResolution`. |
| `xve.preview.motionResolution` | number | `512` | Resolution (longer side, device px) used while moving when adaptive resolution is on. |
| `xve.preview.adaptiveFpsThreshold` | number | `30` | Only drop to `motionResolution` when the full-resolution render runs below this many FPS. `0` = always. |
| `xve.preview.fitOnOpen` | bool | `true` | Fit the preview to the window on open (never magnify). |
| `xve.canvas.gridStep` | number | `8` | Grid step & snap threshold, in pixels. |
| `xve.canvas.showGrid` | bool | `false` | Default for showing the dot-grid overlay. |
| `xve.canvas.showRulers` | bool | `true` | Default for showing rulers/guides. |

### Commands

| Command | Title | When |
|---------|-------|------|
| `xve.openVisualEditor` | XVE: Open in XAML Visual Editor | `.xaml` open as text |
| `xve.openTextEditor` | XVE: Open XAML as Text | `.xaml` open in visual editor |

---

## 10. Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| **Ctrl+Z / Ctrl+Y** | Undo / redo (native VS Code, via the TextDocument) |
| **Delete** | Delete the selected element |
| **Ctrl+C / Ctrl+X / Ctrl+V** | Copy / cut / paste the selected subtree (system clipboard, XAML) |
| **Ctrl+scroll** | Zoom in/out, anchored at the cursor |
| **Middle mouse / Pan tool** | Pan the canvas |
| **Ctrl+R** | Reload the webview (e.g. to apply a language change) |

XVE does not register custom keybindings; it relies on VS Code’s built-in editor commands.

---

## 11. Architecture

![Architecture](../images/architecture.png)

The extension runs in two cooperating contexts, plus an optional native host:

- **Extension host (Node/TS)** — `extension.ts` activates the extension and registers the
  commands; `XveEditorProvider` is the `CustomTextEditorProvider`. The `core/` modules do the
  real work: `XamlDocument` (surgical save), `XamlParser` (positional tokenizer),
  `StructuralDiff` / `LineDiff`, `TypeRegistry` (types & property metadata), `ResourceModel`
  (brushes, styles, `BasedOn`), `ProjectScanner` (`.csproj` → DLLs and dictionaries),
  `PasteNames` (`x:Name` deduplication) and `Localization`. `host/WpfHost` manages the WPF host
  process and reports fatal start-up failures.
- **Webview (HTML/CSS/TS)** — `main.ts` drives the tree, properties, toolbar and UI;
  `renderer.ts` is the web XAML→DOM renderer; `styleResolver.ts` applies the extracted XAML
  styles/resources as CSS; `style.css` is the three-panel layout. It talks to the extension
  host via `postMessage`.
- **WPF host (Windows)** — `xve-wpf-host.exe` (.NET 10) renders XAML with the real WPF engine
  to a PNG plus a hit-test map (via injected `x:Uid`), over a JSON-lines stdio protocol. It can
  run shared across a project or isolated per file.

### Edit flow

![Edit flow](../images/edit-flow.png)

Every edit — a property change, a drag/resize, a reorder — is turned into the smallest set of
text edits by `XamlDocument`, applied via a `WorkspaceEdit`, then the document is re-parsed and
the preview re-rendered. Because the `TextDocument` is always the source of truth, undo/redo
is native and untouched regions never change.

---

## 12. Sample files

The `samples/` folder contains XAML files you can open to explore the editor:

| File | Demonstrates |
|------|--------------|
| [`samples/SampleGrid.xaml`](../../samples/SampleGrid.xaml) | A `Grid` form layout with `RowDefinitions`/`ColumnDefinitions`, spans and alignment. |
| [`samples/SampleControls.xaml`](../../samples/SampleControls.xaml) | `Menu`, `ComboBox` and a `ScrollViewer` — good for testing auto-reveal of dropdowns and per-area scrolling. |
| `samples/Sample.xaml`, `Sample2.xaml` | Basic `Window` + `StackPanel` examples. |

In `SampleControls.xaml`, select a `MenuItem` or `ComboBox` with auto-reveal on to expand its
submenu/list; hover the `ScrollViewer` and use the wheel to scroll only that area.

---

## 13. Troubleshooting / FAQ

**The `.xaml` file opens as plain text, not the visual editor.**
That is by design — the visual editor is an *option*. Use the title-bar button or
`xve.openVisualEditor` to switch.

**The preview looks approximate / custom controls show as placeholders.**
You are likely on the web renderer. On Windows, set `xve.previewBackend` to `auto` or
`wpf-host`, then load [project resources](#7-project-resources-wpf-host) with the
**Project resources** button.

**The host status dot stays grey and the preview never uses WPF.**
Grey means the host is not active — either you are not on Windows, or `xve.previewBackend` is
`web`. If you switched to `wpf-host` and still get grey, look for the error notification: the
most common cause is a missing
[.NET 10 Desktop Runtime](https://dotnet.microsoft.com/download/dotnet/10.0). Note the *Desktop*
runtime is a separate download from the plain .NET runtime.

**Custom types still don’t render in the WPF host.**
Make sure the project is built (so the DLLs exist under `bin/...`) and that you selected the
right resources. Click the host status dot to read the log.

**The UI is in the wrong language.**
Set `xve.language` and reload the webview with **Ctrl+R**.

**Large designs feel slow while dragging.**
Keep `xve.preview.viewportRender` and `xve.preview.adaptiveRes` on — together they render only
the visible region, at a reduced resolution while you move. If it is still heavy, lower
`xve.preview.motionResolution` (e.g. to 384), or raise `xve.preview.adaptiveFpsThreshold` so the
low-resolution mode engages sooner. Setting it to `0` always uses the motion resolution while
moving. Leave `dragStrategy` at `ms`.

## 14. Development history

XVE was built in stages. A condensed history:

- **Stage 8** — layout fidelity & properties: WPF-like size coercion in the web renderer,
  a complete set of common properties, a faithful `Grid` (`RowDefinitions`/`ColumnDefinitions`,
  spans, cell alignment), tree **reorder**, and **project resources** for the WPF host.
- **Stage 7** — render at screen resolution (`renderScale`, default `auto`=device pixel ratio),
  VS Code as the source of truth for `xve.preview.*`, and host performance work (debounce +
  coalescing, cached `ThemeMode`, reused `RenderTargetBitmap`, host pre-warm).
- **Stage 6** — **zoom** (10–800 %, Ctrl+scroll, Fit), the **WPF host** (`wpf-host/`, .NET 10,
  JSON-lines), viewport rendering, the resolution cap, and the settings panel.
- **Stage 4** — `LineDiff` + `StructuralDiff` and the **Changes** view with per-hunk and
  Revert-all.
- **Stage 3** — visual editing (drag/resize), structural operations in `XamlDocument`, the
  add/delete toolbar, and rulers/guides/snap with a stable viewport.
- **Earlier** — the custom text editor for `*.xaml`, `XamlDocument` + positional `XamlParser`,
  the web renderer, two-way selection, the typed properties panel, localization (7 languages)
  and round-trip / surgical-save tests.
