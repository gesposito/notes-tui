/**
 * Tiny insertion-ordered LRU cache backed by a Map. On `get`, hits are
 * re-inserted so they migrate to the "newest" end. On `set` past `cap`,
 * the oldest entry (Map's first key) is evicted.
 *
 * Map's iteration order is insertion order in ES2015+; that's the LRU order.
 */
export class LRU<K, V> {
  private readonly map = new Map<K, V>();
  constructor(private readonly cap: number) {}

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.cap) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
