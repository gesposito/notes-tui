//! Tiny LRU cache (port of `src/lib/lru.ts`): insertion-ordered map where
//! hits move to the newest end and inserts past capacity evict the oldest.

use std::hash::Hash;

use indexmap::IndexMap;

pub struct Lru<K, V> {
    cap: usize,
    map: IndexMap<K, V>,
}

impl<K: Hash + Eq, V> Lru<K, V> {
    pub fn new(cap: usize) -> Self {
        Self {
            cap,
            map: IndexMap::new(),
        }
    }

    /// Refreshes recency on a hit.
    pub fn get(&mut self, key: &K) -> Option<&V> {
        let idx = self.map.get_index_of(key)?;
        let last = self.map.len() - 1;
        self.map.move_index(idx, last);
        self.map.get_index(last).map(|(_, v)| v)
    }

    pub fn set(&mut self, key: K, value: V) {
        self.map.shift_remove(&key);
        self.map.insert(key, value);
        if self.map.len() > self.cap {
            self.map.shift_remove_index(0);
        }
    }

    /// Presence check that does *not* refresh recency.
    pub fn has(&self, key: &K) -> bool {
        self.map.contains_key(key)
    }

    pub fn clear(&mut self) {
        self.map.clear();
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips() {
        let mut cache = Lru::new(3);
        cache.set("a", 1);
        assert_eq!(cache.get(&"a"), Some(&1));
        assert_eq!(cache.get(&"missing"), None);
    }

    #[test]
    fn evicts_the_oldest_past_capacity() {
        let mut cache = Lru::new(2);
        cache.set("a", 1);
        cache.set("b", 2);
        cache.set("c", 3);
        assert_eq!(cache.get(&"a"), None);
        assert_eq!(cache.get(&"b"), Some(&2));
        assert_eq!(cache.get(&"c"), Some(&3));
    }

    #[test]
    fn get_refreshes_recency() {
        let mut cache = Lru::new(2);
        cache.set("a", 1);
        cache.set("b", 2);
        cache.get(&"a");
        cache.set("c", 3);
        assert_eq!(cache.get(&"a"), Some(&1));
        assert_eq!(cache.get(&"b"), None);
    }

    #[test]
    fn set_on_an_existing_key_refreshes_without_growing() {
        let mut cache = Lru::new(2);
        cache.set("a", 1);
        cache.set("b", 2);
        cache.set("a", 11);
        cache.set("c", 3);
        assert_eq!(cache.get(&"a"), Some(&11));
        assert_eq!(cache.get(&"b"), None);
        assert_eq!(cache.len(), 2);
    }

    #[test]
    fn clear_empties() {
        let mut cache = Lru::new(5);
        cache.set("a", 1);
        cache.clear();
        assert!(cache.is_empty());
        assert_eq!(cache.get(&"a"), None);
    }

    #[test]
    fn has_does_not_refresh() {
        let mut cache = Lru::new(2);
        cache.set("a", 1);
        cache.set("b", 2);
        assert!(cache.has(&"a"));
        cache.set("c", 3);
        assert_eq!(cache.get(&"a"), None);
    }
}
