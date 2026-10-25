//! String helpers that reproduce JavaScript semantics where the TypeScript
//! build's output depends on them (snippets, sorting), so both builds print
//! identical results.

use std::cmp::Ordering;

/// JS `\s` / `String.prototype.trim` whitespace: WhiteSpace + LineTerminator.
/// Differs from `char::is_whitespace` on U+FEFF (JS yes, Rust no) and U+0085
/// (Rust yes, JS no).
pub fn is_js_whitespace(c: char) -> bool {
    matches!(c, '\u{2000}'..='\u{200A}')
        || matches!(
            c,
            '\t' | '\n'
                | '\u{000B}'
                | '\u{000C}'
                | '\r'
                | ' '
                | '\u{00A0}'
                | '\u{1680}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
        )
}

/// `s.replace(/\s+/g, " ").trim()`.
pub fn collapse_js_whitespace(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut pending_space = false;
    for c in s.chars() {
        if is_js_whitespace(c) {
            pending_space = !out.is_empty();
        } else {
            if pending_space {
                out.push(' ');
                pending_space = false;
            }
            out.push(c);
        }
    }
    out
}

/// JS `.length`.
pub fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// JS `.slice(0, max)` by UTF-16 units, except that a surrogate pair
/// straddling the cut is dropped whole (Rust strings can't hold the lone
/// surrogate JS would keep).
pub fn truncate_utf16(s: &str, max: usize) -> &str {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        units += c.len_utf16();
        if units > max {
            return &s[..i];
        }
    }
    s
}

/// JS `a < b` ordering on strings: lexicographic by UTF-16 code unit. Only
/// differs from Rust's byte order when comparing astral characters against
/// U+E000..U+FFFF, but keeps sorts identical to the TypeScript build.
pub fn cmp_utf16(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collapses_and_trims_like_js() {
        assert_eq!(
            collapse_js_whitespace("  multi   spaces\there "),
            "multi spaces here"
        );
        assert_eq!(
            collapse_js_whitespace("\u{FEFF}bom\u{3000}ideographic"),
            "bom ideographic"
        );
        assert_eq!(collapse_js_whitespace(" \t\n "), "");
        // NEL is whitespace to Rust but not to JS.
        assert_eq!(collapse_js_whitespace("a\u{0085}b"), "a\u{0085}b");
    }

    #[test]
    fn truncates_by_utf16_units() {
        assert_eq!(truncate_utf16("abcdef", 3), "abc");
        assert_eq!(truncate_utf16("ab", 3), "ab");
        // 👍 is two UTF-16 units: it fits at 4, not at 3.
        assert_eq!(truncate_utf16("ab👍", 4), "ab👍");
        assert_eq!(truncate_utf16("ab👍", 3), "ab");
        assert_eq!(utf16_len("ab👍"), 4);
    }

    #[test]
    fn orders_by_utf16_code_units() {
        // U+FF5E (BMP, high) vs U+1F44D (astral): bytes say FF5E < 1F44D,
        // UTF-16 says the astral one (surrogate D83D) sorts first.
        assert_eq!(cmp_utf16("\u{1F44D}", "\u{FF5E}"), Ordering::Less);
        assert_eq!(cmp_utf16("a", "b"), Ordering::Less);
    }
}
