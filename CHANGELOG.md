# Changelog

All notable changes to the **XAML Visual Editor (XVE)** extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] — 2026-07-08

Documentation and metadata only; no change to the extension's behaviour.

### Added

- Full documentation in all seven UI languages: Español, Deutsch, Français, 日本語, 中文
  (previously English and Polski only).
- Animated `layout-overview.gif` in the README.

### Changed

- Dropped the non-standard `Other` category from the manifest (the Marketplace rejected it anyway).

## [0.1.0] — 2026-07-08

First public release.

### Added

- **Visual editing** — select, drag-to-move (`Margin` / `Canvas.Left/Top`) and resize with
  8 handles, with a live preview. Every gesture is committed as a single **surgical write**:
  only the bytes that must change are touched, so formatting, comments and indentation are
  preserved and native VS Code undo/redo keeps working.
- **Structure tree** with drag-to-reorder, and a **typed properties panel** (bool, enum, brush,
  number, thickness, string) with add/remove and per-attribute revert.
- **Changes view** — a structural diff against the saved file (changed / added / removed / moved
  elements, matched with an LCS tree diff) with revert-per-hunk and Revert all.
- **Two preview engines**:
  - a cross-platform **web renderer** (XAML subset → HTML/CSS, including `{StaticResource}`,
    `Style`/`Setter`, `BasedOn` chains and implicit styles);
  - a Windows-only **WPF host** (`xve-wpf-host.exe`, .NET 10) rendering with the real WPF engine —
    Classic / '98 / Fluent light·dark·system themes, HiDPI supersampling, custom-control DLLs,
    `App.xaml` and resource dictionaries. A prebuilt native app host ships for both **x64 and
    ARM64**; it requires the .NET 10 Desktop Runtime, and XVE points you to it if it is missing.
- **Preview performance controls** — visible-area (viewport) rendering, adaptive resolution
  (low-res while moving, sharp when idle), persistent drag sessions, in-flight coalescing.
- **Host isolation** — run a separate WPF host with its own resources per file
  (`xve.preview.isolation`).
- **Zoom** 10–800 % (Ctrl+scroll anchored at the cursor, Fit to window), rulers, guides and
  snap-to-grid.
- **Two-way selection sync** with a side-by-side text editor, plus change/error line highlighting
  in the text editor.
- **`x:Name` deduplication on paste** (`xve.paste.nameDeduplication`), optionally rewriting
  internal `ElementName` / `x:Reference` references.
- **Run in a real Windows window** (snapshot or live) via the WPF host.
- **Localized UI** — English, Polski, Español, Deutsch, Français, 日本語, 中文.

[0.1.0]: https://github.com/Zete-Pl/XVE-VS-Code-XAML-Visual-Editor/releases/tag/v0.1.0
