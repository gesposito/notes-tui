import type { RefObject } from "react";
import type {
  MouseEvent as OpenTUIMouseEvent,
  SelectOption,
  SelectRenderable,
} from "@opentui/core";
import { NOTES_PANE_WIDTH } from "../lib/format.ts";

type Props = {
  options: SelectOption[];
  cursor: number;
  focused: boolean;
  title: string;
  borderColor: string;
  pageStep: number;
  selectRef: RefObject<SelectRenderable | null>;
  // Filter UI
  showFilterInput: boolean;
  filter: string;
  onFilterInput: (value: string) => void;
  onFilterSubmit: () => void;
  // Select handlers
  onChange: (i: number) => void;
  onMouseDown: (e: OpenTUIMouseEvent) => void;
  onMouseScroll: (e: OpenTUIMouseEvent) => void;
  // When the underlying list is capped, how many notes are hidden.
  hiddenCount?: number;
};

export const NotesPane = ({
  options,
  cursor,
  focused,
  title,
  borderColor,
  pageStep,
  selectRef,
  showFilterInput,
  filter,
  onFilterInput,
  onFilterSubmit,
  onChange,
  onMouseDown,
  onMouseScroll,
  hiddenCount = 0,
}: Props) => (
  <box
    width={NOTES_PANE_WIDTH}
    border
    borderColor={borderColor}
    title={title}
    flexDirection="column"
    onMouseScroll={onMouseScroll}
  >
    {showFilterInput && (
      <input
        focused
        placeholder="Search…"
        onInput={onFilterInput}
        onSubmit={onFilterSubmit}
      />
    )}
    {filter && !showFilterInput && (
      <text fg="#777">search: {filter}</text>
    )}
    {options.length === 0 ? (
      <text fg="#777">(no notes)</text>
    ) : (
      <select
        ref={selectRef}
        style={{ flexGrow: 1 }}
        options={options}
        focused={focused}
        selectedIndex={cursor}
        showScrollIndicator
        showDescription
        wrapSelection
        fastScrollStep={pageStep}
        onMouseDown={onMouseDown}
        onChange={onChange}
      />
    )}
    {hiddenCount > 0 && (
      <text fg="#777">
        + {hiddenCount} more — narrow folder or use Search (f)
      </text>
    )}
  </box>
);
