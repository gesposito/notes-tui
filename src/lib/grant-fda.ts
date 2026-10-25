// Full Disk Access helpers: the standalone script (`bun run grant-fda`), the
// `notes grant-fda` CLI subcommand, the TUI's "open Settings + Finder" on a
// missing grant, and making a compiled binary answer for itself so a grant
// on that binary alone works. macOS exposes no API to grant Full Disk
// Access; the best we can do is open the right Settings pane and reveal the
// binaries in Finder, ready to drag in.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { dlopen, FFIType, ptr, read, type Pointer } from "bun:ffi";

const FDA_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";

// Repo root, where `bun run build` / `build:cli` put the compiled binaries.
const REPO_ROOT = join(dirname(new URL(import.meta.url).pathname), "../..");

/**
 * Running via `bun` from source rather than a compiled binary. Then the
 * binary is `bun` itself, and granting it would cover every Bun script, so
 * there's no narrow grant to hand out.
 */
const runningFromSource = (): boolean => basename(process.execPath) === "bun";

// ── Responsibility ─────────────────────────────────────────────────────────
// macOS privacy checks (TCC) apply to the "responsible process". For a
// command started in a terminal that's the terminal app, so a Full Disk
// Access grant on the binary alone would be ignored, and the only grant that
// worked would cover everything run in that terminal. Re-launching with
// responsibility disclaimed makes the binary answer for itself. These are
// private libSystem calls (LLDB and Chromium use them the same way); if a
// future macOS drops them, dlopen throws and we run as is.

/**
 * Makes a compiled binary answer for itself in macOS privacy checks:
 * re-launches it with responsibility disclaimed and exits with the child's
 * status. Returns in the re-launched process (or from source, or when
 * re-launching isn't possible), where the caller carries on as usual.
 */
export const ensureSelfResponsible = (): void => {
  if (runningFromSource()) return;
  let lib;
  try {
    lib = dlopen("/usr/lib/libSystem.B.dylib", {
      getpid: { args: [], returns: FFIType.i32 },
      __error: { args: [], returns: FFIType.ptr },
      responsibility_get_pid_responsible_for_pid: {
        args: [FFIType.i32],
        returns: FFIType.i32,
      },
      responsibility_spawnattrs_setdisclaim: {
        args: [FFIType.ptr, FFIType.i32],
        returns: FFIType.i32,
      },
      posix_spawnattr_init: { args: [FFIType.ptr], returns: FFIType.i32 },
      posix_spawnattr_destroy: { args: [FFIType.ptr], returns: FFIType.i32 },
      posix_spawn: {
        args: [
          FFIType.ptr,
          FFIType.ptr,
          FFIType.ptr,
          FFIType.ptr,
          FFIType.ptr,
          FFIType.ptr,
        ],
        returns: FFIType.i32,
      },
      waitpid: {
        args: [FFIType.i32, FFIType.ptr, FFIType.i32],
        returns: FFIType.i32,
      },
      _NSGetEnviron: { args: [], returns: FFIType.ptr },
      // The handler is a pointer, passed as an integer to hand over SIG_IGN.
      signal: { args: [FFIType.i32, FFIType.u64], returns: FFIType.u64 },
    });
  } catch {
    return;
  }
  const c = lib.symbols;
  const me = c.getpid();
  if (c.responsibility_get_pid_responsible_for_pid(me) === me) return;

  // NUL-terminated strings and a NULL-terminated pointer array for
  // posix_spawn. `keep` holds the buffers so they outlive the call.
  const keep: Buffer[] = [];
  const cstr = (s: string) => {
    const b = Buffer.from(`${s}\0`, "utf8");
    keep.push(b);
    return b;
  };
  // A compiled binary's argv is ["bun", "/$bunfs/root/<name>", ...args].
  const path = cstr(process.execPath);
  const argv = new BigUint64Array([
    ...[process.execPath, ...process.argv.slice(2)].map((s) =>
      BigInt(ptr(cstr(s))),
    ),
    0n,
  ]);
  // The environment as this process got it, before Bun loaded any `.env`.
  const envp = read.ptr(c._NSGetEnviron()!, 0) as Pointer;

  const attr = new BigUint64Array(1);
  if (c.posix_spawnattr_init(ptr(attr)) !== 0) return;
  const pid = new Int32Array(1);
  const spawned =
    c.responsibility_spawnattrs_setdisclaim(ptr(attr), 1) === 0 &&
    c.posix_spawn(ptr(pid), ptr(path), null, ptr(attr), ptr(argv), envp) === 0;
  c.posix_spawnattr_destroy(ptr(attr));
  if (!spawned) return;

  // The child owns the terminal now; like system(), leave ^C and ^\ to it
  // rather than dying underneath it.
  const SIGINT = 2;
  const SIGQUIT = 3;
  const SIG_IGN = 1n;
  c.signal(SIGINT, SIG_IGN);
  c.signal(SIGQUIT, SIG_IGN);
  const EINTR = 4;
  const status = new Int32Array(1);
  while (c.waitpid(pid[0]!, ptr(status), 0) < 0) {
    if (read.i32(c.__error()!, 0) !== EINTR) process.exit(1);
  }
  const s = status[0]!;
  process.exit((s & 0x7f) === 0 ? (s >> 8) & 0xff : 128 + (s & 0x7f));
};

// ── Settings + Finder ──────────────────────────────────────────────────────

/** What `openFdaHelp` opened, for the TUI to describe on screen. */
export type FdaHelp = {
  /** The binary to turn on, e.g. `notes-tui`. */
  app: string;
  /** Its full path, revealed in Finder ("" if there's nothing to reveal). */
  path: string;
  /** Running from source: the compiled binary has to be built and run instead. */
  fromSource: boolean;
};

/**
 * Opens Privacy & Security → Full Disk Access and reveals this binary in
 * Finder, ready to drag into the list. From source, reveals the compiled
 * `notes-tui` if it has been built. Doesn't wait on `open`, so the TUI never
 * blocks on it.
 */
export const openFdaHelp = (): FdaHelp => {
  const fromSource = runningFromSource();
  const compiled = join(REPO_ROOT, "notes-tui");
  const path = fromSource
    ? existsSync(compiled)
      ? compiled
      : ""
    : process.execPath;
  void (async () => {
    await Bun.spawn(["open", FDA_URL]).exited;
    if (path) await Bun.spawn(["open", "-R", path]).exited;
  })();
  return { app: path ? basename(path) : "notes-tui", path, fromSource };
};

export type GrantFdaOptions = {
  /** Absolute path to the compiled `notes` binary. Defaults to this binary
   *  when running compiled, else `./notes` at the repo root. */
  compiledCliPath?: string;
  /** When true, also `open -R` the binaries so Finder reveals them. */
  revealInFinder?: boolean;
};

export const grantFda = (opts: GrantFdaOptions = {}): void => {
  const cli =
    opts.compiledCliPath ??
    (runningFromSource() ? join(REPO_ROOT, "notes") : process.execPath);
  // Each compiled binary needs its own entry: the CLI and its TUI sibling.
  const binaries = [cli, join(dirname(cli), "notes-tui")].filter(existsSync);
  const reveal = opts.revealInFinder ?? true;

  console.log(
    "Opening System Settings → Privacy & Security → Full Disk Access…",
  );
  spawnSync("open", [FDA_URL]);
  if (reveal && binaries.length > 0) {
    console.log("Revealing the notes binaries in Finder…");
    spawnSync("open", ["-R", ...binaries]);
  }

  console.log("");
  if (binaries.length > 0) {
    console.log("Drag these into the list and toggle them ON:");
    console.log("");
    for (const b of binaries) console.log(`    ${b}`);
  } else {
    console.log("Build the binaries first, then add them to the list:");
    console.log("");
    console.log("    bun run build:cli    # → ./notes");
    console.log("    bun run build        # → ./notes-tui");
  }
  console.log("");
  console.log(
    "They answer for themselves in macOS privacy checks whenever they read",
  );
  console.log(
    "Notes' database (the sqlite backend, `notes inspect`), so the grant",
  );
  console.log(
    "applies even when you start them from a terminal, without giving the",
  );
  console.log(
    "terminal (and everything else run in it) Full Disk Access. Running from",
  );
  console.log(
    "source (`bun run cli`) uses the `bun` binary itself, so it can't be",
  );
  console.log("granted narrowly: use the compiled binaries.");
  console.log("");
  console.log(
    "Caveat: every build changes a binary's identity, so macOS treats it as a",
  );
  console.log("new app: re-add it after rebuilding.");
  console.log("");
  console.log("Test after granting:");
  console.log(`  ${existsSync(cli) ? cli : "./notes"} inspect | head -50`);
};
