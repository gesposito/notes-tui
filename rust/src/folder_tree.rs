//! Folder hierarchy helpers (port of `src/lib/folder-tree.ts`). The tree is
//! implied by `path` ("Account / Parent / Child"), as produced by every
//! backend's `list_folders`.

use std::collections::{HashMap, HashSet};

use crate::notes::Folder;

pub const PATH_SEP: &str = " / ";

/// Path of the parent folder, if `path` has one.
pub fn parent_path(path: &str) -> Option<&str> {
    path.rfind(PATH_SEP).filter(|&i| i > 0).map(|i| &path[..i])
}

/// The active folder + every descendant, matching Apple Notes' "selecting a
/// parent shows all child notes". Ordered: active first, then descendants in
/// `all` order.
pub fn descendant_ids(active: Option<&Folder>, all: &[Folder]) -> Vec<String> {
    let Some(active) = active else {
        return Vec::new();
    };
    let prefix = format!("{}{PATH_SEP}", active.path);
    let mut seen = HashSet::from([active.id.as_str()]);
    let mut ids = vec![active.id.clone()];
    for f in all {
        if f.path.starts_with(&prefix) && seen.insert(&f.id) {
            ids.push(f.id.clone());
        }
    }
    ids
}

/// Equality on the fields the UI shows: id (present), name + path (renamed /
/// moved), note count (added / removed). Lets refresh skip the expensive
/// cache invalidation when nothing visibly changed. Doesn't catch edits
/// within a folder that leave the count unchanged.
pub fn folders_equal(a: &[Folder], b: &[Folder]) -> bool {
    a.len() == b.len()
        && a.iter().zip(b).all(|(x, y)| {
            x.id == y.id && x.note_count == y.note_count && x.name == y.name && x.path == y.path
        })
}

/// Recursive counts: each folder's own count plus every descendant's.
/// Walks each folder's path prefixes once (O(F × depth)) — the same set as
/// the TypeScript build's O(F²) prefix scan.
pub fn recursive_folder_counts(folders: &[Folder]) -> HashMap<String, u32> {
    let by_path: HashMap<&str, &str> = folders
        .iter()
        .map(|f| (f.path.as_str(), f.id.as_str()))
        .collect();
    let mut out: HashMap<String, u32> = folders
        .iter()
        .map(|f| (f.id.clone(), f.note_count))
        .collect();
    for f in folders {
        for (i, _) in f.path.match_indices(PATH_SEP) {
            if i == 0 {
                continue;
            }
            if let Some(&ancestor) = by_path.get(&f.path[..i])
                && ancestor != f.id
            {
                *out.get_mut(ancestor).expect("every folder has an entry") += f.note_count;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notes::mock::folder;

    fn tree() -> Vec<Folder> {
        vec![
            folder("root", "Notes", "iCloud / Notes", 0, 5),
            folder("work", "Work", "iCloud / Work", 0, 2),
            folder("proj", "Projects", "iCloud / Work / Projects", 1, 3),
            folder("q4", "Q4", "iCloud / Work / Projects / Q4", 2, 7),
            folder("personal", "Personal", "iCloud / Personal", 0, 1),
        ]
    }

    #[test]
    fn descendants_of_nothing_is_empty() {
        assert!(descendant_ids(None, &tree()).is_empty());
    }

    #[test]
    fn leaf_yields_just_itself() {
        let t = tree();
        assert_eq!(descendant_ids(Some(&t[3]), &t), ["q4"]);
    }

    #[test]
    fn includes_nested_descendants_only() {
        let t = tree();
        assert_eq!(descendant_ids(Some(&t[1]), &t), ["work", "proj", "q4"]);
        assert_eq!(descendant_ids(Some(&t[2]), &t), ["proj", "q4"]);
    }

    #[test]
    fn same_prefix_siblings_are_not_descendants() {
        let mut t = tree();
        t.push(folder("work2", "Work2", "iCloud / Work2", 0, 9));
        let ids = descendant_ids(Some(&t[1]), &t);
        assert!(!ids.contains(&"work2".to_owned()));
        assert!(ids.contains(&"proj".to_owned()));
    }

    #[test]
    fn recursive_counts_sum_descendants_only() {
        let counts = recursive_folder_counts(&tree());
        assert_eq!(counts["q4"], 7);
        assert_eq!(counts["personal"], 1);
        assert_eq!(counts["work"], 2 + 3 + 7);
        assert_eq!(counts["proj"], 3 + 7);
        assert_eq!(counts["root"], 5);
    }

    #[test]
    fn parent_path_strips_the_last_segment() {
        assert_eq!(
            parent_path("iCloud / Work / Projects"),
            Some("iCloud / Work")
        );
        assert_eq!(parent_path("iCloud / Work"), Some("iCloud"));
        assert_eq!(parent_path("Work"), None);
    }

    #[test]
    fn folders_equal_compares_visible_fields() {
        let a = tree();
        let mut b = tree();
        assert!(folders_equal(&a, &b));
        b[0].note_count += 1;
        assert!(!folders_equal(&a, &b));
    }
}
