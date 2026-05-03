import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { BackendChoice } from "../notes/index.ts";

// macOS-conventional location for app preferences. Persisted across runs;
// users can edit by hand or wipe with `rm`.
export const DEFAULT_SETTINGS_PATH = join(
  homedir(),
  "Library",
  "Application Support",
  "notes-tui",
  "config.json",
);

// Versioned shape so we can migrate (or detect-and-discard) old configs
// without crashing. Bump `version` when the shape changes incompatibly.
export type Settings = {
  version: 1;
  backendChoice?: BackendChoice;
};

const DEFAULTS: Settings = { version: 1 };

const VALID_BACKEND_CHOICES: ReadonlyArray<BackendChoice> = [
  "osa",
  "scripting-bridge",
  "sqlite",
];

const isBackendChoice = (v: unknown): v is BackendChoice =>
  typeof v === "string" &&
  (VALID_BACKEND_CHOICES as readonly string[]).includes(v);

/**
 * Coerce arbitrary parsed JSON into a Settings object. Unknown fields are
 * dropped; invalid values for known fields fall back to defaults.
 * Defensive because the file is human-editable and could carry typos or
 * stale shapes from older app versions.
 */
const normalize = (raw: unknown): Settings => {
  if (!raw || typeof raw !== "object") return DEFAULTS;
  const obj = raw as Record<string, unknown>;
  const out: Settings = { version: 1 };
  if (isBackendChoice(obj.backendChoice)) out.backendChoice = obj.backendChoice;
  return out;
};

export const loadSettings = async (
  path: string = DEFAULT_SETTINGS_PATH,
): Promise<Settings> => {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return DEFAULTS;
    return normalize(await file.json());
  } catch {
    // Malformed JSON, encoding error, etc. — degrade to defaults.
    return DEFAULTS;
  }
};

export const saveSettings = async (
  settings: Settings,
  path: string = DEFAULT_SETTINGS_PATH,
): Promise<void> => {
  // Bun.write doesn't auto-create parent directories.
  mkdirSync(dirname(path), { recursive: true });
  await Bun.write(path, JSON.stringify(settings, null, 2) + "\n");
};

/**
 * Pick the initial backend choice with this priority:
 *   1. `NOTES_BACKEND` env var — for one-off testing without modifying
 *      persisted state.
 *   2. Persisted setting from the user's last in-app switch.
 *   3. Hard default (osa).
 */
export const resolveInitialBackendChoice = (
  settings: Settings,
  env: string | undefined = Bun.env.NOTES_BACKEND,
): BackendChoice => {
  if (isBackendChoice(env)) return env;
  return settings.backendChoice ?? "osa";
};
