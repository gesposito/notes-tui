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
  const folderById = useMemo(() => {
    const m = new Map<string, Folder>();
    for (const f of folders) m.set(f.id, f);
    return m;
  }, [folders]);
  const folderCounts = useMemo(() => recursiveFolderCounts(folders), [folders]);
  const activeFolder = folders[folderCursor];
  const activeFolderIds = useMemo(
    () => descendantIdSet(activeFolder, folders),
    [activeFolder, folders],
  );

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

  // Surface backend errors as toast.
  useEffect(() => {
    if (notesError) setToast(`Failed to load notes: ${notesError}`);
  }, [notesError]);

  // Reset note cursor when active folder, filter, or sort changes.
  useEffect(() => {
    setNoteCursor(0);
  }, [folderCursor, filter, sort]);

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

  const noteOptions: SelectOption[] = useMemo(() => {
    // Only show the [ ]/[x] column once the user has started marking; until
    // then, titles render unprefixed (matches Apple Notes' default).
    const showMarkColumn = marked.size > 0;
    return visibleNotes.map((n) => {
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
  }, [visibleNotes, marked, snippetCache]);

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

  const newNote = async () => {
    if (!activeFolder) {
      setToast("Select a folder first");
      return;
    }
    try {
      await notes.createNote(activeFolder.id);
      setToast(`New note in ${activeFolder.path}`);
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
      setToast(`Created folder "${trimmed}" in ${activeFolder.account}`);
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
      setMode({ kind: "edit", noteId: highlightedNote.id });
    } catch (e) {
      setToast(
        `Failed to open editor: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };

  const cancelEdit = () => {
    setEditBuffer("");
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
      setMode({ kind: "browse" });
      // Title may have changed (first line of body); refresh list + caches.
      if (highlightedNote) {
        invalidateNotes([highlightedNote.folderId]);
        invalidateSnippets([highlightedNote.folderId]);
      }
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
    ? `Move ${mode.sourceCount} note${mode.sourceCount === 1 ? "" : "s"} → ...`
    : "Folders";
  const noteTitle =
    `Notes [${SORT_LABEL[sort]}]` +
    `${marked.size > 0 ? `  (${marked.size} marked)` : ""}` +
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
            visibleNotes.length,
            NOTE_LINES_PER_ITEM,
            (i) => {
              setNoteCursor(i);
              setFocused("notes");
            },
          )}
          onMouseScroll={makeWheelScrollHandler(
            visibleNotes.length,
            setNoteCursor,
          )}
        />

        <PreviewPane
          title={previewTitle}
          body={preview}
          loading={previewLoading}
          hasSelection={!!highlightedNote}
          editing={mode.kind === "edit"}
          initialEditValue={editBuffer}
          textareaRef={textareaRef}
        />
      </box>

      <box>
        <text fg="#777">
          {mode.kind === "browse" &&
            "↑↓ nav · Tab switch · n new note · N new folder · Space mark · m move · / filter · s sort · ? help · q quit"}
          {mode.kind === "moveTarget" &&
            "Pick destination · ↑↓ nav · Enter move · Esc cancel"}
          {mode.kind === "filter" &&
            "Filter notes · type to search · Enter apply · Esc cancel"}
          {mode.kind === "newFolder" &&
            "New folder · type name · Enter create · Esc cancel"}
          {mode.kind === "edit" &&
            "Edit note · type to change · Ctrl+S save · Esc cancel"}
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
