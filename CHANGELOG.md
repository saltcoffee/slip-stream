# Changelog

All notable changes to SlipStream are documented in this file.

## [Unreleased]

## [0.1.1] - 2026-11-12

### Fixed

- Resolved Obsidian plugin review errors: unsafe `innerHTML` usage, detaching leaves in `onunload`, and direct static style assignment.
- Addressed remaining review warnings: declarative settings (`getSettingDefinitions`), Obsidian `getLanguage()`, console logging, plugin-id-prefixed command IDs, unnecessary type assertions, Promise/void mismatches, unawaited promises, and the `builtin-modules` dependency.

### Changed

- `docs/` is no longer tracked in the repository (kept local only).
- Added this changelog.

## [0.1.0] - 2026-11-12

### Added

- Desk-style card stream view for folders, tags, backlinks and outlinks.
- Full / snippet / compact reading densities.
- Drag-to-cite with automatic block references and templates A/B/C/D.
- Citation history with jump-back to the source paragraph.
- Bilingual interface (中文 / English) following the Obsidian language, with a manual override.
- Settings tab, commands, ribbon icon, and file/editor context menus.
- Optional bilingual sample folders (`zh/` + `en/`) selected by interface language.
