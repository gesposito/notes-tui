export type Pane = "folders" | "notes";

export type Mode =
  | { kind: "browse" }
  | { kind: "filter" }
  | { kind: "newFolder" }
  | { kind: "edit"; noteId: string }
  | { kind: "moveTarget"; sourceAccount: string; sourceCount: number }
  | { kind: "backendPicker" };
