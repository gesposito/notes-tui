import type { Folder, MoveResult, Note, NotesBackend } from "./types.ts";

// Notes.app can surface the same item under multiple specifiers
// (e.g. smart folders, "Recently Deleted"). Dedupe by id so the UI
// doesn't see duplicate React keys.
const dedupeById = <T extends { id: string }>(items: T[]): T[] => {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
};

const abortError = (): Error => {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
};

async function osascript(
  script: string,
  lang: "AppleScript" | "JavaScript" = "JavaScript",
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw abortError();
  const args = lang === "JavaScript" ? ["-l", "JavaScript", "-"] : ["-"];
  const proc = Bun.spawn(["osascript", ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const onAbort = () => proc.kill();
  signal?.addEventListener("abort", onAbort);
  try {
    proc.stdin.write(script);
    await proc.stdin.end();
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (signal?.aborted) throw abortError();
    if (code !== 0) {
      throw new Error(`osascript failed (exit ${code}): ${err.trim()}`);
    }
    return out;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

export const osascriptBackend: NotesBackend = {
  async listFolders(signal?: AbortSignal): Promise<Folder[]> {
    // Bulk property-chain strategy: one Apple Event per property per account,
    // regardless of folder count. Replaces the old per-folder container() +
    // notes.length loop, which was ~1100 ms for 43 folders. Bulk path is
    // ~150 ms (see scripts/bench-list-folders.js).
    const script = `
      function compute(node, byId, accountSet) {
        if (!node || node._computed) return node;
        var pid = node.parentId;
        if (accountSet.has(pid) || !byId[pid]) {
          node.depth = 0;
          node.path = node.account + " / " + node.name;
        } else {
          var p = compute(byId[pid], byId, accountSet);
          node.depth = p.depth + 1;
          node.path = p.path + " / " + node.name;
        }
        node._computed = true;
        return node;
      }

      const Notes = Application("Notes");
      const accounts = Notes.accounts();
      const accountSet = new Set();
      for (var i = 0; i < accounts.length; i++) {
        accountSet.add(accounts[i].id());
      }

      const folderInfo = {};
      const orderedFolderIds = [];
      for (var i = 0; i < accounts.length; i++) {
        const account = accounts[i];
        const accountName = account.name();
        // Each of these is a single Apple Event that returns an array
        // covering every folder in the account. Property chains
        // (folders.container.id, folders.notes.id) are evaluated by the
        // Notes scripting engine in one shot — the win over the per-folder
        // loop is ~20× for container() and ~3.7× for notes counts.
        const folderIds = account.folders.id();
        const folderNames = account.folders.name();
        const containerIds = account.folders.container.id();
        const noteIdArrays = account.folders.notes.id();
        for (var j = 0; j < folderIds.length; j++) {
          const fid = folderIds[j];
          folderInfo[fid] = {
            name: folderNames[j],
            parentId: containerIds[j],
            account: accountName,
            depth: 0,
            path: "",
            noteCount: noteIdArrays[j].length,
            _computed: false,
          };
          orderedFolderIds.push(fid);
        }
      }

      for (var i = 0; i < orderedFolderIds.length; i++) {
        compute(folderInfo[orderedFolderIds[i]], folderInfo, accountSet);
      }

      const out = [];
      for (var i = 0; i < orderedFolderIds.length; i++) {
        const id = orderedFolderIds[i];
        const n = folderInfo[id];
        out.push({
          id: id,
          name: n.name,
          account: n.account,
          path: n.path,
          depth: n.depth,
          noteCount: n.noteCount,
        });
      }
      out.sort(function (a, b) {
        const ap = a.path.toLowerCase();
        const bp = b.path.toLowerCase();
        return ap < bp ? -1 : ap > bp ? 1 : 0;
      });
      JSON.stringify(out);
    `;
    return dedupeById(
      JSON.parse(await osascript(script, "JavaScript", signal)) as Folder[],
    );
  },

  async getFolderNotes(
    folderIds: string[],
    signal?: AbortSignal,
  ): Promise<Note[]> {
    if (folderIds.length === 0) return [];
    // Per folder: 3 bulk events (id, name, modificationDate).
    const idsJson = JSON.stringify(folderIds);
    const script = `
      const Notes = Application("Notes");
      const folderIds = ${idsJson};
      const out = [];
      for (var f = 0; f < folderIds.length; f++) {
        const fid = folderIds[f];
        try {
          const folder = Notes.folders.byId(fid);
          const ids = folder.notes.id();
          const names = folder.notes.name();
          const dates = folder.notes.modificationDate();
          const count = Math.min(ids.length, names.length);
          for (var k = 0; k < count; k++) {
            const d = dates[k];
            out.push({
              id: ids[k],
              title: names[k],
              folderId: fid,
              modifiedAt: d ? d.toISOString() : null,
            });
          }
        } catch (e) {}
      }
      JSON.stringify(out);
    `;
    return dedupeById(
      JSON.parse(await osascript(script, "JavaScript", signal)) as Note[],
    );
  },

  async getNoteBody(noteId: string, signal?: AbortSignal): Promise<string> {
    const script = `
      const Notes = Application("Notes");
      const note = Notes.notes.byId(${JSON.stringify(noteId)});
      note.plaintext();
    `;
    return await osascript(script, "JavaScript", signal);
  },

  async getNoteHtml(noteId: string, signal?: AbortSignal): Promise<string> {
    const script = `
      const Notes = Application("Notes");
      const note = Notes.notes.byId(${JSON.stringify(noteId)});
      note.body();
    `;
    return await osascript(script, "JavaScript", signal);
  },

  async getFolderSnippets(
    folderIds: string[],
    signal?: AbortSignal,
  ): Promise<Record<string, Record<string, string>>> {
    if (folderIds.length === 0) return {};
    const idsJson = JSON.stringify(folderIds);
    const script = `
      const Notes = Application("Notes");
      const folderIds = ${idsJson};
      const out = {};
      for (let f = 0; f < folderIds.length; f++) {
        const fid = folderIds[f];
        try {
          const folder = Notes.folders.byId(fid);
          const ids = folder.notes.id();
          const plaintexts = folder.notes.plaintext();
          const snippets = {};
          for (let k = 0; k < ids.length; k++) {
            const text = plaintexts[k] || "";
            const lines = text.split("\\n");
            let snippet = "";
            for (let l = 1; l < lines.length; l++) {
              const t = lines[l].replace(/\\s+/g, " ").trim();
              if (t) { snippet = t; break; }
            }
            if (snippet.length > 120) snippet = snippet.substring(0, 120);
            snippets[ids[k]] = snippet;
          }
          out[fid] = snippets;
        } catch (e) {
          out[fid] = {};
        }
      }
      JSON.stringify(out);
    `;
    return JSON.parse(await osascript(script));
  },

  async getFolderBodies(
    folderIds: string[],
    signal?: AbortSignal,
  ): Promise<Record<string, Record<string, string>>> {
    if (folderIds.length === 0) return {};
    // Same shape as getFolderSnippets — one bulk plaintext() call per folder
    // — but we keep the full body so the search index can match anywhere.
    const idsJson = JSON.stringify(folderIds);
    const script = `
      const Notes = Application("Notes");
      const folderIds = ${idsJson};
      const out = {};
      for (let f = 0; f < folderIds.length; f++) {
        const fid = folderIds[f];
        try {
          const folder = Notes.folders.byId(fid);
          const ids = folder.notes.id();
          const plaintexts = folder.notes.plaintext();
          const bodies = {};
          for (let k = 0; k < ids.length; k++) {
            bodies[ids[k]] = plaintexts[k] || "";
          }
          out[fid] = bodies;
        } catch (e) {
          out[fid] = {};
        }
      }
      JSON.stringify(out);
    `;
    return JSON.parse(await osascript(script, "JavaScript", signal));
  },

  async updateNoteBody(noteId: string, body: string): Promise<void> {
    // Wrap each line in <div> so newlines survive; empty lines become <br>.
    // This matches Apple Notes' own paragraph structure when it serializes back.
    const html = body
      .split("\n")
      .map((line) => {
        const escaped = line
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
        return `<div>${escaped || "<br>"}</div>`;
      })
      .join("");
    const script = `
      const Notes = Application("Notes");
      const note = Notes.notes.byId(${JSON.stringify(noteId)});
      note.body = ${JSON.stringify(html)};
    `;
    await osascript(script);
  },

  async createNote(folderId: string): Promise<void> {
    const script = `
      const Notes = Application("Notes");
      const folder = Notes.folders.byId(${JSON.stringify(folderId)});
      Notes.make({ new: "note", at: folder });
    `;
    await osascript(script);
  },

  async createFolder(accountName: string, name: string): Promise<void> {
    const script = `
      const Notes = Application("Notes");
      const accounts = Notes.accounts();
      let account = null;
      for (let i = 0; i < accounts.length; i++) {
        if (accounts[i].name() === ${JSON.stringify(accountName)}) {
          account = accounts[i];
          break;
        }
      }
      if (!account) throw new Error("Account not found: " + ${JSON.stringify(accountName)});
      Notes.make({
        new: "folder",
        at: account,
        withProperties: { name: ${JSON.stringify(name)} },
      });
    `;
    await osascript(script);
  },

  async moveNotes(moves): Promise<MoveResult[]> {
    if (moves.length === 0) return [];
    const movesJson = JSON.stringify(moves);
    const script = `
      const Notes = Application("Notes");
      const moves = ${movesJson};
      const results = [];
      for (let i = 0; i < moves.length; i++) {
        const m = moves[i];
        try {
          const note = Notes.notes.byId(m.noteId);
          const folder = Notes.folders.byId(m.folderId);
          note.move({ to: folder });
          results.push({ noteId: m.noteId, ok: true });
        } catch (e) {
          const msg = e && e.message ? String(e.message) : String(e);
          results.push({ noteId: m.noteId, ok: false, error: msg });
        }
      }
      JSON.stringify(results);
    `;
    return JSON.parse(await osascript(script));
  },
};
