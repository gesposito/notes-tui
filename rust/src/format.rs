//! Row formatting for the folder and notes panes (port of `src/lib/format.ts`).

use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

// === Folder pane render config ===============================================
// SHOW_FOLDER_COUNTS=false → bare folder names.
// RIGHT_ALIGN_COUNTS=false → count inline (e.g. "Work  12"), no truncation.
pub const SHOW_FOLDER_COUNTS: bool = true;
pub const RIGHT_ALIGN_COUNTS: bool = true;
pub const FOLDER_PANE_WIDTH: u16 = 36;
/// Width the TypeScript build right-aligns counts to: pane width − 2 border −
/// 2 padding − 1 scroll-indicator column. The Rust TUI passes the exact
/// width of the row it draws instead (see `format_folder_option_name_in`).
pub const FOLDER_INNER_WIDTH: usize = FOLDER_PANE_WIDTH as usize - 4 - 1;
pub const NOTES_PANE_WIDTH: u16 = 44;
pub const NOTE_LINES_PER_ITEM: usize = 2;
// =============================================================================

pub fn format_folder_option_name(indent: &str, name: &str, count: u32) -> String {
    format_folder_option_name_in(indent, name, count, FOLDER_INNER_WIDTH)
}

/// `indent + name`, with the count right-aligned to `width` display columns
/// (min one space of gap; over-long names get an ellipsis). Widths are
/// measured in terminal cells rather than UTF-16 units, so emoji and CJK
/// folder names still line up.
pub fn format_folder_option_name_in(indent: &str, name: &str, count: u32, width: usize) -> String {
    let base = format!("{indent}{name}");
    if !SHOW_FOLDER_COUNTS || count == 0 {
        return base;
    }
    let count_text = count.to_string();
    if !RIGHT_ALIGN_COUNTS {
        return format!("{base}  {count_text}");
    }

    let min_gap = 1;
    let max_name = width.saturating_sub(count_text.len() + min_gap);
    let truncated = if base.width() > max_name {
        let budget = max_name.saturating_sub(1);
        let mut used = 0;
        let mut out: String = base
            .chars()
            .take_while(|c| {
                used += c.width().unwrap_or(0);
                used <= budget
            })
            .collect();
        out.push('…');
        out
    } else {
        base
    };
    let padding = min_gap.max(width.saturating_sub(truncated.width() + count_text.len()));
    format!("{truncated}{}{count_text}", " ".repeat(padding))
}

/// Second line of a note row: `YYYY-MM-DD  snippet`, either part optional.
pub fn format_note_meta(modified_at: Option<&str>, snippet: &str) -> String {
    let date = modified_at.map_or("", |d| d.get(..10).unwrap_or(d));
    match (date.is_empty(), snippet.is_empty()) {
        (false, false) => format!("{date}  {snippet}"),
        (false, true) => date.to_owned(),
        _ => snippet.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_the_indented_name_as_is_when_count_is_zero() {
        assert_eq!(format_folder_option_name("  ", "Work", 0), "  Work");
    }

    #[test]
    fn right_aligns_the_count() {
        let out = format_folder_option_name("", "Work", 12);
        assert_eq!(out.width(), FOLDER_INNER_WIDTH);
        assert!(out.starts_with("Work"));
        assert!(out.ends_with("12"));
    }

    #[test]
    fn keeps_a_one_space_gap_at_the_limit() {
        let name = "X".repeat(FOLDER_INNER_WIDTH - 3); // 3 cells for " 12"
        let out = format_folder_option_name("", &name, 12);
        assert_eq!(out.width(), FOLDER_INNER_WIDTH);
        assert!(out.ends_with(" 12"));
    }

    #[test]
    fn truncates_oversize_names_with_an_ellipsis() {
        let out = format_folder_option_name("", "A really really really long folder name", 7);
        assert_eq!(out.width(), FOLDER_INNER_WIDTH);
        assert!(out.contains('…'));
        assert!(out.ends_with('7'));
    }

    #[test]
    fn measures_wide_characters_in_cells() {
        let out = format_folder_option_name_in("", "日本語のフォルダ名です", 3, 20);
        assert_eq!(out.width(), 20);
        assert!(out.ends_with('3'));
    }

    #[test]
    fn indent_prefixes_nested_names() {
        assert_eq!(format_folder_option_name("    ", "Q4", 0), "    Q4");
    }

    #[test]
    fn note_meta_combines_date_and_snippet() {
        assert_eq!(
            format_note_meta(Some("2026-05-02T10:00:00Z"), "Hello world"),
            "2026-05-02  Hello world"
        );
        assert_eq!(
            format_note_meta(Some("2026-05-02T10:00:00Z"), ""),
            "2026-05-02"
        );
        assert_eq!(format_note_meta(None, "Just a snippet"), "Just a snippet");
        assert_eq!(format_note_meta(None, ""), "");
        assert_eq!(
            format_note_meta(Some("2026-05-02T10:30:00.123Z"), "x"),
            "2026-05-02  x"
        );
    }
}
