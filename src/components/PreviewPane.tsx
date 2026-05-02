import type { RefObject } from "react";
import type { TextareaRenderable } from "@opentui/core";

type Props = {
  title: string;
  body: string;
  loading: boolean;
  hasSelection: boolean;
  // Edit mode (optional). When `editing` is true, the pane shows a focused
  // textarea instead of the read-only scrollbox. App reads the current
  // edited content on save via `textareaRef.current.plainText`.
  editing?: boolean;
  initialEditValue?: string;
  textareaRef?: RefObject<TextareaRenderable | null>;
  // Set to true when the watcher detects an external change while the
  // user is mid-edit. Renders a persistent warning banner so they know
  // their save will overwrite.
  externalChangePending?: boolean;
};

export const PreviewPane = ({
  title,
  body,
  loading,
  hasSelection,
  editing,
  initialEditValue,
  textareaRef,
  externalChangePending,
}: Props) => (
  <box
    flexGrow={1}
    border
    borderColor={
      editing && externalChangePending
        ? "#ff6644"
        : editing
          ? "#e6c200"
          : "#555"
    }
    title={editing ? `${title}  [editing — Ctrl+S save · Esc cancel]` : title}
    flexDirection="column"
  >
    {editing && externalChangePending && (
      <text fg="#ff6644">
        ⚠ External changes detected — Ctrl+S will overwrite them
      </text>
    )}
    {editing ? (
      <textarea
        ref={textareaRef}
        style={{ flexGrow: 1 }}
        focused
        initialValue={initialEditValue ?? ""}
      />
    ) : (
      <scrollbox style={{ flexGrow: 1 }}>
        {loading && !body && <text fg="#777">Loading preview…</text>}
        {!hasSelection && <text fg="#777">(no note selected)</text>}
        {body && <text>{body}</text>}
      </scrollbox>
    )}
  </box>
);
