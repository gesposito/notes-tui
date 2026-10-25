//! notes-tui, Rust edition: a terminal UI and CLI for macOS Apple Notes.
//!
//! A port of the Bun + OpenTUI app in the repo root, kept side by side with
//! it. Both drive the same backends (osascript/JXA by default, the Swift
//! ScriptingBridge helper, or a read-only NoteStore.sqlite reader), share
//! the settings file, and expose the same `notes` CLI surface.

pub mod notes;
pub mod text;
