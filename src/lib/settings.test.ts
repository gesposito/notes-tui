import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadSettings,
  resolveInitialBackendChoice,
  saveSettings,
  type Settings,
} from "./settings.ts";

let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "notes-tui-settings-"));
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const path = (name: string) => join(scratch, name);

describe("loadSettings", () => {
  test("returns defaults when file is missing", async () => {
    const s = await loadSettings(path("missing.json"));
    expect(s).toEqual({ version: 1 });
  });

  test("returns defaults when JSON is malformed", async () => {
    const p = path("malformed.json");
    writeFileSync(p, "{not valid json");
    expect(await loadSettings(p)).toEqual({ version: 1 });
  });

  test("returns defaults when file is the wrong shape", async () => {
    const p = path("wrong-shape.json");
    writeFileSync(p, '"a string"');
    expect(await loadSettings(p)).toEqual({ version: 1 });
  });

  test("drops unknown backendChoice values", async () => {
    const p = path("bad-backend.json");
    writeFileSync(p, JSON.stringify({ version: 1, backendChoice: "bogus" }));
    expect(await loadSettings(p)).toEqual({ version: 1 });
  });

  test("accepts valid backendChoice values", async () => {
    const p = path("ok-backend.json");
    writeFileSync(p, JSON.stringify({ version: 1, backendChoice: "sqlite" }));
    expect(await loadSettings(p)).toEqual({
      version: 1,
      backendChoice: "sqlite",
    });
  });
});

describe("saveSettings", () => {
  test("round-trips with loadSettings", async () => {
    const p = path("rt.json");
    const original: Settings = { version: 1, backendChoice: "scripting-bridge" };
    await saveSettings(original, p);
    expect(await loadSettings(p)).toEqual(original);
  });

  test("creates the parent directory if missing", async () => {
    // Write to a nested path that doesn't exist yet — saveSettings should
    // mkdir -p before writing.
    const p = path("deep/nested/dir/settings.json");
    await saveSettings({ version: 1, backendChoice: "osa" }, p);
    expect(await loadSettings(p)).toEqual({
      version: 1,
      backendChoice: "osa",
    });
  });
});

describe("resolveInitialBackendChoice", () => {
  test("env var wins over persisted setting", () => {
    expect(
      resolveInitialBackendChoice({ version: 1, backendChoice: "sqlite" }, "osa"),
    ).toBe("osa");
  });

  test("invalid env var is ignored, persisted wins", () => {
    expect(
      resolveInitialBackendChoice(
        { version: 1, backendChoice: "sqlite" },
        "garbage",
      ),
    ).toBe("sqlite");
  });

  test("persisted value used when env var is unset", () => {
    expect(
      resolveInitialBackendChoice(
        { version: 1, backendChoice: "scripting-bridge" },
        undefined,
      ),
    ).toBe("scripting-bridge");
  });

  test("falls back to osa when neither is set", () => {
    expect(resolveInitialBackendChoice({ version: 1 }, undefined)).toBe("osa");
  });
});
