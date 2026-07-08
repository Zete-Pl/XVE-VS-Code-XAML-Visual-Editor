# XAML Visual Editor (XVE) — ドキュメント

[🇬🇧 English](../en/DOCUMENTATION.md) · [🇵🇱 Polski](../pl/DOKUMENTACJA.md) · [🇪🇸 Español](../es/DOCUMENTACION.md) · [🇩🇪 Deutsch](../de/DOKUMENTATION.md) · [🇫🇷 Français](../fr/DOCUMENTATION.md) · **🇯🇵 日本語** · [🇨🇳 中文](../zh/DOCUMENTATION.md)

XVE は、手書きの **XAML** ファイルを生きた編集可能なビジュアル面 — 構造ツリー、レンダリングされた
プレビュー、型付きプロパティパネル — に変える Visual Studio Code 拡張機能です。テキストファイルは
常に唯一の信頼できる情報源のままです。最大の特徴は **外科的保存 (surgical save)** で、編集は必要な
部分だけを変更し、それ以外はバイト単位でまったく同一に保たれます (書式、コメント、インデントが
保持されます)。

![エディターのレイアウト](../images/layout-overview.png)

---

## 目次

1. [はじめに](#1-はじめに)
2. [インストールと実行](#2-インストールと実行)
3. [最初のステップ](#3-最初のステップ)
4. [インターフェース](#4-インターフェース)
5. [機能](#5-機能)
6. [プレビューバックエンド](#6-プレビューバックエンド)
7. [プロジェクトリソース (WPF ホスト)](#7-プロジェクトリソース-wpf-ホスト)
8. [エラー処理](#8-エラー処理)
9. [設定リファレンス](#9-設定リファレンス)
10. [キーボードショートカット](#10-キーボードショートカット)
11. [アーキテクチャ](#11-アーキテクチャ)
12. [サンプルファイル](#12-サンプルファイル)
13. [トラブルシューティング / FAQ](#13-トラブルシューティング--faq)
14. [開発の歴史](#14-開発の歴史)

---

## 1. はじめに

XVE は、WPF/XAML を手で書きつつも、デザイナーのようなプレビューと素早い視覚的な調整を求める開発者
のために作られました。ツールがマークアップを書き換えたり (再フォーマットしたり) することはありません。

主要な考え方:

- **`*.xaml` 用のカスタムエディター** — *オプション* として登録されるため、ビジュアルエディターと
  プレーンテキストエディターをいつでも切り替えられます。
- **外科的保存** — すべての変更は、元のテキストに対する可能な限り小さい編集として適用されます。
  すべての編集が `TextDocument` を経由するため、VS Code ネイティブの **元に戻す/やり直し** が
  そのまま機能します。
- **2 つのプレビューエンジン** — クロスプラットフォームの **Web レンダラー** と、実際の WPF エンジン
  で描画する Windows 専用・高忠実度の **WPF ホスト**。
- **多言語対応 UI** — 7 言語 (English, Polski, Español, Deutsch, Français, 日本語, 中文)。

---

## 2. インストールと実行

### 必要条件

| コンポーネント | 必要条件 |
|----------------|----------|
| VS Code | `^1.90.0` |
| WPF ホスト — *使用する* (任意) | Windows x64 または ARM64 + **[.NET 10 Desktop Runtime](https://dotnet.microsoft.com/download/dotnet/10.0)** |
| WPF ホスト — *ビルドする* (開発時のみ) | Windows + **.NET 10 SDK** |
| Node.js (開発時のみ) | ≥ 20 (単体テストは Node ≥ 22/24 の type-stripping を使用) |

Marketplace からインストールした後にコンパイルするものは何もありません。拡張機能には **x64 と ARM64
の両方** のビルド済み `xve-wpf-host.exe` が同梱されており、実行時にお使いの VS Code に合うほうが
選ばれます。

必要なのは **Desktop** ランタイム (`Microsoft.WindowsDesktop.App`) — 通常の .NET ランタイムとは別の
ダウンロード — で、しかも **VS Code と同じアーキテクチャ** のものです。ARM64 版 VS Code には ARM64 の
Desktop ランタイムが必要です。見つからない場合、XVE はダウンロードリンク付きの通知を表示し、Web
レンダラーにフォールバックします。

拡張機能は VS Code が動く場所ならどこでも動きます。**WPF ホストは任意** で Windows 専用です。他の
プラットフォーム (またはホストが利用できない場合) では Web レンダラーが使われます。

### ソースから実行する (開発)

```bash
npm install
npm run compile        # 拡張機能 + webview を dist/ にバンドル
npm run test:unit      # コアの単体テスト (Node test runner, type stripping)
npm run test:parity    # Web レンダラーと WPF ホストの描画パリティ (Playwright)
npm run docs:images    # docs/images/ の図とツールバーアイコンを再生成
```

`test:parity` は `samples/parity/` のフィクスチャを両方のバックエンドで描画し、得られたジオメトリを
比較します。ビルド済みの WPF ホストが必要 (下記参照) なため、Windows でのみ実行されます。

`docs:images` は `docs/images/*.svg` をすべて PNG に描画し、ツールバーアイコンを `@vscode/codicons`
から書き出し、スクリーンショットを幅 1200 px にその場で縮小します。冪等 (べきとう) です — すでに上限
以内の画像はそのまま残されます — ので、フル解像度のキャプチャを置いて再実行するだけで済みます。

その後、VS Code で **`F5`** → *Run Extension* を押します。新しい Extension Development Host ウィンドウ
で任意の `.xaml` ファイルを開くか、コマンドパレットから **「XVE: Open in XAML Visual Editor」** を
実行します。

### WPF ホストをビルドする (Windows のみ)

```bash
npm run build:host     # dotnet build wpf-host -c Release  (.NET 10 SDK が必要)
```

これにより `xve-wpf-host.exe` が生成され、高忠実度プレビューのために拡張機能が必要に応じて起動します。

---

## 3. 最初のステップ

1. **XAML ファイルを開く。** ビジュアルエディターは `priority: "option"` で登録されているため、
   `.xaml` ファイルは既定では通常のテキストエディターで開きます。
2. **ビジュアルエディターに切り替える。** エディターのタイトルバーで **「XVE: Open in XAML Visual
   Editor」** をクリックするか、コマンドパレットから `xve.openVisualEditor` を実行します。
3. **テキストに戻す。** ビジュアルエディターがアクティブな状態で、タイトルバーの
   **「XVE: Open XAML as Text」** (`xve.openTextEditor`) をクリックします。

タイトルバーの 2 つのボタンはコンテキストに応じて表示されます。「Visual Editor」ボタンは `.xaml`
ファイルがテキストとして開かれているときだけ、「as Text」ボタンはビジュアルエディターがアクティブな
ときだけ現れます。

(この文書冒頭のスクリーンショットは、3 つのパネルがすべて表示された状態でビジュアルエディターに開かれた
`.xaml` ファイルを示しています。)

---

## 4. インターフェース

ビジュアルエディターは 3 パネル構成です (冒頭の図を参照):

| パネル | 表示内容 |
|--------|----------|
| **構造ツリー** (左) | XAML 要素の階層。クリックで選択、ドラッグで並べ替え。幅を変更可能。 |
| **プレビュー** (中央) | 描画された面。ツールバー、ルーラー/ガイド、ズーム、選択オーバーレイ付き。 |
| **プロパティ** (右) | 選択要素の属性用の型付きエディターと *プロパティを追加*。幅を変更可能。 |

両側のパネルは折りたたみ・サイズ変更ができます。パネル幅とツールバーの位置はウィンドウごとに記憶
されます。

### プレビューのツールバー

ツールバーはプレビューの上に浮かびます。上下左右にドッキングするか、浮かせたままにでき、位置は
ウィンドウごとに記憶されます。2 つのボタンは状態によって見た目が変わるため、代表的な 2 つの構成を
示します。

**デザインビュー** — デザインボタンがアクティブで、ラベル付きのピル形に広がります。ズームのコントロール
が見えており、ホストのステータスドットは緑です (WPF ホストが動作し、正常に描画しています):

![デザインビューのツールバー](../images/toolbar-design.png)

**変更ビュー** — 変更ボタンがアクティブで、保留中の変更数を表示します。ズームのコントロールは消え
(デザイン面に属するもので、差分には属さないため)、パンツールが選択され、このウィンドウが Web
レンダラーを使っているのでドットは灰色です:

![変更ビューのツールバー](../images/toolbar-changes.png)

この 2 つの違いは互いに独立しています。**ズームパネルが隠れているのは、あくまでビューモードが変更だから**
であり、**ドットの色はプレビューバックエンドとホストの描画状態だけで決まります** — ビューモードとは
無関係です。

#### すべてのコントロール (左から右へ)

| アイコン | コントロール | 種類 | 動作 |
|:--------:|--------------|------|------|
| ![](../images/icons/gripper.png) | **ツールバーを移動** | ドラッグハンドル | ツールバーをドラッグし、端の近くで放すとドッキングします。 |
| ![](../images/icons/layout-sidebar-left.png) | **構造を表示** | ボタン *(条件付き)* | 構造パネルを再度開きます。そのパネルが折りたたまれている間だけ表示されます。 |
| ![](../images/icons/pan.png) | **パン** | ツール | ドラッグでプレビューをスクロールします。マウス中ボタンでもいつでも利用できます。 |
| ![](../images/icons/move.png) | **選択 / 移動** | ツール | 要素を選択し、ドラッグで移動し、8 つのハンドルでサイズ変更します。 |
| ![](../images/icons/list-tree.png) | **並べ替え** | ツール | プレビュー内で要素をドラッグし、ツリーと同様に兄弟間の順序を変えます。**これが既定のツールです。** |
| ![](../images/icons/eye.png) | **自動展開** | トグル | 選択要素のドロップダウン/メニュー (ComboBox, Menu, …) を自動的に開きます。**既定でオン。** |
| ![](../images/icons/discard.png) | **元に戻す** | ボタン | 直前の編集を取り消します (VS Code ネイティブの取り消しスタック)。 |
| ![](../images/icons/redo.png) | **やり直し** | ボタン | やり直します。 |
| ![](../images/icons/trash.png) | **削除** | ボタン | 選択要素を削除します (<kbd>Del</kbd> キーと同じ)。 |
| ![](../images/icons/edit.png) | **デザイン** | ビュー切り替え | ライブのデザイン面。アクティブ時にラベル付きのピル形へ広がります。 |
| ![](../images/icons/git-compare.png) | **変更** | ビュー切り替え | 保存済みファイルとの差分。アクティブ時は *変更 (n)*、非アクティブ時は *n* のみをバッジ表示し、変更がなければ何も表示しません。 |
| ![](../images/icons/symbol-numeric.png) | **グリッド** | トグル | ドットグリッドのオーバーレイ。オンにするとグリッドへのスナップも有効になります — 独立した磁石ボタンはありません。**既定でオフ。** |
| ![](../images/icons/symbol-ruler.png) | **ルーラー** | トグル | ルーラー、ドラッグ可能なガイド、ガイドへのスナップ。**既定でオン。** |
| ![](../images/icons/symbol-color.png) | **プレビューのテーマ** | メニュー | プロジェクト内で見つかったリソースディクショナリのテーマ、続いて標準セット: Classic, Classic '98, System, Light, Dark, Native。[セクション 6](#6-プレビューバックエンド) を参照。 |
| ![](../images/icons/server-process.png) | **プレビューエンジン** | メニュー | `Auto`、`Web`、そして Windows のみ `WPF host` と `WPF host — isolated`。[セクション 6](#6-プレビューバックエンド) を参照。 |
| ![](../images/icons/play.png) | **ウィンドウで実行** | メニュー | XAML を実際の Windows ウィンドウで開きます: *Snapshot* (一度きり) または *Live* (プロジェクトに追従)。WPF エンジン、Windows のみ。 |
| ![](../images/icons/package.png) | **プロジェクトリソース** | ダイアログ | 読み込むカスタムコントロール DLL、`App.xaml`、リソースディクショナリを選びます。[セクション 7](#7-プロジェクトリソース-wpf-ホスト) を参照。 |
| ![](../images/icons/dot-ok.png) | **ホストの状態** | インジケーター + ボタン | WPF ホストの状態 (下の表を参照)。クリックでコンソール/ログを開きます。 |
| ![](../images/icons/layout-sidebar-right.png) | **プロパティを表示** | ボタン *(条件付き)* | プロパティパネルを再度開きます。そのパネルが折りたたまれている間だけ表示されます。 |
| ![](../images/icons/triangle-right.png) | **ツールバーのサイズ変更** | ドラッグハンドル *(条件付き)* | ドラッグしてツールバーのサイズを変えます。ツールバーが浮いている (ドッキングしていない) 間だけ表示されます。 |

パン、選択、並べ替えは排他的です — 常にちょうど 1 つがアクティブです。

#### ホストのステータスドット

| ドット | 意味 |
|:------:|------|
| ![](../images/icons/dot-ok.png) | WPF ホストが動作しており、直近の描画に成功しました。 |
| ![](../images/icons/dot-idle.png) | WPF ホストが起動中です。 |
| ![](../images/icons/dot-error.png) | WPF ホストが描画エラーを報告しました。コンソールが自動で開きます。 |
| ![](../images/icons/dot-inactive.png) | WPF ホストなし: Windows 以外か、プレビューエンジンが `Web` に設定されています。エラーではありません。 |

ドットを囲む **青いリング** は、プロジェクトリソースが現在読み込まれていることを意味します。色に
かかわらず、ドットをクリックすると常にコンソール/ログが開きます。ホストが分離されている場合は
ツールチップにその旨が表示されます。

#### ズームパネル

![](../images/icons/zoom-out.png) ![](../images/icons/zoom-in.png)
![](../images/icons/screen-full.png)

ズームは **ツールバーの一部ではありません** — プレビュー右下隅の独立した小さなパネルです: *縮小*、
現在の倍率 (クリックで 100 % に戻す)、*拡大*、*全体表示*。変更ビューでは非表示になります。ツールバー
が下端にドッキングしていて余地がある場合、ズームパネルはツールバーの右端にドッキングします。上の
デザインビューのスクリーンショットで 1 本のバーに見えるのはそのためです。

---

## 5. 機能

### 5.1 構造ツリーと並べ替え

ツリーは XAML の階層を映します。ノードをクリックすると選択されます (対応する要素がプレビューで強調
されます)。**ノードをドラッグ** すると並べ替えられます。ドロップ領域は対象の *前*、*内部*、*後* を
示し、自分自身のサブツリーへのドロップは禁止されます。移動は外科的な `moveElement` として適用され、
インデントは保持されます。

### 5.2 ビジュアル編集 — 移動とサイズ変更

**選択** ツールで、プレビュー内の要素をクリックして選択します。その後:

- ドラッグで **移動**。親のレイアウトに応じて、移動は `Margin` (ほとんどのパネル) または
  `Canvas.Left/Top` (`Canvas` の内部) を更新します。
- **8 つのハンドル** (角 + 辺) で **サイズ変更**。これは `Width`/`Height` (必要に応じて `Margin`) を
  更新します。
- **ライブプレビュー** が操作に追従し、放した時点で変更が 1 回の外科的書き込み (`setAttributes`) と
  して確定します。

![8 つのサイズ変更ハンドルとともに選択された要素](../images/screen-drag-resize.png)

### 5.3 要素の追加 / 削除 / コピー

- ツールバーから要素を **追加**: よく使う 15 種類 (Grid, StackPanel, Canvas, Border, TextBlock,
  Label, Button, TextBox, CheckBox, RadioButton, Slider, ProgressBar, Image, Ellipse, Rectangle) から
  選びます。既定のスニペットが選択中のコンテナーに挿入されます。
- **Delete** キーで選択要素を **削除**。
- **Ctrl+C / Ctrl+X / Ctrl+V** でサブツリーを **コピー / 切り取り / 貼り付け** (兄弟または子として
  貼り付け)。クリップボードは **システムのクリップボード** で、要素は XAML 断片としてコピーされる
  ため、**XVE のウィンドウ間** でも、**テキストエディター** との双方向でも機能します。貼り付け時の
  任意の `x:Name` 重複解消 (設定 `xve.paste.nameDeduplication`、既定はオフ) は、元を変更せずに衝突
  する名前を一意な名前に変更します。

### 5.4 プロパティパネル

<img src="../images/screen-properties.png" align="right" width="280"
     alt="ブラシのカラーピッカーを開いた状態と変更済み属性を含むプロパティパネル">

パネルは各プロパティの種類に応じた **型付きエディター** を表示します:

| 種類 | エディター |
|------|------------|
| `bool` | チェックボックス |
| `enum` | ドロップダウン |
| `number` | 数値フィールド |
| `brush` | カラーピッカー |
| `thickness` | L,T,R,B の 4 フィールド |
| `string` | テキストフィールド |

共通プロパティ (Name, Width/Height, Min/Max サイズ, Margin, Padding, 配置, Background/Foreground,
BorderBrush/Thickness, フォント, Opacity, Visibility, IsEnabled…)、添付プロパティ
(`Grid.Row/Column`, `Canvas.Left/Top`, `DockPanel.Dock`)、型固有のもの (Text, Content, IsChecked,
Value/Minimum/Maximum など) を扱います。

既知のプロパティを追加するには **「+ プロパティを追加」** を、削除するには属性ごとのコントロールを
使います。**前回の保存以降に変更された** 属性は色付きのバーで強調され、属性ごとの **元に戻す**
ボタンが付きます。スクリーンショットでは `BorderBrush` がカラーピッカーで編集され、
`VerticalAlignment` は手つかずです。

<br clear="right">

### 5.5 変更ビュー (差分)

ツールバーを **デザイン** から **変更** に切り替えると、**保存済みファイル** との差異がすべて表示され
ます: 変更された属性、追加された要素、削除された要素、移動された要素 (LCS のツリー照合で検出するため、
並べ替えが追加+削除として報告されることはありません)。各項目には **ハンク単位の元に戻す** ボタンがあり、
**すべて元に戻す** 操作も用意されています。項目をクリックすると、プレビューでその要素が選択されます。
元に戻す処理は編集と同じ外科的な操作を使います。

![変更・追加・削除の項目が並ぶ変更ビュー](../images/screen-changes.png)

### 5.6 ズームとナビゲーション

ズームの範囲は **10〜800 %** です。プレビュー右下隅のズームパネル、**Ctrl+ホイール** (カーソル位置を
基準)、または **全体表示** でプレビューをウィンドウに合わせます。既定 (`xve.preview.fitOnOpen`) では、
ドキュメントは開いたときに調整されます。ビューより大きければ縮小し、そうでなければ 100 % で表示します
(決して拡大しません)。パンツールまたはマウス中ボタンで **パン** します。ルーラー、ガイド、スナップは
いずれも現在のズームに従います。

### 5.7 ルーラー、ガイド、グリッドスナップ

ツールバーから **ルーラー** (上/左) とドット **グリッド** のオーバーレイを切り替えます。ルーラーを
クリックして **ガイド** を追加し、ドラッグで移動、ダブルクリックで削除します。移動/サイズ変更の間、
要素はグリッドとガイドに **スナップ** します。グリッドの刻みとスナップのしきい値は
`xve.canvas.gridStep` (既定 8 px) で設定します。

### 5.8 テキストエディターとの選択同期

テキストエディターを横に開いていると、選択は **双方向** になります:

- **ビジュアル → テキスト** (`xve.sync.selectInTextEditor`): 要素を選択すると、テキストカーソルが
  その開始タグへ移動します。下の例では、構造ツリーで 2 番目の `CheckBox` を選ぶとエディターが 10 行目
  へ移動します。

  ![ツリーで要素を選ぶとテキストカーソルが移動する](../images/screen-sync1.png)

- **テキスト → ビジュアル** (`xve.sync.selectFromTextCursor`): コード内でカーソルを動かすと、対応する
  要素がプレビューで選択されます。下の例では、カーソルは 9 行目にあり、最初の `CheckBox` がサイズ変更
  ハンドル付きでプレビューに選択されています。

  ![テキストカーソルを動かすと対応する要素が選択される](../images/screen-sync2.png)

どちらの方向も既定で有効で、それぞれ独立して切り替えられます。テキストエディターはビジュアル
エディターの下に分割しても、横に並べても構いません — どちらの配置でも動作します。

### 5.9 UI の言語

インターフェースは **7 言語** にローカライズされています。`xve.language` を設定します (空 = VS Code に
従う)。変更後は **Ctrl+R** で webview を再読み込みして適用します。

---

## 6. プレビューバックエンド

![プレビューバックエンド](../images/preview-backends.png)

XVE には 2 つのレンダリングエンジンがあり、**`xve.previewBackend`** で選びます:

- **`auto`** (既定) — Windows では WPF ホスト、それ以外では Web レンダラー。
- **`web`** — クロスプラットフォームの Web レンダラー (XAML のサブセット → HTML/CSS)。
- **`wpf-host`** — Windows の WPF ホスト (実際の WPF エンジン、高忠実度)。

ツールバーのエンジンセレクターからウィンドウごとに上書きすることもできます。そこには 4 番目の項目
*WPF host — isolated* があります (後述の [分離](#分離-xvepreviewisolation) を参照)。WPF ホストが失敗
またはタイムアウトすると、XVE は自動的に Web レンダラーへフォールバックします。まったく起動できない
場合 — 最も多いのは **.NET 10 Desktop Runtime** が未インストールのケース — ダウンロードリンク付きの
通知が表示されます。

### Web レンダラーにおけるスタイルとリソース

Web レンダラーは、タグを `<div>` に対応付けるだけのものではありません。描画前に、XVE はドキュメントの
リソースのうち CSS に対応付けられるサブセットを抽出して適用します:

- **ブラシ** — キーで参照される `SolidColorBrush` と `ImageBrush` のリソース。
- **スタイル** — 単純な `Setter` (レンダラーが理解できるプロパティ) を持つ `Style`。平坦化される
  **`BasedOn` チェーン** も含みます。
- **暗黙スタイル** — `TargetType` を持つキーなしの `Style` は、WPF とまったく同様に、その型のすべての
  要素に適用されます。
- **リソース解決** — `{StaticResource key}` と `{DynamicResource key}` はドキュメントのリソース
  ディクショナリに対して解決されます。

優先順位は WPF に従います: 暗黙スタイル → 名前付きスタイル (`BasedOn` チェーンを含む) → インライン
属性で、常にインライン属性が勝ちます。このサブセットの外にあるもの (トリガー、テンプレート、
コンバーター、データへのバインディング) は Web レンダラーでは無視されます — 忠実に必要な場合は WPF
ホストを使ってください。

### プレビューのテーマ

テーマの選択 (![](../images/icons/symbol-color.png)) では標準セット — **Classic** (素の WPF)、
**Classic '98**、および WPF ホストが `ThemeMode` で適用する Fluent の **Light** / **Dark** / **System**
— が提供されます。**プロジェクト内で見つかったリソースディクショナリのテーマ** はその上に並び、同じ
ように適用できます。`Native` は GTK/Linux 風の見た目で、Web レンダラーにのみ影響します (WPF ホストは
Classic にフォールバックします)。

![プロジェクトのディクショナリを含む複数のテーマでの同じフォーム](../images/screen-themes.png)

### WPF ホストのオプション

| 設定 | 目的 |
|------|------|
| `xve.preview.theme` | プレビューのテーマ: `none` (Classic)、`classic98`、`system`/`light`/`dark` (Fluent)、`native` (GTK 風、Web のみ)。 |
| `xve.preview.renderScale` | スーパーサンプリング: `auto` = device pixel ratio (HiDPI で鮮明)、または `1`/`1.5`/`2`/`3`。 |
| `xve.preview.maxResolution` | ビットマップサイズの上限 (長辺、デバイスピクセル)。`0` = 無制限。 |
| `xve.preview.viewportRender` | 可視領域だけを描画 — 大きなデザインで高速。 |
| `xve.preview.capBasis` | 可視領域の描画: `maxResolution` を可視領域だけで測る (`visible`、ウィンドウサイズによらず鮮明さが安定) か、オーバースキャンを含むスライス全体で測る (`slice`、旧来の挙動)。 |
| `xve.preview.overscan` | 可視領域の描画: スクロール用のバッファーとして可視領域の周囲に描画する追加余白 (プロジェクト単位)。 |
| `xve.preview.debugConsole` | プレビュー下部に、ライブの描画テレメトリーを表示するデバッグコンソールを出します。 |
| `xve.preview.consoleOnStart` | ホストの起動中にコンソールをドッキングします。オフでも、描画エラー時には自動で開きます。 |
| `xve.preview.isolation` | ファイルが専用のホストプロセスとリソースを持つかどうか (後述)。 |

### 適応解像度

ドラッグの各フレームで大きな面をフル HiDPI 解像度で描画するのは高コストです。
**`xve.preview.adaptiveRes`** (**既定でオン**) では、*ドラッグ、スクロール、ズームの最中* はホストが
低い解像度 (`xve.preview.motionResolution`、既定は長辺 512 px) で描画し、動きが止まり次第、フルの
`maxResolution` で一度だけ描き直します。速い動きは滑らかなまま、静止時の画像は鮮明なままです。

この劣化は無条件ではありません。フル解像度の描画が **`xve.preview.adaptiveFpsThreshold`** フレーム/秒
(既定 30) を下回るときだけ働きます。したがって、小さなデザインを高速なマシンで扱う限り、フル解像度を
離れることはありません。しきい値を `0` にすると、動作中は常に動作時解像度を使います。

### ドラッグ/サイズ変更時のライブプレビュー戦略

WPF ホストモードでドラッグ/サイズ変更する際、ライブの再描画は次で制御されます:

- `xve.preview.dragStrategy` — `overlay` (ライブ再描画なし)、`frames` (N フレームごと)、`ms`
  (N ミリ秒ごと、既定)。
- `xve.preview.dragIntervalMs` (既定 25)、`xve.preview.dragFrames` (既定 2)。
- `xve.preview.dragCoalesce` — 同時に進行する描画を最大 1 件に保つ (古いフレームは破棄)。
- `xve.preview.dragSession` — 一度だけ解析し、再解析せずにキャッシュしたツリーを変更する。
- `xve.preview.dragOnChange` — ドラッグ中の要素の属性が実際に変わったときだけ新しいフレームを描画する。
  ポインターを静止させていてもコストはかかりません。
- `xve.preview.debugLiveDrag` — デバッグコンソールのテレメトリーもドラッグの各フレームで更新する。

### 分離 (`xve.preview.isolation`)

WPF ホストはプロジェクトリソースを読み込むことができ、それがカスタム型の描画に影響します。分離は、
ファイルがホストを共有するか専用のホストを得るかを制御します:

- `ask` — 別プロジェクトの (またはプロジェクトに属さない) ファイルについて、分離するか尋ねる。
- `auto` (既定) — そうしたファイルは自動的に分離し、開いているプロジェクト内では 1 つのホストを共有する。
- `shared` — 決して分離しない (すべてに 1 つのホスト)。
- `isolated` — 常に分離する (ファイルごとに別のホスト)。

---

## 7. プロジェクトリソース (WPF ホスト)

**カスタムコントロール** とプロジェクトのテーマを忠実にプレビューするため、WPF ホストはプロジェクトの
リソースを読み込めます。XVE は XAML ファイルから上方向に `.csproj` を探し、最適な
`bin/<Config>/<tfm>` 出力に加えて `App.xaml` とリソースディクショナリを見つけます。

- 選択は **QuickPick** で提示され、プロジェクトごとに記憶されます。方針は
  **`xve.project.autoLoadResources`** (`ask` / `always` / `never`) で設定します。
- ホストはカスタムコントロールの **DLL** を (`clr-namespace` 型については `AssemblyResolve` 経由で)
  読み込み、`App.xaml` / ディクショナリを `Application.Resources` にマージします。
- プレビューのツールバーにある **プロジェクトリソース** ボタン (![](../images/icons/package.png)) で、
  いつでもリソースを選び直せます。

![リソース選択ダイアログとともに、WPF ホストが描画したカスタムコントロール](../images/screen-wpf-host.png)

---

## 8. エラー処理

XAML の解析や描画に失敗したとき、XVE は原因の特定と修正を助けます:

- **コード内の変更を強調** (`xve.editor.highlightChanges`) — 変更された行が隣のテキストエディターで
  着色されます (変更パネルのトグルと連動)。
- **コード内のエラーを強調** (`xve.editor.highlightErrors`) — エラー行が着色され、問題のトークンに
  下線が引かれます。エラーをクリックすると、テキストエディターでその位置が表示されます。
- **自動修正の提案** — 未知の型やプロパティに対し、編集距離の照合で最も近い既知の名前 (例: `Buton` →
  `Button`) を提案します。
- **コンソール** — ホストのステータスドットをクリックして開きます。描画エラー時には
  `xve.preview.consoleOnStart` の設定にかかわらず自動的に開きます。

![描画エラーを表示するホストコンソール](../images/screen-host-console.png)

### WPF ホストが起動できないとき

ホストのバイナリが見つからない、**.NET 10 Desktop Runtime** が未インストール、または起動時にプロセスが
落ちた場合、XVE はこの 3 つのどれが起きたかを説明する通知を表示し、静かに Web レンダラーへフォール
バックします。通知からはランタイムをダウンロードするか、`xve.previewBackend` を `web` に切り替えて
ホストの起動自体をやめることができます。各種類の失敗はセッションごとに一度だけ報告されます。

---

## 9. 設定リファレンス

すべての設定は **`xve.*`** の下にあります。多くはウィンドウスコープなので、VS Code のウィンドウごとに
異なり得ます。以下の既定値は `package.json` と一致します。

| 設定 | 型 | 既定 | 説明 |
|------|----|------|------|
| `xve.language` | enum | `""` | UI の言語 (`""`=VS Code に従う、`en`,`pl`,`es`,`de`,`fr`,`ja`,`zh`)。Ctrl+R で再読み込み。 |
| `xve.project.autoLoadResources` | enum | `ask` | WPF ホスト向けにプロジェクトリソースをどう読み込むか: `ask` / `always` / `never`。 |
| `xve.sync.selectInTextEditor` | bool | `true` | 要素を選択すると、テキストカーソルがそこへ移動する。 |
| `xve.sync.selectFromTextCursor` | bool | `true` | テキストカーソルを動かすと、対応する要素が選択される。 |
| `xve.editor.highlightChanges` | bool | `true` | テキストエディターで変更行を着色する。 |
| `xve.editor.highlightErrors` | bool | `true` | テキストエディターでエラー行を着色/下線表示する。 |
| `xve.paste.nameDeduplication` | enum | `off` | 貼り付け時の `x:Name` 衝突: `off` (そのまま貼り付け) / `rename` / `renameAndReferences` (貼り付けたサブツリー内の `ElementName`, `x:Reference` も修正)。 |
| `xve.previewBackend` | enum | `auto` | プレビューエンジン: `auto` / `web` / `wpf-host`。 |
| `xve.preview.isolation` | enum | `auto` | WPF ホストの分離: `ask` / `auto` / `shared` / `isolated`。 |
| `xve.preview.renderScale` | enum | `auto` | スーパーサンプリング: `auto` / `1` / `1.5` / `2` / `3`。 |
| `xve.preview.maxResolution` | number | `1536` | ビットマップの最大サイズ (長辺、デバイス px)。`0`=無制限。 |
| `xve.preview.theme` | enum | `none` | プレビューのテーマ: `none` / `classic98` / `system` / `light` / `dark` / `native`。 |
| `xve.preview.viewportRender` | bool | `true` | 可視領域だけを描画する。 |
| `xve.preview.capBasis` | enum | `visible` | 可視領域の描画: 上限の基準 — `visible` / `slice`。 |
| `xve.preview.overscan` | number | `100` | 可視領域の描画: 可視領域の周囲の余白 (プロジェクト単位)。 |
| `xve.preview.debugConsole` | bool | `false` | プレビュー下部の、描画テレメトリー付きデバッグコンソール。 |
| `xve.preview.consoleOnStart` | bool | `true` | ホスト起動中にコンソールをドッキング。オフ = 起動中は非表示だが、描画エラー時には表示。 |
| `xve.preview.debugLiveDrag` | bool | `false` | ドラッグの各フレームでもコンソールのテレメトリーを更新する。 |
| `xve.preview.dragStrategy` | enum | `ms` | ライブドラッグの戦略: `overlay` / `frames` / `ms`。 |
| `xve.preview.dragIntervalMs` | number | `25` | `ms` の場合: ライブ再描画の最小間隔 (ms)。 |
| `xve.preview.dragFrames` | number | `2` | `frames` の場合: N フレームごとに再描画。 |
| `xve.preview.dragCoalesce` | bool | `true` | ドラッグ/スクロール中、進行中の描画を最大 1 件に保つ。 |
| `xve.preview.dragSession` | bool | `true` | 永続的なドラッグセッション (一度解析し、キャッシュしたツリーを変更)。 |
| `xve.preview.dragOnChange` | bool | `true` | ドラッグ中、要素の属性が実際に変わったときだけ描画する。 |
| `xve.preview.adaptiveRes` | bool | `true` | 適応解像度: 動作中は `motionResolution`、停止後に一度だけフルの `maxResolution` で描画。 |
| `xve.preview.motionResolution` | number | `512` | 適応解像度が有効なときに動作中に使う解像度 (長辺、デバイス px)。 |
| `xve.preview.adaptiveFpsThreshold` | number | `30` | フル解像度の描画がこの FPS を下回るときだけ `motionResolution` に落とす。`0` = 常に。 |
| `xve.preview.fitOnOpen` | bool | `true` | 開いたときにプレビューをウィンドウに合わせる (拡大はしない)。 |
| `xve.canvas.gridStep` | number | `8` | グリッドの刻みとスナップのしきい値 (ピクセル)。 |
| `xve.canvas.showGrid` | bool | `false` | ドットグリッドのオーバーレイ表示の初期値。 |
| `xve.canvas.showRulers` | bool | `true` | ルーラー/ガイド表示の初期値。 |

### コマンド

| コマンド | タイトル | 条件 |
|----------|----------|------|
| `xve.openVisualEditor` | XVE: Open in XAML Visual Editor | `.xaml` がテキストとして開かれている |
| `xve.openTextEditor` | XVE: Open XAML as Text | `.xaml` がビジュアルエディターで開かれている |

---

## 10. キーボードショートカット

| ショートカット | 動作 |
|----------------|------|
| **Ctrl+Z / Ctrl+Y** | 元に戻す / やり直し (VS Code ネイティブ、TextDocument 経由) |
| **Delete** | 選択要素を削除 |
| **Ctrl+C / Ctrl+X / Ctrl+V** | 選択サブツリーのコピー / 切り取り / 貼り付け (システムのクリップボード、XAML) |
| **Ctrl+ホイール** | カーソル位置を基準に拡大/縮小 |
| **マウス中ボタン / パンツール** | キャンバスをパン |
| **Ctrl+R** | webview を再読み込み (言語変更の適用など) |

XVE は独自のキーバインドを登録しません。VS Code 組み込みのエディターコマンドに依存します。

---

## 11. アーキテクチャ

![アーキテクチャ](../images/architecture.png)

拡張機能は 2 つの協調するコンテキストと、任意のネイティブホストで動作します:

- **拡張機能ホスト (Node/TS)** — `extension.ts` が拡張機能を有効化してコマンドを登録し、
  `XveEditorProvider` が `CustomTextEditorProvider` です。実際の処理は `core/` のモジュールが担います:
  `XamlDocument` (外科的保存)、`XamlParser` (位置情報付きトークナイザー)、`StructuralDiff` /
  `LineDiff`、`TypeRegistry` (型とプロパティのメタデータ)、`ResourceModel` (ブラシ、スタイル、
  `BasedOn`)、`ProjectScanner` (`.csproj` → DLL とディクショナリ)、`PasteNames` (`x:Name` の重複解消)、
  `Localization`。`host/WpfHost` は WPF ホストプロセスを管理し、致命的な起動失敗を報告します。
- **Webview (HTML/CSS/TS)** — `main.ts` がツリー、プロパティ、ツールバー、UI を駆動します。
  `renderer.ts` は Web の XAML→DOM レンダラー、`styleResolver.ts` は抽出した XAML のスタイル/リソースを
  CSS として適用し、`style.css` は 3 パネルのレイアウトです。`postMessage` で拡張機能ホストと通信します。
- **WPF ホスト (Windows)** — `xve-wpf-host.exe` (.NET 10) が実際の WPF エンジンで XAML を PNG と
  ヒットテストマップ (注入された `x:Uid` を利用) に描画し、stdio 上の JSON-lines プロトコルでやり取り
  します。プロジェクト全体で共有することも、ファイルごとに分離することもできます。

### 編集の流れ

![編集の流れ](../images/edit-flow.png)

すべての編集 — プロパティ変更、ドラッグ/サイズ変更、並べ替え — は `XamlDocument` によって最小限の
テキスト編集の集合に変換され、`WorkspaceEdit` 経由で適用されます。その後ドキュメントが再解析され、
プレビューが再描画されます。`TextDocument` が常に信頼できる情報源であるため、元に戻す/やり直しは
ネイティブに動作し、手を触れていない領域は決して変化しません。

---

## 12. サンプルファイル

`samples/` フォルダーには、エディターを試すために開ける XAML ファイルがあります:

| ファイル | 内容 |
|----------|------|
| [`samples/SampleGrid.xaml`](../../samples/SampleGrid.xaml) | `RowDefinitions`/`ColumnDefinitions`、スパン、配置を使った `Grid` のフォームレイアウト。 |
| [`samples/SampleControls.xaml`](../../samples/SampleControls.xaml) | `Menu`、`ComboBox`、`ScrollViewer` — ドロップダウンの自動展開や領域ごとのスクロールの確認に最適。 |
| `samples/Sample.xaml`, `Sample2.xaml` | `Window` + `StackPanel` の基本的な例。 |

`SampleControls.xaml` では、自動展開をオンにして `MenuItem` や `ComboBox` を選ぶとサブメニュー/リストが
開きます。`ScrollViewer` にポインターを重ねてホイールを回すと、その領域だけがスクロールします。

---

## 13. トラブルシューティング / FAQ

**`.xaml` ファイルがビジュアルエディターではなくプレーンテキストで開く。**
仕様です — ビジュアルエディターは *オプション* です。タイトルバーのボタンか `xve.openVisualEditor` で
切り替えてください。

**プレビューが近似的に見える / カスタムコントロールがプレースホルダーになる。**
おそらく Web レンダラーを使っています。Windows では `xve.previewBackend` を `auto` か `wpf-host` に
設定し、**プロジェクトリソース** ボタンで
[プロジェクトリソース](#7-プロジェクトリソース-wpf-ホスト) を読み込んでください。

**ホストのステータスドットが灰色のままで、プレビューが WPF を使わない。**
灰色はホストが非アクティブという意味です — Windows でないか、`xve.previewBackend` が `web` です。
`wpf-host` に切り替えてもなお灰色なら、エラー通知を確認してください。最も多い原因は
[.NET 10 Desktop Runtime](https://dotnet.microsoft.com/download/dotnet/10.0) の欠如です。*Desktop*
ランタイムは通常の .NET ランタイムとは別のダウンロードである点に注意してください。

**WPF ホストでカスタム型がやはり描画されない。**
プロジェクトがビルド済みであること (`bin/...` の下に DLL が存在すること)、そして正しいリソースを選んで
いることを確認してください。ホストのステータスドットをクリックしてログを読みます。

**UI の言語が違う。**
`xve.language` を設定し、**Ctrl+R** で webview を再読み込みします。

**大きなデザインでドラッグが重い。**
`xve.preview.viewportRender` と `xve.preview.adaptiveRes` をオンのままにしてください。両者が組み合わさる
ことで、可視領域だけを、しかも動作中は低い解像度で描画します。それでも重い場合は
`xve.preview.motionResolution` を下げる (例: 384) か、`xve.preview.adaptiveFpsThreshold` を上げて低解像度
モードが早く働くようにします。`0` にすると、動作中は常に動作時解像度を使います。`dragStrategy` は `ms`
のままにしてください。

---

## 14. 開発の歴史

XVE は段階を踏んで作られました。要約した歴史:

- **ステージ 8** — レイアウトの忠実度とプロパティ: Web レンダラーでの WPF 風のサイズ強制、共通プロパティ
  の完全な一式、忠実な `Grid` (`RowDefinitions`/`ColumnDefinitions`、スパン、セルの配置)、ツリーの
  **並べ替え**、WPF ホスト向けの **プロジェクトリソース**。
- **ステージ 7** — 画面解像度での描画 (`renderScale`、既定 `auto`=device pixel ratio)、
  `xve.preview.*` の信頼できる情報源としての VS Code、ホストの性能改善 (デバウンス + コアレッシング、
  キャッシュされた `ThemeMode`、`RenderTargetBitmap` の再利用、ホストの事前起動)。
- **ステージ 6** — **ズーム** (10〜800 %、Ctrl+ホイール、全体表示)、**WPF ホスト** (`wpf-host/`、
  .NET 10、JSON-lines)、ビューポート描画、解像度上限、設定パネル。
- **ステージ 4** — `LineDiff` + `StructuralDiff` と、ハンク単位およびすべて元に戻すを備えた **変更**
  ビュー。
- **ステージ 3** — ビジュアル編集 (ドラッグ/サイズ変更)、`XamlDocument` の構造操作、追加/削除の
  ツールバー、安定したビューポートでのルーラー/ガイド/スナップ。
- **それ以前** — `*.xaml` 用のカスタムテキストエディター、`XamlDocument` と位置情報付き `XamlParser`、
  Web レンダラー、双方向の選択、型付きプロパティパネル、ローカライズ (7 言語)、ラウンドトリップ /
  外科的保存のテスト。
