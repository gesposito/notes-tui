//! `notes` — Apple Notes from the shell. See `notes --help`.

use std::io::{self, Write};
use std::process::ExitCode;

use clap::Parser;
use notes_tui::cli::{Cli, execute};
use notes_tui::notes::{self, BackendChoice, logging};

#[tokio::main]
async fn main() -> ExitCode {
    let cli = Cli::parse();
    let debug = notes::debug_enabled();
    if debug {
        logging::print_debug_hint();
    }
    // Same selection as the Bun CLI: NOTES_BACKEND only, no settings file.
    let backend = notes::make_backend(BackendChoice::from_env(), debug);

    let mut stdout = io::stdout().lock();
    let result = execute(
        cli.command,
        backend.as_ref(),
        &mut stdout,
        &mut io::stdin().lock(),
    )
    .await;
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
