//! The real TUI over an in-memory backend: try the UI (or drive it from a
//! test harness) without touching Apple Notes.
//!
//!   cargo run --example mock_tui

use std::process::ExitCode;
use std::sync::Arc;

use notes_tui::grant_fda;
use notes_tui::notes::BackendChoice;
use notes_tui::notes::mock::{MockBackend, folder, note};
use notes_tui::tui::{self, BackendSource};

#[tokio::main]
async fn main() -> ExitCode {
    let backend = MockBackend::new(
        vec![
            folder("f1", "Personal", "iCloud / Personal", 0, 2),
            folder("f2", "Work", "iCloud / Work", 0, 1),
            folder("f3", "Projects", "iCloud / Work / Projects", 1, 1),
        ],
        vec![
            note("n1", "Shopping list", "f1", "2026-05-02T10:00:00.000Z"),
            note("n2", "Recipe ideas", "f1", "2026-05-01T10:00:00.000Z"),
            note("n3", "Quarterly report", "f2", "2026-04-30T10:00:00.000Z"),
            note("n4", "Rust port plan", "f3", "2026-04-29T10:00:00.000Z"),
        ],
    )
    .with_bodies([
        ("n1", "Shopping list\nMilk\nEggs\nCoffee"),
        ("n2", "Recipe ideas\nRisotto with peas\nShakshuka"),
        ("n3", "Quarterly report\nNumbers go here"),
        (
            "n4",
            "Rust port plan\nratatui + crossterm + tokio\nKeep both builds side by side",
        ),
    ]);

    let result = tui::run(tui::Options {
        source: BackendSource::Static(Arc::new(backend)),
        choice: BackendChoice::Osa,
        on_choice_change: Box::new(|_| Ok(())),
        fda_helper: Box::new(grant_fda::open_fda_help),
    })
    .await;
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e:#}");
            ExitCode::FAILURE
        }
    }
}
