//! TUI state and behavior — the port of `src/app.tsx` and its hooks.
//!
//! React's "derive on render + effects" becomes: input handlers and async
//! results mutate state, then `reconcile()` recomputes derived data and
//! starts or cancels fetches — the effects, run after every change. Fetches
//! run as tokio tasks that report back over a channel; each result carries
//! the cache generation it was started under, so anything that lands after
//! a refresh or backend switch is dropped.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use crossterm::event::{
    Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
};
use indexmap::{IndexMap, IndexSet};
use ratatui::layout::{Position, Rect};
use ratatui::style::Style;
use ratatui_textarea::{CursorMove, TextArea, WrapMode};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};
use tokio::task::AbortHandle;
use tokio::time::Instant;

use super::ui;
use crate::folder_tree::{descendant_ids, folders_equal, parent_path, recursive_folder_counts};
use crate::lru::Lru;
use crate::notes::{
    BackendChoice, Folder, FolderTexts, Move, MoveResult, Note, NotesBackend, make_backend,
};
use crate::sort::{SortMode, sort_notes};

/// Settle time before the folder cursor drives fetches, so fast scrolling
/// doesn't fan out an osascript spawn per row.
const FOLDER_DEBOUNCE: Duration = Duration::from_millis(150);
/// Preview fetch delay on a cache miss (hits are instant).
const PREVIEW_DEBOUNCE: Duration = Duration::from_millis(300);
const PREVIEW_CACHE_CAP: usize = 200;
/// Folders per search-index step: one plaintext bulk call is ~150–250 ms,
/// so chunks keep the "X / Y folders indexed" banner moving.
const INDEX_CHUNK_SIZE: usize = 8;
/// Rows handed to the notes list; after-sort top-N keeps the most relevant.
pub const NOTE_RENDER_CAP: usize = 500;
const WHEEL_STEP: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pane {
    Folders,
    Notes,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Mode {
    Browse,
    Filter,
    NewFolder,
    Edit {
        note_id: String,
    },
    MoveTarget {
        source_account: String,
        source_count: usize,
    },
    BackendPicker,
}

/// Where backends come from.
pub enum BackendSource {
    /// A fixed backend (tests, the mock example). Switching only re-labels,
    /// like the TS provider when it's given a `backend` prop.
    Static(Arc<dyn NotesBackend>),
    /// Real backends, created on first use and kept, so switching back to
    /// scripting-bridge reuses its running helper.
    Registry {
        debug: bool,
        cache: HashMap<BackendChoice, Arc<dyn NotesBackend>>,
    },
}

impl BackendSource {
    pub fn registry(debug: bool) -> Self {
        Self::Registry {
            debug,
            cache: HashMap::new(),
        }
    }

    fn get(&mut self, choice: BackendChoice) -> Arc<dyn NotesBackend> {
        match self {
            Self::Static(backend) => backend.clone(),
            Self::Registry { debug, cache } => cache
                .entry(choice)
                .or_insert_with(|| make_backend(choice, *debug))
                .clone(),
        }
    }
}

pub type ChoiceCallback = Box<dyn FnMut(BackendChoice) -> Result<(), String> + Send>;

#[derive(Debug)]
pub enum FolderLoad {
    Load,
    Refresh { silent: bool, before: Vec<Folder> },
}

/// Results from background tasks.
#[derive(Debug)]
pub enum Msg {
    Folders {
        seq: u64,
        purpose: FolderLoad,
        result: Result<Vec<Folder>, String>,
    },
    Notes {
        generation: u64,
        task: u64,
        folder_ids: Vec<String>,
        result: Result<Vec<Note>, String>,
    },
    Snippets {
        generation: u64,
        task: u64,
        folder_ids: Vec<String>,
        result: Result<FolderTexts, String>,
    },
    Preview {
        generation: u64,
        seq: u64,
        note_id: String,
        result: Result<String, String>,
    },
    IndexChunk {
        generation: u64,
        run: u64,
        folder_ids: Vec<String>,
        result: Result<(Vec<Note>, FolderTexts), String>,
    },
    IndexDone {
        generation: u64,
        run: u64,
    },
    EditBody {
        note_id: String,
        result: Result<String, String>,
    },
    Moved {
        target: Folder,
        source_folder_ids: Vec<String>,
        result: Result<Vec<MoveResult>, String>,
    },
    NoteCreated {
        folder: Folder,
        result: Result<(), String>,
    },
    FolderCreated {
        account: String,
        name: String,
        result: Result<(), String>,
    },
    Saved {
        folder_id: Option<String>,
        result: Result<(), String>,
    },
}

fn err(e: anyhow::Error) -> String {
    format!("{e:#}")
}

fn plural(n: usize, suffix: &'static str) -> &'static str {
    if n == 1 { "" } else { suffix }
}

/// Derived folder data, rebuilt when the folder list or expansion changes.
#[derive(Default)]
pub(super) struct Tree {
    by_id: HashMap<String, usize>,
    by_path: HashMap<String, usize>,
    pub(super) counts: HashMap<String, u32>,
    /// Folders with at least one child (drives the ▸/▾ markers).
    pub(super) with_children: HashSet<String>,
    /// Indices into `folders` whose every ancestor is expanded.
    pub(super) visible: Vec<usize>,
}

impl Tree {
    fn build(folders: &[Folder], expanded: &HashSet<String>) -> Self {
        let by_id = folders
            .iter()
            .enumerate()
            .map(|(i, f)| (f.id.clone(), i))
            .collect();
        let by_path: HashMap<String, usize> = folders
            .iter()
            .enumerate()
            .map(|(i, f)| (f.path.clone(), i))
            .collect();
        let parent = |f: &Folder| -> Option<usize> {
            if f.depth == 0 {
                return None;
            }
            parent_path(&f.path).and_then(|p| by_path.get(p).copied())
        };
        let with_children = folders
            .iter()
            .filter_map(|f| parent(f).map(|p| folders[p].id.clone()))
            .collect();
        let visible = (0..folders.len())
            .filter(|&i| {
                let mut current = &folders[i];
                while current.depth > 0 {
                    match parent(current) {
                        Some(p) if expanded.contains(&folders[p].id) => current = &folders[p],
                        _ => return false,
                    }
                }
                true
            })
            .collect();
        Self {
            by_id,
            counts: recursive_folder_counts(folders),
            by_path,
            with_children,
            visible,
        }
    }
}

struct IndexedNote {
    note: Note,
    title_lower: String,
    body_lower: String,
}

/// Click targets and scroll offsets from the last draw.
#[derive(Debug, Default, Clone, Copy)]
pub(super) struct Hitboxes {
    pub(super) folder_pane: Rect,
    pub(super) folder_list: Rect,
    pub(super) folder_offset: usize,
    pub(super) notes_pane: Rect,
    pub(super) notes_list: Rect,
    pub(super) notes_offset: usize,
    pub(super) preview: Rect,
    pub(super) preview_max_scroll: u16,
}

pub struct App {
    source: BackendSource,
    backend: Arc<dyn NotesBackend>,
    pub(super) backend_choice: BackendChoice,
    on_choice_change: ChoiceCallback,
    tx: UnboundedSender<Msg>,
    /// Cache generation, bumped by refresh/save/backend switch.
    generation: u64,
    folder_seq: u64,
    next_task: u64,

    // Folders
    pub(super) folders: Vec<Folder>,
    pub(super) folders_loading: bool,
    pub(super) folders_error: Option<String>,
    pub(super) tree: Tree,
    tree_dirty: bool,
    pub(super) expanded: HashSet<String>,
    expanded_seeded: bool,
    /// Tracked by id so expand/collapse doesn't shift the selection.
    active_folder_id: Option<String>,
    /// `active_folder_id`'s folder, 150 ms later: what fetches follow.
    debounced_folder_id: Option<String>,
    folder_debounce: Option<(Instant, Option<String>)>,
    /// The move-target picker has its own cursor over the *full* list.
    pub(super) move_cursor: usize,

    // Notes + snippets, cached per folder.
    notes_by_folder: HashMap<String, Vec<Note>>,
    notes_in_flight: HashSet<String>,
    notes_failed: HashSet<String>,
    notes_tasks: Vec<(u64, AbortHandle)>,
    snippets: HashMap<String, IndexMap<String, String>>,
    snippets_in_flight: HashSet<String>,
    snippets_tasks: Vec<(u64, AbortHandle)>,
    /// What the notes pane shows: the active folder, plus its subtree when
    /// it's a collapsed parent (otherwise those notes would be unreachable).
    pub(super) active_ids: Vec<String>,
    data_version: u64,

    // Notes list
    pub(super) note_cursor: usize,
    pub(super) marked: IndexSet<String>,
    pub(super) filter: String,
    pub(super) sort: SortMode,
    pub(super) visible_notes: Vec<Note>,
    visible_key: Option<(u64, Vec<String>, String, SortMode)>,
    cursor_reset_key: (Option<String>, String, SortMode),

    // UI
    pub(super) focused: Pane,
    pub(super) mode: Mode,
    pub(super) toast: String,
    pub(super) help_open: bool,
    pub(super) help_scroll: u16,
    pub(super) filter_input: TextArea<'static>,
    pub(super) new_folder_input: TextArea<'static>,
    pub(super) picker_cursor: usize,
    pub(super) editor: Option<TextArea<'static>>,
    /// Set when a refresh is requested mid-edit; banner until edit closes.
    pub(super) external_change_during_edit: bool,
    write_in_flight: bool,

    // Search index (title + body), scoped to `active_ids`.
    index: IndexMap<String, IndexedNote>,
    indexed_folders: HashSet<String>,
    index_task: Option<AbortHandle>,
    index_run: u64,
    index_scope: Option<Vec<String>>,
    index_failed: bool,

    // Preview
    pub(super) preview: String,
    pub(super) preview_loading: bool,
    preview_cache: Lru<String, String>,
    preview_note: Option<String>,
    preview_debounce: Option<(Instant, String)>,
    preview_task: Option<AbortHandle>,
    preview_seq: u64,
    pub(super) preview_scroll: u16,

    pub(super) hit: Hitboxes,
    pub(super) term_height: u16,
    pub should_quit: bool,
}

pub(super) fn single_line_input(placeholder: &str, value: &str) -> TextArea<'static> {
    let mut input = TextArea::new(vec![value.to_owned()]);
    input.set_cursor_line_style(Style::default());
    input.set_placeholder_text(placeholder);
    input.set_placeholder_style(Style::new().fg(ui::GRAY_66));
    input.set_style(Style::new().fg(ui::WHITE).bg(ui::FOCUSED_BG));
    input.move_cursor(CursorMove::End);
    input
}

fn editor_for(body: &str) -> TextArea<'static> {
    let lines = body
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l).to_owned())
        .collect();
    let mut editor = TextArea::new(lines);
    editor.set_cursor_line_style(Style::default());
    editor.set_wrap_mode(WrapMode::WordOrGlyph);
    editor
}

/// Keys that would put a newline into a single-line input.
fn inserts_newline(key: &KeyEvent) -> bool {
    matches!(key.code, KeyCode::Enter | KeyCode::Char('\n' | '\r'))
        || (key.code == KeyCode::Char('m') && key.modifiers.contains(KeyModifiers::CONTROL))
}

/// Some terminals report `?` directly; others report `/` with shift.
fn is_help_key(key: &KeyEvent) -> bool {
    key.code == KeyCode::Char('?')
        || (key.code == KeyCode::Char('/') && key.modifiers.contains(KeyModifiers::SHIFT))
}

/// Lowercased letter + whether shift was held (uppercase counts as shift).
fn letter(key: &KeyEvent) -> Option<(char, bool)> {
    match key.code {
        KeyCode::Char(c) if c.is_ascii_alphabetic() => Some((
            c.to_ascii_lowercase(),
            c.is_ascii_uppercase() || key.modifiers.contains(KeyModifiers::SHIFT),
        )),
        _ => None,
    }
}

enum Nav {
    Up(usize),
    Down(usize),
    Select,
}

/// OpenTUI Select semantics with `wrapSelection`: stepping past either end
/// jumps to the other end (not modulo), even for a page step.
fn step(cursor: usize, len: usize, nav: &Nav) -> usize {
    if len == 0 {
        return 0;
    }
    match *nav {
        Nav::Up(n) => cursor.checked_sub(n).unwrap_or(len - 1),
        Nav::Down(n) if cursor + n < len => cursor + n,
        Nav::Down(_) => 0,
        Nav::Select => cursor,
    }
}

fn clamp_add(cursor: usize, delta: isize, len: usize) -> usize {
    if len == 0 {
        return 0;
    }
    cursor.saturating_add_signed(delta).min(len - 1)
}

impl App {
    pub fn new(
        mut source: BackendSource,
        choice: BackendChoice,
        on_choice_change: ChoiceCallback,
        term_height: u16,
    ) -> (Self, UnboundedReceiver<Msg>) {
        let (tx, rx) = unbounded_channel();
        let backend = source.get(choice);
        let mut app = Self {
            source,
            backend,
            backend_choice: choice,
            on_choice_change,
            tx,
            generation: 0,
            folder_seq: 0,
            next_task: 0,
            folders: Vec::new(),
            folders_loading: true,
            folders_error: None,
            tree: Tree::default(),
            tree_dirty: false,
            expanded: HashSet::new(),
            expanded_seeded: false,
            active_folder_id: None,
            debounced_folder_id: None,
            folder_debounce: None,
            move_cursor: 0,
            notes_by_folder: HashMap::new(),
            notes_in_flight: HashSet::new(),
            notes_failed: HashSet::new(),
            notes_tasks: Vec::new(),
            snippets: HashMap::new(),
            snippets_in_flight: HashSet::new(),
            snippets_tasks: Vec::new(),
            active_ids: Vec::new(),
            data_version: 0,
            note_cursor: 0,
            marked: IndexSet::new(),
            filter: String::new(),
            sort: SortMode::default(),
            visible_notes: Vec::new(),
            visible_key: None,
            cursor_reset_key: (None, String::new(), SortMode::default()),
            focused: Pane::Folders,
            mode: Mode::Browse,
            toast: String::new(),
            help_open: false,
            help_scroll: 0,
            filter_input: single_line_input("Search…", ""),
            new_folder_input: single_line_input("", ""),
            picker_cursor: 0,
            editor: None,
            external_change_during_edit: false,
            write_in_flight: false,
            index: IndexMap::new(),
            indexed_folders: HashSet::new(),
            index_task: None,
            index_run: 0,
            index_scope: None,
            index_failed: false,
            preview: String::new(),
            preview_loading: false,
            preview_cache: Lru::new(PREVIEW_CACHE_CAP),
            preview_note: None,
            preview_debounce: None,
            preview_task: None,
            preview_seq: 0,
            preview_scroll: 0,
            hit: Hitboxes::default(),
            term_height,
            should_quit: false,
        };
        app.load_folders(FolderLoad::Load);
        app.reconcile();
        (app, rx)
    }

    fn spawn(&self, fut: impl Future<Output = Msg> + Send + 'static) -> AbortHandle {
        let tx = self.tx.clone();
        tokio::spawn(async move {
            let _ = tx.send(fut.await);
        })
        .abort_handle()
    }

    // ── Derived views (also read by `ui`) ──────────────────────────────────

    /// Loading or error screen instead of the panes.
    pub(super) fn main_hidden(&self) -> bool {
        (self.folders_loading && self.folders.is_empty()) || self.folders_error.is_some()
    }

    pub(super) fn move_mode(&self) -> bool {
        matches!(self.mode, Mode::MoveTarget { .. })
    }

    /// Rows of the folder pane: every folder in move mode (so a target deep
    /// in a collapsed subtree is still pickable), the expanded tree
    /// otherwise. Index-based handlers all go through this, so an index and
    /// the folder on screen always agree.
    pub(super) fn pane_folders(&self) -> Vec<usize> {
        if self.move_mode() {
            (0..self.folders.len()).collect()
        } else {
            self.tree.visible.clone()
        }
    }

    pub(super) fn folder_cursor(&self) -> usize {
        self.active_folder_id
            .as_ref()
            .and_then(|id| {
                self.tree
                    .visible
                    .iter()
                    .position(|&i| &self.folders[i].id == id)
            })
            .unwrap_or(0)
    }

    pub(super) fn pane_cursor(&self) -> usize {
        if self.move_mode() {
            self.move_cursor
        } else {
            self.folder_cursor()
        }
    }

    /// Folder under the immediate cursor. Expand/collapse use this, not the
    /// debounced active folder, so ↓ then ← acts on the row just landed on.
    fn cursor_folder(&self) -> Option<&Folder> {
        self.tree
            .visible
            .get(self.folder_cursor())
            .map(|&i| &self.folders[i])
    }

    /// The folder fetches follow (debounced).
    pub(super) fn active_folder(&self) -> Option<&Folder> {
        let id = self.debounced_folder_id.as_ref()?;
        self.tree
            .visible
            .iter()
            .map(|&i| &self.folders[i])
            .find(|f| &f.id == id)
    }

    pub(super) fn rendered_notes(&self) -> &[Note] {
        &self.visible_notes[..self.visible_notes.len().min(NOTE_RENDER_CAP)]
    }

    pub(super) fn highlighted(&self) -> Option<&Note> {
        self.rendered_notes().get(self.note_cursor)
    }

    pub(super) fn snippet(&self, note: &Note) -> &str {
        self.snippets
            .get(&note.folder_id)
            .and_then(|m| m.get(&note.id))
            .map_or("", String::as_str)
    }

    pub(super) fn index_enabled(&self) -> bool {
        self.mode == Mode::Filter || !self.filter.is_empty()
    }

    /// (folders in scope already indexed, folders in scope).
    pub(super) fn index_progress(&self) -> (usize, usize) {
        let loaded = self
            .active_ids
            .iter()
            .filter(|id| self.indexed_folders.contains(*id))
            .count();
        (loaded, self.active_ids.len())
    }

    pub(super) fn indexing(&self) -> bool {
        let (loaded, total) = self.index_progress();
        self.index_enabled() && total > 0 && loaded < total
    }

    fn page_step(&self) -> usize {
        usize::from(self.term_height).saturating_sub(6).max(5)
    }

    pub fn next_deadline(&self) -> Option<Instant> {
        [
            self.folder_debounce.as_ref().map(|(at, _)| *at),
            self.preview_debounce.as_ref().map(|(at, _)| *at),
        ]
        .into_iter()
        .flatten()
        .min()
    }

    // ── Event entry points ─────────────────────────────────────────────────

    /// Returns whether the event was handled (and a redraw is due).
    pub fn handle_event(&mut self, event: Event) -> bool {
        match event {
            Event::Key(key) if key.kind != KeyEventKind::Release => self.handle_key(key),
            Event::Mouse(mouse) => {
                if !self.handle_mouse(mouse) {
                    return false;
                }
            }
            Event::Resize(_, height) => self.term_height = height,
            _ => return false,
        }
        self.reconcile();
        true
    }

    pub fn handle_msg(&mut self, msg: Msg) {
        self.apply_msg(msg);
        self.reconcile();
    }

    pub fn on_timer(&mut self) {
        let now = Instant::now();
        if self
            .folder_debounce
            .as_ref()
            .is_some_and(|(at, _)| *at <= now)
            && let Some((_, target)) = self.folder_debounce.take()
        {
            self.debounced_folder_id = target;
        }
        if self
            .preview_debounce
            .as_ref()
            .is_some_and(|(at, _)| *at <= now)
            && let Some((_, note_id)) = self.preview_debounce.take()
        {
            self.fetch_preview(note_id);
        }
        self.reconcile();
    }

    // ── Reconcile: the effects ─────────────────────────────────────────────

    pub fn reconcile(&mut self) {
        if self.tree_dirty {
            self.tree = Tree::build(&self.folders, &self.expanded);
            self.tree_dirty = false;
            // Default to fully expanded once folders load: it matches the
            // Notes sidebar and avoids a perf trap — landing on a collapsed
            // parent fans a fetch out across every descendant.
            if !self.expanded_seeded && !self.tree.with_children.is_empty() {
                self.expanded = self.tree.with_children.clone();
                self.expanded_seeded = true;
                self.tree = Tree::build(&self.folders, &self.expanded);
            }
        }

        // Debounce the cursor folder into the folder fetches follow. The
        // first value (and "no folder") apply at once.
        let target = self.cursor_folder().map(|f| f.id.clone());
        if self.debounced_folder_id.is_none() || target.is_none() {
            self.debounced_folder_id = target;
            self.folder_debounce = None;
        } else if self.debounced_folder_id == target {
            self.folder_debounce = None;
        } else if self.folder_debounce.as_ref().map(|(_, t)| t) != Some(&target) {
            self.folder_debounce = Some((Instant::now() + FOLDER_DEBOUNCE, target));
        }

        let active_ids = match self.active_folder() {
            None => Vec::new(),
            Some(f)
                if !self.tree.with_children.contains(&f.id) || self.expanded.contains(&f.id) =>
            {
                vec![f.id.clone()]
            }
            Some(f) => descendant_ids(Some(f), &self.folders),
        };
        if active_ids != self.active_ids {
            self.active_ids = active_ids;
            // A new selection supersedes in-flight fetches for the old one.
            for (_, task) in self
                .notes_tasks
                .drain(..)
                .chain(self.snippets_tasks.drain(..))
            {
                task.abort();
            }
            self.notes_in_flight.clear();
            self.snippets_in_flight.clear();
            self.notes_failed.clear();
        }

        // The cursor resets when the active folder, filter, or sort changes.
        let reset_key = (
            self.debounced_folder_id.clone(),
            self.filter.clone(),
            self.sort,
        );
        if reset_key != self.cursor_reset_key {
            self.cursor_reset_key = reset_key;
            self.note_cursor = 0;
        }

        let visible_key = (
            self.data_version,
            self.active_ids.clone(),
            self.filter.clone(),
            self.sort,
        );
        if self.visible_key.as_ref() != Some(&visible_key) {
            self.visible_notes = self.compute_visible_notes();
            self.visible_key = Some(visible_key);
        }
        self.note_cursor = self
            .note_cursor
            .min(self.rendered_notes().len().saturating_sub(1));
        self.move_cursor = self.move_cursor.min(self.folders.len().saturating_sub(1));

        self.fetch_missing_notes();
        self.fetch_missing_snippets();
        self.sync_index();
        self.sync_preview();
    }

    fn compute_visible_notes(&self) -> Vec<Note> {
        if self.filter.is_empty() {
            let all: Vec<Note> = self
                .active_ids
                .iter()
                .filter_map(|fid| self.notes_by_folder.get(fid))
                .flatten()
                .cloned()
                .collect();
            return sort_notes(&all, self.sort);
        }
        // Same scope, matching title + body through the index. The index can
        // hold folders from earlier scopes (cheaper to keep), so filter to
        // the active scope explicitly.
        let q = self.filter.to_lowercase();
        let scope: HashSet<&str> = self.active_ids.iter().map(String::as_str).collect();
        let mut seen = HashSet::new();
        let mut matches = Vec::new();
        for entry in self.index.values() {
            if scope.contains(entry.note.folder_id.as_str())
                && (entry.title_lower.contains(&q) || entry.body_lower.contains(&q))
            {
                seen.insert(entry.note.id.as_str());
                matches.push(entry.note.clone());
            }
        }
        // Folders not indexed yet: title-only matches so something shows now.
        for fid in &self.active_ids {
            for n in self.notes_by_folder.get(fid).into_iter().flatten() {
                if !seen.contains(n.id.as_str()) && n.title.to_lowercase().contains(&q) {
                    seen.insert(&n.id);
                    matches.push(n.clone());
                }
            }
        }
        sort_notes(&matches, self.sort)
    }

    fn fetch_missing_notes(&mut self) {
        let to_fetch: Vec<String> = self
            .active_ids
            .iter()
            .filter(|id| {
                !self.notes_by_folder.contains_key(*id)
                    && !self.notes_in_flight.contains(*id)
                    && !self.notes_failed.contains(*id)
            })
            .cloned()
            .collect();
        if to_fetch.is_empty() {
            return;
        }
        self.notes_in_flight.extend(to_fetch.iter().cloned());
        self.next_task += 1;
        let (generation, task, backend) = (self.generation, self.next_task, self.backend.clone());
        let handle = self.spawn(async move {
            let result = backend.get_folder_notes(&to_fetch).await.map_err(err);
            Msg::Notes {
                generation,
                task,
                folder_ids: to_fetch,
                result,
            }
        });
        self.notes_tasks.push((task, handle));
    }

    fn fetch_missing_snippets(&mut self) {
        let to_fetch: Vec<String> = self
            .active_ids
            .iter()
            .filter(|id| !self.snippets.contains_key(*id) && !self.snippets_in_flight.contains(*id))
            .cloned()
            .collect();
        if to_fetch.is_empty() {
            return;
        }
        self.snippets_in_flight.extend(to_fetch.iter().cloned());
        self.next_task += 1;
        let (generation, task, backend) = (self.generation, self.next_task, self.backend.clone());
        let handle = self.spawn(async move {
            let result = backend.get_folder_snippets(&to_fetch).await.map_err(err);
            Msg::Snippets {
                generation,
                task,
                folder_ids: to_fetch,
                result,
            }
        });
        self.snippets_tasks.push((task, handle));
    }

    /// Progressive full-text index of the folders in scope, while search is
    /// on. Notes and bodies are fetched together per chunk; the bodies'
    /// `plaintext()` Apple Event dominates.
    fn sync_index(&mut self) {
        if !self.index_enabled() {
            if let Some(task) = self.index_task.take() {
                task.abort();
            }
            self.index_scope = None;
            self.index_failed = false;
            return;
        }
        if self.index_scope.as_ref() != Some(&self.active_ids) {
            if let Some(task) = self.index_task.take() {
                task.abort();
            }
            self.index_scope = Some(self.active_ids.clone());
            self.index_failed = false;
        }
        if self.index_task.is_some() || self.index_failed {
            return;
        }
        let pending: Vec<String> = self
            .active_ids
            .iter()
            .filter(|id| !self.indexed_folders.contains(*id))
            .cloned()
            .collect();
        if pending.is_empty() {
            return;
        }
        self.index_run += 1;
        let (generation, run, backend, tx) = (
            self.generation,
            self.index_run,
            self.backend.clone(),
            self.tx.clone(),
        );
        let task = tokio::spawn(async move {
            for chunk in pending.chunks(INDEX_CHUNK_SIZE) {
                let chunk = chunk.to_vec();
                let result = tokio::try_join!(
                    backend.get_folder_notes(&chunk),
                    backend.get_folder_bodies(&chunk)
                )
                .map_err(err);
                let failed = result.is_err();
                if tx
                    .send(Msg::IndexChunk {
                        generation,
                        run,
                        folder_ids: chunk,
                        result,
                    })
                    .is_err()
                    || failed
                {
                    return;
                }
            }
            let _ = tx.send(Msg::IndexDone { generation, run });
        });
        self.index_task = Some(task.abort_handle());
    }

    fn sync_preview(&mut self) {
        let highlighted = self.highlighted().map(|n| n.id.clone());
        if highlighted == self.preview_note {
            return;
        }
        self.preview_note = highlighted.clone();
        self.preview_debounce = None;
        if let Some(task) = self.preview_task.take() {
            task.abort();
        }
        self.preview_scroll = 0;
        match highlighted {
            None => {
                self.preview.clear();
                self.preview_loading = false;
            }
            Some(id) => {
                if let Some(text) = self.preview_cache.get(&id) {
                    self.preview = text.clone();
                    self.preview_loading = false;
                } else {
                    // The previous body stays up until the new one lands,
                    // like the TS build (no flash to "Loading…").
                    self.preview_loading = true;
                    self.preview_debounce = Some((Instant::now() + PREVIEW_DEBOUNCE, id));
                }
            }
        }
    }

    fn fetch_preview(&mut self, note_id: String) {
        self.preview_seq += 1;
        let (generation, seq, backend) = (self.generation, self.preview_seq, self.backend.clone());
        self.preview_task = Some(self.spawn(async move {
            let result = backend.get_note_body(&note_id).await.map_err(err);
            Msg::Preview {
                generation,
                seq,
                note_id,
                result,
            }
        }));
    }

    // ── Async results ──────────────────────────────────────────────────────

    fn apply_msg(&mut self, msg: Msg) {
        match msg {
            Msg::Folders {
                seq,
                purpose,
                result,
            } => {
                if seq != self.folder_seq {
                    return; // superseded by a newer load
                }
                self.folders_loading = false;
                match result {
                    Err(e) => self.folders_error = Some(e),
                    Ok(fresh) => {
                        let refresh = match purpose {
                            FolderLoad::Load => None,
                            FolderLoad::Refresh { silent, before } => {
                                Some((silent, folders_equal(&fresh, &before)))
                            }
                        };
                        self.set_folders(fresh);
                        match refresh {
                            Some((silent, true)) => {
                                if !silent {
                                    self.toast = "Up to date".into();
                                }
                            }
                            Some((silent, false)) => {
                                let ids = self.active_ids.clone();
                                self.invalidate(&ids);
                                self.bust();
                                if !silent {
                                    self.toast = "Refreshed".into();
                                }
                            }
                            None => {}
                        }
                    }
                }
            }
            Msg::Notes {
                generation,
                task,
                folder_ids,
                result,
            } => {
                if generation != self.generation {
                    return;
                }
                self.notes_tasks.retain(|(id, _)| *id != task);
                for fid in &folder_ids {
                    self.notes_in_flight.remove(fid);
                }
                match result {
                    Ok(notes) => {
                        let mut grouped: HashMap<String, Vec<Note>> = HashMap::new();
                        for n in notes {
                            grouped.entry(n.folder_id.clone()).or_default().push(n);
                        }
                        for fid in folder_ids {
                            let notes = grouped.remove(&fid).unwrap_or_default();
                            self.notes_by_folder.insert(fid, notes);
                        }
                        self.data_version += 1;
                    }
                    Err(e) => {
                        // Not retried until the selection changes or a
                        // refresh, so an error can't spin a fetch loop.
                        self.notes_failed.extend(folder_ids);
                        self.toast = format!("Failed to load notes: {e}");
                    }
                }
            }
            Msg::Snippets {
                generation,
                task,
                folder_ids,
                result,
            } => {
                if generation != self.generation {
                    return;
                }
                self.snippets_tasks.retain(|(id, _)| *id != task);
                for fid in &folder_ids {
                    self.snippets_in_flight.remove(fid);
                }
                // Snippets are non-critical: a failure just caches them empty.
                let mut by_folder = result.unwrap_or_default();
                for fid in folder_ids {
                    let snippets = by_folder.shift_remove(&fid).unwrap_or_default();
                    self.snippets.insert(fid, snippets);
                }
            }
            Msg::Preview {
                generation,
                seq,
                note_id,
                result,
            } => {
                if generation != self.generation {
                    return;
                }
                let current = seq == self.preview_seq;
                match result {
                    Ok(text) => {
                        if current {
                            self.preview.clone_from(&text);
                            self.preview_loading = false;
                        }
                        self.preview_cache.set(note_id, text);
                    }
                    Err(e) if current => {
                        self.preview = format!("(error: {e})");
                        self.preview_loading = false;
                    }
                    Err(_) => {}
                }
            }
            Msg::IndexChunk {
                generation,
                run,
                folder_ids,
                result,
            } => {
                if generation != self.generation || run != self.index_run {
                    return;
                }
                match result {
                    Ok((notes, bodies)) => {
                        for n in notes {
                            let body = bodies
                                .get(&n.folder_id)
                                .and_then(|m| m.get(&n.id))
                                .cloned()
                                .unwrap_or_default();
                            let entry = IndexedNote {
                                title_lower: n.title.to_lowercase(),
                                body_lower: body.to_lowercase(),
                                note: n,
                            };
                            self.index.insert(entry.note.id.clone(), entry);
                        }
                        self.indexed_folders.extend(folder_ids);
                        self.data_version += 1;
                    }
                    Err(e) => {
                        self.index_task = None;
                        self.index_failed = true;
                        self.toast = format!("Search indexing failed: {e}");
                    }
                }
            }
            Msg::IndexDone { generation, run } => {
                if generation == self.generation && run == self.index_run {
                    self.index_task = None;
                }
            }
            Msg::EditBody { note_id, result } => match result {
                // Only if the user hasn't moved on to another mode meanwhile.
                Ok(body) if self.mode == Mode::Browse => {
                    self.editor = Some(editor_for(&body));
                    self.external_change_during_edit = false;
                    self.mode = Mode::Edit { note_id };
                }
                Ok(_) => {}
                Err(e) => self.toast = format!("Failed to open editor: {e}"),
            },
            Msg::Moved {
                target,
                source_folder_ids,
                result,
            } => {
                self.write_in_flight = false;
                match result {
                    Ok(results) => {
                        let ok = results.iter().filter(|r| r.ok).count();
                        let failed = results.len() - ok;
                        self.toast =
                            format!("Moved {ok} Note{} to {}", plural(ok, "s"), target.path);
                        if failed > 0 {
                            self.toast.push_str(&format!(" ({failed} failed)"));
                        }
                        self.marked.clear();
                        self.mode = Mode::Browse;
                        self.focused = Pane::Notes;
                        self.invalidate(&source_folder_ids);
                        self.load_folders(FolderLoad::Load);
                    }
                    Err(e) => self.toast = format!("Move failed: {e}"),
                }
            }
            Msg::NoteCreated { folder, result } => match result {
                Ok(()) => {
                    self.toast = format!("New Note in {}", folder.path);
                    self.invalidate(std::slice::from_ref(&folder.id));
                    self.load_folders(FolderLoad::Load);
                }
                Err(e) => self.toast = format!("Create failed: {e}"),
            },
            Msg::FolderCreated {
                account,
                name,
                result,
            } => match result {
                Ok(()) => {
                    self.toast = format!("Created Folder \"{name}\" in {account}");
                    self.load_folders(FolderLoad::Load);
                }
                Err(e) => self.toast = format!("Create folder failed: {e}"),
            },
            Msg::Saved { folder_id, result } => {
                self.write_in_flight = false;
                match result {
                    Ok(()) => {
                        self.toast = "Saved".into();
                        self.editor = None;
                        self.external_change_during_edit = false;
                        self.mode = Mode::Browse;
                        // The title may have changed (first line of body).
                        if let Some(fid) = folder_id {
                            self.invalidate(&[fid]);
                        }
                        self.bust();
                        self.load_folders(FolderLoad::Load);
                    }
                    Err(e) => self.toast = format!("Save failed: {e}"),
                }
            }
        }
    }

    // ── State helpers ──────────────────────────────────────────────────────

    fn load_folders(&mut self, purpose: FolderLoad) {
        self.folder_seq += 1;
        self.folders_loading = true;
        self.folders_error = None;
        let (seq, backend) = (self.folder_seq, self.backend.clone());
        self.spawn(async move {
            let result = backend.list_folders().await.map_err(err);
            Msg::Folders {
                seq,
                purpose,
                result,
            }
        });
    }

    fn set_folders(&mut self, folders: Vec<Folder>) {
        self.folders = folders;
        self.tree_dirty = true;
        self.move_cursor = self.move_cursor.min(self.folders.len().saturating_sub(1));
    }

    /// Drops cached data for folders a write touched, so they refetch.
    fn invalidate(&mut self, folder_ids: &[String]) {
        for fid in folder_ids {
            self.notes_by_folder.remove(fid);
            self.notes_failed.remove(fid);
            self.snippets.remove(fid);
            self.indexed_folders.remove(fid);
        }
        self.index
            .retain(|_, e| !folder_ids.contains(&e.note.folder_id));
        self.data_version += 1;
    }

    /// Wipes every data cache (notes, snippets, index, preview) and orphans
    /// in-flight fetches, after a refresh or backend switch, so nothing stale
    /// or from another backend is served.
    fn bust(&mut self) {
        self.generation += 1;
        let tasks = self
            .notes_tasks
            .drain(..)
            .chain(self.snippets_tasks.drain(..));
        for (_, task) in tasks {
            task.abort();
        }
        for task in [self.index_task.take(), self.preview_task.take()]
            .into_iter()
            .flatten()
        {
            task.abort();
        }
        self.notes_by_folder.clear();
        self.notes_in_flight.clear();
        self.notes_failed.clear();
        self.snippets.clear();
        self.snippets_in_flight.clear();
        self.index.clear();
        self.indexed_folders.clear();
        self.index_scope = None;
        self.index_failed = false;
        self.preview_cache.clear();
        self.preview_note = None; // re-evaluated (and refetched) by reconcile
        self.preview_debounce = None;
        self.data_version += 1;
    }

    fn set_filter(&mut self, filter: String) {
        self.filter = filter;
    }

    fn folder_of_note(&self, note_id: &str) -> Option<&str> {
        self.notes_by_folder
            .values()
            .flatten()
            .find(|n| n.id == note_id)
            .map(|n| n.folder_id.as_str())
    }

    fn ids_to_move(&self) -> Vec<String> {
        if self.marked.is_empty() {
            self.highlighted()
                .map(|n| vec![n.id.clone()])
                .unwrap_or_default()
        } else {
            self.marked.iter().cloned().collect()
        }
    }

    // ── Keyboard ───────────────────────────────────────────────────────────

    fn handle_key(&mut self, key: KeyEvent) {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        // Ctrl+C always quits (OpenTUI's exitOnCtrlC).
        if ctrl && key.code == KeyCode::Char('c') {
            self.should_quit = true;
            return;
        }
        if self.main_hidden() {
            if letter(&key) == Some(('q', false)) {
                self.should_quit = true;
            }
            return;
        }
        if self.help_open {
            self.help_key(key);
            return;
        }
        // Help opens from anywhere text isn't being typed.
        if !matches!(
            self.mode,
            Mode::Filter | Mode::NewFolder | Mode::Edit { .. }
        ) && is_help_key(&key)
        {
            self.help_open = true;
            self.help_scroll = 0;
            return;
        }
        match self.mode.clone() {
            Mode::Browse => self.browse_key(key),
            Mode::Filter => self.filter_key(key),
            Mode::MoveTarget { source_account, .. } => self.move_key(key, &source_account),
            Mode::NewFolder => self.new_folder_key(key),
            Mode::BackendPicker => self.picker_key(key),
            Mode::Edit { note_id } => self.edit_key(key, note_id),
        }
    }

    fn help_key(&mut self, key: KeyEvent) {
        match key.code {
            _ if is_help_key(&key) || key.code == KeyCode::Esc => self.help_open = false,
            KeyCode::Up | KeyCode::Char('k') => {
                self.help_scroll = self.help_scroll.saturating_sub(1)
            }
            KeyCode::Down | KeyCode::Char('j') => {
                self.help_scroll = self.help_scroll.saturating_add(1)
            }
            KeyCode::PageUp => self.help_scroll = self.help_scroll.saturating_sub(10),
            KeyCode::PageDown => self.help_scroll = self.help_scroll.saturating_add(10),
            KeyCode::Home => self.help_scroll = 0,
            _ => {}
        }
    }

    fn list_nav(&self, key: &KeyEvent, vim_keys: bool) -> Option<Nav> {
        let shift = key.modifiers.contains(KeyModifiers::SHIFT);
        match key.code {
            KeyCode::Up if shift => Some(Nav::Up(self.page_step())),
            KeyCode::Down if shift => Some(Nav::Down(self.page_step())),
            KeyCode::Up => Some(Nav::Up(1)),
            KeyCode::Down => Some(Nav::Down(1)),
            KeyCode::Char('k') if vim_keys => Some(Nav::Up(1)),
            KeyCode::Char('j') if vim_keys => Some(Nav::Down(1)),
            KeyCode::Enter => Some(Nav::Select),
            _ => None,
        }
    }

    fn browse_key(&mut self, key: KeyEvent) {
        let mods = key.modifiers;
        let (ctrl, alt, sup) = (
            mods.contains(KeyModifiers::CONTROL),
            mods.contains(KeyModifiers::ALT),
            mods.contains(KeyModifiers::SUPER),
        );
        if let Some((c, shift)) = letter(&key) {
            match c {
                'q' => {
                    self.should_quit = true;
                    return;
                }
                // Note List Search: `f` (Apple's ⌥⌘F without the modifiers
                // most terminals strip; ⌥⌘F works where it's forwarded).
                'f' if (!ctrl && !alt && !sup) || (alt && sup) => {
                    self.set_filter(String::new());
                    self.filter_input = single_line_input("Search…", "");
                    self.mode = Mode::Filter;
                    return;
                }
                's' => {
                    self.sort = self.sort.next();
                    return;
                }
                'r' => return self.refresh(false),
                // Cmd+N is the terminal's, so bare n / N per TUI convention.
                'n' if shift => return self.enter_new_folder(),
                'n' => return self.new_note(),
                'b' if shift => {
                    self.picker_cursor = BackendChoice::ALL
                        .iter()
                        .position(|&c| c == self.backend_choice)
                        .unwrap_or(0);
                    self.mode = Mode::BackendPicker;
                    return;
                }
                _ => {}
            }
        }
        if matches!(key.code, KeyCode::Tab | KeyCode::BackTab) {
            self.focused = match self.focused {
                Pane::Folders => Pane::Notes,
                Pane::Notes => Pane::Folders,
            };
            return;
        }
        match self.focused {
            Pane::Folders => match key.code {
                KeyCode::Right => self.expand_folder(),
                KeyCode::Left => self.collapse_or_parent(),
                _ => match self.list_nav(&key, true) {
                    Some(Nav::Select) => self.focused = Pane::Notes,
                    Some(nav) => {
                        let len = self.tree.visible.len();
                        let next = step(self.folder_cursor(), len, &nav);
                        if let Some(&i) = self.tree.visible.get(next) {
                            self.active_folder_id = Some(self.folders[i].id.clone());
                        }
                    }
                    None => {}
                },
            },
            Pane::Notes => match (key.code, letter(&key)) {
                (KeyCode::Char(' '), _) => {
                    if let Some(id) = self.highlighted().map(|n| n.id.clone())
                        && !self.marked.shift_remove(&id)
                    {
                        self.marked.insert(id);
                    }
                }
                (_, Some(('e', _))) => self.enter_edit(),
                (_, Some(('m', _))) => self.enter_move_mode(),
                _ => match self.list_nav(&key, true) {
                    Some(Nav::Select) | None => {}
                    Some(nav) => {
                        self.note_cursor = step(self.note_cursor, self.rendered_notes().len(), &nav)
                    }
                },
            },
        }
    }

    fn filter_key(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Esc => {
                self.mode = Mode::Browse;
                self.set_filter(String::new());
            }
            KeyCode::Enter => self.mode = Mode::Browse,
            KeyCode::Up | KeyCode::Down => {
                if let Some(nav) = self.list_nav(&key, false) {
                    self.note_cursor = step(self.note_cursor, self.rendered_notes().len(), &nav);
                }
            }
            KeyCode::Tab | KeyCode::BackTab => {}
            _ if inserts_newline(&key) => {}
            _ => {
                if self.filter_input.input(key) {
                    let text = self
                        .filter_input
                        .lines()
                        .first()
                        .cloned()
                        .unwrap_or_default();
                    self.set_filter(text);
                }
            }
        }
    }

    fn move_key(&mut self, key: KeyEvent, source_account: &str) {
        if key.code == KeyCode::Esc {
            self.mode = Mode::Browse;
            self.focused = Pane::Notes;
            return;
        }
        match self.list_nav(&key, true) {
            Some(Nav::Select) => {
                if let Some(target) = self.folders.get(self.move_cursor).cloned() {
                    self.perform_move(target, source_account);
                }
            }
            Some(nav) => self.move_cursor = step(self.move_cursor, self.folders.len(), &nav),
            None => {}
        }
    }

    fn new_folder_key(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Esc => self.mode = Mode::Browse,
            KeyCode::Enter => self.submit_new_folder(),
            KeyCode::Tab | KeyCode::BackTab => {}
            _ if inserts_newline(&key) => {}
            _ => {
                self.new_folder_input.input(key);
            }
        }
    }

    fn picker_key(&mut self, key: KeyEvent) {
        if key.code == KeyCode::Esc {
            self.mode = Mode::Browse;
            return;
        }
        match self.list_nav(&key, true) {
            Some(Nav::Select) => self.switch_backend(BackendChoice::ALL[self.picker_cursor]),
            Some(nav) => {
                self.picker_cursor = step(self.picker_cursor, BackendChoice::ALL.len(), &nav)
            }
            None => {}
        }
    }

    // Terminals with flow control on intercept Ctrl+S — `stty -ixon` frees it.
    fn edit_key(&mut self, key: KeyEvent, note_id: String) {
        if key.code == KeyCode::Esc {
            self.cancel_edit();
        } else if key.code == KeyCode::Char('s') && key.modifiers.contains(KeyModifiers::CONTROL) {
            self.save_edit(note_id);
        } else if let Some(editor) = self.editor.as_mut() {
            editor.input(key);
        }
    }

    // ── Mouse ──────────────────────────────────────────────────────────────

    fn handle_mouse(&mut self, mouse: MouseEvent) -> bool {
        if self.main_hidden()
            || self.help_open
            || matches!(
                self.mode,
                Mode::NewFolder | Mode::BackendPicker | Mode::Edit { .. }
            )
        {
            return false;
        }
        let pos = Position::new(mouse.column, mouse.row);
        let delta = match mouse.kind {
            MouseEventKind::ScrollUp => -(WHEEL_STEP as isize),
            MouseEventKind::ScrollDown => WHEEL_STEP as isize,
            MouseEventKind::Down(MouseButton::Left) => return self.click(pos),
            _ => return false,
        };
        let h = self.hit;
        if h.folder_pane.contains(pos) {
            let rows = self.pane_folders();
            let next = clamp_add(self.pane_cursor(), delta, rows.len());
            if self.move_mode() {
                self.move_cursor = next;
            } else if let Some(&i) = rows.get(next) {
                self.active_folder_id = Some(self.folders[i].id.clone());
            }
        } else if h.notes_pane.contains(pos) {
            self.note_cursor = clamp_add(self.note_cursor, delta, self.rendered_notes().len());
        } else if h.preview.contains(pos) {
            let scroll = i64::from(self.preview_scroll) + delta as i64;
            self.preview_scroll = scroll.clamp(0, i64::from(h.preview_max_scroll)) as u16;
        } else {
            return false;
        }
        true
    }

    fn click(&mut self, pos: Position) -> bool {
        let h = self.hit;
        if h.folder_list.contains(pos) {
            let i = h.folder_offset + usize::from(pos.y - h.folder_list.y);
            let rows = self.pane_folders();
            let Some(&folder) = rows.get(i) else {
                return false;
            };
            if self.move_mode() {
                self.move_cursor = i;
            } else {
                self.active_folder_id = Some(self.folders[folder].id.clone());
                self.focused = Pane::Folders;
            }
            true
        } else if h.notes_list.contains(pos) && !self.move_mode() {
            let i = h.notes_offset
                + usize::from(pos.y - h.notes_list.y) / crate::format::NOTE_LINES_PER_ITEM;
            if i >= self.rendered_notes().len() {
                return false;
            }
            self.note_cursor = i;
            self.focused = Pane::Notes;
            true
        } else {
            false
        }
    }

    // ── Actions ────────────────────────────────────────────────────────────

    fn refresh(&mut self, silent: bool) {
        // Not in browse mode: surface the change instead of yanking the UI.
        if self.mode != Mode::Browse {
            if matches!(self.mode, Mode::Edit { .. }) {
                self.external_change_during_edit = true;
            } else if !silent {
                self.toast = "Refresh deferred — exit current mode first".into();
            }
            return;
        }
        // Cheap first pass: fresh folders + counts, compared on arrival; most
        // refreshes find nothing changed and skip the cache wipe.
        let before = self.folders.clone();
        self.load_folders(FolderLoad::Refresh { silent, before });
    }

    fn new_note(&mut self) {
        let Some(folder) = self.active_folder().cloned() else {
            self.toast = "Select a folder first".into();
            return;
        };
        let backend = self.backend.clone();
        self.spawn(async move {
            let result = backend.create_note(&folder.id).await.map_err(err);
            Msg::NoteCreated { folder, result }
        });
    }

    fn enter_new_folder(&mut self) {
        if self.active_folder().is_none() {
            self.toast = "Select a folder first (so we know which account to add to)".into();
            return;
        }
        self.new_folder_input = single_line_input("", "New Folder");
        self.mode = Mode::NewFolder;
    }

    fn submit_new_folder(&mut self) {
        let name = self
            .new_folder_input
            .lines()
            .first()
            .map(|l| l.trim().to_owned())
            .unwrap_or_default();
        self.mode = Mode::Browse;
        let Some(account) = self.active_folder().map(|f| f.account.clone()) else {
            return;
        };
        if name.is_empty() {
            return;
        }
        let backend = self.backend.clone();
        self.spawn(async move {
            let result = backend.create_folder(&account, &name).await.map_err(err);
            Msg::FolderCreated {
                account,
                name,
                result,
            }
        });
    }

    fn enter_edit(&mut self) {
        let Some(note_id) = self.highlighted().map(|n| n.id.clone()) else {
            self.toast = "No note highlighted".into();
            return;
        };
        let backend = self.backend.clone();
        self.spawn(async move {
            let result = backend.get_note_body(&note_id).await.map_err(err);
            Msg::EditBody { note_id, result }
        });
    }

    fn cancel_edit(&mut self) {
        self.editor = None;
        self.external_change_during_edit = false;
        self.mode = Mode::Browse;
    }

    fn save_edit(&mut self, note_id: String) {
        let Some(editor) = &self.editor else { return };
        if self.write_in_flight {
            return;
        }
        let content = editor.lines().join("\n");
        let folder_id = self.highlighted().map(|n| n.folder_id.clone());
        self.write_in_flight = true;
        let backend = self.backend.clone();
        self.spawn(async move {
            let result = backend
                .update_note_body(&note_id, &content)
                .await
                .map_err(err);
            Msg::Saved { folder_id, result }
        });
    }

    fn expand_folder(&mut self) {
        let Some(id) = self.cursor_folder().map(|f| f.id.clone()) else {
            return;
        };
        if self.tree.with_children.contains(&id) && self.expanded.insert(id) {
            self.tree_dirty = true;
        }
    }

    /// ← collapses an expanded folder, otherwise jumps to its parent — how
    /// Finder and most tree views behave.
    fn collapse_or_parent(&mut self) {
        let Some(folder) = self.cursor_folder().cloned() else {
            return;
        };
        if self.expanded.remove(&folder.id) {
            self.tree_dirty = true;
            return;
        }
        if folder.depth == 0 {
            return;
        }
        let parent = parent_path(&folder.path).and_then(|p| self.tree.by_path.get(p));
        if let Some(&p) = parent {
            self.active_folder_id = Some(self.folders[p].id.clone());
        }
    }

    fn switch_backend(&mut self, next: BackendChoice) {
        self.mode = Mode::Browse;
        if next == self.backend_choice {
            return; // picking the current one is a no-op
        }
        let mut toast = format!("Switched to {}", next.label());
        if !matches!(self.source, BackendSource::Static(_)) {
            self.backend_choice = next;
            self.backend = self.source.get(next);
            if let Err(e) = (self.on_choice_change)(next) {
                toast.push_str(&format!(" (failed to save settings: {e})"));
            }
            // Different backend, possibly different IDs: don't show the old
            // one's folders while the new list loads.
            self.set_folders(Vec::new());
            self.load_folders(FolderLoad::Load);
        }
        self.bust();
        self.marked.clear();
        self.toast = toast;
    }

    fn enter_move_mode(&mut self) {
        let ids = self.ids_to_move();
        if ids.is_empty() {
            self.toast = "Nothing to move".into();
            return;
        }
        let accounts: IndexSet<&str> = ids
            .iter()
            .filter_map(|id| self.folder_of_note(id))
            .filter_map(|fid| {
                self.tree
                    .by_id
                    .get(fid)
                    .map(|&i| self.folders[i].account.as_str())
            })
            .collect();
        if accounts.len() > 1 {
            self.toast = "Cannot move across accounts".into();
            return;
        }
        let Some(source_account) = accounts.first().map(|a| (*a).to_owned()) else {
            return;
        };
        // Seed the picker at the active folder's row in the full list —
        // usually the source folder the user was just browsing.
        self.move_cursor = self
            .active_folder()
            .and_then(|a| self.folders.iter().position(|f| f.id == a.id))
            .unwrap_or(0);
        self.mode = Mode::MoveTarget {
            source_account,
            source_count: ids.len(),
        };
        self.focused = Pane::Folders;
    }

    fn perform_move(&mut self, target: Folder, source_account: &str) {
        if self.write_in_flight {
            return;
        }
        if target.account != source_account {
            self.toast = format!("Cannot move to {} (cross-account)", target.account);
            return;
        }
        let ids = self.ids_to_move();
        if ids.is_empty() {
            self.toast = "Nothing to move".into();
            return;
        }
        let mut source_folder_ids: IndexSet<String> = ids
            .iter()
            .filter_map(|id| self.folder_of_note(id).map(str::to_owned))
            .collect();
        source_folder_ids.insert(target.id.clone());
        let moves: Vec<Move> = ids
            .into_iter()
            .map(|note_id| Move {
                note_id,
                folder_id: target.id.clone(),
            })
            .collect();
        self.write_in_flight = true;
        let backend = self.backend.clone();
        self.spawn(async move {
            let result = backend.move_notes(&moves).await.map_err(err);
            Msg::Moved {
                target,
                source_folder_ids: source_folder_ids.into_iter().collect(),
                result,
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notes::mock::{Call, MockBackend, folder, note};
    use crate::tui::ui;
    use ratatui::{Terminal, backend::TestBackend};

    fn fixture() -> Arc<MockBackend> {
        Arc::new(MockBackend::new(
            vec![
                folder("f1", "Personal", "iCloud / Personal", 0, 2),
                folder("f2", "Work", "iCloud / Work", 0, 1),
            ],
            vec![
                note("n1", "Shopping list", "f1", "2026-05-02T10:00:00Z"),
                note("n2", "Recipe ideas", "f1", "2026-05-01T10:00:00Z"),
                note("n3", "Quarterly report", "f2", "2026-04-30T10:00:00Z"),
            ],
        ))
    }

    struct Harness {
        app: App,
        rx: UnboundedReceiver<Msg>,
        terminal: Terminal<TestBackend>,
    }

    impl Harness {
        async fn new(backend: Arc<MockBackend>) -> Self {
            let mut h = Self::mount(backend);
            h.settle().await;
            h
        }

        /// Mounted but not settled (for asserting the loading state).
        fn mount(backend: Arc<MockBackend>) -> Self {
            let (app, rx) = App::new(
                BackendSource::Static(backend),
                BackendChoice::Osa,
                Box::new(|_| Ok(())),
                30,
            );
            Self {
                app,
                rx,
                terminal: Terminal::new(TestBackend::new(140, 30)).unwrap(),
            }
        }

        /// Applies task results and fires debounce timers until nothing is
        /// left to do. Runs on paused time, so the 150/300 ms timers cost
        /// nothing in real time.
        async fn settle(&mut self) {
            loop {
                let deadline = self.app.next_deadline();
                tokio::select! {
                    biased;
                    Some(msg) = self.rx.recv() => self.app.handle_msg(msg),
                    () = async {
                        match deadline {
                            Some(at) => tokio::time::sleep_until(at).await,
                            None => std::future::pending().await,
                        }
                    } => self.app.on_timer(),
                    () = tokio::time::sleep(Duration::from_secs(5)) => break,
                }
            }
        }

        async fn press(&mut self, code: KeyCode, modifiers: KeyModifiers) {
            self.app
                .handle_event(Event::Key(KeyEvent::new(code, modifiers)));
            self.settle().await;
        }

        async fn key(&mut self, c: char) {
            let mods = if c.is_ascii_uppercase() {
                KeyModifiers::SHIFT
            } else {
                KeyModifiers::NONE
            };
            self.press(KeyCode::Char(c), mods).await;
        }

        fn frame(&mut self) -> String {
            self.terminal.draw(|f| ui::draw(f, &mut self.app)).unwrap();
            let buffer = self.terminal.backend().buffer();
            let width = buffer.area.width as usize;
            buffer
                .content()
                .chunks(width)
                .map(|row| row.iter().map(|c| c.symbol()).collect::<String>())
                .collect::<Vec<_>>()
                .join("\n")
        }
    }

    #[tokio::test(start_paused = true)]
    async fn shows_the_loading_screen_until_folders_resolve() {
        let backend = fixture();
        let gate = backend.gate_list_folders();
        let mut h = Harness::mount(backend);
        h.settle().await;
        assert!(h.frame().contains("Loading notes"));
        gate.notify_one();
        h.settle().await;
        assert!(h.frame().contains("Personal"));
    }

    #[tokio::test(start_paused = true)]
    async fn shows_the_error_screen_when_listing_fails() {
        let backend = fixture();
        backend.fail_list_folders("osascript failed (exit 1): not authorized");
        let mut h = Harness::new(backend).await;
        let frame = h.frame();
        assert!(frame.contains("Error: osascript failed (exit 1): not authorized"));
        assert!(frame.contains("Automation"));
    }

    #[tokio::test(start_paused = true)]
    async fn renders_folders_and_the_active_folders_notes() {
        let mut h = Harness::new(fixture()).await;
        let frame = h.frame();
        for text in [
            "Folders",
            "Personal",
            "Work",
            "Shopping list",
            "Recipe ideas",
            "Body of n1",
        ] {
            assert!(frame.contains(text), "missing {text:?} in\n{frame}");
        }
        assert!(!frame.contains("Quarterly report"));
    }

    #[tokio::test(start_paused = true)]
    async fn s_cycles_sort_modes() {
        let mut h = Harness::new(fixture()).await;
        assert!(h.frame().contains("[Date ↓]"));
        for label in ["[Date ↑]", "[Title]", "[Date ↓]"] {
            h.key('s').await;
            assert!(h.frame().contains(label), "{label}");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn question_mark_toggles_help() {
        let mut h = Harness::new(fixture()).await;
        assert!(!h.frame().contains("Keyboard shortcuts"));
        h.key('?').await;
        let frame = h.frame();
        assert!(frame.contains("Keyboard shortcuts"));
        assert!(frame.contains("Navigation"));
        assert!(frame.contains("Sort By"));
        h.key('?').await;
        assert!(!h.frame().contains("Keyboard shortcuts"));
    }

    #[tokio::test(start_paused = true)]
    async fn n_creates_a_note_in_the_active_folder() {
        let backend = fixture();
        let mut h = Harness::new(backend.clone()).await;
        h.key('n').await;
        assert!(backend.calls().contains(&Call::CreateNote("f1".into())));
        assert!(h.frame().contains("New Note in iCloud / Personal"));
    }

    #[tokio::test(start_paused = true)]
    async fn shift_n_opens_the_new_folder_dialog_and_enter_creates() {
        let backend = fixture();
        let mut h = Harness::new(backend.clone()).await;
        h.key('N').await;
        let frame = h.frame();
        assert!(frame.contains("New Folder"));
        assert!(frame.contains("Name:"));
        h.press(KeyCode::Enter, KeyModifiers::NONE).await;
        assert!(backend.calls().contains(&Call::CreateFolder {
            account: "iCloud".into(),
            name: "New Folder".into()
        }));
    }

    #[tokio::test(start_paused = true)]
    async fn esc_cancels_the_new_folder_dialog() {
        let backend = fixture();
        let mut h = Harness::new(backend.clone()).await;
        h.key('N').await;
        assert!(h.frame().contains("Name:"));
        h.press(KeyCode::Esc, KeyModifiers::NONE).await;
        assert!(!h.frame().contains("Name:"));
        assert!(
            !backend
                .calls()
                .iter()
                .any(|c| matches!(c, Call::CreateFolder { .. }))
        );
    }

    #[tokio::test(start_paused = true)]
    async fn tab_space_marks_then_m_enters_move_mode() {
        let mut h = Harness::new(fixture()).await;
        h.press(KeyCode::Tab, KeyModifiers::NONE).await;
        h.key(' ').await;
        assert!(h.frame().contains("[x] Shopping list"));
        h.key('m').await;
        assert!(h.frame().contains("Move To…"));
    }

    // Regression carried over from the TS suite: the move picker must list
    // every folder (not just the expanded subset), and the dispatched target
    // must be the row on screen.
    #[tokio::test(start_paused = true)]
    async fn move_picker_shows_the_full_tree_and_moves_to_the_selected_row() {
        let backend = Arc::new(MockBackend::new(
            vec![
                folder("alpha", "Alpha", "iCloud / Alpha", 0, 1),
                folder("bravo", "Bravo", "iCloud / Bravo", 0, 0),
                folder("b-child", "DeepFolder", "iCloud / Bravo / Child", 1, 1),
                folder("charlie", "Charlie", "iCloud / Charlie", 0, 1),
            ],
            vec![
                note("n-alpha", "InAlpha", "alpha", "2026-05-03T10:00:00Z"),
                note("n-child", "InDeep", "b-child", "2026-05-03T10:01:00Z"),
                note("n-charlie", "InCharlie", "charlie", "2026-05-03T10:02:00Z"),
            ],
        ));
        let mut h = Harness::new(backend.clone()).await;
        assert!(h.frame().contains("DeepFolder"), "expanded by default");

        // Down to Bravo, collapse it: Child disappears in browse mode.
        h.press(KeyCode::Down, KeyModifiers::NONE).await;
        h.press(KeyCode::Left, KeyModifiers::NONE).await;
        assert!(!h.frame().contains("DeepFolder"));

        // Collapsed Bravo aggregates its subtree, so InDeep is markable.
        h.press(KeyCode::Tab, KeyModifiers::NONE).await;
        h.key(' ').await;
        h.key('m').await;
        let frame = h.frame();
        assert!(frame.contains("Move To…"));
        assert!(frame.contains("DeepFolder"), "picker shows the full tree");

        // Seeded at Bravo (row 1 of the full list); ↓↓ lands on Charlie.
        h.press(KeyCode::Down, KeyModifiers::NONE).await;
        h.press(KeyCode::Down, KeyModifiers::NONE).await;
        h.press(KeyCode::Enter, KeyModifiers::NONE).await;
        assert!(backend.calls().contains(&Call::MoveNotes(vec![Move {
            note_id: "n-child".into(),
            folder_id: "charlie".into()
        }])));
        assert!(h.frame().contains("Moved 1 Note to iCloud / Charlie"));
    }

    #[tokio::test(start_paused = true)]
    async fn search_matches_bodies_through_the_index() {
        let backend = Arc::new(
            MockBackend::new(
                vec![folder("f1", "Personal", "iCloud / Personal", 0, 2)],
                vec![
                    note("n1", "Shopping list", "f1", "2026-05-02T10:00:00Z"),
                    note("n2", "Recipe ideas", "f1", "2026-05-01T10:00:00Z"),
                ],
            )
            .with_bodies([
                ("n1", "Shopping list\nmilk, eggs"),
                ("n2", "Recipe ideas\nrisotto"),
            ]),
        );
        let mut h = Harness::new(backend).await;
        h.key('f').await;
        for c in "risotto".chars() {
            h.key(c).await;
        }
        let frame = h.frame();
        assert!(frame.contains("Recipe ideas"));
        assert!(!frame.contains("Shopping list"));
        assert!(frame.contains("1 match in 1 folder"));
        // Enter keeps the filter applied; Esc from browse doesn't clear it.
        h.press(KeyCode::Enter, KeyModifiers::NONE).await;
        assert!(h.frame().contains("search: risotto"));
    }

    #[tokio::test(start_paused = true)]
    async fn edit_then_ctrl_s_saves_the_buffer() {
        let backend = Arc::new(
            MockBackend::new(
                vec![folder("f1", "Personal", "iCloud / Personal", 0, 1)],
                vec![note("n1", "Shopping list", "f1", "2026-05-02T10:00:00Z")],
            )
            .with_bodies([("n1", "Shopping list\nmilk")]),
        );
        let mut h = Harness::new(backend.clone()).await;
        h.press(KeyCode::Tab, KeyModifiers::NONE).await;
        h.key('e').await;
        assert!(h.frame().contains("[editing — Ctrl+S save · Esc cancel]"));
        h.press(KeyCode::End, KeyModifiers::NONE).await;
        h.key('!').await;
        h.press(KeyCode::Char('s'), KeyModifiers::CONTROL).await;
        assert!(backend.calls().contains(&Call::UpdateNoteBody {
            note_id: "n1".into(),
            body: "Shopping list!\nmilk".into()
        }));
        assert!(h.frame().contains("Saved"));
        assert_eq!(h.app.mode, Mode::Browse);
    }

    #[tokio::test(start_paused = true)]
    async fn q_and_ctrl_c_quit() {
        let mut h = Harness::new(fixture()).await;
        h.key('q').await;
        assert!(h.app.should_quit);
        let mut h = Harness::new(fixture()).await;
        h.press(KeyCode::Char('c'), KeyModifiers::CONTROL).await;
        assert!(h.app.should_quit);
    }

    #[tokio::test(start_paused = true)]
    async fn refresh_reports_when_nothing_changed() {
        let mut h = Harness::new(fixture()).await;
        h.key('r').await;
        assert!(h.frame().contains("Up to date"));
    }

    #[tokio::test(start_paused = true)]
    async fn clicking_a_note_row_selects_it() {
        let mut h = Harness::new(fixture()).await;
        h.frame(); // lay out hitboxes
        let list = h.app.hit.notes_list;
        // Second note row: two lines per item.
        h.app.handle_event(Event::Mouse(MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: list.x + 2,
            row: list.y + 2,
            modifiers: KeyModifiers::NONE,
        }));
        h.settle().await;
        assert_eq!(h.app.focused, Pane::Notes);
        assert_eq!(h.app.highlighted().map(|n| n.id.as_str()), Some("n2"));
        assert!(h.frame().contains("Body of n2"));
    }

    #[test]
    fn stepping_wraps_to_the_far_end_like_opentui() {
        assert_eq!(step(0, 5, &Nav::Up(1)), 4);
        assert_eq!(step(4, 5, &Nav::Down(1)), 0);
        assert_eq!(step(3, 5, &Nav::Down(5)), 0);
        assert_eq!(step(2, 5, &Nav::Up(5)), 4);
        assert_eq!(step(1, 5, &Nav::Down(2)), 3);
        assert_eq!(step(0, 0, &Nav::Down(1)), 0);
    }
}
