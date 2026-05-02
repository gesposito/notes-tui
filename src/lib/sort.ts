import type { Note } from "../notes/types.ts";

export type SortMode = "dateDesc" | "dateAsc" | "titleAsc";

export const SORT_CYCLE: readonly SortMode[] = [
  "dateDesc",
  "dateAsc",
  "titleAsc",
] as const;

export const SORT_LABEL: Record<SortMode, string> = {
  dateDesc: "Date ↓",
  dateAsc: "Date ↑",
  titleAsc: "Title",
};

// Plain `<` / `>` on lowercased strings is ~10× faster than localeCompare
// for large lists. Trade-off: no Unicode-aware ordering, which is fine for
// terminal-only sort and matches Apple's case-insensitive default.
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const sortNotes = (notes: Note[], mode: SortMode): Note[] => {
  const out = notes.slice();
  if (mode === "dateDesc") {
    out.sort((a, b) => cmp(b.modifiedAt ?? "", a.modifiedAt ?? ""));
  } else if (mode === "dateAsc") {
    out.sort((a, b) => cmp(a.modifiedAt ?? "", b.modifiedAt ?? ""));
  } else {
    out.sort((a, b) =>
      cmp((a.title || "").toLowerCase(), (b.title || "").toLowerCase()),
    );
  }
  return out;
};

export const cycleSort = (mode: SortMode): SortMode => {
  const i = SORT_CYCLE.indexOf(mode);
  return SORT_CYCLE[(i + 1) % SORT_CYCLE.length]!;
};
