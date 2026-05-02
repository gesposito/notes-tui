import { describe, expect, test } from "bun:test";
import {
  cycleSort,
  SORT_CYCLE,
  sortNotes,
  type SortMode,
} from "./sort.ts";
import type { Note } from "../notes/types.ts";

const note = (
  id: string,
  title: string,
  modifiedAt: string | null,
): Note => ({
  id,
  title,
  folderId: "f1",
  modifiedAt,
});

describe("sortNotes", () => {
  test("dateDesc: newest first", () => {
    const out = sortNotes(
      [
        note("a", "A", "2026-05-01T00:00:00Z"),
        note("b", "B", "2026-05-03T00:00:00Z"),
        note("c", "C", "2026-05-02T00:00:00Z"),
      ],
      "dateDesc",
    );
    expect(out.map((n) => n.id)).toEqual(["b", "c", "a"]);
  });

  test("dateAsc: oldest first", () => {
    const out = sortNotes(
      [
        note("a", "A", "2026-05-01T00:00:00Z"),
        note("b", "B", "2026-05-03T00:00:00Z"),
        note("c", "C", "2026-05-02T00:00:00Z"),
      ],
      "dateAsc",
    );
    expect(out.map((n) => n.id)).toEqual(["a", "c", "b"]);
  });

  test("titleAsc: alphabetical, case-insensitive", () => {
    const out = sortNotes(
      [
        note("1", "banana", "2026-05-01T00:00:00Z"),
        note("2", "Apple", "2026-05-01T00:00:00Z"),
        note("3", "cherry", "2026-05-01T00:00:00Z"),
      ],
      "titleAsc",
    );
    expect(out.map((n) => n.title)).toEqual(["Apple", "banana", "cherry"]);
  });

  test("does not mutate the input array", () => {
    const input = [
      note("a", "A", "2026-05-01T00:00:00Z"),
      note("b", "B", "2026-05-02T00:00:00Z"),
    ];
    const snapshot = input.slice();
    sortNotes(input, "dateDesc");
    expect(input).toEqual(snapshot);
  });

  test("null modifiedAt sorts last in dateDesc, first in dateAsc", () => {
    const desc = sortNotes(
      [
        note("a", "A", null),
        note("b", "B", "2026-05-01T00:00:00Z"),
      ],
      "dateDesc",
    );
    expect(desc.map((n) => n.id)).toEqual(["b", "a"]);

    const asc = sortNotes(
      [
        note("a", "A", null),
        note("b", "B", "2026-05-01T00:00:00Z"),
      ],
      "dateAsc",
    );
    expect(asc.map((n) => n.id)).toEqual(["a", "b"]);
  });
});

describe("cycleSort", () => {
  test("walks the full cycle and wraps around", () => {
    const seen: SortMode[] = [];
    let mode: SortMode = SORT_CYCLE[0]!;
    for (let i = 0; i < SORT_CYCLE.length + 1; i++) {
      seen.push(mode);
      mode = cycleSort(mode);
    }
    expect(seen).toEqual([...SORT_CYCLE, SORT_CYCLE[0]!]);
  });
});
