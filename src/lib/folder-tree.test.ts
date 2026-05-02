import { describe, expect, test } from "bun:test";
import {
  descendantIdSet,
  recursiveFolderCounts,
} from "./folder-tree.ts";
import type { Folder } from "../notes/types.ts";

const folder = (
  id: string,
  name: string,
  path: string,
  depth: number,
  noteCount = 0,
): Folder => ({
  id,
  name,
  account: "iCloud",
  path,
  depth,
  noteCount,
});

const tree: Folder[] = [
  folder("root", "Notes", "iCloud / Notes", 0, 5),
  folder("work", "Work", "iCloud / Work", 0, 2),
  folder("proj", "Projects", "iCloud / Work / Projects", 1, 3),
  folder("q4", "Q4", "iCloud / Work / Projects / Q4", 2, 7),
  folder("personal", "Personal", "iCloud / Personal", 0, 1),
];

describe("descendantIdSet", () => {
  test("returns empty set when no active folder", () => {
    expect(descendantIdSet(undefined, tree).size).toBe(0);
  });

  test("leaf folder yields just itself", () => {
    const ids = descendantIdSet(tree[3], tree); // "q4"
    expect([...ids]).toEqual(["q4"]);
  });

  test("includes nested descendants only (not siblings or unrelated)", () => {
    const ids = descendantIdSet(tree[1], tree); // "work"
    expect(ids).toEqual(new Set(["work", "proj", "q4"]));
  });

  test("deeply nested middle folder includes downstream descendants only", () => {
    const ids = descendantIdSet(tree[2], tree); // "proj"
    expect(ids).toEqual(new Set(["proj", "q4"]));
  });

  test("path-prefix matching does not include same-prefix siblings", () => {
    // Folder named "Work2" would have path "iCloud / Work2" — must not
    // get pulled in by "iCloud / Work" prefix matching.
    const treePlus = [
      ...tree,
      folder("work2", "Work2", "iCloud / Work2", 0, 9),
    ];
    const ids = descendantIdSet(tree[1], treePlus); // "work"
    expect(ids.has("work2")).toBe(false);
    expect(ids.has("work")).toBe(true);
    expect(ids.has("proj")).toBe(true);
  });
});

describe("recursiveFolderCounts", () => {
  test("leaf folder count equals its own noteCount", () => {
    const counts = recursiveFolderCounts(tree);
    expect(counts.q4).toBe(7);
    expect(counts.personal).toBe(1);
  });

  test("parent total equals own + sum of all descendants", () => {
    const counts = recursiveFolderCounts(tree);
    // work (2) + proj (3) + q4 (7) = 12
    expect(counts.work).toBe(12);
    // proj (3) + q4 (7) = 10
    expect(counts.proj).toBe(10);
  });

  test("siblings are not included in parent's count", () => {
    const counts = recursiveFolderCounts(tree);
    // root and work are siblings; root.count must not include work's tree
    expect(counts.root).toBe(5);
  });
});
