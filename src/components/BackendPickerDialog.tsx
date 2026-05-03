import type { SelectOption } from "@opentui/core";
import {
  BACKEND_LABELS,
  type BackendChoice,
} from "../notes/index.ts";

type Props = {
  current: BackendChoice;
  onSelect: (choice: BackendChoice) => void;
};

const ORDER: BackendChoice[] = ["osa", "scripting-bridge", "sqlite"];

/**
 * Centered picker showing the three NotesBackend implementations. Enter
 * commits the highlighted row; Esc dismisses (handled by
 * useAppKeybindings via mode === "backendPicker"). The current backend is
 * the initial selection so accidentally pressing Enter is a no-op.
 */
export const BackendPickerDialog = ({ current, onSelect }: Props) => {
  const options: SelectOption[] = ORDER.map((c) => ({
    name: c === current ? `● ${BACKEND_LABELS[c]}` : `  ${BACKEND_LABELS[c]}`,
    description: "",
    value: c,
  }));
  const initialIndex = Math.max(0, ORDER.indexOf(current));
  return (
    <box
      position="absolute"
      top="30%"
      left="20%"
      right="20%"
      height={11}
      border
      borderColor="#33ccff"
      title="Switch Backend"
      backgroundColor="#0d1117"
      zIndex={100}
      flexDirection="column"
      paddingX={2}
      paddingY={1}
    >
      <select
        focused
        style={{ flexGrow: 1 }}
        options={options}
        selectedIndex={initialIndex}
        showScrollIndicator={false}
        showDescription={false}
        wrapSelection
        onSelect={(i) => {
          const next = ORDER[i];
          if (next) onSelect(next);
        }}
      />
      <text fg="#666">Enter: switch · Esc: cancel</text>
    </box>
  );
};
