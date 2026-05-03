// Decoder for the gzipped protobuf in NoteStore.sqlite's ZICNOTEDATA.ZDATA
// column. Apple stores note bodies as `Document → Document → Note → text +
// attribute_runs`, where the outer envelope adds versioning and the
// attribute_runs hold formatting (bold/italic/checklist/attachment-anchor).
//
// We only need plaintext for preview, snippets, and the search index, so we
// walk the protobuf wire format manually for the text field and ignore
// everything else. No protobuf schema needed — wire types are
// self-describing.
//
// Layout we follow (verified against macOS Tahoe NoteStore):
//   outer:  { 1: varint, 2: LEN ── body envelope }
//   body:   { 1: varint, 2: varint, 3: LEN ── note }
//   note:   { 2: LEN = utf-8 plaintext, 3: LEN = attribute_run, ... }
//
// Inline attachments (drawings, images, links) appear in the text as
// U+FFFC (OBJECT REPLACEMENT CHARACTER); we leave them in place — Apple's
// own `note.plaintext()` returns them too, so this matches the osa output.

const TEXT_DECODER = new TextDecoder("utf-8");

type Buf = Uint8Array;

const readVarint = (
  buf: Buf,
  pos: number,
): { value: number; pos: number } | null => {
  let value = 0;
  let shift = 0;
  let p = pos;
  while (p < buf.length) {
    const b = buf[p++]!;
    value |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return { value, pos: p };
    shift += 7;
    // 35-bit cap is plenty for our field tags + lengths; bail otherwise.
    if (shift > 35) return null;
  }
  return null;
};

/**
 * Returns the raw bytes of the first LEN-typed field with `targetField`
 * at the *current* message level. Skips varints and fixed-size fields.
 * Returns null if not found or if the buffer is malformed.
 */
const findLenField = (buf: Buf, targetField: number): Buf | null => {
  let p = 0;
  while (p < buf.length) {
    const tag = readVarint(buf, p);
    if (!tag) return null;
    p = tag.pos;
    const wireType = tag.value & 7;
    const fieldNumber = tag.value >>> 3;
    if (wireType === 0) {
      // varint: skip the value
      const v = readVarint(buf, p);
      if (!v) return null;
      p = v.pos;
    } else if (wireType === 2) {
      // LEN: read length, optionally return the slice
      const lenInfo = readVarint(buf, p);
      if (!lenInfo) return null;
      p = lenInfo.pos;
      const len = lenInfo.value;
      if (len < 0 || p + len > buf.length) return null;
      if (fieldNumber === targetField) return buf.subarray(p, p + len);
      p += len;
    } else if (wireType === 1) {
      // 64-bit fixed
      p += 8;
    } else if (wireType === 5) {
      // 32-bit fixed
      p += 4;
    } else {
      // 3 (start group), 4 (end group) — deprecated; bail.
      return null;
    }
  }
  return null;
};

/**
 * Decompresses ZICNOTEDATA.ZDATA and extracts the plaintext body. Returns
 * null if the blob is empty, not gzip, or doesn't match the expected
 * envelope shape — caller should fall back to osa in that case.
 */
export const extractNoteText = (zdata: Uint8Array): string | null => {
  if (!zdata || zdata.length < 2) return null;
  // gzip magic — anything else (e.g. encrypted notes) we don't handle.
  if (zdata[0] !== 0x1f || zdata[1] !== 0x8b) return null;

  // Bun.gunzipSync's overload is picky about ArrayBufferLike vs ArrayBuffer
  // when the input came from `subarray` on a buffer with a wider type.
  // Copying into a fresh Uint8Array is a no-op for tiny note blobs and
  // satisfies the TS overload.
  let decompressed: Uint8Array;
  try {
    decompressed = Bun.gunzipSync(new Uint8Array(zdata));
  } catch {
    return null;
  }

  // Walk: outer.field(2) → body.field(3) → note.field(2).
  const body = findLenField(decompressed, 2);
  if (!body) return null;
  const note = findLenField(body, 3);
  if (!note) return null;
  const text = findLenField(note, 2);
  if (!text) return null;

  return TEXT_DECODER.decode(text);
};

/**
 * Returns the second non-empty line of a note's plaintext, trimmed and
 * truncated to 120 chars — same convention as the osa snippet path.
 * The first line is the title; the second is what shows in the list pane.
 */
export const snippetFromText = (text: string): string => {
  const lines = text.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const trimmed = lines[i]!.replace(/\s+/g, " ").trim();
    if (trimmed) return trimmed.length > 120 ? trimmed.slice(0, 120) : trimmed;
  }
  return "";
};
