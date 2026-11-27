# Changelog

All notable changes to SlipStream are documented in this file.

## [Unreleased]

## [0.1.6] - 2026-11-27

### Added

- **Desk-private evidence outline & excerpt tray (16-01)**: collect complete blocks, focus fragments/callouts, or valid selections from cards and focus results into each desk's private outline with frozen snapshots (`origins`, `selectedRanges`, context hints), separate plain-text personal notes, duplicate confirmation, and explicit snapshot refresh without modifying source files or consuming citation dedupe.
- **Thesis-grouped evidence organization (16-02)**: switch between Materials and Outline in the desk view; create, rename, and reorder single-layer groups; move and reorder entries across the collection zone and groups; keep empty groups as material-needed placeholders; return entries in order when deleting non-empty groups; and navigate via keyboard with windowed list rendering.
- **Preflighted single-transaction batch insertion (16-03)**: preview and insert an entry, a group, or the full outline in one target transaction with read-only cancellable source verification (`verified`, `relocated`, `changed`, `unlocated`, `missing`, `unavailable`), duplicate and snapshot-capacity preflight, non-empty and Markdown/HTML structural boundary checks, same-source-as-target post-commit validation, suspend-to-editor target/source handoff, read-only multi-anchor planning before confirmed source ID writes, single-undo target commit, independent per-source batch records with monotonic commit sequences and save-only retry, and explicit saved-snapshot fallback when sources are unavailable.
- **v3 plugin data schema & migration**: migrate v0/v1/v2 data directly to `schemaVersion: 3` (per-desk `outline` and `lastCommitSequence`) after a pre-migration backup, validate outline/sequence boundaries with read-only recovery, update outline paths on vault renames, and mark deleted sources as `unconfirmed-after-loss`.

### Fixed

- **Code audit & CSS lint fixes (16-04)**: removed redundant type assertions in `CardStreamController` and `FocusResults`, aligned async `Promise<void>` contracts in `FocusResultsHost` and `DeskSelectorHost` with error feedback, narrowed `CollectionService` file checks with `instanceof TFile`, switched `FocusSearch` yield timers to `window.setTimeout`/`window.clearTimeout`, removed the deprecated `SettingsTab.display()` fallback and `this.display()` refresh path, and removed `!important` from `.slipstream-root .is-hidden` using scoped selector specificity.

### Notes

- Optional P1 export (`16-P1-A`: export outline preview as plain Markdown) is deferred and not included in 0.1.6.

## [0.1.5] - 2026-11-17

### Added

- Named desks: save the current browse as a desk with a name and target note, switch between desks, rename and delete them, and restore each desk's sources, reading density, metadata filter, sort, pin/collapse/hidden state and reading position independently.
- Multi-source collections: combine folder, tag, backlink, outlink and manually added notes in one desk, show every matched source on each card, apply global and per-folder exclusions, and exclude the target note unless it is explicitly added.
- Full-collection loading: load every member before filtering and sorting, paginate cards by a configurable batch size instead of truncating the collection, and report collection / visible / loaded counts.
- Full-collection body search: search the whole desk collection (including notes that are not loaded or rendered), with literal phrase matching, Chinese text and case-insensitive English, metadata-filter intersection, an explicit "include hidden" switch and live progress with cancellation.
- Paragraph focus results: group matches by source, show the containing heading and a matched preview, navigate between hits, expand a section in its note, and cite or copy a fragment through the existing verified citation workflow.
- Highlight and callout focus: inspect only `==highlight==` occurrences, only callouts, or both, optionally combined with a keyword.
- Best-effort reading position restore across refreshes, desk switches, close/reopen and restarts, including actively rendering off-screen cards.
- v2 plugin data with desk storage, `collectionLimit` migrated to `collectionPageSize`, backups before migration or field normalization, and read-only recovery for malformed or future data.

### Changed

- The collection limit setting is now the per-batch page size; the full collection is no longer truncated.
- The citation target command now affects only the explicitly active SlipStream view instead of broadcasting to every open desk.

### Fixed

- Upgrade existing schemaVersion 1 data instead of opening it read-only.
- Refuse focus citations whose displayed text no longer matches the current source, even when the replacement has the same length, and never record it as verified.
- Freeze the citation target before reading the source so switching desks while a citation is in flight cannot write into the new draft, and cancel pending focus citations on desk switch or close.
- Release the previous target binding when creating a desk so citations never fall back to the old draft.
- Make desk creation retries reuse one create-operation identity, preventing duplicate-name overwrites and failed-then-persisted retries.
- Re-resolve the collection and restart the focus search when sources, metadata filters or hidden scope change, and publish partial focus results while scanning.
- Do not cache content that changed during a read as the current version.
- Keep previously observed missing references when a same-path file appears instead of silently re-adopting it.
- Require an explicit SlipStream view for the citation-target command when several views are open.
- Complete focus section expansion, partial-text selection, drag-to-cite and whole-block citation (including template C).
- Guard reading-position restore against late tasks and user scrolling.
- Let focus navigation load later result batches and step through every occurrence in a block.
- Keep emoji table cells searchable and ignore `==` inside inline code (including multi-backtick spans).
- Validate code-block and whole-block citations against the search-time source fingerprint, so changed code can never be inserted as verified.
- Invalidate focus drag tokens when leaving the desk session so an old drag cannot write into a new desk’s draft.
- Prevent a same-path new file from being auto-adopted as a previously unresolved manual note.
- Expand the correct duplicate-heading section and include preceding context for heading-less notes.
- Preserve focus selections when citing via keyboard, stop late desk-creation saves from switching the view back, and re-sort focus results when the sort changes.

## [0.1.4] - 2026-11-14

### Changed

- Reissue the 0.1.3 citation and review fixes under a new version for a fresh Obsidian Community directory review.

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
- Resolve review warnings for frontmatter types, redundant assertions and escapes, editor callbacks and asynchronous DOM event handlers.

### Changed

- Require Obsidian 1.13.0 or later for the declarative settings refresh API.
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
