//! Persisted preferences (port of `src/lib/settings.ts`). Same file and
//! shape as the Bun build, so both remember the same backend choice.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use crate::notes::BackendChoice;

/// macOS-conventional location; human-editable, wipe with `rm`.
pub fn default_settings_path() -> PathBuf {
    let home = std::env::var_os("HOME").map_or_else(|| PathBuf::from("/"), PathBuf::from);
    home.join("Library/Application Support/notes-tui/config.json")
}

/// Versioned so an incompatible shape can be detected and discarded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub version: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backend_choice: Option<BackendChoice>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: 1,
            backend_choice: None,
        }
    }
}

/// Coerce arbitrary JSON into `Settings`: unknown fields are dropped and
/// invalid values fall back to defaults. Defensive because the file is
/// hand-editable and may carry typos or older shapes.
fn normalize(raw: &Value) -> Settings {
    Settings {
        version: 1,
        backend_choice: raw
            .get("backendChoice")
            .and_then(Value::as_str)
            .and_then(BackendChoice::parse),
    }
}

/// Missing, unreadable, or malformed files degrade to defaults.
pub fn load_settings(path: &Path) -> Settings {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .map_or_else(Settings::default, |raw| normalize(&raw))
}

pub fn save_settings(settings: &Settings, path: &Path) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let json = serde_json::to_string_pretty(settings).expect("settings always serialize");
    std::fs::write(path, json + "\n")
}

/// Initial backend: `NOTES_BACKEND` (one-off testing without touching the
/// file), then the persisted choice, then osa.
pub fn resolve_initial_backend_choice(settings: &Settings, env: Option<&str>) -> BackendChoice {
    env.and_then(BackendChoice::parse)
        .or(settings.backend_choice)
        .unwrap_or(BackendChoice::Osa)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_backend(c: BackendChoice) -> Settings {
        Settings {
            version: 1,
            backend_choice: Some(c),
        }
    }

    #[test]
    fn missing_file_yields_defaults() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            load_settings(&dir.path().join("missing.json")),
            Settings::default()
        );
    }

    #[test]
    fn malformed_or_wrong_shape_yields_defaults() {
        let dir = tempfile::tempdir().unwrap();
        for (name, body) in [
            ("malformed.json", "{not valid json"),
            ("shape.json", "\"a string\""),
        ] {
            let p = dir.path().join(name);
            std::fs::write(&p, body).unwrap();
            assert_eq!(load_settings(&p), Settings::default(), "{name}");
        }
    }

    #[test]
    fn drops_unknown_backend_values_and_keeps_valid_ones() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("s.json");
        std::fs::write(&p, r#"{"version":1,"backendChoice":"bogus"}"#).unwrap();
        assert_eq!(load_settings(&p), Settings::default());
        std::fs::write(&p, r#"{"version":1,"backendChoice":"sqlite","extra":true}"#).unwrap();
        assert_eq!(load_settings(&p), with_backend(BackendChoice::Sqlite));
    }

    #[test]
    fn save_round_trips_and_creates_parent_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("deep/nested/dir/settings.json");
        save_settings(&with_backend(BackendChoice::ScriptingBridge), &p).unwrap();
        assert_eq!(
            load_settings(&p),
            with_backend(BackendChoice::ScriptingBridge)
        );
        // Same bytes the Bun build writes.
        assert_eq!(
            std::fs::read_to_string(&p).unwrap(),
            "{\n  \"version\": 1,\n  \"backendChoice\": \"scripting-bridge\"\n}\n"
        );
    }

    #[test]
    fn resolution_order_is_env_then_settings_then_osa() {
        let s = with_backend(BackendChoice::Sqlite);
        assert_eq!(
            resolve_initial_backend_choice(&s, Some("osa")),
            BackendChoice::Osa
        );
        assert_eq!(
            resolve_initial_backend_choice(&s, Some("garbage")),
            BackendChoice::Sqlite
        );
        assert_eq!(
            resolve_initial_backend_choice(&s, None),
            BackendChoice::Sqlite
        );
        assert_eq!(
            resolve_initial_backend_choice(&Settings::default(), None),
            BackendChoice::Osa
        );
    }
}
