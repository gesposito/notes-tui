//! `notes` — Apple Notes from the shell. See `notes --help`.

use std::io::{self, Write};
use std::process::ExitCode;

use clap::Parser;
use notes_tui::cli::{Cli, Command, execute};
use notes_tui::grant_fda;
use notes_tui::notes::{self, BackendChoice, logging};

fn main() -> ExitCode {
    let cli = Cli::parse();
    // Same selection as the Bun CLI: NOTES_BACKEND only, no settings file.
    let choice = BackendChoice::from_env();
    // Reading Notes' database needs Full Disk Access, and a grant on this
    // binary only counts if it answers for itself rather than for the
    // terminal that started it (see grant_fda). Done before the runtime
    // exists, since it may re-launch the process.
    if choice == BackendChoice::Sqlite || matches!(cli.command, Command::Inspect { .. }) {
        grant_fda::ensure_self_responsible();
    }
    let debug = notes::debug_enabled();
    if debug {
        logging::print_debug_hint();
    }
    let backend = notes::make_backend(choice, debug);

    let mut stdout = io::stdout().lock();
    let result = tokio::runtime::Runtime::new()
        .map_err(anyhow::Error::from)
        .and_then(|runtime| {
            runtime.block_on(execute(
                cli.command,
                backend.as_ref(),
                &mut stdout,
                &mut io::stdin().lock(),
            ))
        });
    let flushed = stdout.flush();
    if debug {
        logging::dump_stats();
    }

    let broken_pipe = |e: &io::Error| e.kind() == io::ErrorKind::BrokenPipe;
    match result {
        // `notes folders | head` closing the pipe early isn't an error.
        Err(e)
            if e.chain()
                .any(|c| c.downcast_ref::<io::Error>().is_some_and(broken_pipe)) =>
        {
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("error: {e:#}");
            ExitCode::FAILURE
        }
        Ok(()) if flushed.as_ref().is_err_and(|e| !broken_pipe(e)) => ExitCode::FAILURE,
        Ok(()) => ExitCode::SUCCESS,
    }
}
