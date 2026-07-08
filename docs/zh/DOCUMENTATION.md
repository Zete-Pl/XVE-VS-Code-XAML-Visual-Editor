# XAML Visual Editor (XVE) — 文档

[🇬🇧 English](../en/DOCUMENTATION.md) · [🇵🇱 Polski](../pl/DOKUMENTACJA.md) · [🇪🇸 Español](../es/DOCUMENTACION.md) · [🇩🇪 Deutsch](../de/DOKUMENTATION.md) · [🇫🇷 Français](../fr/DOCUMENTATION.md) · [🇯🇵 日本語](../ja/DOCUMENTATION.md) · **🇨🇳 中文**

XVE 是一个 Visual Studio Code 扩展，它把手写的 **XAML** 文件变成可实时编辑的可视界面 —— 结构树、
渲染预览和类型化属性面板 —— 同时始终以文本文件作为唯一可信来源。它的核心特性是 **外科式保存**：
一次编辑只改动必须改动的部分，文件的其余内容保持逐字节完全一致（格式、注释和缩进都被保留）。

![编辑器布局](../images/layout-overview.png)

---

## 目录

1. [简介](#1-简介)
2. [安装与运行](#2-安装与运行)
3. [第一步](#3-第一步)
4. [界面](#4-界面)
5. [功能](#5-功能)
6. [预览后端](#6-预览后端)
7. [项目资源 (WPF 主机)](#7-项目资源-wpf-主机)
8. [错误处理](#8-错误处理)
9. [设置参考](#9-设置参考)
10. [键盘快捷键](#10-键盘快捷键)
11. [架构](#11-架构)
12. [示例文件](#12-示例文件)
13. [疑难解答 / FAQ](#13-疑难解答--faq)
14. [开发历史](#14-开发历史)

---

## 1. 简介

XVE 面向那些手写 WPF/XAML、却仍希望拥有设计器式预览与快速可视化微调的开发者 —— 而且不希望工具
重写（并重新格式化）他们的标记。

核心理念：

- **`*.xaml` 的自定义编辑器** —— 注册为 *选项*，因此你可以随时在可视编辑器与纯文本编辑器之间切换。
- **外科式保存** —— 每次改动都以对原文本尽可能小的编辑来应用。由于所有编辑都经过 `TextDocument`，
  VS Code 原生的 **撤销/重做** 照常工作。
- **两个预览引擎** —— 跨平台的 **Web 渲染器**，以及仅限 Windows、使用真实 WPF 引擎渲染的高保真
  **WPF 主机**。
- **本地化界面** —— 7 种语言（English, Polski, Español, Deutsch, Français, 日本語, 中文）。

---

## 2. 安装与运行

### 环境要求

| 组件 | 要求 |
|------|------|
| VS Code | `^1.90.0` |
| WPF 主机 —— *使用*（可选） | Windows x64 或 ARM64 + **[.NET 10 Desktop Runtime](https://dotnet.microsoft.com/download/dotnet/10.0)** |
| WPF 主机 —— *构建*（仅开发） | Windows + **.NET 10 SDK** |
| Node.js（仅开发） | ≥ 20（单元测试使用 Node ≥ 22/24 的 type-stripping） |

从 Marketplace 安装后无需编译任何东西：扩展同时附带 **x64 和 ARM64** 的预构建
`xve-wpf-host.exe`，并在运行时选择与你的 VS Code 匹配的那一个。

你确实需要的是 **Desktop** 运行时（`Microsoft.WindowsDesktop.App`）—— 它与普通 .NET 运行时是两个
不同的下载 —— 而且必须 **与 VS Code 的架构一致**。ARM64 版 VS Code 需要 ARM64 的 Desktop 运行时。
若缺失，XVE 会显示带下载链接的通知，并回退到 Web 渲染器。

VS Code 能运行的地方，扩展就能运行。**WPF 主机是可选的**，且仅限 Windows；在其他平台上（或主机不可用
时）会使用 Web 渲染器。

### 从源码运行（开发）

```bash
npm install
npm run compile        # 将扩展 + webview 打包到 dist/
npm run test:unit      # 核心单元测试（Node test runner，type stripping）
npm run test:parity    # Web 渲染器与 WPF 主机的渲染一致性（Playwright）
npm run docs:images    # 重新生成 docs/images/ 中的图示与工具栏图标
```

`test:parity` 用两种后端渲染 `samples/parity/` 中的样例，并比较得到的几何布局；它需要已构建的 WPF
主机（见下文），因此只能在 Windows 上运行。

`docs:images` 把每个 `docs/images/*.svg` 渲染成 PNG，从 `@vscode/codicons` 导出工具栏图标，并就地把
截图缩放到 1200 px 宽。它是幂等的 —— 已在限制以内的图片会原样保留 —— 所以你可以直接放入全分辨率截图，
再运行一次即可。

随后在 VS Code 中按 **`F5`** → *Run Extension*。在新的 Extension Development Host 窗口中打开任意
`.xaml` 文件（或从命令面板运行 **“XVE: Open in XAML Visual Editor”**）。

### 构建 WPF 主机（仅 Windows）

```bash
npm run build:host     # dotnet build wpf-host -c Release（需要 .NET 10 SDK）
```

这会生成 `xve-wpf-host.exe`，扩展会在需要高保真预览时按需启动它。

---

## 3. 第一步

1. **打开一个 XAML 文件。** 由于可视编辑器以 `priority: "option"` 注册，`.xaml` 文件默认在普通文本
   编辑器中打开。
2. **切换到可视编辑器。** 在编辑器标题栏点击 **“XVE: Open in XAML Visual Editor”**，或从命令面板运行
   `xve.openVisualEditor`。
3. **切回文本。** 在可视编辑器处于活动状态时，点击标题栏的 **“XVE: Open XAML as Text”**
   （`xve.openTextEditor`）。

标题栏的这两个按钮与上下文相关：“Visual Editor” 按钮只在 `.xaml` 文件以文本方式打开时出现，
“as Text” 按钮只在可视编辑器处于活动状态时出现。

（本文档顶部的截图展示了一个在可视编辑器中打开、三个面板均可见的 `.xaml` 文件。）

---

## 4. 界面

可视编辑器采用三面板布局（见顶部图示）：

| 面板 | 显示内容 |
|------|----------|
| **结构树**（左） | XAML 元素层次结构。点击选择，拖动重排。可调整宽度。 |
| **预览**（中） | 渲染出的界面，带工具栏、标尺/参考线、缩放和选择覆盖层。 |
| **属性**（右） | 所选元素属性的类型化编辑器，以及 *添加属性*。可调整宽度。 |

两侧面板都可折叠和调整大小；面板宽度与工具栏位置按窗口记忆。

### 预览工具栏

工具栏浮在预览之上。它可以停靠（上/下/左/右）或保持浮动，并按窗口记住位置。其中两个按钮会随状态改变
外观，所以这里给出它的两种常见形态。

**设计视图** —— 设计按钮处于激活状态，展开为带标签的胶囊。缩放控件可见，主机状态点是绿色的（WPF 主机
正在运行且渲染正常）：

![设计视图中的工具栏](../images/toolbar-design.png)

**更改视图** —— 更改按钮处于激活状态，并显示待处理更改的数量。缩放控件消失（它们属于设计界面，而不属于
差异视图），平移工具被选中，并且由于此窗口使用 Web 渲染器，状态点是灰色的：

![更改视图中的工具栏](../images/toolbar-changes.png)

这两个差别彼此独立：**缩放面板隐藏纯粹是因为视图模式是“更改”**，而 **状态点的颜色只取决于预览后端和
主机的渲染状态** —— 与视图模式无关。

#### 每一个控件，从左到右

| 图标 | 控件 | 类型 | 作用 |
|:----:|------|------|------|
| ![](../images/icons/gripper.png) | **移动工具栏** | 拖动手柄 | 拖动工具栏；靠近某个边缘松手即可停靠。 |
| ![](../images/icons/layout-sidebar-left.png) | **显示结构** | 按钮 *(条件显示)* | 重新打开结构面板。仅在该面板折叠时显示。 |
| ![](../images/icons/pan.png) | **平移 (Pan)** | 工具 | 拖动以滚动预览。也可随时用鼠标中键实现。 |
| ![](../images/icons/move.png) | **选择 / 移动** | 工具 | 选择元素、拖动移动、用 8 个手柄调整大小。 |
| ![](../images/icons/list-tree.png) | **重排** | 工具 | 在预览中拖动元素以改变其同级顺序，与在树中一样。**这是默认工具。** |
| ![](../images/icons/eye.png) | **自动展开** | 开关 | 自动打开所选元素的下拉/菜单（ComboBox、Menu 等）。**默认开启。** |
| ![](../images/icons/discard.png) | **撤销** | 按钮 | 撤销上一次编辑（VS Code 原生撤销栈）。 |
| ![](../images/icons/redo.png) | **重做** | 按钮 | 重做。 |
| ![](../images/icons/trash.png) | **删除** | 按钮 | 删除所选元素（等同于 <kbd>Del</kbd> 键）。 |
| ![](../images/icons/edit.png) | **设计** | 视图开关 | 实时设计界面。激活时展开为带标签的胶囊。 |
| ![](../images/icons/git-compare.png) | **更改** | 视图开关 | 与已保存文件的差异。激活时显示 *更改 (n)*；未激活时仅以徽标显示 *n*，没有更改时则什么都不显示。 |
| ![](../images/icons/symbol-numeric.png) | **网格** | 开关 | 点阵网格覆盖层。开启它也会启用网格吸附 —— 没有单独的磁铁按钮。**默认关闭。** |
| ![](../images/icons/symbol-ruler.png) | **标尺** | 开关 | 标尺、可拖动的参考线以及参考线吸附。**默认开启。** |
| ![](../images/icons/symbol-color.png) | **预览主题** | 菜单 | 项目中找到的资源字典主题，其下是标准集合：Classic、Classic '98、System、Light、Dark、Native。参见[第 6 节](#6-预览后端)。 |
| ![](../images/icons/server-process.png) | **预览引擎** | 菜单 | `Auto`、`Web`，以及仅在 Windows 上的 `WPF host` 和 `WPF host — isolated`。参见[第 6 节](#6-预览后端)。 |
| ![](../images/icons/play.png) | **运行窗口** | 菜单 | 在真实的 Windows 窗口中打开 XAML：*Snapshot*（一次性）或 *Live*（跟随项目）。WPF 引擎，仅 Windows。 |
| ![](../images/icons/package.png) | **项目资源** | 对话框 | 选择要加载哪些自定义控件 DLL、`App.xaml` 和资源字典。参见[第 7 节](#7-项目资源-wpf-主机)。 |
| ![](../images/icons/dot-ok.png) | **主机状态** | 指示灯 + 按钮 | WPF 主机的状态（见下表）。点击可打开控制台/日志。 |
| ![](../images/icons/layout-sidebar-right.png) | **显示属性** | 按钮 *(条件显示)* | 重新打开属性面板。仅在该面板折叠时显示。 |
| ![](../images/icons/triangle-right.png) | **调整工具栏大小** | 拖动手柄 *(条件显示)* | 拖动以调整工具栏大小。仅在工具栏浮动（未停靠）时显示。 |

平移、选择与重排互斥 —— 任何时候都恰好有一个处于激活状态。

#### 主机状态点

| 状态点 | 含义 |
|:------:|------|
| ![](../images/icons/dot-ok.png) | WPF 主机正在运行，且上一次渲染成功。 |
| ![](../images/icons/dot-idle.png) | WPF 主机正在启动。 |
| ![](../images/icons/dot-error.png) | WPF 主机报告了渲染错误。控制台会自动打开。 |
| ![](../images/icons/dot-inactive.png) | 没有 WPF 主机：要么你不在 Windows 上，要么预览引擎设为 `Web`。这不是错误。 |

状态点周围的 **蓝色圆环** 表示当前已加载项目资源。无论颜色如何，点击状态点始终会打开控制台/日志。
如果主机处于隔离模式，其工具提示会说明这一点。

#### 缩放面板

![](../images/icons/zoom-out.png) ![](../images/icons/zoom-in.png)
![](../images/icons/screen-full.png)

缩放 **不属于工具栏** —— 它是预览右下角一个独立的小面板：*缩小*、当前百分比（点击可重置为 100 %）、
*放大* 和 *适应窗口*。在更改视图中它是隐藏的。当工具栏停靠在下边缘且空间足够时，缩放面板会停靠到工具栏
的右端 —— 这就是上面设计视图截图中它们看起来像一整条的原因。

---

## 5. 功能

### 5.1 结构树与重排

树反映 XAML 的层次结构。点击节点以选中它（对应元素会在预览中高亮）。**拖动节点** 可重排：放置区域会
提示 *之前*、*内部* 或 *之后*，且禁止放入自身的子树。移动会作为一次外科式的 `moveElement` 应用，并保留
缩进。

### 5.2 可视化编辑 —— 移动与调整大小

使用 **选择** 工具，在预览中点击元素将其选中。然后：

- 拖动以 **移动**。取决于父级布局，移动会更新 `Margin`（多数面板）或 `Canvas.Left/Top`（在 `Canvas`
  内部）。
- 使用 **8 个手柄**（角 + 边）**调整大小**；这会更新 `Width`/`Height`（必要时还有 `Margin`）。
- **实时预览** 跟随你的手势；松手时，改动会作为一次外科式写入（`setAttributes`）提交。

![一个被选中的元素及其 8 个调整手柄](../images/screen-drag-resize.png)

### 5.3 添加 / 删除 / 复制元素

- 从工具栏 **添加** 元素：可从 15 种常用类型中选择（Grid、StackPanel、Canvas、Border、TextBlock、
  Label、Button、TextBox、CheckBox、RadioButton、Slider、ProgressBar、Image、Ellipse、Rectangle）。
  一段默认代码会插入到所选容器中。
- 用 **Delete** 键 **删除** 所选元素。
- 用 **Ctrl+C / Ctrl+X / Ctrl+V** **复制 / 剪切 / 粘贴** 子树（作为同级或子元素粘贴）。剪贴板是
  **系统剪贴板** —— 元素以 XAML 片段形式复制 —— 因此可以在 **多个 XVE 窗口之间** 使用，也能与
  **文本编辑器** 双向互通。粘贴时可选的 `x:Name` 去重（设置 `xve.paste.nameDeduplication`，默认关闭）
  会把冲突的名称改成唯一名称，且不触碰原件。

### 5.4 属性面板

<img src="../images/screen-properties.png" align="right" width="280"
     alt="打开了画刷取色器并含有一个已更改属性的属性面板">

面板会根据每个属性的类别显示 **类型化编辑器**：

| 类别 | 编辑器 |
|------|--------|
| `bool` | 复选框 |
| `enum` | 下拉列表 |
| `number` | 数字输入框 |
| `brush` | 取色器 |
| `thickness` | L,T,R,B 四个输入框 |
| `string` | 文本框 |

它覆盖常用属性（Name、Width/Height、Min/Max 尺寸、Margin、Padding、对齐、Background/Foreground、
BorderBrush/Thickness、字体、Opacity、Visibility、IsEnabled 等）、附加属性（`Grid.Row/Column`、
`Canvas.Left/Top`、`DockPanel.Dock`），以及类型特有的属性（Text、Content、IsChecked、
Value/Minimum/Maximum 等）。

用 **“+ 添加属性”** 来添加任何已知属性，用每个属性旁的控件来移除它。**自上次保存以来已更改** 的属性会
用彩色条高亮，并获得逐属性的 **还原** 按钮 —— 截图中，`BorderBrush` 已用取色器编辑，而
`VerticalAlignment` 未被触碰。

<br clear="right">

### 5.5 更改视图（差异）

把工具栏从 **设计** 切到 **更改**，即可看到与 **已保存文件** 的一切差异：更改的属性、新增的元素、删除的
元素和移动的元素（用 LCS 树匹配检测，因此重排不会被报告为新增+删除）。每一条都有 **逐块还原** 按钮，
并且提供 **全部还原** 操作。点击某一条会在预览中选中对应元素。还原使用与编辑相同的外科式操作。

![包含更改、新增和删除条目的更改视图](../images/screen-changes.png)

### 5.6 缩放与导航

缩放范围为 **10–800 %**。使用预览右下角的缩放面板、**Ctrl+滚轮**（以光标为锚点）或 **适应窗口** 让预览
适配窗口。默认情况下（`xve.preview.fitOnOpen`）文档在打开时会自动适配：若大于视图则缩小，否则以 100 %
显示（绝不放大）。用平移工具或鼠标中键 **平移**。标尺、参考线和吸附都遵循当前缩放。

### 5.7 标尺、参考线与网格吸附

从工具栏切换 **标尺**（上/左）和点阵 **网格** 覆盖层。点击标尺可添加 **参考线**；拖动可移动，双击可
删除。在移动/调整大小时，元素会 **吸附** 到网格和参考线。网格步长与吸附阈值由 `xve.canvas.gridStep`
设置（默认 8 px）。

### 5.8 与文本编辑器的选择同步

当文本编辑器并排打开时，选择是 **双向的**：

- **可视 → 文本**（`xve.sync.selectInTextEditor`）：选中一个元素会把文本光标移到它的起始标签。下图中，
  在结构树里选中第二个 `CheckBox`，编辑器就跳到第 10 行。

  ![在树中选中元素会移动文本光标](../images/screen-sync1.png)

- **文本 → 可视**（`xve.sync.selectFromTextCursor`）：在代码中移动光标会在预览中选中对应元素。下图中，
  光标位于第 9 行，第一个 `CheckBox` 在预览中被选中，并显示其调整手柄。

  ![移动文本光标会选中对应元素](../images/screen-sync2.png)

两个方向默认都开启，可独立切换。文本编辑器可以拆分到可视编辑器下方，也可以放在旁边 —— 两种布局都可以。

### 5.9 界面语言

界面已本地化为 **7 种语言**。设置 `xve.language`（留空 = 跟随 VS Code）。更改后用 **Ctrl+R** 重新加载
webview 使其生效。

---

## 6. 预览后端

![预览后端](../images/preview-backends.png)

XVE 有两个渲染引擎，通过 **`xve.previewBackend`** 选择：

- **`auto`**（默认）—— 在 Windows 上使用 WPF 主机，其他平台使用 Web 渲染器。
- **`web`** —— 跨平台的 Web 渲染器（XAML 子集 → HTML/CSS）。
- **`wpf-host`** —— Windows 的 WPF 主机（真实 WPF 引擎，高保真）。

你也可以在工具栏的引擎选择器中按窗口覆盖该设置，那里还有第四个条目 *WPF host — isolated*
（见下文 [隔离](#隔离-xvepreviewisolation)）。如果 WPF 主机失败或超时，XVE 会自动回退到 Web 渲染器；
如果它根本无法启动 —— 最常见的原因是未安装 **.NET 10 Desktop Runtime** —— 你会收到带下载链接的通知。

### Web 渲染器中的样式与资源

Web 渲染器不只是把标签映射成 `<div>`。渲染之前，XVE 会提取文档资源中可映射为 CSS 的子集并加以应用：

- **画刷** —— 通过键引用的 `SolidColorBrush` 和 `ImageBrush` 资源。
- **样式** —— 带有简单 `Setter`（渲染器能理解的属性）的 `Style`，包括会被展平的 **`BasedOn` 链**。
- **隐式样式** —— 带 `TargetType` 的无键 `Style` 会应用到该类型的每个元素，与 WPF 完全一致。
- **资源查找** —— `{StaticResource key}` 和 `{DynamicResource key}` 会针对文档的资源字典进行解析。

优先级遵循 WPF：隐式样式 → 命名样式（含其 `BasedOn` 链）→ 内联属性，内联属性始终胜出。位于该子集之外的
一切（触发器、模板、转换器、数据绑定）都会被 Web 渲染器忽略 —— 需要忠实呈现时请使用 WPF 主机。

### 预览主题

主题选择器（![](../images/icons/symbol-color.png)）提供标准集合 —— **Classic**（纯 WPF）、
**Classic '98**，以及 WPF 主机通过 `ThemeMode` 应用的 Fluent **Light** / **Dark** / **System** 变体。
**在你的项目中找到的资源字典主题** 会列在它们上方，应用方式相同。`Native` 是 GTK/Linux 风格外观，只影响
Web 渲染器（WPF 主机会回退到 Classic）。

![同一个窗体在多种预览主题下，包括项目资源字典](../images/screen-themes.png)

### WPF 主机选项

| 设置 | 用途 |
|------|------|
| `xve.preview.theme` | 预览主题：`none`（Classic）、`classic98`、`system`/`light`/`dark`（Fluent）、`native`（GTK 外观，仅 Web）。 |
| `xve.preview.renderScale` | 超采样：`auto` = device pixel ratio（HiDPI 下清晰），或 `1`/`1.5`/`2`/`3`。 |
| `xve.preview.maxResolution` | 位图尺寸上限（长边，设备像素）。`0` = 不限制。 |
| `xve.preview.viewportRender` | 只渲染可见区域 —— 对大型设计更快。 |
| `xve.preview.capBasis` | 可见区域渲染：`maxResolution` 只按可见区域衡量（`visible`，不同窗口尺寸下清晰度稳定），还是按含 overscan 的整个切片衡量（`slice`，旧行为）。 |
| `xve.preview.overscan` | 可见区域渲染：在可见区域周围额外渲染的边距（项目单位），作为滚动缓冲。 |
| `xve.preview.debugConsole` | 在预览底部显示带实时渲染遥测的调试控制台。 |
| `xve.preview.consoleOnStart` | 主机启动期间停靠控制台。关闭时，遇到渲染错误仍会自动打开。 |
| `xve.preview.isolation` | 文件是否获得自己的主机进程与资源（见下文）。 |

### 自适应分辨率

在拖动的每一帧都以完整 HiDPI 分辨率渲染大面积界面代价高昂。启用 **`xve.preview.adaptiveRes`**
（**默认开启**）后，*在你拖动、滚动或缩放时*，主机会以较低分辨率渲染（`xve.preview.motionResolution`，
默认长边 512 px），一旦动作停止便以完整的 `maxResolution` 重新渲染一次。快速移动保持流畅，静止画面保持
清晰。

这种降级并非无条件：只有当完整分辨率的渲染低于 **`xve.preview.adaptiveFpsThreshold`** 帧每秒（默认 30）
时才会启用。因此在性能强劲的机器上处理小型设计时，你永远不会离开完整分辨率。把阈值设为 `0` 则在移动时
始终使用运动分辨率。

### 拖动/调整大小时的实时预览策略

在 WPF 主机模式下拖动/调整大小时，实时重渲染由以下设置控制：

- `xve.preview.dragStrategy` —— `overlay`（不做实时重渲染）、`frames`（每 N 帧一次）或 `ms`
  （每 N 毫秒一次，默认）。
- `xve.preview.dragIntervalMs`（默认 25）、`xve.preview.dragFrames`（默认 2）。
- `xve.preview.dragCoalesce` —— 最多保持一次渲染在途（丢弃过期帧）。
- `xve.preview.dragSession` —— 只解析一次并修改缓存的树，而不是重新解析。
- `xve.preview.dragOnChange` —— 仅当被拖动元素的属性确实发生变化时才渲染新帧，因此按住指针不动不产生
  任何开销。
- `xve.preview.debugLiveDrag` —— 在每个拖动帧也刷新调试控制台的遥测数据。

### 隔离 (`xve.preview.isolation`)

WPF 主机可以加载项目资源，而这会影响自定义类型的渲染方式。隔离决定一个文件是共享主机还是获得自己的
主机：

- `ask` —— 对来自其他项目（或不属于任何项目）的文件，询问是否隔离。
- `auto`（默认）—— 自动隔离这类文件；在已打开的项目内共享一个主机。
- `shared` —— 从不隔离（所有内容共用一个主机）。
- `isolated` —— 始终隔离（每个文件一个独立主机）。

---

## 7. 项目资源 (WPF 主机)

为了忠实预览 **自定义控件** 和项目主题，WPF 主机可以加载你项目的资源。XVE 会从 XAML 文件向上查找
`.csproj`，然后找到最合适的 `bin/<Config>/<tfm>` 输出，外加 `App.xaml` 和资源字典。

- 选择会在 **QuickPick** 中给出，并按项目记住；策略由 **`xve.project.autoLoadResources`**
  （`ask` / `always` / `never`）设置。
- 主机会加载自定义控件的 **DLL**（对 `clr-namespace` 类型通过 `AssemblyResolve`），并把 `App.xaml` /
  字典合并进 `Application.Resources`。
- 使用预览工具栏中的 **项目资源** 按钮（![](../images/icons/package.png)）可随时重新选择资源。

![由 WPF 主机渲染的自定义控件，以及项目资源选择器](../images/screen-wpf-host.png)

---

## 8. 错误处理

当 XAML 无法解析或渲染时，XVE 会帮你定位并修复：

- **在代码中高亮更改**（`xve.editor.highlightChanges`）—— 更改的行会在并排的文本编辑器中着色（与更改
  面板的开关联动）。
- **在代码中高亮错误**（`xve.editor.highlightErrors`）—— 错误行会着色，出问题的标记会加下划线。点击错误
  会在文本编辑器中定位到它。
- **自动修复建议** —— 对未知的类型或属性，XVE 会用编辑距离匹配给出最接近的已知名称（例如 `Buton` →
  `Button`）。
- **控制台** —— 点击主机状态点即可打开。发生渲染错误时它会自行打开，无论
  `xve.preview.consoleOnStart` 如何设置。

![显示渲染错误的主机控制台](../images/screen-host-console.png)

### 当 WPF 主机无法启动

如果主机可执行文件缺失、未安装 **.NET 10 Desktop Runtime**，或进程在启动时崩溃，XVE 会显示通知说明是这
三种情况中的哪一种，并静默回退到 Web 渲染器。通知会提供下载运行时的选项，或把 `xve.previewBackend` 切换
为 `web`，让主机不再被尝试启动。每一类失败在每个会话中只报告一次。

---

## 9. 设置参考

所有设置都位于 **`xve.*`** 之下。多数为窗口作用域，因此不同的 VS Code 窗口可以不同。下表默认值与
`package.json` 一致。

| 设置 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `xve.language` | enum | `""` | 界面语言（`""`=跟随 VS Code，`en`,`pl`,`es`,`de`,`fr`,`ja`,`zh`）。用 Ctrl+R 重新加载。 |
| `xve.project.autoLoadResources` | enum | `ask` | 如何为 WPF 主机加载项目资源：`ask` / `always` / `never`。 |
| `xve.sync.selectInTextEditor` | bool | `true` | 选中元素会把文本光标移到它那里。 |
| `xve.sync.selectFromTextCursor` | bool | `true` | 移动文本光标会选中对应元素。 |
| `xve.editor.highlightChanges` | bool | `true` | 在文本编辑器中给更改的行着色。 |
| `xve.editor.highlightErrors` | bool | `true` | 在文本编辑器中给错误行着色/加下划线。 |
| `xve.paste.nameDeduplication` | enum | `off` | 粘贴时的 `x:Name` 冲突：`off`（原样粘贴）/ `rename` / `renameAndReferences`（同时修正粘贴子树内的 `ElementName`、`x:Reference`）。 |
| `xve.previewBackend` | enum | `auto` | 预览引擎：`auto` / `web` / `wpf-host`。 |
| `xve.preview.isolation` | enum | `auto` | WPF 主机隔离：`ask` / `auto` / `shared` / `isolated`。 |
| `xve.preview.renderScale` | enum | `auto` | 超采样：`auto` / `1` / `1.5` / `2` / `3`。 |
| `xve.preview.maxResolution` | number | `1536` | 位图最大尺寸（长边，设备 px）。`0`=不限制。 |
| `xve.preview.theme` | enum | `none` | 预览主题：`none` / `classic98` / `system` / `light` / `dark` / `native`。 |
| `xve.preview.viewportRender` | bool | `true` | 只渲染可见区域。 |
| `xve.preview.capBasis` | enum | `visible` | 可见区域渲染：上限基准 —— `visible` / `slice`。 |
| `xve.preview.overscan` | number | `100` | 可见区域渲染：可见区域周围的边距（项目单位）。 |
| `xve.preview.debugConsole` | bool | `false` | 预览底部带渲染遥测的调试控制台。 |
| `xve.preview.consoleOnStart` | bool | `true` | 主机启动期间停靠控制台。关闭 = 启动时隐藏，但渲染错误时仍会显示。 |
| `xve.preview.debugLiveDrag` | bool | `false` | 在每个拖动帧也刷新控制台遥测。 |
| `xve.preview.dragStrategy` | enum | `ms` | 实时拖动策略：`overlay` / `frames` / `ms`。 |
| `xve.preview.dragIntervalMs` | number | `25` | 对 `ms`：实时重渲染之间的最小间隔（毫秒）。 |
| `xve.preview.dragFrames` | number | `2` | 对 `frames`：每 N 帧重渲染一次。 |
| `xve.preview.dragCoalesce` | bool | `true` | 拖动/滚动期间最多保持一次渲染在途。 |
| `xve.preview.dragSession` | bool | `true` | 持久拖动会话（只解析一次，修改缓存的树）。 |
| `xve.preview.dragOnChange` | bool | `true` | 拖动期间，仅当元素属性确实变化时才渲染。 |
| `xve.preview.adaptiveRes` | bool | `true` | 自适应分辨率：移动时以 `motionResolution` 渲染，停止后以完整 `maxResolution` 渲染一次。 |
| `xve.preview.motionResolution` | number | `512` | 启用自适应分辨率时，移动过程中使用的分辨率（长边，设备 px）。 |
| `xve.preview.adaptiveFpsThreshold` | number | `30` | 仅当完整分辨率渲染低于此 FPS 时才降到 `motionResolution`。`0` = 始终。 |
| `xve.preview.fitOnOpen` | bool | `true` | 打开时让预览适配窗口（绝不放大）。 |
| `xve.canvas.gridStep` | number | `8` | 网格步长与吸附阈值（像素）。 |
| `xve.canvas.showGrid` | bool | `false` | 是否显示点阵网格覆盖层的初始值。 |
| `xve.canvas.showRulers` | bool | `true` | 是否显示标尺/参考线的初始值。 |

### 命令

| 命令 | 标题 | 何时可用 |
|------|------|----------|
| `xve.openVisualEditor` | XVE: Open in XAML Visual Editor | `.xaml` 以文本方式打开 |
| `xve.openTextEditor` | XVE: Open XAML as Text | `.xaml` 在可视编辑器中打开 |

---

## 10. 键盘快捷键

| 快捷键 | 操作 |
|--------|------|
| **Ctrl+Z / Ctrl+Y** | 撤销 / 重做（VS Code 原生，经由 TextDocument） |
| **Delete** | 删除所选元素 |
| **Ctrl+C / Ctrl+X / Ctrl+V** | 复制 / 剪切 / 粘贴所选子树（系统剪贴板，XAML） |
| **Ctrl+滚轮** | 以光标为锚点放大/缩小 |
| **鼠标中键 / 平移工具** | 平移画布 |
| **Ctrl+R** | 重新加载 webview（例如应用语言更改） |

XVE 不注册自定义键位绑定；它依赖 VS Code 内置的编辑器命令。

---

## 11. 架构

![架构](../images/architecture.png)

扩展运行在两个协作的上下文中，外加一个可选的原生主机：

- **扩展主机 (Node/TS)** —— `extension.ts` 激活扩展并注册命令；`XveEditorProvider` 是
  `CustomTextEditorProvider`。真正的工作由 `core/` 中的模块完成：`XamlDocument`（外科式保存）、
  `XamlParser`（带位置信息的分词器）、`StructuralDiff` / `LineDiff`、`TypeRegistry`（类型与属性元数据）、
  `ResourceModel`（画刷、样式、`BasedOn`）、`ProjectScanner`（`.csproj` → DLL 与字典）、`PasteNames`
  （`x:Name` 去重）以及 `Localization`。`host/WpfHost` 管理 WPF 主机进程并报告致命的启动失败。
- **Webview (HTML/CSS/TS)** —— `main.ts` 驱动树、属性、工具栏和界面；`renderer.ts` 是 Web 的 XAML→DOM
  渲染器；`styleResolver.ts` 把提取出的 XAML 样式/资源作为 CSS 应用；`style.css` 是三面板布局。它通过
  `postMessage` 与扩展主机通信。
- **WPF 主机 (Windows)** —— `xve-wpf-host.exe`（.NET 10）用真实的 WPF 引擎把 XAML 渲染成 PNG，外加一份
  命中测试映射（借助注入的 `x:Uid`），通过 stdio 上的 JSON-lines 协议通信。它可以在整个项目中共享，也可以
  按文件隔离运行。

### 编辑流程

![编辑流程](../images/edit-flow.png)

每一次编辑 —— 属性更改、拖动/调整大小、重排 —— 都由 `XamlDocument` 转换成最小的一组文本编辑，经由
`WorkspaceEdit` 应用，随后文档被重新解析、预览被重新渲染。因为 `TextDocument` 始终是唯一可信来源，撤销/
重做是原生的，未触碰的区域永不改变。

---

## 12. 示例文件

`samples/` 文件夹中的 XAML 文件可供你打开以探索编辑器：

| 文件 | 演示内容 |
|------|----------|
| [`samples/SampleGrid.xaml`](../../samples/SampleGrid.xaml) | 使用 `RowDefinitions`/`ColumnDefinitions`、跨行列与对齐的 `Grid` 表单布局。 |
| [`samples/SampleControls.xaml`](../../samples/SampleControls.xaml) | `Menu`、`ComboBox` 和一个 `ScrollViewer` —— 适合测试下拉的自动展开与区域内滚动。 |
| `samples/Sample.xaml`, `Sample2.xaml` | 基础的 `Window` + `StackPanel` 示例。 |

在 `SampleControls.xaml` 中，开启自动展开后选中 `MenuItem` 或 `ComboBox`，即可展开其子菜单/列表；把指针
悬停在 `ScrollViewer` 上并滚动滚轮，则只滚动该区域。

---

## 13. 疑难解答 / FAQ

**`.xaml` 文件以纯文本打开，而不是可视编辑器。**
这是设计使然 —— 可视编辑器是一个 *选项*。用标题栏按钮或 `xve.openVisualEditor` 切换。

**预览看起来只是近似 / 自定义控件显示为占位符。**
你多半在使用 Web 渲染器。在 Windows 上，把 `xve.previewBackend` 设为 `auto` 或 `wpf-host`，然后用
**项目资源** 按钮加载[项目资源](#7-项目资源-wpf-主机)。

**主机状态点一直是灰色，预览从不使用 WPF。**
灰色表示主机未激活 —— 要么你不在 Windows 上，要么 `xve.previewBackend` 是 `web`。如果你已切换到
`wpf-host` 却仍是灰色，请留意错误通知：最常见的原因是缺少
[.NET 10 Desktop Runtime](https://dotnet.microsoft.com/download/dotnet/10.0)。注意 *Desktop* 运行时与普通
.NET 运行时是两个不同的下载。

**自定义类型在 WPF 主机中仍然不渲染。**
确认项目已构建（这样 DLL 才会存在于 `bin/...` 下），并且你选择了正确的资源。点击主机状态点阅读日志。

**界面语言不对。**
设置 `xve.language`，然后用 **Ctrl+R** 重新加载 webview。

**大型设计在拖动时感觉卡顿。**
保持 `xve.preview.viewportRender` 和 `xve.preview.adaptiveRes` 开启 —— 二者结合只渲染可见区域，且在移动
时使用较低分辨率。如果仍然吃力，降低 `xve.preview.motionResolution`（例如降到 384），或提高
`xve.preview.adaptiveFpsThreshold` 让低分辨率模式更早介入。设为 `0` 则在移动时始终使用运动分辨率。把
`dragStrategy` 保持为 `ms`。

---

## 14. 开发历史

XVE 是分阶段构建的。精简的历史：

- **第 8 阶段** —— 布局保真度与属性：Web 渲染器中类 WPF 的尺寸强制、一整套常用属性、忠实的 `Grid`
  （`RowDefinitions`/`ColumnDefinitions`、跨行列、单元格对齐）、树的 **重排**，以及 WPF 主机的
  **项目资源**。
- **第 7 阶段** —— 按屏幕分辨率渲染（`renderScale`，默认 `auto`=device pixel ratio）、以 VS Code 作为
  `xve.preview.*` 的唯一可信来源，以及主机性能工作（防抖 + 合并、缓存的 `ThemeMode`、复用的
  `RenderTargetBitmap`、主机预热）。
- **第 6 阶段** —— **缩放**（10–800 %、Ctrl+滚轮、适应窗口）、**WPF 主机**（`wpf-host/`、.NET 10、
  JSON-lines）、视口渲染、分辨率上限，以及设置面板。
- **第 4 阶段** —— `LineDiff` + `StructuralDiff`，以及带逐块还原和全部还原的 **更改** 视图。
- **第 3 阶段** —— 可视化编辑（拖动/调整大小）、`XamlDocument` 中的结构操作、添加/删除工具栏，以及带
  稳定视口的标尺/参考线/吸附。
- **更早** —— `*.xaml` 的自定义文本编辑器、`XamlDocument` + 带位置信息的 `XamlParser`、Web 渲染器、
  双向选择、类型化属性面板、本地化（7 种语言），以及往返 / 外科式保存测试。
