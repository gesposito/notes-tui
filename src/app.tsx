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
import type { Folder } from "./notes/index.ts";
import { notes as defaultBackend } from "./notes/index.ts";
import { NotesProvider, useNotes } from "./notes/context.tsx";
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
import type { Mode, Pane } from "./types.ts";

export const App = () => {
  const notes = useNotes();
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

  // ── Notes / snippets / preview ──────────────────────────────────────────
  const { notesByFolder, invalidate: invalidateNotes, error: notesError } =
    useNotesByFolder(activeFolderIds);
  const { snippetCache, invalidate: invalidateSnippets } =
    useFolderSnippets(activeFolderIds);
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
  // Bumped on each successful refresh so useNotePreview re-fetches the body
  // even when the highlighted noteId is unchanged.
  const [previewBustToken, setPreviewBustToken] = useState(0);
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

  // ── Visible notes (filter + sort) ───────────────────────────────────────
  const visibleNotes = useMemo(() => {
    if (activeFolderIds.size === 0) return [];
    const all = [];
    for (const fid of activeFolderIds) {
      const arr = notesByFolder.get(fid);
      if (arr) all.push(...arr);
    }
    const filtered = !filter
      ? all
      : all.filter((n) =>
          n.title.toLowerCase().includes(filter.toLowerCase()),
        );
    return sortNotes(filtered, sort);
  }, [notesByFolder, activeFolderIds, filter, sort]);

  // ── Viewport math ───────────────────────────────────────────────────────
  const filterRowVisible = mode.kind === "filter" || filter.length > 0;
  const { pageStep, folderVisibleRows, noteVisibleRows } = usePaneViewport(
    termHeight,
    filterRowVisible,
  );
  const folderScrollOffset = useScrollOffset(
    folderCursor,
    folderVisibleRows,
    visibleFolders.length,
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
      visibleFolders.map((f) => {
        const hasChildren = foldersWithChildren.has(f.id);
        const isExpanded = hasChildren && expandedFolders.has(f.id);
        const marker = hasChildren ? (isExpanded ? "▾ " : "▸ ") : "  ";
        // When expanded, child rows show their own counts beside the parent,
        // so showing the recursive total here would double-count. Collapse
        // it back to the direct count. Collapsed parents and leaves keep
        // the recursive total so the user knows what's hidden.
        const count = isExpanded ? f.noteCount : (folderCounts[f.id] ?? 0);
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
    [visibleFolders, foldersWithChildren, expandedFolders, folderCounts],
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

  const expandFolder = () => {
    if (!activeFolder || !foldersWithChildren.has(activeFolder.id)) return;
    if (expandedFolders.has(activeFolder.id)) return;
    setExpandedFolders((s) => {
      const next = new Set(s);
      next.add(activeFolder.id);
      return next;
    });
  };

  // Left arrow: collapse the active folder if it's expanded; otherwise jump
  // to the parent. Mirrors how Finder/Files apps handle ← in tree views.
  const collapseOrParent = () => {
    if (!activeFolder) return;
    if (expandedFolders.has(activeFolder.id)) {
      setExpandedFolders((s) => {
        const next = new Set(s);
        next.delete(activeFolder.id);
        return next;
      });
      return;
    }
    if (activeFolder.depth === 0) return;
    const idx = activeFolder.path.lastIndexOf(" / ");
    if (idx <= 0) return;
    const parent = folderByPath.get(activeFolder.path.substring(0, idx));
    if (parent) setActiveFolderId(parent.id);
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

  const moveTargetMode = mode.kind === "moveTarget";
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
          cursor={folderCursor}
          focused={focused === "folders" || moveTargetMode}
          title={folderTitle}
          borderColor={folderBorderColor}
          pageStep={pageStep}
          selectRef={folderSelectRef}
          onChange={(i) => {
            const f = visibleFolders[i];
            if (f) setActiveFolderId(f.id);
          }}
          onSelect={(i) => {
            if (moveTargetMode) {
              // Move-target mode lists every folder (no tree filtering),
              // so we still index into `folders` here.
              const target = folders[i];
              if (target) void performMove(target, mode.sourceAccount);
            } else {
              setFocused("notes");
            }
          }}
          onMouseDown={makeOptionClickHandler(
            folderSelectRef.current,
            folderScrollOffset,
            visibleFolders.length,
            1,
            (i) => {
              const f = visibleFolders[i];
              if (f) setActiveFolderId(f.id);
              setFocused("folders");
            },
          )}
          onMouseScroll={makeWheelScrollHandler(
            visibleFolders.length,
            (updater) => {
              const next = updater(folderCursor);
              const f = visibleFolders[next];
              if (f) setActiveFolderId(f.id);
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

      <box>
        <text fg="#777">
          {mode.kind === "browse" &&
            "↑↓ Nav · ←/→ Collapse/Expand · Tab Switch · n New Note · N New Folder · m Move To… · f Search · s Sort · r Refresh · ? Help · q Quit"}
          {mode.kind === "moveTarget" &&
            "Move To… · ↑↓ Pick destination · Enter Move · Esc Cancel"}
          {mode.kind === "filter" &&
            "Note List Search · type to filter · Enter Apply · Esc Cancel"}
          {mode.kind === "newFolder" &&
            "New Folder · type name · Enter Create · Esc Cancel"}
          {mode.kind === "edit" &&
            "Edit Note · Ctrl+S Save (formatting lost — see EDITING.md) · Esc Cancel"}
        </text>
      </box>
      {toast && <text fg="#33cc66">{toast}</text>}
      {helpOpen && <HelpDialog />}
      {mode.kind === "newFolder" && (
        <NewFolderDialog
          initialValue={newFolderName}
          onInput={setNewFolderName}
          onSubmit={() => void submitNewFolder(newFolderName)}
        />
      )}
    </box>
  );
};

if (import.meta.main) {
  const renderer = await createCliRenderer({ screenMode: "alternate-screen" });
  createRoot(renderer).render(
    <NotesProvider backend={defaultBackend}>
      <App />
    </NotesProvider>,
  );
}
