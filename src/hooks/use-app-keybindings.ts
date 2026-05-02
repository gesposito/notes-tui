import type { Dispatch, SetStateAction } from "react";
import { useKeyboard } from "@opentui/react";
import { cycleSort, type SortMode } from "../lib/sort.ts";
import type { Note } from "../notes/types.ts";
import type { Mode, Pane } from "../types.ts";

type Deps = {
  mode: Mode;
  focused: Pane;
  helpOpen: boolean;
  highlightedNote: Note | undefined;
  setMode: (m: Mode) => void;
  setFocused: Dispatch<SetStateAction<Pane>>;
  setFilter: (f: string) => void;
  setSort: Dispatch<SetStateAction<SortMode>>;
  setMarked: Dispatch<SetStateAction<Set<string>>>;
  setHelpOpen: Dispatch<SetStateAction<boolean>>;
  enterMoveMode: () => void;
  enterNewFolder: () => void;
  enterEdit: () => void;
  saveEdit: () => void;
  cancelEdit: () => void;
  newNote: () => void;
  refresh: () => void;
  quit: () => void;
};

// Some terminals report `?` directly; others report `/` with shift. Match either.
const isHelpKey = (key: { name: string; shift?: boolean }): boolean =>
  key.name === "?" || (key.name === "/" && key.shift === true);

/**
 * All app-level keybindings in one place. Mode-aware:
 *   - filter:     Esc cancels (the <input> handles printable keys + Enter).
 *   - moveTarget: Esc returns to browse.
 *   - browse:     Tab/q/// /s globally; Space/m only when notes pane is focused.
 *
 * Folder/notes navigation (↑/↓/Enter) is handled internally by each Select.
 */
export const useAppKeybindings = (deps: Deps): void => {
  useKeyboard((key) => {
    // help dialog: ? or Esc closes it; nothing else does anything
    if (deps.helpOpen) {
      if (isHelpKey(key) || key.name === "escape") deps.setHelpOpen(false);
      return;
    }

    // ? opens help from anywhere except filter mode (where <input> may consume it)
    if (deps.mode.kind !== "filter" && isHelpKey(key)) {
      deps.setHelpOpen(true);
      return;
    }

    // filter mode — the <input> owns printable keys; only Esc bubbles here
    if (deps.mode.kind === "filter") {
      if (key.name === "escape") {
        deps.setMode({ kind: "browse" });
        deps.setFilter("");
      }
      return;
    }

    // moveTarget mode — folder Select handles ↑/↓/Enter; only Esc bubbles
    if (deps.mode.kind === "moveTarget") {
      if (key.name === "escape") {
        deps.setMode({ kind: "browse" });
        deps.setFocused("notes");
      }
      return;
    }

    // newFolder mode — <input> owns printable keys; only Esc bubbles
    if (deps.mode.kind === "newFolder") {
      if (key.name === "escape") deps.setMode({ kind: "browse" });
      return;
    }

    // edit mode — <textarea> consumes printable keys; we only listen for
    // Ctrl+S (save) and Esc (cancel). Note: terminals with flow control on
    // intercept Ctrl+S — `stty -ixon` if you need to disable that.
    if (deps.mode.kind === "edit") {
      if (key.name === "escape") {
        deps.cancelEdit();
        return;
      }
      if (key.name === "s" && key.ctrl) {
        deps.saveEdit();
      }
      return;
    }

    // browse mode
    if (key.name === "q") {
      deps.quit();
      return;
    }
    if (key.name === "tab") {
      deps.setFocused((p) => (p === "folders" ? "notes" : "folders"));
      return;
    }
    // Note List Search: `f` (mirrors Apple's ⌥⌘F without the modifiers
    // most terminals strip). ⌥⌘F also fires if your terminal forwards
    // Cmd+Option (iTerm2 / Ghostty / Kitty can be configured to).
    if (
      (key.name === "f" && !key.ctrl && !key.meta && !key.option) ||
      (key.name === "f" && key.meta === true && key.option === true)
    ) {
      deps.setFilter("");
      deps.setMode({ kind: "filter" });
      return;
    }
    if (key.name === "s") {
      deps.setSort(cycleSort);
      return;
    }
    if (key.name === "r") {
      deps.refresh();
      return;
    }
    // n / N (Shift+n): create note / folder. (Cmd+N in macOS terminals is
    // intercepted by the terminal itself, so we use the bare letters per
    // TUI convention.)
    if (key.name === "n") {
      if (key.shift) deps.enterNewFolder();
      else deps.newNote();
      return;
    }

    // Notes-pane-only bindings below this line
    if (deps.focused !== "notes") return;

    if (key.name === "space") {
      const note = deps.highlightedNote;
      if (!note) return;
      deps.setMarked((m) => {
        const next = new Set(m);
        if (next.has(note.id)) next.delete(note.id);
        else next.add(note.id);
        return next;
      });
      return;
    }

    if (key.name === "e") {
      deps.enterEdit();
      return;
    }

    if (key.name === "m") {
      deps.enterMoveMode();
    }
  });
};
