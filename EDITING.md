# Editing notes in notes-tui

The TUI lets you view, search, organize, create, and edit Apple Notes from
the terminal. View/organize is solid. **Editing has real limitations worth
understanding before you commit to it for notes that matter.**

## What works

- View any note: title, body (rendered from HTML — paragraphs, bullets,
  bold/italic text content).
- Open editor with `e`, save with `Ctrl+S`, cancel with `Esc`.
- Create new notes (`n`) and new folders (`N`).
- Move notes between folders within the same account.
- Live re-load when Notes.app or iCloud writes externally (with Full Disk
  Access; manual `r` otherwise).

## Limitations of editing

### Formatting is destroyed on save

Apple Notes stores notes as rich content (bold, italic, headers, lists,
checklists, tables, attachments). Our editor pipeline:

1. **Open**: we fetch `note.plaintext()` — strips all formatting before you
   even see it. The textarea shows plain text only.
2. **Save**: we wrap each line of your edited text in `<div>...</div>` and
   write that as the note's `body`. The note's body is **replaced
   entirely**.

Result: any rich formatting in the original is gone after save. If you
edit a note that has bold text, headers, lists, or checklists, those will
be replaced with plain text on save.

> **If you care about preserving formatting, edit the note in Notes.app
> instead.**

### Checklists are invisible (read or write)

Apple's AppleScript dictionary does not expose checklist state through the
HTML body. A note containing:

- `[x]` Buy milk
- `[ ]` Walk the dog

…comes through as bare `• Buy milk` / `• Walk the dog`. There is no way
for us to know which items are checked. Likewise, we have no way to
write checkbox state back. Editing a checklist note will replace its
contents with plain bullets/text — the checklist is gone.

The only path to accurate checklist rendering is reading Apple's internal
SQLite store and decoding the gzipped protobuf body — possible but
brittle. We deliberately don't go there.

### Attachments are invisible

PDFs, images, sketches, scanned documents, audio recordings, links with
preview cards — none of these surface through AppleScript's `body` HTML.
They exist in the note but the editor doesn't see them. **Saving a note
that has attachments will silently drop them.**

### No conflict detection

If Notes.app on this Mac or another device (via iCloud) updates the same
note while you're editing in the TUI, **last writer wins**:

1. You press `e`, we snapshot the plaintext.
2. Meanwhile, an iPhone or Notes.app saves a new version.
3. You press `Ctrl+S` — your snapshot overwrites the newer version.

Auto-refresh is suppressed during edit mode (so external changes don't
yank the UI under you), which means you wouldn't even see the conflict
before you save. Treat editing as a single-writer operation.

### No undo after save

`Esc` discards in-progress edits cleanly. Once you've pressed `Ctrl+S`,
the change is committed to Notes — there's no undo from our side. Apple
Notes' own undo history may or may not let you revert (depending on
whether it captures external `body` writes as a discrete step).

### Locked notes

Apple supports password-locked notes. AppleScript can't read or write
their content. We surface them with empty bodies; trying to edit one will
either fail or write garbage.

### Smart folders

Apple's smart folders (rule-based virtual folders) aren't visible in our
folder list — we only show concrete folders that have an `id`. Notes that
match a smart folder still appear under their actual storage folder.

## Recommended workflow

| Task | Use the TUI | Use Notes.app |
| --- | --- | --- |
| Navigate / search / triage many notes | ✅ | |
| Bulk move | ✅ | |
| Quick title or text-only note edits | ✅ | |
| Plain notes (no formatting / attachments) | ✅ | |
| Checklists, headings, bold/italic | | ✅ |
| Attachments (images, PDFs, sketches) | | ✅ |
| Concurrent editing across devices | | ✅ |
| Anything you'd be sad to lose if it round-trips wrong | | ✅ |

## How to detect a destructive edit before saving

1. Look at the original note in Notes.app first if it has any visible
   formatting, checkboxes, or attachments — those will not survive the
   round trip.
2. Cancel with `Esc` if you're unsure.
3. If you've already saved and need to recover: open the note in Notes.app
   and check the version history (via Notes' own undo, or iCloud's
   "Recently Deleted" if the note was overwritten with a different title).
