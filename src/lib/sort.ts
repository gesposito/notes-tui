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

export const sortNotes = (notes: Note[], mode: SortMode): Note[] => {
  const out = notes.slice();
  if (mode === "dateDesc") {
    out.sort((a, b) =>
      (b.modifiedAt ?? "").localeCompare(a.modifiedAt ?? ""),
    );
  } else if (mode === "dateAsc") {
    out.sort((a, b) =>
      (a.modifiedAt ?? "").localeCompare(b.modifiedAt ?? ""),
    );
  } else {
    out.sort((a, b) =>
      (a.title || "")
        .toLowerCase()
        .localeCompare((b.title || "").toLowerCase()),
    );
  }
  return out;
};

export const cycleSort = (mode: SortMode): SortMode => {
  const i = SORT_CYCLE.indexOf(mode);
  return SORT_CYCLE[(i + 1) % SORT_CYCLE.length]!;
};
