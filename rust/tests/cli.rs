//! Smoke tests against the built `notes` binary: argument parsing, help,
//! and exit codes, without touching Apple Notes.

use std::process::Command;

fn notes(args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_notes"))
        .args(args)
        .env_remove("DEBUG")
        .output()
        .expect("failed to run the notes binary")
}

#[test]
fn help_lists_every_subcommand() {
    let out = notes(&["--help"]);
    assert!(out.status.success());
    let stdout = String::from_utf8(out.stdout).unwrap();
    assert!(stdout.contains("Usage: notes <COMMAND>"));
    for cmd in [
        "folders",
        "folder-notes",
        "folder-snippets",
        "folder-bodies",
        "body",
        "html",
        "new-note",
        "new-folder",
        "update",
        "move",
        "search",
        "inspect",
        "grant-fda",
    ] {
        assert!(stdout.contains(cmd), "help is missing {cmd}");
    }
}

#[test]
fn missing_required_arguments_exit_with_usage_error() {
    let out = notes(&["move", "n1"]);
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("--to <FOLDER_ID>"));
}

#[test]
fn inspect_reports_a_missing_store() {
    let out = notes(&["inspect", "--path", "/no/such/NoteStore.sqlite"]);
    assert_eq!(out.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&out.stderr).contains("/no/such/NoteStore.sqlite"));
}
