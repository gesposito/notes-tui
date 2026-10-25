//! Rendering (the JSX half of `src/app.tsx` and `src/components/*`).
//!
//! Lists mimic OpenTUI's Select: `▶` indicator, #334455 selection bar,
//! centered scrolling, and a `█` thumb in the last column. Scroll offsets
//! and pane rects are stored back on the app, so a mouse click maps to the
//! row that was actually drawn.

use ratatui::Frame;
use ratatui::buffer::Buffer;
use ratatui::layout::{Constraint, Layout, Margin, Rect};
use ratatui::style::{Color, Style};
use ratatui::text::{Line, Span, Text};
use ratatui::widgets::{Block, Clear, Padding, Paragraph, Wrap};
use unicode_width::UnicodeWidthStr;

use super::app::{App, Mode, Pane};
use crate::format::{
    FOLDER_PANE_WIDTH, NOTE_LINES_PER_ITEM, NOTES_PANE_WIDTH, format_folder_option_name_in,
    format_note_meta,
};
use crate::notes::BackendChoice;
use crate::shortcuts::SHORTCUTS;

pub(super) const WHITE: Color = Color::Rgb(0xff, 0xff, 0xff);
pub(super) const CYAN: Color = Color::Rgb(0x33, 0xcc, 0xff);
pub(super) const YELLOW: Color = Color::Rgb(0xe6, 0xc2, 0x00);
pub(super) const GREEN: Color = Color::Rgb(0x33, 0xcc, 0x66);
pub(super) const ORANGE: Color = Color::Rgb(0xff, 0x66, 0x44);
pub(super) const RED: Color = Color::Rgb(0xff, 0x00, 0x00);
pub(super) const GRAY_55: Color = Color::Rgb(0x55, 0x55, 0x55);
pub(super) const GRAY_66: Color = Color::Rgb(0x66, 0x66, 0x66);
pub(super) const GRAY_77: Color = Color::Rgb(0x77, 0x77, 0x77);
pub(super) const GRAY_88: Color = Color::Rgb(0x88, 0x88, 0x88);
pub(super) const GRAY_AA: Color = Color::Rgb(0xaa, 0xaa, 0xaa);
pub(super) const GRAY_CC: Color = Color::Rgb(0xcc, 0xcc, 0xcc);
pub(super) const FOCUSED_BG: Color = Color::Rgb(0x1a, 0x1a, 0x1a);
pub(super) const SELECTED_BG: Color = Color::Rgb(0x33, 0x44, 0x55);
pub(super) const SELECTED_FG: Color = Color::Rgb(0xff, 0xff, 0x00);
pub(super) const DIALOG_BG: Color = Color::Rgb(0x0d, 0x11, 0x17);

const HELP_KEY_COLUMN: usize = 18;

/// OpenTUI Select's scroll position: keep the selection centered.
pub(super) fn centered_offset(cursor: usize, visible: usize, total: usize) -> usize {
    cursor
        .saturating_sub(visible / 2)
        .min(total.saturating_sub(visible))
}

/// Note text can carry tabs and control characters; neither should reach
/// the terminal raw.
fn sanitize(text: &str) -> String {
    text.replace('\t', "    ")
        .chars()
        .filter(|&c| c == '\n' || !c.is_control())
        .collect()
}

/// Greedy word wrap by display width. A word wider than `width` gets a
/// line of its own rather than being split.
fn wrap_words(text: &str, width: usize) -> Vec<String> {
    let mut lines = Vec::new();
    let mut line = String::new();
    for word in text.split(' ') {
        if !line.is_empty() && line.width() + 1 + word.width() > width {
            lines.push(std::mem::take(&mut line));
        }
        if !line.is_empty() {
            line.push(' ');
        }
        line.push_str(word);
    }
    lines.push(line);
    lines
}

fn gray(text: impl Into<String>) -> Line<'static> {
    Line::styled(text.into(), Style::new().fg(GRAY_77))
}

fn pane(title: String, border: Color) -> Block<'static> {
    Block::bordered()
        .border_style(Style::new().fg(border))
        .title(title)
}

struct Row {
    name: String,
    description: Option<String>,
}

/// Where a list is scrolled to and how it's drawn.
struct ListView {
    selected: usize,
    offset: usize,
    total: usize,
    focused: bool,
    lines_per_item: u16,
}

/// Draws visible rows like OpenTUI's Select. `rows` holds only the rows
/// from `view.offset` on.
fn render_select(buf: &mut Buffer, area: Rect, rows: &[Row], view: ListView) {
    let ListView {
        selected,
        offset,
        total,
        focused,
        lines_per_item,
    } = view;
    if area.is_empty() {
        return;
    }
    buf.set_style(
        area,
        Style::new().bg(if focused { FOCUSED_BG } else { Color::Reset }),
    );
    let visible_items = usize::from(area.height / lines_per_item).max(1);
    for (i, row) in rows.iter().enumerate().take(visible_items) {
        let y = area.y + (i as u16) * lines_per_item;
        if y + lines_per_item > area.bottom() {
            break;
        }
        let is_selected = offset + i == selected;
        if is_selected {
            buf.set_style(
                Rect::new(area.x, y, area.width, lines_per_item),
                Style::new().bg(SELECTED_BG),
            );
        }
        let indicator = if is_selected { "▶ " } else { "  " };
        let name_style = Style::new().fg(if is_selected { SELECTED_FG } else { WHITE });
        // The last column is reserved for the scroll thumb.
        let name_width = usize::from(area.width.saturating_sub(2));
        buf.set_stringn(
            area.x + 1,
            y,
            format!("{indicator}{}", row.name),
            name_width,
            name_style,
        );
        if let Some(desc) = &row.description
            && lines_per_item > 1
        {
            let desc_style = Style::new().fg(if is_selected { GRAY_CC } else { GRAY_88 });
            buf.set_stringn(
                area.x + 3,
                y + 1,
                desc,
                usize::from(area.width.saturating_sub(4)),
                desc_style,
            );
        }
    }
    if total > visible_items {
        let max_offset = (total - visible_items) as f64;
        let track = f64::from(area.height.saturating_sub(2).max(1));
        let thumb = area.y + 1 + ((offset as f64 / max_offset) * track).floor() as u16;
        buf.set_string(
            area.right() - 1,
            thumb.min(area.bottom() - 1),
            "█",
            Style::new().fg(GRAY_66),
        );
    }
}

/// Wrapped height of `text` at `width` (at least one line if non-empty).
fn wrapped_height(text: &Text<'_>, width: u16) -> u16 {
    if text.lines.is_empty() || width == 0 {
        return 0;
    }
    let lines = Paragraph::new(text.clone())
        .wrap(Wrap { trim: false })
        .line_count(width);
    u16::try_from(lines).unwrap_or(u16::MAX)
}

pub fn draw(frame: &mut Frame, app: &mut App) {
    let area = frame.area();
    app.term_height = area.height;

    if app.folders_loading && app.folders.is_empty() {
        let text = Text::from(vec![
            Line::raw("Loading notes…"),
            gray(
                "(First run may prompt for Automation access; large libraries can take a few seconds.)",
            ),
        ]);
        frame.render_widget(
            Paragraph::new(text).wrap(Wrap { trim: false }),
            area.inner(Margin::new(1, 1)),
        );
        return;
    }
    if let Some(error) = &app.folders_error {
        let text = Text::from(vec![
            Line::styled(format!("Error: {error}"), Style::new().fg(RED)),
            gray(
                "On first run, macOS will ask permission to control Notes. If denied, \
                 enable it in System Settings → Privacy & Security → Automation.",
            ),
            gray("Press Ctrl-C to quit."),
        ]);
        frame.render_widget(
            Paragraph::new(text).wrap(Wrap { trim: false }),
            area.inner(Margin::new(1, 1)),
        );
        return;
    }

    let label = format!(" [{}] ", app.backend_choice);
    let hint_width = area.width.saturating_sub(label.width() as u16);
    let hint = Text::from(gray(footer_hint(&app.mode)));
    let banner = banner(app);
    let toast = (!app.toast.is_empty())
        .then(|| Text::from(Line::styled(app.toast.clone(), Style::new().fg(GREEN))));

    let [main, footer, banner_area, toast_area] = Layout::vertical([
        Constraint::Min(0),
        Constraint::Length(wrapped_height(&hint, hint_width).max(1)),
        Constraint::Length(banner.as_ref().map_or(0, |b| wrapped_height(b, area.width))),
        Constraint::Length(toast.as_ref().map_or(0, |t| wrapped_height(t, area.width))),
    ])
    .areas(area);
    let [folders_area, notes_area, preview_area] = Layout::horizontal([
        Constraint::Length(FOLDER_PANE_WIDTH),
        Constraint::Length(NOTES_PANE_WIDTH),
        Constraint::Min(0),
    ])
    .areas(main);

    draw_folders(frame, app, folders_area);
    draw_notes(frame, app, notes_area);
    draw_preview(frame, app, preview_area);

    let [hint_area, label_area] =
        Layout::horizontal([Constraint::Length(hint_width), Constraint::Min(0)]).areas(footer);
    frame.render_widget(Paragraph::new(hint).wrap(Wrap { trim: false }), hint_area);
    frame.render_widget(Line::styled(label, Style::new().fg(GRAY_55)), label_area);
    if let Some(banner) = banner {
        frame.render_widget(
            Paragraph::new(banner).wrap(Wrap { trim: false }),
            banner_area,
        );
    }
    if let Some(toast) = toast {
        frame.render_widget(Paragraph::new(toast).wrap(Wrap { trim: false }), toast_area);
    }

    if app.help_open {
        draw_help(frame, app, area);
    }
    match app.mode {
        Mode::NewFolder => draw_new_folder(frame, app, area),
        Mode::BackendPicker => draw_backend_picker(frame, app, area),
        _ => {}
    }
}

fn footer_hint(mode: &Mode) -> &'static str {
    match mode {
        Mode::Browse => {
            "↑↓ Nav · ←/→ Collapse/Expand · Tab Switch · n New Note · N New Folder · m Move To… · \
             f Search · s Sort · r Refresh · B Backend · ? Help · q Quit"
        }
        Mode::MoveTarget { .. } => "Move To… · ↑↓ Pick destination · Enter Move · Esc Cancel",
        Mode::Filter => "Note List Search · type to filter · Enter Apply · Esc Cancel",
        Mode::NewFolder => "New Folder · type name · Enter Create · Esc Cancel",
        Mode::Edit { .. } => {
            "Edit Note · Ctrl+S Save (formatting lost — see EDITING.md) · Esc Cancel"
        }
        Mode::BackendPicker => "Switch Backend · ↑↓ Pick · Enter Switch · Esc Cancel",
    }
}

fn banner(app: &App) -> Option<Text<'static>> {
    if !app.index_enabled() {
        return None;
    }
    let (loaded, total) = app.index_progress();
    let folders = format!("folder{}", if total == 1 { "" } else { "s" });
    if app.indexing() {
        let text = format!(
            "Indexing {loaded}/{total} {folders} in scope for full-text search… \
             (collapse a parent to widen, more specific terms to narrow)"
        );
        Some(Text::from(Line::styled(text, Style::new().fg(YELLOW))))
    } else if !app.filter.is_empty() {
        let n = app.visible_notes.len();
        let matches = if n == 1 { "match" } else { "matches" };
        Some(Text::from(gray(format!(
            "{n} {matches} in {total} {folders}"
        ))))
    } else {
        None
    }
}

fn draw_folders(frame: &mut Frame, app: &mut App, area: Rect) {
    let move_mode = app.move_mode();
    let border = if move_mode {
        YELLOW
    } else if app.focused == Pane::Folders {
        CYAN
    } else {
        GRAY_55
    };
    let title = match &app.mode {
        Mode::MoveTarget { source_count, .. } => {
            format!(
                "Move To…  ({source_count} Note{})",
                if *source_count == 1 { "" } else { "s" }
            )
        }
        _ => "Folders".to_owned(),
    };
    let block = pane(title, border);
    let inner = block.inner(area);
    frame.render_widget(block, area);

    let rows = app.pane_folders();
    let cursor = app.pane_cursor();
    let offset = centered_offset(cursor, usize::from(inner.height), rows.len());
    // 1 pad + 2 indicator + 1 scroll-thumb column.
    let name_width = usize::from(inner.width.saturating_sub(4));
    let visible: Vec<Row> = rows
        .iter()
        .skip(offset)
        .take(usize::from(inner.height))
        .map(|&i| {
            let f = &app.folders[i];
            let has_children = app.tree.with_children.contains(&f.id);
            let expanded = has_children && app.expanded.contains(&f.id);
            // Disclosure markers do nothing in move mode, so they're hidden.
            let marker = match (move_mode, has_children, expanded) {
                (true, _, _) | (false, false, _) => "  ",
                (false, true, true) => "▾ ",
                (false, true, false) => "▸ ",
            };
            // Expanded parents show their direct count (children list their
            // own); collapsed parents and leaves show the recursive total.
            let count = if !move_mode && expanded {
                f.note_count
            } else {
                app.tree.counts.get(&f.id).copied().unwrap_or(0)
            };
            let indent = format!("{}{marker}", "  ".repeat(f.depth as usize));
            Row {
                name: format_folder_option_name_in(&indent, &sanitize(&f.name), count, name_width),
                description: None,
            }
        })
        .collect();
    let focused = app.focused == Pane::Folders || move_mode;
    render_select(
        frame.buffer_mut(),
        inner,
        &visible,
        ListView {
            selected: cursor,
            offset,
            total: rows.len(),
            focused,
            lines_per_item: 1,
        },
    );
    app.hit.folder_pane = area;
    app.hit.folder_list = inner;
    app.hit.folder_offset = offset;
}

fn draw_notes(frame: &mut Frame, app: &mut App, area: Rect) {
    let border = if app.focused == Pane::Notes {
        CYAN
    } else {
        GRAY_55
    };
    let mut title = format!("Notes [{}]", app.sort.label());
    if !app.marked.is_empty() {
        title.push_str(&format!("  ({} Selected)", app.marked.len()));
    }
    if let Some(folder) = app.active_folder() {
        title.push_str(&format!("  —  {}", folder.path));
    }
    let block = pane(title, border);
    let mut rest = block.inner(area);
    frame.render_widget(block, area);
    app.hit.notes_pane = area;
    app.hit.notes_list = Rect::default();

    if app.mode == Mode::Filter || !app.filter.is_empty() {
        let [top, below] =
            Layout::vertical([Constraint::Length(1), Constraint::Min(0)]).areas(rest);
        if app.mode == Mode::Filter {
            frame.render_widget(&app.filter_input, top);
        } else {
            frame.render_widget(gray(format!("search: {}", app.filter)), top);
        }
        rest = below;
    }
    let hidden = app
        .visible_notes
        .len()
        .saturating_sub(super::app::NOTE_RENDER_CAP);
    if hidden > 0 {
        let [list, bottom] =
            Layout::vertical([Constraint::Min(0), Constraint::Length(1)]).areas(rest);
        frame.render_widget(
            gray(format!("+ {hidden} more — narrow folder or use Search (f)")),
            bottom,
        );
        rest = list;
    }

    let total = app.rendered_notes().len();
    if total == 0 {
        frame.render_widget(gray("(no notes)"), rest);
        return;
    }
    let per_item = NOTE_LINES_PER_ITEM as u16;
    let visible_items = usize::from(rest.height / per_item).max(1);
    let offset = centered_offset(app.note_cursor, visible_items, total);
    // The [ ]/[x] column appears once marking starts (Apple Notes shows bare
    // titles by default).
    let show_marks = !app.marked.is_empty();
    let rows: Vec<Row> = app
        .rendered_notes()
        .iter()
        .skip(offset)
        .take(visible_items)
        .map(|n| {
            let prefix = match (show_marks, app.marked.contains(&n.id)) {
                (false, _) => "",
                (true, true) => "[x] ",
                (true, false) => "[ ] ",
            };
            let title = if n.title.is_empty() {
                "(untitled)".to_owned()
            } else {
                sanitize(&n.title)
            };
            Row {
                name: format!("{prefix}{title}"),
                description: Some(sanitize(&format_note_meta(
                    n.modified_at.as_deref(),
                    app.snippet(n),
                ))),
            }
        })
        .collect();
    let focused = app.focused == Pane::Notes && app.mode == Mode::Browse;
    render_select(
        frame.buffer_mut(),
        rest,
        &rows,
        ListView {
            selected: app.note_cursor,
            offset,
            total,
            focused,
            lines_per_item: per_item,
        },
    );
    app.hit.notes_list = rest;
    app.hit.notes_offset = offset;
}

fn draw_preview(frame: &mut Frame, app: &mut App, area: Rect) {
    let editing = matches!(app.mode, Mode::Edit { .. });
    let external = editing && app.external_change_during_edit;
    let border = if external {
        ORANGE
    } else if editing {
        YELLOW
    } else {
        GRAY_55
    };
    let title = app
        .highlighted()
        .map(|n| sanitize(&n.title))
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "Preview".to_owned());
    let title = if editing {
        format!("{title}  [editing — Ctrl+S save · Esc cancel]")
    } else {
        title
    };
    let block = pane(title, border);
    let mut rest = block.inner(area);
    frame.render_widget(block, area);
    app.hit.preview = area;

    if external {
        let [top, below] =
            Layout::vertical([Constraint::Length(1), Constraint::Min(0)]).areas(rest);
        frame.render_widget(
            Line::styled(
                "⚠ External changes detected — Ctrl+S will overwrite them",
                Style::new().fg(ORANGE),
            ),
            top,
        );
        rest = below;
    }
    if editing {
        if let Some(editor) = &app.editor {
            frame.render_widget(editor, rest);
        }
        return;
    }

    let mut lines: Vec<Line> = Vec::new();
    if app.preview_loading && app.preview.is_empty() {
        lines.push(gray("Loading preview…"));
    }
    if app.highlighted().is_none() {
        lines.push(gray("(no note selected)"));
    }
    if !app.preview.is_empty() {
        lines.extend(Text::raw(sanitize(&app.preview)).lines);
    }
    let paragraph = Paragraph::new(lines).wrap(Wrap { trim: false });
    let content = u16::try_from(paragraph.line_count(rest.width)).unwrap_or(u16::MAX);
    app.hit.preview_max_scroll = content.saturating_sub(rest.height);
    app.preview_scroll = app.preview_scroll.min(app.hit.preview_max_scroll);
    frame.render_widget(paragraph.scroll((app.preview_scroll, 0)), rest);
}

/// Absolute-positioned box like the TS dialogs (`top="30%" left="20%"`).
fn dialog_rect(
    area: Rect,
    top_pct: u16,
    side_pct: u16,
    height: Option<u16>,
    bottom_pct: u16,
) -> Rect {
    let x = area.x + area.width * side_pct / 100;
    let width = area.width.saturating_sub(2 * (area.width * side_pct / 100));
    let y = area.y + area.height * top_pct / 100;
    let max_height = area.bottom().saturating_sub(y);
    let height = height.unwrap_or_else(|| {
        area.height
            .saturating_sub(area.height * (top_pct + bottom_pct) / 100)
    });
    Rect::new(x, y, width, height.min(max_height))
}

fn dialog(frame: &mut Frame, rect: Rect, title: &str) -> Rect {
    let block = Block::bordered()
        .border_style(Style::new().fg(CYAN))
        .title(title.to_owned())
        .style(Style::new().bg(DIALOG_BG))
        .padding(Padding::symmetric(2, 1));
    let inner = block.inner(rect);
    frame.render_widget(Clear, rect);
    frame.render_widget(block, rect);
    inner
}

fn draw_help(frame: &mut Frame, app: &mut App, area: Rect) {
    let inner = dialog(
        frame,
        dialog_rect(area, 5, 15, None, 5),
        "Keyboard shortcuts",
    );
    let [body, footer] = Layout::vertical([Constraint::Min(0), Constraint::Length(1)]).areas(inner);
    // Two columns: descriptions wrap within their own column, as in the TS
    // dialog's flex rows.
    let description_width = usize::from(body.width).saturating_sub(HELP_KEY_COLUMN);
    let mut lines: Vec<Line> = Vec::new();
    for (i, group) in SHORTCUTS.iter().enumerate() {
        if i > 0 {
            lines.push(Line::raw(""));
        }
        lines.push(Line::styled(group.name, Style::new().fg(CYAN)));
        for (key, description) in group.bindings {
            for (j, part) in wrap_words(description, description_width)
                .into_iter()
                .enumerate()
            {
                let key_cell = if j == 0 { *key } else { "" };
                let pad = HELP_KEY_COLUMN.saturating_sub(key_cell.width());
                lines.push(Line::from(vec![
                    Span::styled(
                        format!("{key_cell}{}", " ".repeat(pad)),
                        Style::new().fg(GRAY_AA),
                    ),
                    Span::styled(part, Style::new().fg(WHITE)),
                ]));
            }
        }
    }
    let max_scroll = u16::try_from(lines.len())
        .unwrap_or(u16::MAX)
        .saturating_sub(body.height);
    app.help_scroll = app.help_scroll.min(max_scroll);
    frame.render_widget(Paragraph::new(lines).scroll((app.help_scroll, 0)), body);
    frame.render_widget(
        Line::styled("(press ? or Esc to close)", Style::new().fg(GRAY_66)),
        footer,
    );
}

fn draw_new_folder(frame: &mut Frame, app: &App, area: Rect) {
    let inner = dialog(frame, dialog_rect(area, 35, 25, Some(9), 0), "New Folder");
    let [row, _, footer] = Layout::vertical([
        Constraint::Length(1),
        Constraint::Min(0),
        Constraint::Length(1),
    ])
    .areas(inner);
    let [label, input] = Layout::horizontal([Constraint::Length(6), Constraint::Min(0)]).areas(row);
    frame.render_widget(Span::styled("Name: ", Style::new().fg(GRAY_AA)), label);
    frame.render_widget(&app.new_folder_input, input);
    frame.render_widget(
        Line::styled("Enter: create · Esc: cancel", Style::new().fg(GRAY_66)),
        footer,
    );
}

fn draw_backend_picker(frame: &mut Frame, app: &App, area: Rect) {
    let inner = dialog(
        frame,
        dialog_rect(area, 30, 20, Some(11), 0),
        "Switch Backend",
    );
    let [list, footer] = Layout::vertical([Constraint::Min(0), Constraint::Length(1)]).areas(inner);
    let rows: Vec<Row> = BackendChoice::ALL
        .iter()
        .map(|&c| Row {
            name: format!(
                "{} {}",
                if c == app.backend_choice { "●" } else { " " },
                c.label()
            ),
            description: None,
        })
        .collect();
    render_select(
        frame.buffer_mut(),
        list,
        &rows,
        ListView {
            selected: app.picker_cursor,
            offset: 0,
            total: rows.len(),
            focused: true,
            lines_per_item: 1,
        },
    );
    frame.render_widget(
        Line::styled("Enter: switch · Esc: cancel", Style::new().fg(GRAY_66)),
        footer,
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_selection_centered_within_bounds() {
        assert_eq!(centered_offset(0, 10, 100), 0);
        assert_eq!(centered_offset(50, 10, 100), 45);
        assert_eq!(centered_offset(99, 10, 100), 90);
        assert_eq!(centered_offset(3, 10, 4), 0);
    }

    #[test]
    fn wraps_words_by_display_width() {
        assert_eq!(wrap_words("one two three", 7), ["one two", "three"]);
        assert_eq!(wrap_words("one two three", 100), ["one two three"]);
        assert_eq!(wrap_words("unbreakable word", 4), ["unbreakable", "word"]);
    }

    #[test]
    fn sanitizes_tabs_and_control_characters() {
        assert_eq!(sanitize("a\tb\u{7}c\nd"), "a    bc\nd");
    }
}
