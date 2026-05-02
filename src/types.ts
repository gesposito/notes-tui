export type Pane = "folders" | "notes";

export type Mode =
  | { kind: "browse" }
  | { kind: "filter" }
  | { kind: "moveTarget"; sourceAccount: string; sourceCount: number };
