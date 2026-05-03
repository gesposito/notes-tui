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
      { key: "n", description: "New Note (in active folder)" },
      { key: "e", description: "Edit Note (plain text only — formatting lost on save)" },
      { key: "Space", description: "Select / deselect Note" },
      { key: "m", description: "Move To… (selected notes or current)" },
    ],
  },
  {
    name: "Folders",
    bindings: [
      { key: "N (Shift+n)", description: "New Folder (in active account)" },
      { key: "→", description: "Expand folder" },
      { key: "←", description: "Collapse folder (or jump to parent)" },
    ],
  },
  {
    name: "View",
    bindings: [
      {
        key: "f",
        description:
          "Search title + body in current folder (subfolders too if collapsed; ⌥⌘F also)",
      },
      { key: "s", description: "Sort By… (Date Modified ↓ / ↑ / Title)" },
      { key: "r", description: "Refresh (pull external changes)" },
      {
        key: "B (Shift+b)",
        description: "Switch backend (osa / scripting-bridge / sqlite)",
      },
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
