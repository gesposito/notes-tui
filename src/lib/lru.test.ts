import { describe, expect, test } from "bun:test";
import { LRU } from "./lru.ts";

describe("LRU", () => {
  test("get/set basic round-trip", () => {
    const cache = new LRU<string, number>(3);
    cache.set("a", 1);
    expect(cache.get("a")).toBe(1);
    expect(cache.get("missing")).toBeUndefined();
  });

  test("evicts oldest when over cap", () => {
    const cache = new LRU<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
  });

  test("get refreshes recency (LRU order)", () => {
    const cache = new LRU<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a"); // refreshes a — b is now oldest
    cache.set("c", 3);
    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe(3);
  });

  test("set on existing key refreshes recency without growing", () => {
    const cache = new LRU<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("a", 11);
    cache.set("c", 3);
    expect(cache.get("a")).toBe(11);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.size).toBe(2);
  });

  test("clear empties the cache", () => {
    const cache = new LRU<string, number>(5);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("a")).toBeUndefined();
  });

  test("has returns presence without refreshing recency", () => {
    const cache = new LRU<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.has("a"); // should not refresh
    cache.set("c", 3);
    // a should still be evicted (has didn't refresh)
    expect(cache.get("a")).toBeUndefined();
  });
});
