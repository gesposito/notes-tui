import type { Dispatch, SetStateAction } from "react";
import { useKeyboard } from "@opentui/react";
import { cycleSort, type SortMode } from "../lib/sort.ts";
import type { Note } from "../notes/types.ts";
import type { Mode, Pane } from "../types.ts";

type Deps = {
  mode: Mode;
  focused: Pane;
  highlightedNote: Note | undefined;
  setMode: (m: Mode) => void;
  setFocused: Dispatch<SetStateAction<Pane>>;
  setFilter: (f: string) => void;
  setSort: Dispatch<SetStateAction<SortMode>>;
  setMarked: Dispatch<SetStateAction<Set<string>>>;
  enterMoveMode: () => void;
  quit: () => void;
};

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

    // browse mode
    if (key.name === "q") {
      deps.quit();
      return;
    }
    if (key.name === "tab") {
      deps.setFocused((p) => (p === "folders" ? "notes" : "folders"));
      return;
    }
    if (key.name === "/") {
      deps.setFilter("");
      deps.setMode({ kind: "filter" });
      return;
    }
    if (key.name === "s") {
      deps.setSort(cycleSort);
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

    if (key.name === "m") {
      deps.enterMoveMode();
    }
  });
};
