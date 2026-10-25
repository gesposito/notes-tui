//! The terminal UI: three panes (folders | notes | preview) over a
//! `NotesBackend`. See `app` for behavior and `ui` for rendering.

mod app;
mod ui;

use std::io::stdout;

use anyhow::Result;
use crossterm::event::{DisableMouseCapture, EnableMouseCapture, EventStream};
use crossterm::execute;
use futures::StreamExt;
use ratatui::DefaultTerminal;
use tokio::time::{Instant, sleep_until};

pub use app::{App, BackendSource, ChoiceCallback, FdaHelp, FdaHelper, Mode, Msg, Pane};

use crate::notes::BackendChoice;

pub struct Options {
    pub source: BackendSource,
    pub choice: BackendChoice,
    /// Called on every in-app backend switch (the binary persists it).
    pub on_choice_change: ChoiceCallback,
    /// Opens Settings + Finder when the sqlite backend lacks Full Disk Access
    /// (`grant_fda::open_fda_help`).
    pub fda_helper: FdaHelper,
}

/// Runs the TUI until the user quits, restoring the terminal on the way out
/// (and on panic).
pub async fn run(options: Options) -> Result<()> {
    let mut terminal = ratatui::try_init()?;
    if let Err(e) = execute!(stdout(), EnableMouseCapture) {
        ratatui::restore();
        return Err(e.into());
    }
    // ratatui's panic hook restores raw mode and the alternate screen; mouse
    // capture is ours to undo.
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = execute!(stdout(), DisableMouseCapture);
        previous(info);
    }));

    let result = event_loop(&mut terminal, options).await;
    let _ = execute!(stdout(), DisableMouseCapture);
    ratatui::restore();
    result
}

async fn sleep_until_deadline(deadline: Option<Instant>) {
    match deadline {
        Some(at) => sleep_until(at).await,
        None => std::future::pending().await,
    }
}

async fn event_loop(terminal: &mut DefaultTerminal, options: Options) -> Result<()> {
    let height = terminal.size()?.height;
    let (mut app, mut rx) = App::new(
        options.source,
        options.choice,
        options.on_choice_change,
        options.fda_helper,
        height,
    );
    let mut events = EventStream::new();
    let mut dirty = true;
    loop {
        if dirty {
            terminal.draw(|frame| ui::draw(frame, &mut app))?;
        }
        // Redraw only when something was handled (mouse motion isn't).
        dirty = tokio::select! {
            event = events.next() => match event {
                Some(Ok(event)) => app.handle_event(event),
                Some(Err(e)) => return Err(e.into()),
                None => return Ok(()),
            },
            Some(msg) = rx.recv() => {
                app.handle_msg(msg);
                true
            }
            () = sleep_until_deadline(app.next_deadline()) => {
                app.on_timer();
                true
            }
        };
        if app.should_quit {
            return Ok(());
        }
    }
}
