//! `notes-tui` — interactive three-pane Apple Notes browser.

use std::process::ExitCode;

use notes_tui::grant_fda;
use notes_tui::notes::{self, BackendChoice, logging};
use notes_tui::settings::{
    default_settings_path, load_settings, resolve_initial_backend_choice, save_settings,
};
use notes_tui::tui::{self, BackendSource};

fn main() -> ExitCode {
    // Load settings before mounting so the first frame already uses the last
    // choice. NOTES_BACKEND still wins, for one-off A/B runs.
    let path = default_settings_path();
    let mut settings = load_settings(&path);
    let choice =
        resolve_initial_backend_choice(&settings, std::env::var("NOTES_BACKEND").ok().as_deref());
    // A Full Disk Access grant on this binary only counts if it answers for
    // itself rather than for the terminal that started it (see grant_fda).
    // Done before the runtime exists, since it may re-launch the process.
    if choice == BackendChoice::Sqlite {
        grant_fda::ensure_self_responsible();
    }
    let debug = notes::debug_enabled();
    if debug {
        logging::print_debug_hint();
    }

    let options = tui::Options {
        source: BackendSource::registry(debug),
        choice,
        on_choice_change: Box::new(move |next| {
            settings.backend_choice = Some(next);
            save_settings(&settings, &path).map_err(|e| e.to_string())
        }),
        fda_helper: Box::new(grant_fda::open_fda_help),
    };
    let result = tokio::runtime::Runtime::new()
        .map_err(anyhow::Error::from)
        .and_then(|runtime| runtime.block_on(tui::run(options)));

    if debug {
        logging::dump_stats();
    }
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e:#}");
            ExitCode::FAILURE
        }
    }
}
