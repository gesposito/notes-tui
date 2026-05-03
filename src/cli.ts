#!/usr/bin/env bun
// `notes` — a thin CLI wrapper around the same NotesBackend the TUI uses.
// Lets you script Apple Notes from the shell:
//
//   notes folders | jq '.[] | select(.depth == 0)'
//   notes search "q3 forecast" -f $(notes folders | jq -r '.[0].id')
//   echo "new body" | notes update <noteId>
//
// The backend is selected the same way as the TUI: NOTES_BACKEND=scripting-bridge
// for the Swift helper, anything else (or unset) for osascript.
//
// `buildCli(backend)` is exported so tests can run subcommands programmatically
// against a mock backend via citty's `runCommand`. Module-level `runMain` is
// gated on `import.meta.main` so importing this file doesn't kick off the CLI.
import { defineCommand, runMain } from "citty";
import type { NotesBackend } from "./notes/types.ts";

// ── Output helpers ─────────────────────────────────────────────────────────
const printJson = (value: unknown, raw: boolean): void => {
  process.stdout.write(
    raw ? JSON.stringify(value) : JSON.stringify(value, null, 2),
  );
  process.stdout.write("\n");
};

const readStdin = async (): Promise<string> => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin as unknown as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
};

// Note: variadic positional IDs are read straight off `args._`. Citty maps
// the first positional to the named arg (e.g. `folderId`) for required-
// validation and help, but it leaves *all* positionals in `_` — so reading
// from `_` directly is the simplest way to avoid double-counting.

// Shared flag definitions so aliases stay consistent across subcommands.
// Plain object (not `as const`) — citty's BooleanArgDef wants a mutable
// `alias: string[]` and a non-narrowed `default: boolean`.
const RAW_FLAG = {
  type: "boolean" as const,
  default: false,
  alias: ["r"],
  description: "Compact JSON output (one line, no indentation)",
};

// ── Factory ────────────────────────────────────────────────────────────────
// Each subcommand's `run` returns its data so `runCommand(...)` (the citty
// test helper) can assert on it. Side-effect of writing to stdout is kept
// for normal CLI use; tests can ignore stdout because they read the return.
export const buildCli = (backend: NotesBackend) => {
  const folders = defineCommand({
    meta: {
      name: "folders",
      alias: "ls",
      description: "List every folder (flat, sorted by path)",
    },
    args: { raw: RAW_FLAG },
    async run({ args }) {
      const result = await backend.listFolders();
      printJson(result, args.raw);
      return result;
    },
  });

  const folderNotes = defineCommand({
    meta: {
      name: "folder-notes",
      alias: "fn",
      description: "List notes in one or more folders",
    },
    args: {
      folderId: {
        type: "positional",
        required: true,
        valueHint: "FOLDER_ID",
        description: "Folder ID (pass extra IDs as additional positionals)",
      },
      raw: RAW_FLAG,
    },
    async run({ args }) {
      // args._ contains every positional — citty doesn't strip the named
      // ones, so reading from it directly avoids double-counting `folderId`.
      const ids = (args._ ?? []).map(String);
      const result = await backend.getFolderNotes(ids);
      printJson(result, args.raw);
      return result;
    },
  });

  const folderSnippets = defineCommand({
    meta: {
      name: "folder-snippets",
      description: "Fetch second-line snippets per note for the given folders",
    },
    args: {
      folderId: {
        type: "positional",
        required: true,
        valueHint: "FOLDER_ID",
        description: "Folder ID (pass extra IDs as additional positionals)",
      },
      raw: RAW_FLAG,
    },
    async run({ args }) {
      // args._ contains every positional — citty doesn't strip the named
      // ones, so reading from it directly avoids double-counting `folderId`.
      const ids = (args._ ?? []).map(String);
      const result = await backend.getFolderSnippets(ids);
      printJson(result, args.raw);
      return result;
    },
  });

  const folderBodies = defineCommand({
    meta: {
      name: "folder-bodies",
      description: "Fetch full plaintext bodies per note for the given folders",
    },
    args: {
      folderId: {
        type: "positional",
        required: true,
        valueHint: "FOLDER_ID",
        description: "Folder ID (pass extra IDs as additional positionals)",
      },
      raw: RAW_FLAG,
    },
    async run({ args }) {
      // args._ contains every positional — citty doesn't strip the named
      // ones, so reading from it directly avoids double-counting `folderId`.
      const ids = (args._ ?? []).map(String);
      const result = await backend.getFolderBodies(ids);
      printJson(result, args.raw);
      return result;
    },
  });

  const body = defineCommand({
    meta: {
      name: "body",
      alias: "cat",
      description: "Print a note's plaintext body to stdout",
    },
    args: {
      noteId: {
        type: "positional",
        required: true,
        valueHint: "NOTE_ID",
        description: "Note ID",
      },
    },
    async run({ args }) {
      const result = await backend.getNoteBody(String(args.noteId));
      process.stdout.write(result);
      return result;
    },
  });

  const html = defineCommand({
    meta: { name: "html", description: "Print a note's HTML body to stdout" },
    args: {
      noteId: {
        type: "positional",
        required: true,
        valueHint: "NOTE_ID",
        description: "Note ID",
      },
    },
    async run({ args }) {
      const result = await backend.getNoteHtml(String(args.noteId));
      process.stdout.write(result);
      return result;
    },
  });

  const newNote = defineCommand({
    meta: {
      name: "new-note",
      alias: "nn",
      description: "Create a blank note in the given folder",
    },
    args: {
      folder: {
        type: "string",
        required: true,
        alias: ["f"],
        valueHint: "FOLDER_ID",
        description: "Target folder ID",
      },
    },
    async run({ args }) {
      await backend.createNote(String(args.folder));
    },
  });

  const newFolder = defineCommand({
    meta: {
      name: "new-folder",
      alias: "mkdir",
      description: "Create a top-level folder in the given account",
    },
    args: {
      name: {
        type: "positional",
        required: true,
        valueHint: "FOLDER_NAME",
        description: "New folder name",
      },
      account: {
        type: "string",
        required: true,
        alias: ["a"],
        valueHint: "ACCOUNT",
        description: "Account name (e.g. 'iCloud')",
      },
    },
    async run({ args }) {
      await backend.createFolder(String(args.account), String(args.name));
    },
  });

  const update = defineCommand({
    meta: {
      name: "update",
      description:
        "Replace a note's body with stdin (formatting is lost — see EDITING.md)",
    },
    args: {
      noteId: {
        type: "positional",
        required: true,
        valueHint: "NOTE_ID",
        description: "Note ID",
      },
    },
    async run({ args }) {
      const body = await readStdin();
      await backend.updateNoteBody(String(args.noteId), body);
    },
  });

  const move = defineCommand({
    meta: {
      name: "move",
      alias: "mv",
      description: "Move one or more notes into a destination folder",
    },
    args: {
      noteId: {
        type: "positional",
        required: true,
        valueHint: "NOTE_ID",
        description: "Note ID (pass extra IDs as additional positionals)",
      },
      to: {
        type: "string",
        required: true,
        alias: ["t"],
        valueHint: "FOLDER_ID",
        description: "Destination folder ID",
      },
      raw: RAW_FLAG,
    },
    async run({ args }) {
      const ids = (args._ ?? []).map(String);
      const moves = ids.map((noteId) => ({
        noteId,
        folderId: String(args.to),
      }));
      const result = await backend.moveNotes(moves);
      printJson(result, args.raw);
      return result;
    },
  });

  const search = defineCommand({
    meta: {
      name: "search",
      alias: "find",
      description:
        "Full-text search (title + body). Defaults to all folders; -f narrows.",
    },
    args: {
      query: {
        type: "positional",
        required: true,
        valueHint: "QUERY",
        description: "Substring to match (case-insensitive)",
      },
      folder: {
        type: "string",
        alias: ["f"],
        valueHint: "FOLDER_ID",
        description: "Limit to a single folder (and its subtree if --recursive)",
      },
      recursive: {
        type: "boolean",
        default: false,
        alias: ["R"],
        description: "When --folder is set, also include descendants",
      },
      raw: RAW_FLAG,
    },
    async run({ args }) {
      const all = await backend.listFolders();
      const folderIds: string[] = (() => {
        if (!args.folder) return all.map((f) => f.id);
        const root = all.find((f) => f.id === String(args.folder));
        if (!root) throw new Error(`Folder not found: ${args.folder}`);
        if (!args.recursive) return [root.id];
        const prefix = root.path + " / ";
        return [
          root.id,
          ...all.filter((f) => f.path.startsWith(prefix)).map((f) => f.id),
        ];
      })();
      const [notesArr, bodyMap] = await Promise.all([
        backend.getFolderNotes(folderIds),
        backend.getFolderBodies(folderIds),
      ]);
      const q = String(args.query).toLowerCase();
      const matches = notesArr
        .map((n) => ({ ...n, body: bodyMap[n.folderId]?.[n.id] ?? "" }))
        .filter(
          (n) =>
            n.title.toLowerCase().includes(q) ||
            n.body.toLowerCase().includes(q),
        );
      printJson(matches, args.raw);
      return matches;
    },
  });

  return defineCommand({
    meta: {
      name: "notes",
      version: "0.1.0",
      description:
        "Apple Notes CLI. Backend selected by NOTES_BACKEND (osascript by default).",
    },
    subCommands: {
      folders,
      "folder-notes": folderNotes,
      "folder-snippets": folderSnippets,
      "folder-bodies": folderBodies,
      body,
      html,
      "new-note": newNote,
      "new-folder": newFolder,
      update,
      move,
      search,
    },
  });
};

// ── Entry ──────────────────────────────────────────────────────────────────
if (import.meta.main) {
  const { notes } = await import("./notes/index.ts");
  await runMain(buildCli(notes));
}
