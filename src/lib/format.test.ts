import { describe, expect, test } from "bun:test";
import {
  FOLDER_INNER_WIDTH,
  formatFolderOptionName,
  formatNoteMeta,
} from "./format.ts";

describe("formatFolderOptionName", () => {
  test("returns indented name as-is when count is 0", () => {
    expect(formatFolderOptionName("  ", "Work", 0)).toBe("  Work");
  });

  test("right-aligns count to FOLDER_INNER_WIDTH", () => {
    const out = formatFolderOptionName("", "Work", 12);
    expect(out.length).toBe(FOLDER_INNER_WIDTH);
    expect(out.startsWith("Work")).toBe(true);
    expect(out.endsWith("12")).toBe(true);
  });

  test("preserves min 1-space gap between name and count", () => {
    // Name length + " " + count should fit; if name exactly maxNameLen,
    // padding collapses to 1 space.
    const name = "X".repeat(FOLDER_INNER_WIDTH - 3); // 3 chars for " 12"
    const out = formatFolderOptionName("", name, 12);
    expect(out.length).toBe(FOLDER_INNER_WIDTH);
    expect(out.endsWith(" 12")).toBe(true);
  });

  test("truncates oversize names with ellipsis", () => {
    const longName = "A really really really long folder name";
    const out = formatFolderOptionName("", longName, 7);
    expect(out.length).toBe(FOLDER_INNER_WIDTH);
    expect(out.includes("…")).toBe(true);
    expect(out.endsWith("7")).toBe(true);
  });

  test("indent prefixes name (nested folders)", () => {
    const out = formatFolderOptionName("    ", "Q4", 0);
    expect(out).toBe("    Q4");
  });
});

describe("formatNoteMeta", () => {
  test("date + snippet combined", () => {
    expect(formatNoteMeta("2026-05-02T10:00:00Z", "Hello world")).toBe(
      "2026-05-02  Hello world",
    );
  });

  test("date only when snippet is empty", () => {
    expect(formatNoteMeta("2026-05-02T10:00:00Z", "")).toBe("2026-05-02");
  });

  test("snippet only when date is null", () => {
    expect(formatNoteMeta(null, "Just a snippet")).toBe("Just a snippet");
  });

  test("empty when neither", () => {
    expect(formatNoteMeta(null, "")).toBe("");
  });

  test("date is truncated to YYYY-MM-DD (first 10 chars of ISO)", () => {
    expect(formatNoteMeta("2026-05-02T10:30:00.123Z", "x")).toBe(
      "2026-05-02  x",
    );
  });
});
