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
import { usePollRefresh } from "./hooks/use-poll-refresh.ts";
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
  const [folderCursor, setFolderCursor] = useState(0);
  // When true, selecting a parent folder also shows notes from its
  // descendant folders (Apple-Notes "Show all in folder" behavior).
  // When false, only direct notes of the active folder appear.
  const [recursiveView, setRecursiveView] = useState(true);
  const folderById = useMemo(() => {
    const m = new Map<string, Folder>();
    for (const f of folders) m.set(f.id, f);
    return m;
  }, [folders]);
  const folderCounts = useMemo(() => recursiveFolderCounts(folders), [folders]);
  // The folder Select gets the immediate `folderCursor` so navigation feels
  // instant; downstream effects (lazy notes/snippets fetches, preview) drive
  // off the debounced value so blasting through folders doesn't fan out
  // dozens of in-flight osascript spawns.
  const debouncedFolderCursor = useDebouncedValue(folderCursor, 150);
  const activeFolder = folders[debouncedFolderCursor];
  const activeFolderIds = useMemo(() => {
    if (!activeFolder) return new Set<string>();
    if (!recursiveView) return new Set([activeFolder.id]);
    return descendantIdSet(activeFolder, folders);
  }, [activeFolder, folders, recursiveView]);

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
    folders.length,
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
      folders.map((f) => ({
        name: formatFolderOptionName(
          "  ".repeat(f.depth),
          f.name,
          folderCounts[f.id] ?? 0,
        ),
        description: "",
        value: f.id,
      })),
    [folders, folderCounts],
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

  // Auto-refresh via polling. Picks up external changes (Notes.app saves,
  // iCloud pulls) within the interval. Silent (no toast) so it doesn't spam.
  usePollRefresh(() => refresh(true), 15_000);

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
    toggleRecursiveView: () => setRecursiveView((r) => !r),
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
    `Notes [${SORT_LABEL[sort]}${recursiveView ? "" : " · Direct"}]` +
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
          onChange={setFolderCursor}
          onSelect={(i) => {
            if (moveTargetMode) {
              const target = folders[i];
              if (target) void performMove(target, mode.sourceAccount);
            } else {
              setFocused("notes");
            }
          }}
          onMouseDown={makeOptionClickHandler(
            folderSelectRef.current,
            folderScrollOffset,
            folders.length,
            1,
            (i) => {
              setFolderCursor(i);
              setFocused("folders");
            },
          )}
          onMouseScroll={makeWheelScrollHandler(
            folders.length,
            setFolderCursor,
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
            "↑↓ Nav · Tab Switch · n New Note · N New Folder · m Move To… · f Search · s Sort · t Subfolders · r Refresh · ? Help · q Quit"}
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
