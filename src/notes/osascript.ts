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

async function osascript(
  script: string,
  lang: "AppleScript" | "JavaScript" = "JavaScript",
): Promise<string> {
  const args = lang === "JavaScript" ? ["-l", "JavaScript", "-"] : ["-"];
  const proc = Bun.spawn(["osascript", ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(script);
  await proc.stdin.end();
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`osascript failed (exit ${code}): ${err.trim()}`);
  }
  return out;
}

export const osascriptBackend: NotesBackend = {
  async listFolders(): Promise<Folder[]> {
    // Lazy strategy: fetch folders + counts only. No per-note metadata yet.
    // Per folder events: container() (~38ms) + notes.length (~10ms) ≈ 48ms.
    // For 43 folders ≈ 2000ms, vs old listAll ≈ 5400ms.
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
        const accountId = account.id();
        const folders = account.folders();
        const folderIds = account.folders.id();
        const folderNames = account.folders.name();
        for (var j = 0; j < folders.length; j++) {
          const folder = folders[j];
          const fid = folderIds[j];
          let pid = accountId;
          try {
            const cont = folder.container();
            if (cont) pid = cont.id();
          } catch (e) {}
          folderInfo[fid] = {
            name: folderNames[j],
            parentId: pid,
            account: accountName,
            depth: 0,
            path: "",
            noteCount: folder.notes.length,
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
    return dedupeById(JSON.parse(await osascript(script)) as Folder[]);
  },

  async getFolderNotes(folderIds: string[]): Promise<Note[]> {
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
    return dedupeById(JSON.parse(await osascript(script)) as Note[]);
  },

  async getNoteBody(noteId: string): Promise<string> {
    const script = `
      const Notes = Application("Notes");
      const note = Notes.notes.byId(${JSON.stringify(noteId)});
      note.plaintext();
    `;
    return await osascript(script);
  },

  async getFolderSnippets(
    folderIds: string[],
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
