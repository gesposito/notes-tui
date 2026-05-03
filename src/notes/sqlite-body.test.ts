import { describe, expect, test } from "bun:test";
import { extractNoteText, snippetFromText } from "./sqlite-body.ts";

// Build a minimal Apple-Notes-shaped protobuf and gzip it. Mirrors what
// ZICNOTEDATA.ZDATA actually contains:
//   outer { 1: varint, 2: LEN [ 1: varint, 2: varint, 3: LEN [ 2: LEN=text ] ] }
const buildZdata = (text: string): Uint8Array => {
  const utf = new TextEncoder().encode(text);

  // Encode a length-delimited field (wire type 2) header for fieldNumber.
  const lenField = (fieldNumber: number, payload: Uint8Array): Uint8Array => {
    const tag = (fieldNumber << 3) | 2;
    const lenBytes: number[] = [];
    let n = payload.length;
    while (n > 0x7f) {
      lenBytes.push((n & 0x7f) | 0x80);
      n >>>= 7;
    }
    lenBytes.push(n);
    return Uint8Array.from([tag, ...lenBytes, ...payload]);
  };

  // varint field with value 0: tag = (fn << 3) | 0, then value byte 0
  const varintZero = (fn: number): Uint8Array =>
    Uint8Array.from([(fn << 3) | 0, 0]);

  const note = lenField(2, utf); // Note { 2: text }
  const body = new Uint8Array([
    ...varintZero(1),
    ...varintZero(2),
    ...lenField(3, note), // body { 1, 2, 3: note }
  ]);
  const outer = new Uint8Array([
    ...varintZero(1),
    ...lenField(2, body), // outer { 1, 2: body }
  ]);
  return Bun.gzipSync(outer);
};

describe("extractNoteText", () => {
  test("decodes a simple plaintext note", () => {
    const zdata = buildZdata("Hello world");
    expect(extractNoteText(zdata)).toBe("Hello world");
  });

  test("decodes multi-line text including the title line", () => {
    const text = "Trip\nLunch\n\nReceipt\n\nForm";
    expect(extractNoteText(buildZdata(text))).toBe(text);
  });

  test("preserves U+FFFC attachment markers", () => {
    const text = "Title\nText with ￼ attachment";
    expect(extractNoteText(buildZdata(text))).toBe(text);
  });

  test("returns null on empty / too-small input", () => {
    expect(extractNoteText(new Uint8Array(0))).toBeNull();
    expect(extractNoteText(new Uint8Array([0x1f]))).toBeNull();
  });

  test("returns null on non-gzip input (e.g. encrypted blob)", () => {
    // Random non-gzip bytes — caller should fall back to osa.
    expect(extractNoteText(new Uint8Array([0x00, 0x01, 0x02, 0x03]))).toBeNull();
  });

  test("returns null on gzipped bytes that don't match the expected envelope", () => {
    // Valid gzip of just "garbage" — no protobuf structure inside.
    const zdata = Bun.gzipSync(new TextEncoder().encode("garbage"));
    expect(extractNoteText(zdata)).toBeNull();
  });

  test("decodes longer payloads (varint length spans 2+ bytes)", () => {
    // 200-char text forces the inner length varint to use 2 bytes (>127).
    const text = "A".repeat(200);
    expect(extractNoteText(buildZdata(text))).toBe(text);
  });
});

describe("snippetFromText", () => {
  test("returns the second non-empty line", () => {
    expect(snippetFromText("Title\nFirst body line\nSecond body line")).toBe(
      "First body line",
    );
  });

  test("skips blank lines after the title", () => {
    expect(snippetFromText("Title\n\n\n  \nReal content here")).toBe(
      "Real content here",
    );
  });

  test("collapses internal whitespace", () => {
    expect(snippetFromText("Title\n  multi   spaces\there")).toBe(
      "multi spaces here",
    );
  });

  test("truncates to 120 characters", () => {
    const long = "T\n" + "x".repeat(200);
    expect(snippetFromText(long).length).toBe(120);
  });

  test("returns empty string when no second line exists", () => {
    expect(snippetFromText("Title only")).toBe("");
    expect(snippetFromText("")).toBe("");
  });
});
