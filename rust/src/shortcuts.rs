//! Source of truth for the help dialog (port of `src/lib/shortcuts.ts`).
//! Adding a keybinding? List it here and wire it in `tui::app`.

pub struct ShortcutGroup {
    pub name: &'static str,
    pub bindings: &'static [(&'static str, &'static str)],
}

pub const SHORTCUTS: &[ShortcutGroup] = &[
    ShortcutGroup {
        name: "Navigation",
        bindings: &[
            ("↑ / ↓", "Move cursor up / down"),
            ("Shift + ↑ / ↓", "Page up / down"),
            ("Tab", "Switch between folder and notes pane"),
            ("Enter", "Open selected (or move into folder)"),
        ],
    },
    ShortcutGroup {
        name: "Notes",
        bindings: &[
            ("n", "New Note (in active folder)"),
            ("e", "Edit Note (plain text only — formatting lost on save)"),
            ("Space", "Select / deselect Note"),
            ("m", "Move To… (selected notes or current)"),
        ],
    },
    ShortcutGroup {
        name: "Folders",
        bindings: &[
            ("N (Shift+n)", "New Folder (in active account)"),
            ("→", "Expand folder"),
            ("←", "Collapse folder (or jump to parent)"),
        ],
    },
    ShortcutGroup {
        name: "View",
        bindings: &[
            (
                "f",
                "Search title + body in current folder (subfolders too if collapsed; ⌥⌘F also)",
            ),
            ("s", "Sort By… (Date Modified ↓ / ↑ / Title)"),
            ("r", "Refresh (pull external changes)"),
            (
                "B (Shift+b)",
                "Switch backend (osa / scripting-bridge / sqlite)",
            ),
        ],
    },
    ShortcutGroup {
        name: "Help / Quit",
        bindings: &[
            ("?", "Toggle this help dialog"),
            ("Esc", "Dismiss help / cancel filter or move"),
            ("q", "Quit"),
        ],
    },
];
