# SlipStream

**Turn folders and tags into a continuous, draggable reference stream — for effortless long-form writing.** No more jumping between tabs and split panes.

[中文说明](README.zh-CN.md) · English

---

## What it does

- **Desk-style card stream**: right-click a folder (or a tag, backlinks/outlinks) and open SlipStream in the sidebar — your notes become one continuously scrollable stack of cards.
- **Three reading densities**: Full text / Highlights & Callouts / Compact titles.
- **Click, keyboard and drag citations**: bind a draft and insertion position, cite selected text or whole paragraphs, or drag to the actual receiving editor.
- **Verified sources**: cite the displayed excerpt or complete selection, retaining Markdown for whole blocks. Precision is shown as whole block, fragment, multi-block start, heading or file. Full source paths distinguish notes with the same name.
- **Citation records**: distinguish inserts from copies and retain real target paths. Successful inserts also save independent, minimal verification snapshots.

## Installation

1. Open **Settings → Community plugins** in Obsidian.
2. Select **Browse** and search for **SlipStream**.
3. Select **Install**, then **Enable**.

> Desktop only.

## Quick start

1. **Right-click a folder** in the file explorer → "Open in SlipStream"; or run `SlipStream: Open` from the command palette.
2. Switch the data source on top (folder / tag / backlinks / outlinks).
3. Use the toolbar to change density, filter and sort.
4. Place the cursor or selection in your draft and run `SlipStream: Set current note as citation target`, or use **Choose target**. Reading another note keeps this binding. Closing the view or restarting requires choosing again.
5. Select text in a card or open its paragraph **⋯** actions, then choose **Cite to target**. Tab reaches paragraph actions, Up/Down moves between fragments, Enter/Space opens actions, and Escape cancels. Header copy uses a valid selection and never guesses the first block.
6. Alternatively, drag a paragraph handle to a draft. Drops use the receiving editor and honor replace/append inside its selection. Multiple cursors, expired positions and unmappable drops stop with a recovery message.

The first new source block ID requires an explanation and a saved choice. Browsing, selecting and cancelling do not add IDs. Undoing a draft citation keeps the source ID. Copying follows the same rules. Disabling automatic IDs still allows verified existing IDs.

Duplicate reminders concern successful inserts of the same source fragment into the same draft during this session. Copies do not reserve insertion dedupe; another draft can use the same material. Undoing or deleting may leave the reminder; choose **Insert again** explicitly. If insertion succeeds but saving records fails, use **Retry saving records only**.

## Settings

- Interface language (follow Obsidian / 中文 / English)
- Default density and view placement
- Include subfolders, exclude globs
- Excerpt length, include highlights / callouts
- Auto block reference, default citation template
- Session duplicate reminders per target note, selection replace/append
- Recording toggle, history limit, independent snapshot usage and cleanup
- Appearance (card width, font scale) and advanced options

## Citation templates and records

A quotes every line, B retains the body and adds a source, and C embeds only a complete block with a verified block anchor. Selections, excerpts and sources without an anchor require an explicit alternative to C.

D preserves existing templates and the `content`, `filename`, `path`, `title`, `blockId`, `heading`, `url` and `date` variables; dates use local time. The new `link` variable supplies a safe source link and `blockquoteContent` quotes every line. Recommended template:

```text
{{blockquoteContent}}
> — {{link}}
```

0.1.3 adds reliability checks: unknown variables, empty output, missing verifiable source links and ambiguous names stop a citation. Your stored template remains intact; fix it or choose A for this operation.

History defaults to 200 events. Independent snapshots are limited to 1,000 entries or 10 MiB, whichever comes first. At capacity, citations still work with an explicit missing-snapshot message; old snapshots are never silently evicted. Clearing history keeps snapshots; clearing snapshots keeps notes and history. Disabling recording stops new events and snapshots without deleting existing data. History does not claim a citation still exists in the draft.

Upgrades first create a uniquely named `data-backup-*.json` in the actual plugin directory. Unknown legacy actions/targets stay unknown. Failed backups, unreadable data and newer schemas preserve the original file and disable recording and new IDs; citations without new IDs remain available.

## Privacy

- Fully local. The plugin makes no network requests, uploads nothing, and collects no data.
- History, minimal insertion snapshots and upgrade backups stay in your own vault. Entire drafts or sources are not retained beyond the blocks actually cited. History and snapshots can be cleared separately.

## Support

If SlipStream has been helpful, you can support its development:

| WeChat | Alipay |
| :---: | :---: |
| <img src="assets/wechat-donate.jpg" width="180" alt="WeChat Pay QR code" /> | <img src="assets/alipay-donate.jpg" width="180" alt="Alipay QR code" /> |

## License

MIT
