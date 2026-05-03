// Shared FDA-grant helper. Used by both the standalone script
// (`bun run grant-fda`) and the `notes grant-fda` CLI subcommand. macOS
// exposes no API to programmatically grant Full Disk Access — this just
// removes the click-around: opens the right Settings pane and reveals
// the compiled CLI binary in Finder so it's ready to drag in.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const FDA_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";

const which = (cmd: string): string => {
  const r = spawnSync("which", [cmd], { encoding: "utf8" });
  return r.stdout.trim();
};

// Determine the compiled CLI path. When invoked via the compiled binary
// itself, process.execPath IS the binary. When invoked via `bun run`, the
// caller is expected to pass it in (the script computes it from its own
// location; the CLI subcommand resolves project root the same way).
const isCompiledCli = (): boolean => {
  // Bun-compiled single-file executables have process.execPath pointing
  // at our binary, not at `bun`. Easiest reliable check: basename ends
  // with "notes" and isn't "bun".
  const name = process.execPath.split("/").pop() ?? "";
  return name === "notes";
};

export type GrantFdaOptions = {
  /** Absolute path to the compiled `notes` binary. Optional: defaults to
   *  process.execPath when running compiled, otherwise unresolved. */
  compiledCliPath?: string;
  /** When true, also `open -R` the binary so Finder reveals it pre-selected. */
  revealInFinder?: boolean;
};

export const grantFda = (opts: GrantFdaOptions = {}): void => {
  const compiledCliPath =
    opts.compiledCliPath ?? (isCompiledCli() ? process.execPath : undefined);
  const reveal = opts.revealInFinder ?? true;
  const bunPath = which("bun") || "(bun not in PATH)";

  console.log("Opening System Settings → Privacy & Security → Full Disk Access…");
  spawnSync("open", [FDA_URL]);

  if (reveal && compiledCliPath && existsSync(compiledCliPath)) {
    console.log("Revealing the compiled CLI in Finder…");
    spawnSync("open", ["-R", compiledCliPath]);
  }

  console.log("");
  console.log("Drag ONE of these into the list (then toggle ON).");
  console.log("Recommended in practice: your terminal app — see why below.");
  console.log("");
  console.log("  • Your terminal app (recommended):");
  console.log(
    "      e.g. /Applications/Ghostty.app, /Applications/Utilities/Terminal.app,",
  );
  console.log(
    "      /Applications/iTerm.app, /Applications/WezTerm.app — whichever you use.",
  );
  console.log(
    "    Why: macOS attributes file access to the *responsible process* at the",
  );
  console.log(
    "    top of the tree (your terminal), not the immediate child. Granting FDA",
  );
  console.log(
    "    to bun or ./notes alone often DOESN'T work when bun is launched from",
  );
  console.log(
    "    Claude Code, tmux, or other nested shells — TCC defers to the terminal's",
  );
  console.log(
    "    own decision, which is the entry NOT in the list. Granting at the",
  );
  console.log("    terminal level covers the whole tree.");
  console.log("");
  if (compiledCliPath && existsSync(compiledCliPath)) {
    console.log("  • Compiled CLI (narrowest scope):");
    console.log(`      ${compiledCliPath}`);
    console.log(
      "    Caveat: every `bun run build:cli` changes the binary's hash. macOS",
    );
    console.log(
      "    treats it as a new app and the FDA grant doesn't carry over —",
    );
    console.log(
      "    re-toggle (or remove + re-add) after each build. `codesign -s -` makes",
    );
    console.log(
      "    the ad-hoc signature explicit but doesn't stop the hash churn.",
    );
  } else {
    console.log("  • Compiled CLI (narrowest scope):");
    console.log("      Not built yet. First: bun run build:cli");
    if (compiledCliPath) {
      console.log(`      Then drag in: ${compiledCliPath}`);
    }
  }
  console.log("");
  console.log("  • bun binary (works only if the parent already has FDA):");
  console.log(`      ${bunPath}`);
  console.log(
    "    Note: `bun upgrade` (or mise switching versions) replaces this binary,",
  );
  console.log("    so FDA is lost.");
  console.log("");
  console.log("Test after granting:");
  if (compiledCliPath && existsSync(compiledCliPath)) {
    console.log(`  ${compiledCliPath} inspect | head -50`);
  } else {
    console.log("  bun run cli inspect | head -50          # if you granted terminal/bun");
    console.log("  bun run build:cli && ./notes inspect    # if you granted compiled CLI");
  }
  console.log("");
  console.log(
    "Diagnostic if it still fails: from the same shell, run",
  );
  console.log(
    `  head -c 32 "$HOME/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite" | xxd`,
  );
  console.log(
    "  → hex bytes:                  shell has FDA, only bun/CLI is missing it",
  );
  console.log(
    "  → \"Operation not permitted\":  no FDA in this shell tree → grant terminal",
  );
};
