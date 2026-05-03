#!/usr/bin/env bun
// Opens System Settings → Privacy & Security → Full Disk Access and prints
// the exact paths to drag into the list. Useful before testing the SQLite
// backend (NOTES_BACKEND=sqlite) or the `notes inspect` subcommand.
//
//   bun run grant-fda
//
// Same logic is also exposed as `notes grant-fda` once you've built the CLI.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { grantFda } from "../src/lib/grant-fda.ts";

// Resolve project root from this script's location: scripts/ → up 1.
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
grantFda({ compiledCliPath: join(projectRoot, "notes") });
