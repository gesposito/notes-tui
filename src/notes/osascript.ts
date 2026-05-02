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
    // account.folders returns every folder in the account flat (regardless of
    // nesting). Hierarchy is reconstructed via folder.container (the parent
    // folder or account). Depth is the length of the container chain.
    const script = `
      function compute(id, byId, accountId, accountName) {
        const node = byId[id];
        if (!node) return null;
        if (node._computed) return node;
        const parentId = node.parentId;
        if (!parentId || parentId === accountId || !byId[parentId]) {
          node.depth = 0;
          node.path = accountName + " / " + node.name;
        } else {
          const p = compute(parentId, byId, accountId, accountName);
          node.depth = (p ? p.depth : 0) + 1;
          node.path = (p ? p.path : accountName) + " / " + node.name;
        }
        node._computed = true;
        return node;
      }
      const Notes = Application("Notes");
      const out = [];
      const accounts = Notes.accounts();
      for (let i = 0; i < accounts.length; i++) {
        const account = accounts[i];
        const accountName = account.name();
        const accountId = account.id();
        const folders = account.folders();
        const ids = account.folders.id();
        const names = account.folders.name();
        const byId = {};
        for (let j = 0; j < folders.length; j++) {
          let parentId = accountId;
          try {
            const cont = folders[j].container();
            if (cont) parentId = cont.id();
          } catch (e) {}
          byId[ids[j]] = {
            name: names[j],
            parentId: parentId,
            depth: 0,
            path: "",
            _computed: false,
          };
        }
        for (let j = 0; j < ids.length; j++) {
          compute(ids[j], byId, accountId, accountName);
        }
        for (let j = 0; j < ids.length; j++) {
          const node = byId[ids[j]];
          out.push({
            id: ids[j],
            name: node.name,
            account: accountName,
            path: node.path,
            depth: node.depth,
          });
        }
      }
      // Sort by path so parents render before children.
      out.sort(function (a, b) {
        const ap = a.path.toLowerCase();
        const bp = b.path.toLowerCase();
        return ap < bp ? -1 : ap > bp ? 1 : 0;
      });
      JSON.stringify(out);
    `;
    return dedupeById(JSON.parse(await osascript(script)) as Folder[]);
  },

  async listNotes(): Promise<Note[]> {
    // Cheap fields only: id, title, modificationDate. plaintext bulk-fetch is
    // deferred to getFolderSnippets so startup stays fast.
    const script = `
      const Notes = Application("Notes");
      const out = [];
      const accounts = Notes.accounts();
      for (let i = 0; i < accounts.length; i++) {
        const account = accounts[i];
        const accountName = account.name();
        const folders = account.folders();
        const folderIds = account.folders.id();
        const folderNames = account.folders.name();
        for (let j = 0; j < folders.length; j++) {
          const folder = folders[j];
          const folderId = folderIds[j];
          const folderName = folderNames[j];
          const folderPath = accountName + " / " + folderName;
          const noteIds = folder.notes.id();
          const noteNames = folder.notes.name();
          const noteDates = folder.notes.modificationDate();
          for (let k = 0; k < noteIds.length; k++) {
            const d = noteDates[k];
            out.push({
              id: noteIds[k],
              title: noteNames[k],
              folderId: folderId,
              folderPath: folderPath,
              account: accountName,
              modifiedAt: d ? d.toISOString() : null,
            });
          }
        }
      }
      JSON.stringify(out);
    `;
    return dedupeById(JSON.parse(await osascript(script)) as Note[]);
  },

  async getFolderSnippets(folderId: string): Promise<Record<string, string>> {
    // One Apple Event pulls every plaintext in this folder. Snippets are
    // computed server-side so the JSON we return is small.
    const script = `
      const Notes = Application("Notes");
      const folder = Notes.folders.byId(${JSON.stringify(folderId)});
      const ids = folder.notes.id();
      const plaintexts = folder.notes.plaintext();
      const out = {};
      for (let k = 0; k < ids.length; k++) {
        const text = plaintexts[k] || "";
        const lines = text.split("\\n");
        let snippet = "";
        for (let l = 1; l < lines.length; l++) {
          const t = lines[l].replace(/\\s+/g, " ").trim();
          if (t) { snippet = t; break; }
        }
        if (snippet.length > 120) snippet = snippet.substring(0, 120);
        out[ids[k]] = snippet;
      }
      JSON.stringify(out);
    `;
    return JSON.parse(await osascript(script));
  },

  async getNoteBody(noteId: string): Promise<string> {
    // plaintext is the note's body without HTML markup; ideal for terminal
    // display. Read-only — Apple's AppleScript dictionary only allows writes
    // through the HTML `body` property.
    const script = `
      const Notes = Application("Notes");
      const note = Notes.notes.byId(${JSON.stringify(noteId)});
      note.plaintext();
    `;
    return await osascript(script);
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
