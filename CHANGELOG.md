# Changelog

All notable changes to SlipStream are documented in this file.

## [Unreleased]

## [0.1.3] - 2026-11-14

### Added

- Explicit per-view citation targets with recorded insertion positions, paragraph actions, keyboard access and visible source precision.
- First-use consent for source block IDs, per-target session duplicate confirmation, cancellation and recoverable operation feedback.
- Independent insertion snapshots with capacity reporting, record-only retries and separate snapshot cleanup.
- Validated v1 plugin data with local backups before legacy migration and serialized saves.

### Fixed

- Preserve displayed excerpts, repeated highlights and complete cross-block selections with their actual source ranges.
- Verify full source snapshots and open editor buffers before anchoring; reuse short IDs and write structured IDs outside lists, quotes and callouts.
- Capture drops in the receiving editor through public CodeMirror APIs, honor replace/append, reject stale positions and isolate citation undo history.
- Quote every line in A, retain B paragraph boundaries, restrict C to whole anchored blocks and validate custom-template variables and source links.
- Separate clipboard success, draft insertion and record persistence; copies and failures no longer consume insertion dedupe.
- Space confirmation-dialog buttons consistently and allow wrapping in narrow windows.

### Changed

- Built-in source links use full vault paths; custom templates gain `link` and `blockquoteContent`. Invalid or ambiguous outputs are reported without rewriting stored templates.
- History distinguishes insertion, copying and unknown legacy events. Clearing history leaves snapshots intact; recording can be disabled independently of session duplicate reminders.

## [0.1.2] - 2026-11-12

### Fixed

- Use CSS custom properties (`--slipstream-min-height`, `--slipstream-handle-top`) with `setCssProps` for dynamic layout styles, resolving the `obsidianmd/no-static-styles-assignment` review error.

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
