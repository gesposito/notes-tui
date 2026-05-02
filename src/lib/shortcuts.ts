export type ShortcutBinding = {
  key: string;
  description: string;
};

export type ShortcutGroup = {
  name: string;
  bindings: ShortcutBinding[];
};

/**
 * Source-of-truth for the help dialog. Adding a new keybinding? Add it here
 * and wire it in `use-app-keybindings.ts` — the dialog renders automatically.
 */
export const SHORTCUTS: ShortcutGroup[] = [
  {
    name: "Navigation",
    bindings: [
      { key: "↑ / ↓", description: "Move cursor up / down" },
      { key: "Shift + ↑ / ↓", description: "Page up / down" },
      { key: "Tab", description: "Switch between folder and notes pane" },
      { key: "Enter", description: "Open selected (or move into folder)" },
    ],
  },
  {
    name: "Notes",
    bindings: [
      { key: "n", description: "New note in active folder" },
      { key: "Space", description: "Mark / unmark current note" },
      { key: "m", description: "Move marked notes (or current) to a folder" },
    ],
  },
  {
    name: "Folders",
    bindings: [
      { key: "N (Shift+n)", description: "New folder in active account" },
    ],
  },
  {
    name: "View",
    bindings: [
      { key: "/", description: "Filter notes by title" },
      { key: "s", description: "Cycle sort: date ↓ → date ↑ → title" },
    ],
  },
  {
    name: "Help / Quit",
    bindings: [
      { key: "?", description: "Toggle this help dialog" },
      { key: "Esc", description: "Dismiss help / cancel filter or move" },
      { key: "q", description: "Quit" },
    ],
  },
];
