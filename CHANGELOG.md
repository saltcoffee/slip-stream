# Changelog

All notable changes to SlipStream are documented in this file.

## [Unreleased]

### Changed

- Address Obsidian plugin review warnings: declarative settings (`getSettingDefinitions`), use Obsidian `getLanguage()`, remove direct `innerHTML` writes, avoid console logging, remove plugin-id-prefixed command IDs, use `setCssProps`, and drop the `builtin-modules` dependency.

## [0.1.0] - 2026-11-12

### Added

- Desk-style card stream view for folders, tags, backlinks and outlinks.
- Full / snippet / compact reading densities.
- Drag-to-cite with automatic block references and templates A/B/C/D.
- Citation history with jump-back to the source paragraph.
- Bilingual interface (中文 / English) following the Obsidian language, with a manual override.
- Settings tab, commands, ribbon icon, and file/editor context menus.
- Optional bilingual sample folders (`zh/` + `en/`) selected by interface language.
