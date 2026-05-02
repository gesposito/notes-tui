import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createCliRenderer,
  type MouseEvent as OpenTUIMouseEvent,
  type SelectOption,
  type SelectRenderable,
} from "@opentui/core";
import {
  createRoot,
  useKeyboard,
  useRenderer,
  useTerminalDimensions,
} from "@opentui/react";
import type { Folder, Note } from "./notes/index.ts";
import { notes as defaultBackend } from "./notes/index.ts";
import { NotesProvider, useNotes } from "./notes/context.tsx";

type Pane = "folders" | "notes";
type Mode =
  | { kind: "browse" }
  | { kind: "filter" }
  | { kind: "moveTarget"; sourceAccount: string; sourceCount: number };

type SortMode = "dateDesc" | "dateAsc" | "titleAsc";
const SORT_CYCLE: SortMode[] = ["dateDesc", "dateAsc", "titleAsc"];
const SORT_LABEL: Record<SortMode, string> = {
  dateDesc: "Date ↓",
  dateAsc: "Date ↑",
  titleAsc: "Title",
};

// === Folder pane render config ================================================
// SHOW_FOLDER_COUNTS=false  → bare folder names.
// RIGHT_ALIGN_COUNTS=false  → count inline (e.g. "Work  12"), no truncation.
// FOLDER_INNER_WIDTH        → usable content width when right-aligning.
//   Pane width − 2 border − 2 padding − 1 scroll indicator column.
//   (Select reserves the rightmost column for showScrollIndicator even when
//   it's not currently visible; without this offset the count gets clipped.)
const SHOW_FOLDER_COUNTS = true;
const RIGHT_ALIGN_COUNTS = true;
const FOLDER_PANE_WIDTH = 36;
const FOLDER_INNER_WIDTH = FOLDER_PANE_WIDTH - 4 - 1;
// ==============================================================================

const formatFolderOptionName = (
  indent: string,
  name: string,
  count: number,
): string => {
  const baseName = indent + name;
  if (!SHOW_FOLDER_COUNTS) return baseName;
  const countText = count > 0 ? String(count) : "";
  if (!countText) return baseName;

  if (!RIGHT_ALIGN_COUNTS) {
    return `${baseName}  ${countText}`;
  }

  const minGap = 1;
  const maxNameLen = FOLDER_INNER_WIDTH - countText.length - minGap;
  const truncated =
    baseName.length > maxNameLen
      ? baseName.substring(0, Math.max(0, maxNameLen - 1)) + "…"
      : baseName;
  const padding = Math.max(
    minGap,
    FOLDER_INNER_WIDTH - truncated.length - countText.length,
  );
  return truncated + " ".repeat(padding) + countText;
};

export const App = () => {
  const notes = useNotes();
  const renderer = useRenderer();
  const { height: termHeight } = useTerminalDimensions();
  // Approx visible rows per pane: terminal height minus borders, title, footer, toast.
  const pageStep = Math.max(5, termHeight - 6);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [folderCursor, setFolderCursor] = useState(0);
  const [noteCursor, setNoteCursor] = useState(0);
  const [marked, setMarked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<SortMode>("dateDesc");
  const [focused, setFocused] = useState<Pane>("folders");
  const [mode, setMode] = useState<Mode>({ kind: "browse" });
  const [toast, setToast] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const folderSelectRef = useRef<SelectRenderable | null>(null);
  const noteSelectRef = useRef<SelectRenderable | null>(null);
  const [folderScrollOffset, setFolderScrollOffset] = useState(0);
  const [noteScrollOffset, setNoteScrollOffset] = useState(0);
  const [preview, setPreview] = useState<string>("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewSeq = useRef(0);
  const [snippetCache, setSnippetCache] = useState<
    Map<string, Record<string, string>>
  >(new Map());
  const inFlightSnippets = useRef<Set<string>>(new Set());
  // Lazy-loaded notes: Map<folderId, Note[]>. Populated on demand per folder.
  const [notesByFolder, setNotesByFolder] = useState<Map<string, Note[]>>(
    new Map(),
  );
  const inFlightNotes = useRef<Set<string>>(new Set());

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const f = await notes.listFolders();
      setFolders(f);
      // Cached notes/snippets stay across reload; entries for moved-from
      // and moved-to folders should be invalidated by the caller.
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const activeFolder = folders[folderCursor];

  // Active folder + every descendant (matches Apple Notes' "selecting a parent
  // shows everything beneath it" behavior).
  const activeFolderIds = useMemo(() => {
    if (!activeFolder) return new Set<string>();
    const ids = new Set<string>([activeFolder.id]);
    const prefix = activeFolder.path + " / ";
    for (const f of folders) {
      if (f.path.startsWith(prefix)) ids.add(f.id);
    }
    return ids;
  }, [activeFolder, folders]);

  const visibleNotes = useMemo(() => {
    if (activeFolderIds.size === 0) return [];
    const all: Note[] = [];
    for (const fid of activeFolderIds) {
      const arr = notesByFolder.get(fid);
      if (arr) all.push(...arr);
    }
    const filtered = !filter
      ? all
      : (() => {
          const q = filter.toLowerCase();
          return all.filter((n) => n.title.toLowerCase().includes(q));
        })();
    // Sort a copy so we don't mutate the cache arrays.
    const sorted = filtered.slice();
    if (sort === "dateDesc") {
      sorted.sort((a, b) => (b.modifiedAt ?? "").localeCompare(a.modifiedAt ?? ""));
    } else if (sort === "dateAsc") {
      sorted.sort((a, b) => (a.modifiedAt ?? "").localeCompare(b.modifiedAt ?? ""));
    } else {
      sorted.sort((a, b) =>
        (a.title || "").toLowerCase().localeCompare((b.title || "").toLowerCase()),
      );
    }
    return sorted;
  }, [notesByFolder, activeFolderIds, filter, sort]);

  // Lazy-fetch notes for any active folder we don't have cached yet.
  // One backend call covers the whole fan-out (active + descendants).
  useEffect(() => {
    if (activeFolderIds.size === 0) return;
    const toFetch: string[] = [];
    for (const folderId of activeFolderIds) {
      if (notesByFolder.has(folderId)) continue;
      if (inFlightNotes.current.has(folderId)) continue;
      toFetch.push(folderId);
      inFlightNotes.current.add(folderId);
    }
    if (toFetch.length === 0) return;
    notes
      .getFolderNotes(toFetch)
      .then((arr) => {
        // Group returned notes by folderId.
        const grouped: Record<string, Note[]> = {};
        for (const n of arr) {
          (grouped[n.folderId] ||= []).push(n);
        }
        setNotesByFolder((m) => {
          const next = new Map(m);
          for (const fid of toFetch) {
            next.set(fid, grouped[fid] ?? []);
          }
          return next;
        });
      })
      .catch((e) => {
        setToast(
          `Failed to load notes: ${e instanceof Error ? e.message : String(e)}`,
        );
      })
      .finally(() => {
        for (const fid of toFetch) inFlightNotes.current.delete(fid);
      });
  }, [activeFolderIds, notesByFolder]);

  // For O(1) folder lookup by id (account/path resolution from a Note).
  const folderById = useMemo(() => {
    const m = new Map<string, Folder>();
    for (const f of folders) m.set(f.id, f);
    return m;
  }, [folders]);

  // Reset note cursor when active folder, filter, or sort changes.
  useEffect(() => {
    setNoteCursor(0);
  }, [folderCursor, filter, sort]);

  // Approximate visible rows per pane.
  // Folders: 1 line per item; Notes: 2 lines (showDescription=true).
  const folderVisibleRows = Math.max(1, termHeight - 5);
  const filterRowVisible = mode.kind === "filter" || filter.length > 0;
  const NOTE_LINES_PER_ITEM = 2;
  const noteVisibleRows = Math.max(
    1,
    Math.floor((termHeight - 5 - (filterRowVisible ? 1 : 0)) / NOTE_LINES_PER_ITEM),
  );

  // Mirror Select's scrollOffset (private internally) by re-running the same
  // keep-cursor-in-view logic on every cursor change.
  useEffect(() => {
    setFolderScrollOffset((prev) => {
      if (folders.length <= folderVisibleRows) return 0;
      let next = prev;
      if (folderCursor < next) next = folderCursor;
      else if (folderCursor >= next + folderVisibleRows)
        next = folderCursor - folderVisibleRows + 1;
      return Math.max(0, Math.min(next, folders.length - folderVisibleRows));
    });
  }, [folderCursor, folderVisibleRows, folders.length]);

  useEffect(() => {
    setNoteScrollOffset((prev) => {
      if (visibleNotes.length <= noteVisibleRows) return 0;
      let next = prev;
      if (noteCursor < next) next = noteCursor;
      else if (noteCursor >= next + noteVisibleRows)
        next = noteCursor - noteVisibleRows + 1;
      return Math.max(
        0,
        Math.min(next, visibleNotes.length - noteVisibleRows),
      );
    });
  }, [noteCursor, noteVisibleRows, visibleNotes.length]);

  // Lazy-fetch snippets for every folder contributing to visibleNotes
  // (active folder + descendants). Cached per folder, deduped via
  // inFlightSnippets. One backend call covers the whole fan-out.
  useEffect(() => {
    if (activeFolderIds.size === 0) return;
    const toFetch: string[] = [];
    for (const folderId of activeFolderIds) {
      if (snippetCache.has(folderId)) continue;
      if (inFlightSnippets.current.has(folderId)) continue;
      toFetch.push(folderId);
      inFlightSnippets.current.add(folderId);
    }
    if (toFetch.length === 0) return;
    notes
      .getFolderSnippets(toFetch)
      .then((byFolder) => {
        setSnippetCache((m) => {
          const next = new Map(m);
          for (const [fid, snippets] of Object.entries(byFolder)) {
            next.set(fid, snippets);
          }
          return next;
        });
      })
      .catch(() => {
        // Snippets are non-critical; swallow.
      })
      .finally(() => {
        for (const fid of toFetch) inFlightSnippets.current.delete(fid);
      });
  }, [activeFolderIds, snippetCache]);

  // Lazy-fetch preview when highlighted note changes. Debounced so fast
  // keyboard nav doesn't spawn an osascript per keystroke; sequence counter
  // discards stale responses.
  const highlightedNoteId = visibleNotes[noteCursor]?.id;
  useEffect(() => {
    if (!highlightedNoteId) {
      setPreview("");
      setPreviewLoading(false);
      return;
    }
    const seq = ++previewSeq.current;
    setPreviewLoading(true);
    const timer = setTimeout(async () => {
      try {
        const body = await notes.getNoteBody(highlightedNoteId);
        if (previewSeq.current === seq) {
          setPreview(body);
          setPreviewLoading(false);
        }
      } catch (e) {
        if (previewSeq.current === seq) {
          setPreview(`(error: ${e instanceof Error ? e.message : String(e)})`);
          setPreviewLoading(false);
        }
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [highlightedNoteId]);

  const folderCounts = useMemo(() => {
    // Direct counts come from the backend (Folder.noteCount).
    // Recursive: each folder's total = own + sum over descendants. O(F²);
    // fine for hundreds of folders.
    const recursive: Record<string, number> = {};
    for (const f of folders) {
      let total = f.noteCount;
      const prefix = f.path + " / ";
      for (const child of folders) {
        if (child.id !== f.id && child.path.startsWith(prefix)) {
          total += child.noteCount;
        }
      }
      recursive[f.id] = total;
    }
    return recursive;
  }, [folders]);

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

  const noteOptions: SelectOption[] = useMemo(
    () =>
      visibleNotes.map((n) => {
        const date = n.modifiedAt ? n.modifiedAt.substring(0, 10) : "";
        const snippet = snippetCache.get(n.folderId)?.[n.id] ?? "";
        const meta =
          date && snippet ? `${date}  ${snippet}` : date || snippet || "";
        return {
          name: `${marked.has(n.id) ? "[x]" : "[ ]"} ${n.title || "(untitled)"}`,
          description: meta,
          value: n.id,
        };
      }),
    [visibleNotes, marked, snippetCache],
  );

  const performMove = async (target: Folder, sourceAccount: string) => {
    if (target.account !== sourceAccount) {
      setToast(`Cannot move to ${target.account} (cross-account)`);
      return;
    }
    const ids =
      marked.size > 0
        ? Array.from(marked)
        : visibleNotes[noteCursor]
          ? [visibleNotes[noteCursor]!.id]
          : [];
    if (ids.length === 0) {
      setToast("Nothing to move");
      return;
    }
    // Identify source folder ids so we know what to invalidate.
    const sourceFolderIds = new Set<string>();
    for (const id of ids) {
      for (const arr of notesByFolder.values()) {
        const note = arr.find((n) => n.id === id);
        if (note) {
          sourceFolderIds.add(note.folderId);
          break;
        }
      }
    }
    sourceFolderIds.add(target.id);

    setLoading(true);
    try {
      const results = await notes.moveNotes(
        ids.map((noteId) => ({ noteId, folderId: target.id })),
      );
      const ok = results.filter((r) => r.ok).length;
      const failed = results.length - ok;
      setToast(
        `Moved ${ok} note${ok === 1 ? "" : "s"} → ${target.path}` +
          (failed ? ` (${failed} failed)` : ""),
      );
      setMarked(new Set());
      setMode({ kind: "browse" });
      setFocused("notes");
      // Invalidate notes + snippets for source(s) and destination so the
      // next render re-fetches fresh data.
      setNotesByFolder((m) => {
        const next = new Map(m);
        for (const fid of sourceFolderIds) next.delete(fid);
        return next;
      });
      setSnippetCache((m) => {
        const next = new Map(m);
        for (const fid of sourceFolderIds) next.delete(fid);
        return next;
      });
      await reload();
    } catch (e) {
      setToast(`Move failed: ${e instanceof Error ? e.message : String(e)}`);
      setLoading(false);
    }
  };

  const quit = () => {
    renderer?.destroy();
    process.exit(0);
  };

  const scrollSelect = (
    total: number,
    setCursor: (updater: (n: number) => number) => void,
    e: OpenTUIMouseEvent,
  ) => {
    const dir = e.scroll?.direction;
    if (!dir || total === 0) return;
    const step = 3;
    const delta = dir === "up" ? -step : dir === "down" ? step : 0;
    if (delta === 0) return;
    setCursor((c) => {
      const next = c + delta;
      if (next < 0) return 0;
      if (next >= total) return total - 1;
      return next;
    });
  };

  const handleSelectClick = (
    sel: SelectRenderable | null,
    offset: number,
    total: number,
    linesPerItem: number,
    setCursor: (i: number) => void,
    pane: Pane,
    e: OpenTUIMouseEvent,
  ) => {
    if (!sel || e.button !== 0) return;
    const localY = e.y - sel.screenY;
    if (localY < 0) return;
    const clickedIndex = offset + Math.floor(localY / linesPerItem);
    if (clickedIndex < 0 || clickedIndex >= total) return;
    setCursor(clickedIndex);
    setFocused(pane);
  };

  useKeyboard((key) => {
    // Filter mode: <input> owns most input; we only catch Esc.
    if (mode.kind === "filter") {
      if (key.name === "escape") {
        setMode({ kind: "browse" });
        setFilter("");
      }
      return;
    }

    if (mode.kind === "moveTarget") {
      if (key.name === "escape") {
        setMode({ kind: "browse" });
        setFocused("notes");
      }
      return;
    }

    // browse mode
    if (key.name === "q") {
      quit();
      return;
    }
    if (key.name === "tab") {
      setFocused((p) => (p === "folders" ? "notes" : "folders"));
      return;
    }
    if (key.name === "/") {
      setFilter("");
      setMode({ kind: "filter" });
      return;
    }
    if (key.name === "s") {
      setSort((s) => {
        const i = SORT_CYCLE.indexOf(s);
        return SORT_CYCLE[(i + 1) % SORT_CYCLE.length]!;
      });
      return;
    }

    if (focused !== "notes") return;

    if (key.name === "space") {
      const note = visibleNotes[noteCursor];
      if (!note) return;
      setMarked((m) => {
        const next = new Set(m);
        if (next.has(note.id)) next.delete(note.id);
        else next.add(note.id);
        return next;
      });
      return;
    }

    if (key.name === "m") {
      const ids =
        marked.size > 0
          ? Array.from(marked)
          : visibleNotes[noteCursor]
            ? [visibleNotes[noteCursor]!.id]
            : [];
      if (ids.length === 0) {
        setToast("Nothing to move");
        return;
      }
      // Account lookup: notes don't carry account directly; resolve via folder.
      const accounts = new Set<string>();
      for (const id of ids) {
        for (const arr of notesByFolder.values()) {
          const note = arr.find((n) => n.id === id);
          if (note) {
            const folder = folderById.get(note.folderId);
            if (folder) accounts.add(folder.account);
            break;
          }
        }
      }
      if (accounts.size > 1) {
        setToast("Cannot move across accounts");
        return;
      }
      const [sourceAccount] = accounts;
      if (!sourceAccount) return;
      setMode({
        kind: "moveTarget",
        sourceAccount,
        sourceCount: ids.length,
      });
      setFocused("folders");
    }
  });

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

  return (
    <box flexDirection="column" width="100%" height="100%">
      <box flexDirection="row" flexGrow={1}>
        {/* Folder pane */}
        <box
          width={FOLDER_PANE_WIDTH}
          border
          borderColor={folderBorderColor}
          title={folderTitle}
          onMouseScroll={(e) =>
            scrollSelect(folders.length, setFolderCursor, e)
          }
        >
          <select
            ref={folderSelectRef}
            style={{ flexGrow: 1 }}
            options={folderOptions}
            focused={focused === "folders" || moveTargetMode}
            selectedIndex={folderCursor}
            showScrollIndicator
            showDescription={false}
            wrapSelection
            fastScrollStep={pageStep}
            onMouseDown={(e) =>
              handleSelectClick(
                folderSelectRef.current,
                folderScrollOffset,
                folders.length,
                1,
                setFolderCursor,
                "folders",
                e,
              )
            }
            onChange={(i) => setFolderCursor(i)}
            onSelect={(i) => {
              if (moveTargetMode) {
                const target = folders[i];
                if (target) void performMove(target, mode.sourceAccount);
              } else {
                setFocused("notes");
              }
            }}
          />
        </box>

        {/* Notes pane */}
        <box
          width={44}
          border
          borderColor={noteBorderColor}
          title={noteTitle}
          flexDirection="column"
          onMouseScroll={(e) =>
            scrollSelect(visibleNotes.length, setNoteCursor, e)
          }
        >
          {mode.kind === "filter" && (
            <input
              focused
              placeholder="Filter notes…"
              onInput={setFilter}
              onSubmit={() => setMode({ kind: "browse" })}
            />
          )}
          {filter && mode.kind !== "filter" && (
            <text fg="#777">filter: {filter}</text>
          )}
          {visibleNotes.length === 0 ? (
            <text fg="#777">(no notes)</text>
          ) : (
            <select
              ref={noteSelectRef}
              style={{ flexGrow: 1 }}
              options={noteOptions}
              focused={focused === "notes" && mode.kind === "browse"}
              selectedIndex={noteCursor}
              showScrollIndicator
              showDescription
              wrapSelection
              fastScrollStep={pageStep}
              onMouseDown={(e) =>
                handleSelectClick(
                  noteSelectRef.current,
                  noteScrollOffset,
                  visibleNotes.length,
                  NOTE_LINES_PER_ITEM,
                  setNoteCursor,
                  "notes",
                  e,
                )
              }
              onChange={(i) => setNoteCursor(i)}
            />
          )}
        </box>

        {/* Preview pane */}
        <box
          flexGrow={1}
          border
          borderColor="#555"
          title={
            visibleNotes[noteCursor]
              ? visibleNotes[noteCursor]!.title || "(untitled)"
              : "Preview"
          }
          flexDirection="column"
        >
          <scrollbox style={{ flexGrow: 1 }}>
            {previewLoading && !preview && (
              <text fg="#777">Loading preview…</text>
            )}
            {!highlightedNoteId && <text fg="#777">(no note selected)</text>}
            {preview && <text>{preview}</text>}
          </scrollbox>
        </box>
      </box>

      {/* Footer */}
      <box>
        <text fg="#777">
          {mode.kind === "browse" &&
            "Tab: switch · ↑↓: nav · Shift+↑↓: page · Space: mark · m: move · /: filter · s: sort · q: quit"}
          {mode.kind === "moveTarget" &&
            "Pick destination · ↑↓: nav · Shift+↑↓: page · Enter: move · Esc: cancel"}
          {mode.kind === "filter" &&
            "Filter notes · type to search · Enter: apply · Esc: cancel"}
        </text>
      </box>
      {toast && <text fg="#33cc66">{toast}</text>}
    </box>
  );
};

// Only spin up the renderer when this file is the entry point; tests can
// import App without triggering a real terminal session.
if (import.meta.main) {
  const renderer = await createCliRenderer({ screenMode: "alternate-screen" });
  createRoot(renderer).render(
    <NotesProvider backend={defaultBackend}>
      <App />
    </NotesProvider>,
  );
}
