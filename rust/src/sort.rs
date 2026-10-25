//! Note list ordering (port of `src/lib/sort.ts`).

use std::cmp::Ordering;

use crate::notes::Note;
use crate::text::cmp_utf16;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SortMode {
    #[default]
    DateDesc,
    DateAsc,
    TitleAsc,
}

impl SortMode {
    pub const CYCLE: [SortMode; 3] = [Self::DateDesc, Self::DateAsc, Self::TitleAsc];

    pub fn label(self) -> &'static str {
        match self {
            Self::DateDesc => "Date ↓",
            Self::DateAsc => "Date ↑",
            Self::TitleAsc => "Title",
        }
    }

    pub fn next(self) -> Self {
        let i = Self::CYCLE.iter().position(|&m| m == self).unwrap_or(0);
        Self::CYCLE[(i + 1) % Self::CYCLE.len()]
    }
}

/// Stable sort, so ties keep their input order. Plain code-unit comparison
/// on lowercased strings (no locale collation), matching the TypeScript
/// build and Apple's case-insensitive default. Missing dates sort as "".
pub fn sort_notes(notes: &[Note], mode: SortMode) -> Vec<Note> {
    let date = |n: &Note| n.modified_at.clone().unwrap_or_default();
    let keyed: Vec<(String, &Note)> = notes
        .iter()
        .map(|n| match mode {
            SortMode::TitleAsc => (n.title.to_lowercase(), n),
            _ => (date(n), n),
        })
        .collect();
    let mut keyed = keyed;
    keyed.sort_by(|(a, _), (b, _)| -> Ordering {
        match mode {
            SortMode::DateDesc => cmp_utf16(b, a),
            _ => cmp_utf16(a, b),
        }
    });
    keyed.into_iter().map(|(_, n)| n.clone()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(id: &str, title: &str, modified_at: Option<&str>) -> Note {
        Note {
            id: id.into(),
            title: title.into(),
            folder_id: "f1".into(),
            modified_at: modified_at.map(Into::into),
        }
    }

    fn ids(notes: &[Note]) -> Vec<&str> {
        notes.iter().map(|n| n.id.as_str()).collect()
    }

    fn three() -> Vec<Note> {
        vec![
            note("a", "A", Some("2026-05-01T00:00:00Z")),
            note("b", "B", Some("2026-05-03T00:00:00Z")),
            note("c", "C", Some("2026-05-02T00:00:00Z")),
        ]
    }

    #[test]
    fn date_desc_is_newest_first() {
        assert_eq!(
            ids(&sort_notes(&three(), SortMode::DateDesc)),
            ["b", "c", "a"]
        );
    }

    #[test]
    fn date_asc_is_oldest_first() {
        assert_eq!(
            ids(&sort_notes(&three(), SortMode::DateAsc)),
            ["a", "c", "b"]
        );
    }

    #[test]
    fn title_asc_is_case_insensitive() {
        let notes = vec![
            note("1", "banana", None),
            note("2", "Apple", None),
            note("3", "cherry", None),
        ];
        let titles: Vec<String> = sort_notes(&notes, SortMode::TitleAsc)
            .into_iter()
            .map(|n| n.title)
            .collect();
        assert_eq!(titles, ["Apple", "banana", "cherry"]);
    }

    #[test]
    fn missing_dates_sort_last_desc_and_first_asc() {
        let notes = vec![
            note("a", "A", None),
            note("b", "B", Some("2026-05-01T00:00:00Z")),
        ];
        assert_eq!(ids(&sort_notes(&notes, SortMode::DateDesc)), ["b", "a"]);
        assert_eq!(ids(&sort_notes(&notes, SortMode::DateAsc)), ["a", "b"]);
    }

    #[test]
    fn ties_keep_input_order() {
        let notes = vec![note("x", "Same", None), note("y", "same", None)];
        assert_eq!(ids(&sort_notes(&notes, SortMode::TitleAsc)), ["x", "y"]);
    }

    #[test]
    fn cycle_wraps_around() {
        assert_eq!(SortMode::DateDesc.next(), SortMode::DateAsc);
        assert_eq!(SortMode::DateAsc.next(), SortMode::TitleAsc);
        assert_eq!(SortMode::TitleAsc.next(), SortMode::DateDesc);
    }
}
