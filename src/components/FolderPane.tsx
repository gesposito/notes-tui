import type { RefObject } from "react";
import type {
  MouseEvent as OpenTUIMouseEvent,
  SelectOption,
  SelectRenderable,
} from "@opentui/core";
import { FOLDER_PANE_WIDTH } from "../lib/format.ts";

type Props = {
  options: SelectOption[];
  cursor: number;
  focused: boolean;
  title: string;
  borderColor: string;
  pageStep: number;
  selectRef: RefObject<SelectRenderable | null>;
  onChange: (i: number) => void;
  onSelect: (i: number) => void;
  onMouseDown: (e: OpenTUIMouseEvent) => void;
  onMouseScroll: (e: OpenTUIMouseEvent) => void;
};

export const FolderPane = ({
  options,
  cursor,
  focused,
  title,
  borderColor,
  pageStep,
  selectRef,
  onChange,
  onSelect,
  onMouseDown,
  onMouseScroll,
}: Props) => (
  <box
    width={FOLDER_PANE_WIDTH}
    border
    borderColor={borderColor}
    title={title}
    onMouseScroll={onMouseScroll}
  >
    <select
      ref={selectRef}
      style={{ flexGrow: 1 }}
      options={options}
      focused={focused}
      selectedIndex={cursor}
      showScrollIndicator
      showDescription={false}
      wrapSelection
      fastScrollStep={pageStep}
      onMouseDown={onMouseDown}
      onChange={onChange}
      onSelect={onSelect}
    />
  </box>
);
