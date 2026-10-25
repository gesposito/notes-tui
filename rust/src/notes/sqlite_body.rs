//! Decoder for the gzipped protobuf in NoteStore.sqlite's ZICNOTEDATA.ZDATA
//! column (port of `src/notes/sqlite-body.ts`). Apple stores note bodies as
//! `Document → Document → Note → text + attribute_runs`; we only need the
//! plaintext, so we walk the protobuf wire format by hand for the text field
//! and ignore everything else. Wire types are self-describing, so no schema.
//!
//! Layout (verified against macOS Tahoe NoteStore):
//!   outer:  { 1: varint, 2: LEN ── body envelope }
//!   body:   { 1: varint, 2: varint, 3: LEN ── note }
//!   note:   { 2: LEN = utf-8 plaintext, 3: LEN = attribute_run, ... }
//!
//! Inline attachments appear in the text as U+FFFC; we leave them in place,
//! matching what `note.plaintext()` returns through osa.

use std::cell::RefCell;

use libdeflater::Decompressor;

use crate::text::{collapse_js_whitespace, truncate_utf16};

/// Deflate expands data at most ~1032:1, so a gzip trailer claiming more is
/// a corrupt blob; refusing it up front avoids a huge allocation.
const MAX_DEFLATE_RATIO: usize = 1032;

thread_local! {
    // Reused across the notes of a folder rather than allocated per note.
    static DECOMPRESSOR: RefCell<Decompressor> = RefCell::new(Decompressor::new());
}

/// Whole-buffer gunzip with libdeflate — about 3× faster than flate2's
/// default backend on note blobs, on par with `Bun.gunzipSync`. The output
/// is sized from the gzip trailer, which stores the uncompressed length.
fn gunzip(zdata: &[u8]) -> Option<Vec<u8>> {
    let trailer: [u8; 4] = zdata.get(zdata.len().checked_sub(4)?..)?.try_into().ok()?;
    let size = u32::from_le_bytes(trailer) as usize;
    if size > zdata.len().saturating_mul(MAX_DEFLATE_RATIO) {
        return None;
    }
    let mut out = vec![0; size];
    let written = DECOMPRESSOR
        .with_borrow_mut(|d| d.gzip_decompress(zdata, &mut out))
        .ok()?;
    out.truncate(written);
    Some(out)
}

fn read_varint(buf: &[u8], pos: usize) -> Option<(u64, usize)> {
    let mut value = 0u64;
    let mut shift = 0;
    let mut p = pos;
    while p < buf.len() {
        let b = buf[p];
        p += 1;
        value |= u64::from(b & 0x7f) << shift;
        if b & 0x80 == 0 {
            return Some((value, p));
        }
        shift += 7;
        // 35-bit cap is plenty for field tags + lengths; bail otherwise.
        if shift > 35 {
            return None;
        }
    }
    None
}

/// Raw bytes of the first LEN-typed field numbered `target` at the current
/// message level. `None` if absent or malformed.
fn find_len_field(buf: &[u8], target: u64) -> Option<&[u8]> {
    let mut p = 0;
    while p < buf.len() {
        let (tag, next) = read_varint(buf, p)?;
        p = next;
        let field = tag >> 3;
        match tag & 7 {
            0 => p = read_varint(buf, p)?.1,
            2 => {
                let (len, next) = read_varint(buf, p)?;
                p = next;
                let end = p.checked_add(usize::try_from(len).ok()?)?;
                if end > buf.len() {
                    return None;
                }
                if field == target {
                    return Some(&buf[p..end]);
                }
                p = end;
            }
            1 => p += 8,
            5 => p += 4,
            // 3/4 (groups) are deprecated and never appear here; bail.
            _ => return None,
        }
    }
    None
}

/// Gunzips ZDATA and extracts the plaintext body. `None` when the blob is
/// empty, not gzip (e.g. an encrypted note), or not the expected envelope —
/// callers fall back to osa.
pub fn extract_note_text(zdata: &[u8]) -> Option<String> {
    if zdata.len() < 2 || zdata[0] != 0x1f || zdata[1] != 0x8b {
        return None;
    }
    let decompressed = gunzip(zdata)?;

    // Walk: outer.field(2) → body.field(3) → note.field(2).
    let body = find_len_field(&decompressed, 2)?;
    let note = find_len_field(body, 3)?;
    let text = find_len_field(note, 2)?;

    // Same as TextDecoder("utf-8"): replacement chars, leading BOM dropped.
    let s = String::from_utf8_lossy(text);
    Some(s.strip_prefix('\u{FEFF}').unwrap_or(&s).to_owned())
}

/// Second non-empty line of a note's plaintext, whitespace-collapsed and
/// truncated to 120 chars — the same convention as the osa snippet path. The
/// first line is the title; the second is what shows in the list pane.
pub fn snippet_from_text(text: &str) -> String {
    text.split('\n')
        .skip(1)
        .map(collapse_js_whitespace)
        .find(|line| !line.is_empty())
        .map(|line| truncate_utf16(&line, 120).to_owned())
        .unwrap_or_default()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use flate2::{Compression, write::GzEncoder};
    use std::io::Write;

    // Minimal Apple-Notes-shaped protobuf, gzipped — mirrors ZICNOTEDATA.ZDATA:
    //   outer { 1: varint, 2: LEN [ 1: varint, 2: varint, 3: LEN [ 2: LEN=text ] ] }
    fn len_field(field: u8, payload: &[u8]) -> Vec<u8> {
        let mut out = vec![(field << 3) | 2];
        let mut n = payload.len();
        while n > 0x7f {
            out.push((n as u8 & 0x7f) | 0x80);
            n >>= 7;
        }
        out.push(n as u8);
        out.extend_from_slice(payload);
        out
    }

    fn gzip(bytes: &[u8]) -> Vec<u8> {
        let mut enc = GzEncoder::new(Vec::new(), Compression::default());
        enc.write_all(bytes).unwrap();
        enc.finish().unwrap()
    }

    pub(crate) fn build_zdata(text: &str) -> Vec<u8> {
        let note = len_field(2, text.as_bytes());
        let mut body = vec![1 << 3, 0, 2 << 3, 0];
        body.extend(len_field(3, &note));
        let mut outer = vec![1 << 3, 0];
        outer.extend(len_field(2, &body));
        gzip(&outer)
    }

    #[test]
    fn decodes_a_simple_plaintext_note() {
        assert_eq!(
            extract_note_text(&build_zdata("Hello world")).as_deref(),
            Some("Hello world")
        );
    }

    #[test]
    fn decodes_multi_line_text_including_the_title_line() {
        let text = "Trip\nLunch\n\nReceipt\n\nForm";
        assert_eq!(extract_note_text(&build_zdata(text)).as_deref(), Some(text));
    }

    #[test]
    fn preserves_attachment_markers() {
        let text = "Title\nText with \u{FFFC} attachment";
        assert_eq!(extract_note_text(&build_zdata(text)).as_deref(), Some(text));
    }

    #[test]
    fn rejects_empty_and_tiny_input() {
        assert_eq!(extract_note_text(&[]), None);
        assert_eq!(extract_note_text(&[0x1f]), None);
    }

    #[test]
    fn rejects_non_gzip_input() {
        assert_eq!(extract_note_text(&[0x00, 0x01, 0x02, 0x03]), None);
    }

    #[test]
    fn rejects_gzip_without_the_expected_envelope() {
        assert_eq!(extract_note_text(&gzip(b"garbage")), None);
    }

    #[test]
    fn rejects_truncated_blobs() {
        let zdata = build_zdata("Title\nBody that gets cut off");
        assert_eq!(extract_note_text(&zdata[..zdata.len() - 6]), None);
    }

    #[test]
    fn rejects_a_trailer_claiming_an_impossible_size() {
        // A corrupt length must not turn into a multi-GB allocation.
        let mut zdata = build_zdata("Title\nBody");
        let n = zdata.len();
        zdata[n - 4..].copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(extract_note_text(&zdata), None);
    }

    #[test]
    fn decodes_payloads_with_multi_byte_length_varints() {
        let text = "A".repeat(200);
        assert_eq!(extract_note_text(&build_zdata(&text)), Some(text));
    }

    #[test]
    fn snippet_is_the_second_non_empty_line() {
        assert_eq!(
            snippet_from_text("Title\nFirst body line\nSecond body line"),
            "First body line"
        );
        assert_eq!(
            snippet_from_text("Title\n\n\n  \nReal content here"),
            "Real content here"
        );
    }

    #[test]
    fn snippet_collapses_internal_whitespace() {
        assert_eq!(
            snippet_from_text("Title\n  multi   spaces\there"),
            "multi spaces here"
        );
    }

    #[test]
    fn snippet_truncates_to_120_characters() {
        let long = format!("T\n{}", "x".repeat(200));
        assert_eq!(snippet_from_text(&long).len(), 120);
    }

    #[test]
    fn snippet_is_empty_without_a_second_line() {
        assert_eq!(snippet_from_text("Title only"), "");
        assert_eq!(snippet_from_text(""), "");
    }
}
