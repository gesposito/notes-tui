import type { Folder, MoveResult, Note, NotesBackend } from "./types.ts";
import { osascriptBackend } from "./osascript.ts";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

type Helper = {
  stdin: Bun.FileSink;
  stdout: ReadableStream<Uint8Array>;
};

const HELPER_PATH = new URL("../../helper/notes-bridge", import.meta.url)
  .pathname;

class ScriptingBridgeBackend implements NotesBackend {
  private proc: Helper | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer = "";
  private starting: Promise<void> | null = null;

  private async ensureProc(): Promise<void> {
    if (this.proc) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const proc = Bun.spawn([HELPER_PATH], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "inherit",
      });
      const helper: Helper = {
        stdin: proc.stdin as Bun.FileSink,
        stdout: proc.stdout as ReadableStream<Uint8Array>,
      };
      this.proc = helper;
      void this.readLoop(helper);
    })();
    await this.starting;
    this.starting = null;
  }

  private async readLoop(proc: Helper): Promise<void> {
    const decoder = new TextDecoder();
    const reader = proc.stdout.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      this.buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.substring(0, idx);
        this.buffer = this.buffer.substring(idx + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as {
            id?: number;
            result?: unknown;
            error?: string;
          };
          if (typeof msg.id !== "number") continue;
          const handler = this.pending.get(msg.id);
          if (!handler) continue;
          this.pending.delete(msg.id);
          if (msg.error) handler.reject(new Error(msg.error));
          else handler.resolve(msg.result);
        } catch {
          // Skip malformed line.
        }
      }
    }
    // Helper exited; reject any in-flight requests.
    for (const handler of this.pending.values()) {
      handler.reject(new Error("notes-bridge helper exited"));
    }
    this.pending.clear();
    this.proc = null;
  }

  private async call<T>(method: string, params?: unknown): Promise<T> {
    await this.ensureProc();
    const proc = this.proc;
    if (!proc) throw new Error("notes-bridge helper not running");
    const id = this.nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      });
    });
    proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    proc.stdin.flush();
    return promise;
  }

  listFolders(): Promise<Folder[]> {
    return this.call("listFolders");
  }

  getFolderNotes(folderIds: string[]): Promise<Note[]> {
    if (folderIds.length === 0) return Promise.resolve([]);
    return this.call("getFolderNotes", { folderIds });
  }

  async getFolderSnippets(
    folderIds: string[],
  ): Promise<Record<string, Record<string, string>>> {
    // Helper still takes a single folder per call; SB has no spawn cost so
    // we just fan out in parallel and assemble the same shape osa returns.
    const results = await Promise.all(
      folderIds.map((id) =>
        this.call<Record<string, string>>("getFolderSnippets", {
          folderId: id,
        }),
      ),
    );
    const out: Record<string, Record<string, string>> = {};
    for (let i = 0; i < folderIds.length; i++) {
      out[folderIds[i]!] = results[i]!;
    }
    return out;
  }

  getNoteBody(noteId: string): Promise<string> {
    return this.call("getNoteBody", { noteId });
  }

  getNoteHtml(noteId: string): Promise<string> {
    return this.call("getNoteHtml", { noteId });
  }

  moveNotes(
    moves: Array<{ noteId: string; folderId: string }>,
  ): Promise<MoveResult[]> {
    return this.call("moveNotes", { moves });
  }

  // Creation operations are rare and the helper doesn't implement Apple
  // Events for `make`. Defer to osa — one extra spawn on the rare write
  // path is fine.
  createNote(folderId: string): Promise<void> {
    return osascriptBackend.createNote(folderId);
  }

  createFolder(accountName: string, name: string): Promise<void> {
    return osascriptBackend.createFolder(accountName, name);
  }

  updateNoteBody(noteId: string, body: string): Promise<void> {
    return osascriptBackend.updateNoteBody(noteId, body);
  }
}

export const scriptingBridgeBackend: NotesBackend = new ScriptingBridgeBackend();
