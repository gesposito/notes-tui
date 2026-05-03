import { describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { App } from "./app.tsx";
import { NotesProvider } from "./notes/context.tsx";
import type { Folder, Note, NotesBackend } from "./notes/types.ts";

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

const fixtureFolders: Folder[] = [
  {
    id: "f1",
    name: "Personal",
    account: "iCloud",
    path: "iCloud / Personal",
    depth: 0,
    noteCount: 2,
  },
  {
    id: "f2",
    name: "Work",
    account: "iCloud",
    path: "iCloud / Work",
    depth: 0,
    noteCount: 1,
  },
];

const fixtureNotes: Note[] = [
  {
    id: "n1",
    title: "Shopping list",
    folderId: "f1",
    modifiedAt: "2026-05-02T10:00:00Z",
  },
  {
    id: "n2",
    title: "Recipe ideas",
    folderId: "f1",
    modifiedAt: "2026-05-01T10:00:00Z",
  },
  {
    id: "n3",
    title: "Quarterly report",
    folderId: "f2",
    modifiedAt: "2026-04-30T10:00:00Z",
  },
];

const makeMock = (overrides: Partial<NotesBackend> = {}): NotesBackend => ({
  listFolders: async () => fixtureFolders,
  getFolderNotes: async (ids) =>
    fixtureNotes.filter((n) => ids.includes(n.folderId)),
  getNoteBody: async (id) => `Body of ${id}`,
  getFolderSnippets: async (ids) =>
    Object.fromEntries(ids.map((id) => [id, {}])),
  getFolderBodies: async (ids) =>
    Object.fromEntries(ids.map((id) => [id, {}])),
  moveNotes: async (moves) =>
    moves.map((m) => ({ noteId: m.noteId, ok: true })),
  createNote: async () => undefined,
  createFolder: async () => undefined,
  getNoteHtml: async (id) => `<p>Body of ${id}</p>`,
  updateNoteBody: async () => undefined,
  ...overrides,
});

const settle = (ms = 50): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// Wrap any state-mutating step (mount drain, key event, mock backend
// resolution) in React's act(...) so React stops complaining about
// unflushed state. Pairs with a renderOnce() in the test for the
// terminal-buffer flush. The drainMs default covers the preview-debounce
// (150ms) plus a margin for chained useEffect updates.
const interact = (
  fn: () => void | Promise<unknown>,
  drainMs = 200,
): Promise<void> =>
  act(async () => {
    const result = fn();
    if (result && typeof (result as Promise<unknown>).then === "function") {
      await result;
    }
    await settle(drainMs);
  });

// Plain-render variant for tests that need to see the loading state.
// testRender itself isn't wrapped in act, so we wrap the call so
// post-commit effects are captured.
const mountRaw = async (backend: NotesBackend) => {
  let handles!: Awaited<ReturnType<typeof testRender>>;
  await act(async () => {
    handles = await testRender(
      <NotesProvider backend={backend}>
        <App />
      </NotesProvider>,
      { width: 140, height: 30 },
    );
  });
  return handles;
};

// Standard mount: drains the initial useEffect chain (listFolders →
// activeFolderIds → getFolderNotes/getFolderSnippets → preview-debounce)
// so the test sees a fully-loaded UI.
const mount = async (backend: NotesBackend) => {
  const handles = await mountRaw(backend);
  await interact(() => settle(0), 250);
  await handles.renderOnce();
  return handles;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("notes-tui", () => {
  test("shows the loading screen until folders resolve", async () => {
    let resolveListFolders: (f: Folder[]) => void = () => {};
    const slow = makeMock({
      listFolders: () =>
        new Promise<Folder[]>((r) => {
          resolveListFolders = r;
        }),
    });
    const { renderOnce, captureCharFrame } = await mountRaw(slow);
    await renderOnce();
    expect(captureCharFrame()).toContain("Loading notes");
    // Resolve and drain so the test exits cleanly.
    await interact(() => {
      resolveListFolders(fixtureFolders);
    });
  });

  test("renders the folder pane after listFolders resolves", async () => {
    const { captureCharFrame } = await mount(makeMock());
    const frame = captureCharFrame();
    expect(frame).toContain("Personal");
    expect(frame).toContain("Work");
    expect(frame).toContain("Folders");
  });

  test("populates the notes pane via lazy getFolderNotes for the active folder", async () => {
    const { captureCharFrame } = await mount(makeMock());
    const frame = captureCharFrame();
    expect(frame).toContain("Shopping list");
    expect(frame).toContain("Recipe ideas");
  });

  test("'s' cycles through sort modes", async () => {
    const { mockInput, renderOnce, captureCharFrame } = await mount(makeMock());
    expect(captureCharFrame()).toContain("[Date ↓]");

    await interact(() => mockInput.pressKeys(["s"]));
    await renderOnce();
    expect(captureCharFrame()).toContain("[Date ↑]");

    await interact(() => mockInput.pressKeys(["s"]));
    await renderOnce();
    expect(captureCharFrame()).toContain("[Title]");

    await interact(() => mockInput.pressKeys(["s"]));
    await renderOnce();
    expect(captureCharFrame()).toContain("[Date ↓]");
  });

  test("'?' toggles the help dialog", async () => {
    const { mockInput, renderOnce, captureCharFrame } = await mount(makeMock());
    expect(captureCharFrame()).not.toContain("Keyboard shortcuts");

    await interact(() => mockInput.pressKeys(["?"]));
    await renderOnce();
    expect(captureCharFrame()).toContain("Keyboard shortcuts");
    // A few entries from the dialog content
    expect(captureCharFrame()).toContain("Navigation");
    expect(captureCharFrame()).toContain("Sort By");

    await interact(() => mockInput.pressKeys(["?"]));
    await renderOnce();
    expect(captureCharFrame()).not.toContain("Keyboard shortcuts");
  });

  test("'n' creates a note in the active folder", async () => {
    const createNote = mock(async () => undefined);
    const { mockInput, renderOnce } = await mount(makeMock({ createNote }));

    await interact(() => mockInput.pressKeys(["n"]));
    await renderOnce();

    expect(createNote).toHaveBeenCalledTimes(1);
    // Active folder at startup is fixtureFolders[0] → "f1"
    expect(createNote).toHaveBeenCalledWith("f1");
  });

  test("'N' opens the new-folder dialog; Enter creates with the prefilled name", async () => {
    const createFolder = mock(async () => undefined);
    const { mockInput, renderOnce, captureCharFrame } = await mount(
      makeMock({ createFolder }),
    );

    await interact(() => mockInput.pressKeys(["N"]));
    await renderOnce();
    const frame = captureCharFrame();
    // Dialog markers: title + label
    expect(frame).toContain("New Folder");
    expect(frame).toContain("Name:");

    // Enter commits the prefilled value ("New Folder").
    await interact(() => mockInput.pressEnter());
    await renderOnce();

    expect(createFolder).toHaveBeenCalledTimes(1);
    // Account from active folder ("iCloud"), name from prefill ("New Folder").
    expect(createFolder).toHaveBeenCalledWith("iCloud", "New Folder");
  });

  test("Esc cancels the new-folder dialog without creating", async () => {
    const createFolder = mock(async () => undefined);
    const { mockInput, renderOnce, captureCharFrame } = await mount(
      makeMock({ createFolder }),
    );

    await interact(() => mockInput.pressKeys(["N"]));
    await renderOnce();
    expect(captureCharFrame()).toContain("Name:");

    await interact(() => mockInput.pressEscape());
    await renderOnce();
    // Dialog gone: the "Name:" label only appears inside the dialog.
    expect(captureCharFrame()).not.toContain("Name:");
    expect(createFolder).not.toHaveBeenCalled();
  });

  test("Tab → Space marks a note → 'm' enters move mode", async () => {
    const { mockInput, renderOnce, captureCharFrame } = await mount(makeMock());

    // Tab moves focus to the notes pane.
    await interact(() => mockInput.pressTab());
    await renderOnce();

    // Space marks the highlighted note.
    await interact(() => mockInput.pressKeys([" "]));
    await renderOnce();
    // The [x] marker on the row is the reliable visual signal; the
    // header "(1 marked)" line gets hidden when the title overflows.
    expect(captureCharFrame()).toContain("[x] Shopping list");

    // 'm' enters move mode; the folder pane title flips.
    await interact(() => mockInput.pressKeys(["m"]));
    await renderOnce();
    expect(captureCharFrame()).toContain("Move To…");
  });

  // Regression: in move mode the picker must list every folder (not just
  // the visible/expanded subset) AND the index→folder mapping in the
  // dispatcher must agree with what's on screen. Earlier code listed
  // `visibleFolders` but indexed `folders[i]` in onSelect, so picking a
  // target with any parent collapsed would silently move the note to a
  // *different* folder at the same numeric position in the unfiltered
  // list. We assert both halves below.
  test(
    "move-target picker shows the full tree and dispatches to the visually-selected folder",
    async () => {
      const nestedFolders: Folder[] = [
        { id: "alpha",   name: "Alpha",   account: "iCloud", path: "iCloud / Alpha",         depth: 0, noteCount: 1 },
        { id: "bravo",   name: "Bravo",   account: "iCloud", path: "iCloud / Bravo",         depth: 0, noteCount: 0 },
        { id: "b-child", name: "DeepFolder",   account: "iCloud", path: "iCloud / Bravo / Child", depth: 1, noteCount: 1 },
        { id: "charlie", name: "Charlie", account: "iCloud", path: "iCloud / Charlie",       depth: 0, noteCount: 1 },
      ];
      const nestedNotes: Note[] = [
        { id: "n-alpha",   title: "InAlpha",   folderId: "alpha",   modifiedAt: "2026-05-03T10:00:00Z" },
        { id: "n-child",   title: "InDeep",    folderId: "b-child", modifiedAt: "2026-05-03T10:01:00Z" },
        { id: "n-charlie", title: "InCharlie", folderId: "charlie", modifiedAt: "2026-05-03T10:02:00Z" },
      ];
      const moveNotes = mock(async (moves: Array<{ noteId: string; folderId: string }>) =>
        moves.map((m) => ({ noteId: m.noteId, ok: true })),
      );
      const { mockInput, renderOnce, captureCharFrame } = await mount(
        makeMock({
          listFolders: async () => nestedFolders,
          getFolderNotes: async (ids) =>
            nestedNotes.filter((n) => ids.includes(n.folderId)),
          moveNotes,
        }),
      );

      // Default expand-all: all 4 rows visible.
      expect(captureCharFrame()).toContain("DeepFolder");

      // Move cursor to Bravo (index 1 in the expanded tree) and collapse
      // it. The 300ms drain after ↓ guarantees the 150ms folder-cursor
      // debounce has settled, so collapseOrParent reads the *new* active
      // folder (Bravo) rather than the old one (Alpha).
      await interact(() => mockInput.pressArrow("down"), 300);
      await renderOnce();
      await interact(() => mockInput.pressArrow("left"));
      await renderOnce();
      // After collapse: Child is hidden in browse mode.
      expect(captureCharFrame()).not.toContain("DeepFolder");

      // Tab to notes pane, mark the only note (Bravo collapsed → its
      // subtree is aggregated → "InChild" shows up there).
      await interact(() => mockInput.pressTab());
      await renderOnce();
      await interact(() => mockInput.pressKeys([" "]));
      await renderOnce();

      // Enter move mode.
      await interact(() => mockInput.pressKeys(["m"]));
      await renderOnce();
      const moveFrame = captureCharFrame();
      expect(moveFrame).toContain("Move To…");
      // Half 1 of the regression: picker re-expands to the full tree even
      // though Bravo is still collapsed in browse mode.
      expect(moveFrame).toContain("DeepFolder");

      // Cursor was seeded to Bravo's position in the full list (index 1).
      // Press ↓ twice to reach Charlie (index 3 in folders[]).
      // Half 2 of the regression: in the buggy code, the picker only
      // listed 3 visible rows so ↓↓ from Bravo would wrap to Alpha and
      // dispatch via `folders[0]`. We assert we land on Charlie.
      await interact(() => mockInput.pressArrow("down"));
      await renderOnce();
      await interact(() => mockInput.pressArrow("down"));
      await renderOnce();
      await interact(() => mockInput.pressEnter());
      await renderOnce();

      expect(moveNotes).toHaveBeenCalledTimes(1);
      expect(moveNotes).toHaveBeenCalledWith([
        { noteId: "n-child", folderId: "charlie" },
      ]);
    },
  );
});
