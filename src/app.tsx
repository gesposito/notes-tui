import { useEffect, useMemo, useRef, useState } from "react";
import {
  createCliRenderer,
  type SelectOption,
  type SelectRenderable,
  type TextareaRenderable,
} from "@opentui/core";
import {
  createRoot,
  useRenderer,
  useTerminalDimensions,
} from "@opentui/react";
import type { Folder, Note } from "./notes/index.ts";
import { NotesProvider, useNotes, useBackendChoice } from "./notes/context.tsx";
import {
  BACKEND_LABELS,
  type BackendChoice,
} from "./notes/index.ts";
import {
  loadSettings,
  resolveInitialBackendChoice,
  saveSettings,
  type Settings,
} from "./lib/settings.ts";
import { SORT_LABEL, sortNotes, type SortMode } from "./lib/sort.ts";
import {
  formatFolderOptionName,
  formatNoteMeta,
  NOTE_LINES_PER_ITEM,
} from "./lib/format.ts";
import {
  descendantIdSet,
  foldersEqual,
  recursiveFolderCounts,
} from "./lib/folder-tree.ts";
import {
  makeOptionClickHandler,
  makeWheelScrollHandler,
} from "./lib/select-handlers.ts";
import { useFolders } from "./hooks/use-folders.ts";
import { useNotesByFolder } from "./hooks/use-notes-by-folder.ts";
import { useFolderSnippets } from "./hooks/use-folder-snippets.ts";
import { useNotePreview } from "./hooks/use-note-preview.ts";
import { useNoteIndex } from "./hooks/use-note-index.ts";
import { useMoveAction } from "./hooks/use-move-action.ts";
import { useAppKeybindings } from "./hooks/use-app-keybindings.ts";
import {
  usePaneViewport,
  useScrollOffset,
} from "./hooks/use-pane-viewport.ts";
import { useDebouncedValue } from "./hooks/use-debounced-value.ts";
import { FolderPane } from "./components/FolderPane.tsx";
import { NotesPane } from "./components/NotesPane.tsx";
import { PreviewPane } from "./components/PreviewPane.tsx";
import { HelpDialog } from "./components/HelpDialog.tsx";
import { NewFolderDialog } from "./components/NewFolderDialog.tsx";
import { BackendPickerDialog } from "./components/BackendPickerDialog.tsx";
import type { Mode, Pane } from "./types.ts";

export const App = () => {
  const notes = useNotes();
  const { choice: backendChoice, setChoice: setBackendChoice } =
    useBackendChoice();
  const renderer = useRenderer();
  const { height: termHeight } = useTerminalDimensions();

  // ── Folder state ────────────────────────────────────────────────────────
  const { folders, loading, error, reload } = useFolders();
  const folderById = useMemo(() => {
    const m = new Map<string, Folder>();
    for (const f of folders) m.set(f.id, f);
    return m;
  }, [folders]);
  const folderByPath = useMemo(() => {
    const m = new Map<string, Folder>();
    for (const f of folders) m.set(f.path, f);
    return m;
  }, [folders]);
  const folderCounts = useMemo(() => recursiveFolderCounts(folders), [folders]);

  // Folders with at least one child (drives the ▸/▾ disclosure markers).
  const foldersWithChildren = useMemo(() => {
    const set = new Set<string>();
    for (const f of folders) {
      if (f.depth === 0) continue;
      const idx = f.path.lastIndexOf(" / ");
      if (idx <= 0) continue;
      const parent = folderByPath.get(f.path.substring(0, idx));
      if (parent) set.add(parent.id);
    }
    return set;
  }, [folders, folderByPath]);

  // Tree expansion state. Defaults to fully-expanded once folders load: it
  // matches the macOS Notes sidebar's typical state and avoids a scroll-time
  // perf trap — landing on a collapsed parent fans out a fetch across every
  // descendant (notes + snippets), which can stall the UI 1–2 s. Expanded
  // means each row is a single-folder fetch. Users can still collapse with
  // ←; we just don't trigger the aggregation by default.
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    new Set(),
  );
  const expandedSeeded = useRef(false);
  useEffect(() => {
    if (expandedSeeded.current) return;
    if (foldersWithChildren.size === 0) return;
    setExpandedFolders(new Set(foldersWithChildren));
    expandedSeeded.current = true;
  }, [foldersWithChildren]);

  // A folder is visible if every ancestor is expanded.
  const visibleFolders = useMemo(() => {
    return folders.filter((f) => {
      let current: Folder | undefined = f;
      while (current && current.depth > 0) {
        const idx = current.path.lastIndexOf(" / ");
        if (idx <= 0) return false;
        const parent = folderByPath.get(current.path.substring(0, idx));
        if (!parent || !expandedFolders.has(parent.id)) return false;
        current = parent;
      }
      return true;
    });
  }, [folders, folderByPath, expandedFolders]);

  // Active folder tracked by id so expand/collapse doesn't shift selection.
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
  // Move-target picker uses its own cursor so the user can navigate the
  // *full* folder list (not just visible/expanded ones) without disturbing
  // the browse-mode active folder.
  const [moveCursor, setMoveCursor] = useState(0);
  const folderCursor = useMemo(() => {
    if (!activeFolderId) return 0;
    const idx = visibleFolders.findIndex((f) => f.id === activeFolderId);
    return idx >= 0 ? idx : 0;
  }, [visibleFolders, activeFolderId]);
  // Debounced cursor (150 ms) drives the lazy fetches so fast scrolling
  // doesn't fan out spawns. Folder Select gets the immediate value.
  const debouncedFolderCursor = useDebouncedValue(folderCursor, 150);
  const activeFolder = visibleFolders[debouncedFolderCursor];
  // What's in the notes pane:
  //   - leaf folder, or expanded parent → just that folder's direct notes
  //     (children are reachable separately, so showing their notes here would
  //     duplicate what the user already sees in the tree)
  //   - collapsed parent → aggregate the whole subtree, since the children
  //     are hidden and otherwise their notes would be unreachable
  const activeFolderIds = useMemo(() => {
    if (!activeFolder) return new Set<string>();
    const hasChildren = foldersWithChildren.has(activeFolder.id);
    if (!hasChildren || expandedFolders.has(activeFolder.id)) {
      return new Set([activeFolder.id]);
    }
    return descendantIdSet(activeFolder, folders);
  }, [activeFolder, foldersWithChildren, expandedFolders, folders]);

  // Bumped on each successful refresh and on backend switch. Wipes every
  // data cache (notes, snippets, search index, preview LRU) so we don't
  // serve stale content from a different backend or before a refresh.
  // Despite the legacy name it's not preview-only anymore.
  const [previewBustToken, setPreviewBustToken] = useState(0);

  // ── Notes / snippets / preview ──────────────────────────────────────────
  const { notesByFolder, invalidate: invalidateNotes, error: notesError } =
    useNotesByFolder(activeFolderIds, previewBustToken);
  const { snippetCache, invalidate: invalidateSnippets } =
    useFolderSnippets(activeFolderIds, previewBustToken);
  const [noteCursor, setNoteCursor] = useState(0);
  const [marked, setMarked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<SortMode>("dateDesc");

  // ── UI state ────────────────────────────────────────────────────────────
  const [focused, setFocused] = useState<Pane>("folders");
  const [mode, setMode] = useState<Mode>({ kind: "browse" });
  const [toast, setToast] = useState("");
  const [helpOpen, setHelpOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [editBuffer, setEditBuffer] = useState("");
  // Set when the watcher fires while the user is mid-edit; banner shows
  // until edit closes (save or cancel both reset it).
  const [externalChangeDuringEdit, setExternalChangeDuringEdit] =
    useState(false);

  // Surface backend errors as toast.
  useEffect(() => {
    if (notesError) setToast(`Failed to load notes: ${notesError}`);
  }, [notesError]);

  // Reset note cursor when active folder, filter, or sort changes. Tied to
  // the debounced folder cursor so rapid scrolling doesn't reset noteCursor
  // many times per second.
  useEffect(() => {
    setNoteCursor(0);
  }, [debouncedFolderCursor, filter, sort]);

  // When move-target mode opens, seed the picker cursor at the active
  // folder's position in the *full* folders list (so it starts somewhere
  // sensible — usually the source folder the user was just browsing).
  // Intentionally only depends on mode.kind so we don't reset mid-pick.
  useEffect(() => {
    if (mode.kind !== "moveTarget") return;
    if (!activeFolder) {
      setMoveCursor(0);
      return;
    }
    const idx = folders.findIndex((f) => f.id === activeFolder.id);
    setMoveCursor(idx >= 0 ? idx : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode.kind]);

  // ── Search index (full-body, scoped to the visible selection) ──────────
  // The index covers the same folders that are *visible* in the notes pane:
  //   - leaf or expanded parent → just the active folder
  //   - collapsed parent → that folder + its subtree
  // i.e. exactly `activeFolderIds`. Search results match what the user can
  // see, which is much less surprising than a global index.
  const scopedFolderIds = useMemo(
    () => Array.from(activeFolderIds),
    [activeFolderIds],
  );
  const indexEnabled = mode.kind === "filter" || filter.length > 0;
  const {
    index: noteIndex,
    progress: indexProgress,
    indexing,
    invalidate: invalidateIndex,
  } = useNoteIndex(scopedFolderIds, indexEnabled, previewBustToken);

  // ── Visible notes (filter + sort) ───────────────────────────────────────
  const visibleNotes = useMemo(() => {
    // No filter: scoped to the active folder (current behavior).
    if (!filter) {
      if (activeFolderIds.size === 0) return [];
      const all = [];
      for (const fid of activeFolderIds) {
        const arr = notesByFolder.get(fid);
        if (arr) all.push(...arr);
      }
      return sortNotes(all, sort);
    }
    // Filter active: same scope, but match title + body via the index.
    // The index cache may carry entries from previously-scoped folders
    // (cheaper to keep them than to re-fetch later), so we filter to the
    // active scope explicitly here.
    const q = filter.toLowerCase();
    const matches: Note[] = [];
    const seen = new Set<string>();
    for (const entry of noteIndex.values()) {
      if (!activeFolderIds.has(entry.folderId)) continue;
      if (
        entry.title.toLowerCase().includes(q) ||
        entry.body.toLowerCase().includes(q)
      ) {
        matches.push(entry);
        seen.add(entry.id);
      }
    }
    // Fallback for folders in scope that aren't indexed yet — title-only
    // match so something appears immediately.
    for (const fid of activeFolderIds) {
      const arr = notesByFolder.get(fid);
      if (!arr) continue;
      for (const n of arr) {
        if (seen.has(n.id)) continue;
        if (n.title.toLowerCase().includes(q)) {
          matches.push(n);
          seen.add(n.id);
        }
      }
    }
    return sortNotes(matches, sort);
  }, [notesByFolder, activeFolderIds, filter, sort, noteIndex]);

  // ── Viewport math ───────────────────────────────────────────────────────
  const filterRowVisible = mode.kind === "filter" || filter.length > 0;
  const { pageStep, folderVisibleRows, noteVisibleRows } = usePaneViewport(
    termHeight,
    filterRowVisible,
  );
  // Move-target mode shows EVERY folder (so a target deep in a collapsed
  // subtree is still pickable). Browse mode shows only the visible/expanded
  // tree. Index-based handlers below all read paneFolders, so the index
  // and the underlying folder always agree — the bug we shipped earlier
  // was that the click handler indexed into `folders` while the Select
  // listed `visibleFolders`, sending moves to the wrong target.
  const moveTargetMode = mode.kind === "moveTarget";
  const paneFolders = moveTargetMode ? folders : visibleFolders;
  const paneCursor = moveTargetMode ? moveCursor : folderCursor;
  const folderScrollOffset = useScrollOffset(
    paneCursor,
    folderVisibleRows,
    paneFolders.length,
  );
  const noteScrollOffset = useScrollOffset(
    noteCursor,
    noteVisibleRows,
    visibleNotes.length,
  );

  // ── Preview ─────────────────────────────────────────────────────────────
  const highlightedNote = visibleNotes[noteCursor];
  const { preview, loading: previewLoading } = useNotePreview(
    highlightedNote?.id,
    previewBustToken,
  );

  // ── Refs for click-target geometry + edit buffer access ────────────────
  const folderSelectRef = useRef<SelectRenderable | null>(null);
  const noteSelectRef = useRef<SelectRenderable | null>(null);
  const textareaRef = useRef<TextareaRenderable | null>(null);

  // ── SelectOptions ───────────────────────────────────────────────────────
  const folderOptions: SelectOption[] = useMemo(
    () =>
      paneFolders.map((f) => {
        const hasChildren = foldersWithChildren.has(f.id);
        const isExpanded = hasChildren && expandedFolders.has(f.id);
        // Disclosure markers are non-actionable in move mode (no expand/
        // collapse there) so we keep the row plain to avoid suggesting
        // they do something.
        const marker = moveTargetMode
          ? "  "
          : hasChildren
            ? isExpanded
              ? "▾ "
              : "▸ "
            : "  ";
        // When expanded, child rows show their own counts beside the parent,
        // so showing the recursive total here would double-count. Collapse
        // it back to the direct count. Collapsed parents and leaves keep
        // the recursive total so the user knows what's hidden. Move mode
        // always shows the full tree so we always show recursive counts.
        const count =
          !moveTargetMode && isExpanded
            ? f.noteCount
            : (folderCounts[f.id] ?? 0);
        return {
          name: formatFolderOptionName(
            "  ".repeat(f.depth) + marker,
            f.name,
            count,
          ),
          description: "",
          value: f.id,
        };
      }),
    [
      paneFolders,
      moveTargetMode,
      foldersWithChildren,
      expandedFolders,
      folderCounts,
    ],
  );

  // Cap the list passed to <select>: OpenTUI doesn't virtualize options, so
  // every note in the array allocates text buffer space whether it's
  // visible or not. After-sort top-N keeps the most relevant items.
  const NOTE_RENDER_CAP = 500;
  const renderedNotes = useMemo(
    () => visibleNotes.slice(0, NOTE_RENDER_CAP),
    [visibleNotes],
  );
  const hiddenNotesCount = Math.max(
    0,
    visibleNotes.length - renderedNotes.length,
  );

  const noteOptions: SelectOption[] = useMemo(() => {
    // Only show the [ ]/[x] column once the user has started marking; until
    // then, titles render unprefixed (matches Apple Notes' default).
    const showMarkColumn = marked.size > 0;
    return renderedNotes.map((n) => {
      const prefix = showMarkColumn
        ? `${marked.has(n.id) ? "[x]" : "[ ]"} `
        : "";
      return {
        name: `${prefix}${n.title || "(untitled)"}`,
        description: formatNoteMeta(
          n.modifiedAt,
          snippetCache.get(n.folderId)?.[n.id] ?? "",
        ),
        value: n.id,
      };
    });
  }, [renderedNotes, marked, snippetCache]);

  // ── Actions ─────────────────────────────────────────────────────────────
  const { enterMoveMode, performMove } = useMoveAction({
    folderById,
    notesByFolder,
    marked,
    highlightedNote,
    setMode,
    setFocused,
    setMarked,
    setToast,
    invalidateNotes,
    invalidateSnippets,
    invalidateIndex,
    reload,
  });

  const quit = () => {
    renderer?.destroy();
    process.exit(0);
  };

  const refresh = async (silent = false) => {
    // Not in browse mode — surface the change rather than yanking the UI.
    if (mode.kind !== "browse") {
      if (mode.kind === "edit") {
        // Persistent banner in the edit pane; auto-clears on save/cancel.
        setExternalChangeDuringEdit(true);
      } else if (!silent) {
        // Manual `r` press in a transient mode: tell them why nothing happened.
        setToast("Refresh deferred — exit current mode first");
      }
      return;
    }
    // Cheap first pass: pull fresh folders + counts and compare. Most polling
    // ticks find nothing changed and we can skip the expensive per-folder
    // invalidation entirely.
    const before = folders;
    const fresh = await reload();
    if (!fresh) return;
    if (foldersEqual(fresh, before)) {
      if (!silent) setToast("Up to date");
      return;
    }
    invalidateNotes(activeFolderIds);
    invalidateSnippets(activeFolderIds);
    setPreviewBustToken((t) => t + 1);
    if (!silent) setToast("Refreshed");
  };

  const newNote = async () => {
    if (!activeFolder) {
      setToast("Select a folder first");
      return;
    }
    try {
      await notes.createNote(activeFolder.id);
      setToast(`New Note in ${activeFolder.path}`);
      // Invalidate this folder's note cache + reload folder counts.
      invalidateNotes([activeFolder.id]);
      invalidateSnippets([activeFolder.id]);
      invalidateIndex([activeFolder.id]);
      await reload();
    } catch (e) {
      setToast(
        `Create failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };

  const enterNewFolder = () => {
    if (!activeFolder) {
      setToast("Select a folder first (so we know which account to add to)");
      return;
    }
    setNewFolderName("New Folder");
    setMode({ kind: "newFolder" });
  };

  const submitNewFolder = async (name: string) => {
    const trimmed = name.trim();
    setMode({ kind: "browse" });
    setNewFolderName("");
    if (!trimmed || !activeFolder) return;
    try {
      await notes.createFolder(activeFolder.account, trimmed);
      setToast(`Created Folder "${trimmed}" in ${activeFolder.account}`);
      await reload();
    } catch (e) {
      setToast(
        `Create folder failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };

  const enterEdit = async () => {
    if (!highlightedNote) {
      setToast("No note highlighted");
      return;
    }
    try {
      const plaintext = await notes.getNoteBody(highlightedNote.id);
      setEditBuffer(plaintext);
      setExternalChangeDuringEdit(false);
      setMode({ kind: "edit", noteId: highlightedNote.id });
    } catch (e) {
      setToast(
        `Failed to open editor: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };

  const cancelEdit = () => {
    setEditBuffer("");
    setExternalChangeDuringEdit(false);
    setMode({ kind: "browse" });
  };

  // expand/collapse use the *immediate* cursor (not `activeFolder`, which
  // is debounced 150ms for fetch-throttling). Without this, pressing ↓
  // then ← in quick succession would collapse the previously-active
  // folder instead of the one the user just landed on.
  const cursorFolder = visibleFolders[folderCursor];

  const expandFolder = () => {
    if (!cursorFolder || !foldersWithChildren.has(cursorFolder.id)) return;
    if (expandedFolders.has(cursorFolder.id)) return;
    setExpandedFolders((s) => {
      const next = new Set(s);
      next.add(cursorFolder.id);
      return next;
    });
  };

  // Left arrow: collapse the cursor's folder if it's expanded; otherwise
  // jump to the parent. Mirrors how Finder/Files apps handle ← in tree
  // views.
  const collapseOrParent = () => {
    if (!cursorFolder) return;
    if (expandedFolders.has(cursorFolder.id)) {
      setExpandedFolders((s) => {
        const next = new Set(s);
        next.delete(cursorFolder.id);
        return next;
      });
      return;
    }
    if (cursorFolder.depth === 0) return;
    const idx = cursorFolder.path.lastIndexOf(" / ");
    if (idx <= 0) return;
    const parent = folderByPath.get(cursorFolder.path.substring(0, idx));
    if (parent) setActiveFolderId(parent.id);
  };

  const openBackendPicker = () => {
    setMode({ kind: "backendPicker" });
  };

  const switchBackend = (next: BackendChoice) => {
    setMode({ kind: "browse" });
    if (next === backendChoice) return; // selecting current = no-op
    setBackendChoice(next);
    // Wipe every data cache. The hooks already react to `notes` identity
    // changing (re-fetch via context), and bumping the bust token clears
    // their accumulated state so we don't show data from the previous
    // backend in the brief window before the refetch lands.
    setPreviewBustToken((t) => t + 1);
    setMarked(new Set());
    setToast(`Switched to ${BACKEND_LABELS[next]}`);
  };

  const saveEdit = async () => {
    if (mode.kind !== "edit") return;
    const noteId = mode.noteId;
    // Read the current textarea contents (textarea is uncontrolled —
    // initialValue seeded the buffer, edits live in the renderable).
    const content = textareaRef.current?.plainText ?? editBuffer;
    try {
      await notes.updateNoteBody(noteId, content);
      setToast("Saved");
      setEditBuffer("");
      setExternalChangeDuringEdit(false);
      setMode({ kind: "browse" });
      // Title may have changed (first line of body); refresh list + caches.
      if (highlightedNote) {
        invalidateNotes([highlightedNote.folderId]);
        invalidateSnippets([highlightedNote.folderId]);
        invalidateIndex([highlightedNote.folderId]);
      }
      setPreviewBustToken((t) => t + 1);
      await reload();
    } catch (e) {
      setToast(
        `Save failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };

  // ── Keyboard ────────────────────────────────────────────────────────────
  useAppKeybindings({
    mode,
    focused,
    helpOpen,
    highlightedNote,
    setMode,
    setFocused,
    setFilter,
    setSort,
    setMarked,
    setHelpOpen,
    enterMoveMode,
    enterNewFolder,
    enterEdit,
    saveEdit,
    cancelEdit,
    newNote,
    refresh: () => refresh(false),
    expandFolder,
    collapseOrParent,
    openBackendPicker,
    quit,
  });

  // ── Render ──────────────────────────────────────────────────────────────
  if (loading && folders.length === 0) {
    return (
      <box flexDirection="column" padding={1}>
        <text>Loading notes…</text>
        <text fg="#777">
          (First run may prompt for Automation access; large libraries can take
          a few seconds.)
        </text>
      </box>
    );
  }

  if (error) {
    return (
      <box flexDirection="column" padding={1}>
        <text fg="red">Error: {error}</text>
        <text fg="#777">
          On first run, macOS will ask permission to control Notes. If denied,
          enable it in System Settings → Privacy &amp; Security → Automation.
        </text>
        <text fg="#777">Press Ctrl-C to quit.</text>
      </box>
    );
  }

  // (moveTargetMode + paneFolders + paneCursor declared above with the
  // viewport math; reused here for border-coloring and the JSX below.)
  const folderBorderColor = moveTargetMode
    ? "#e6c200"
    : focused === "folders"
      ? "#33ccff"
      : "#555";
  const noteBorderColor = focused === "notes" ? "#33ccff" : "#555";

  const folderTitle = moveTargetMode
    ? `Move To…  (${mode.sourceCount} Note${mode.sourceCount === 1 ? "" : "s"})`
    : "Folders";
  const noteTitle =
    `Notes [${SORT_LABEL[sort]}]` +
    `${marked.size > 0 ? `  (${marked.size} Selected)` : ""}` +
    `${activeFolder ? `  —  ${activeFolder.path}` : ""}`;
  const previewTitle = highlightedNote?.title || "Preview";

  return (
    <box flexDirection="column" width="100%" height="100%">
      <box flexDirection="row" flexGrow={1}>
        <FolderPane
          options={folderOptions}
          cursor={paneCursor}
          focused={focused === "folders" || moveTargetMode}
          title={folderTitle}
          borderColor={folderBorderColor}
          pageStep={pageStep}
          selectRef={folderSelectRef}
          onChange={(i) => {
            // paneFolders is `folders` in move mode, `visibleFolders` in
            // browse mode — index always agrees with what's on screen.
            const f = paneFolders[i];
            if (!f) return;
            if (moveTargetMode) setMoveCursor(i);
            else setActiveFolderId(f.id);
          }}
          onSelect={(i) => {
            const target = paneFolders[i];
            if (moveTargetMode) {
              if (target) void performMove(target, mode.sourceAccount);
            } else {
              setFocused("notes");
            }
          }}
          onMouseDown={makeOptionClickHandler(
            folderSelectRef.current,
            folderScrollOffset,
            paneFolders.length,
            1,
            (i) => {
              const f = paneFolders[i];
              if (!f) return;
              if (moveTargetMode) {
                setMoveCursor(i);
              } else {
                setActiveFolderId(f.id);
                setFocused("folders");
              }
            },
          )}
          onMouseScroll={makeWheelScrollHandler(
            paneFolders.length,
            (updater) => {
              const next = updater(paneCursor);
              const f = paneFolders[next];
              if (!f) return;
              if (moveTargetMode) setMoveCursor(next);
              else setActiveFolderId(f.id);
            },
          )}
        />

        <NotesPane
          options={noteOptions}
          cursor={noteCursor}
          focused={focused === "notes" && mode.kind === "browse"}
          title={noteTitle}
          borderColor={noteBorderColor}
          pageStep={pageStep}
          selectRef={noteSelectRef}
          showFilterInput={mode.kind === "filter"}
          filter={filter}
          onFilterInput={setFilter}
          onFilterSubmit={() => setMode({ kind: "browse" })}
          onChange={setNoteCursor}
          onMouseDown={makeOptionClickHandler(
            noteSelectRef.current,
            noteScrollOffset,
            renderedNotes.length,
            NOTE_LINES_PER_ITEM,
            (i) => {
              setNoteCursor(i);
              setFocused("notes");
            },
          )}
          onMouseScroll={makeWheelScrollHandler(
            renderedNotes.length,
            setNoteCursor,
          )}
          hiddenCount={hiddenNotesCount}
        />

        <PreviewPane
          title={previewTitle}
          body={preview}
          loading={previewLoading}
          hasSelection={!!highlightedNote}
          editing={mode.kind === "edit"}
          initialEditValue={editBuffer}
          textareaRef={textareaRef}
          externalChangePending={externalChangeDuringEdit}
        />
      </box>

      <box flexDirection="row" justifyContent="space-between">
        <text fg="#777">
          {mode.kind === "browse" &&
            "↑↓ Nav · ←/→ Collapse/Expand · Tab Switch · n New Note · N New Folder · m Move To… · f Search · s Sort · r Refresh · B Backend · ? Help · q Quit"}
          {mode.kind === "moveTarget" &&
            "Move To… · ↑↓ Pick destination · Enter Move · Esc Cancel"}
          {mode.kind === "filter" &&
            "Note List Search · type to filter · Enter Apply · Esc Cancel"}
          {mode.kind === "newFolder" &&
            "New Folder · type name · Enter Create · Esc Cancel"}
          {mode.kind === "edit" &&
            "Edit Note · Ctrl+S Save (formatting lost — see EDITING.md) · Esc Cancel"}
          {mode.kind === "backendPicker" &&
            "Switch Backend · ↑↓ Pick · Enter Switch · Esc Cancel"}
        </text>
        <text fg="#555"> [{backendChoice}] </text>
      </box>
      {indexEnabled && indexing && (
        <text fg="#e6c200">
          Indexing {indexProgress.loaded}/{indexProgress.total} folder
          {indexProgress.total === 1 ? "" : "s"} in scope for full-text
          search… (collapse a parent to widen, more specific terms to narrow)
        </text>
      )}
      {indexEnabled && !indexing && filter.length > 0 && (
        <text fg="#777">
          {visibleNotes.length} match{visibleNotes.length === 1 ? "" : "es"}
          {" "}in {indexProgress.total} folder
          {indexProgress.total === 1 ? "" : "s"}
        </text>
      )}
      {toast && <text fg="#33cc66">{toast}</text>}
      {helpOpen && <HelpDialog />}
      {mode.kind === "newFolder" && (
        <NewFolderDialog
          initialValue={newFolderName}
          onInput={setNewFolderName}
          onSubmit={() => void submitNewFolder(newFolderName)}
        />
      )}
      {mode.kind === "backendPicker" && (
        <BackendPickerDialog current={backendChoice} onSelect={switchBackend} />
      )}
    </box>
  );
};

if (import.meta.main) {
  // Load persisted settings before mounting so the first render already
  // has the user's last choice. NOTES_BACKEND env var still wins (handy
  // for one-off A/B testing without touching the file).
  const settings = await loadSettings();
  const initialChoice = resolveInitialBackendChoice(settings);

  // Persist on every in-app switch. We fire-and-forget — the user has
  // already moved on; if the write fails we don't want to block the UI.
  // Errors land on stderr so a tail of the log surfaces them; alt-screen
  // hides them otherwise.
  let current: Settings = settings;
  const persistChoice = (next: BackendChoice) => {
    current = { ...current, backendChoice: next };
    saveSettings(current).catch((e) => {
      process.stderr.write(`[notes-tui] failed to save settings: ${e}\n`);
    });
  };

  const renderer = await createCliRenderer({ screenMode: "alternate-screen" });
  createRoot(renderer).render(
    <NotesProvider
      initialChoice={initialChoice}
      onChoiceChange={persistChoice}
    >
      <App />
    </NotesProvider>,
  );
}
