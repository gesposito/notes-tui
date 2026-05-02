type Props = {
  initialValue: string;
  onInput: (value: string) => void;
  onSubmit: () => void;
};

/**
 * Centered modal for naming a new folder. The <input> is focused and
 * pre-filled with `initialValue`; Enter commits via onSubmit, Esc cancels
 * (handled in useAppKeybindings since it sees mode === "newFolder").
 */
export const NewFolderDialog = ({
  initialValue,
  onInput,
  onSubmit,
}: Props) => (
  <box
    position="absolute"
    top="35%"
    left="25%"
    right="25%"
    height={9}
    border
    borderColor="#33ccff"
    title="New Folder"
    backgroundColor="#0d1117"
    zIndex={100}
    flexDirection="column"
    paddingX={2}
    paddingY={1}
  >
    <box flexDirection="row">
      <text fg="#aaa">Name: </text>
      <input
        focused
        value={initialValue}
        onInput={onInput}
        onSubmit={onSubmit}
      />
    </box>
    <box flexGrow={1} />
    <text fg="#666">Enter: create · Esc: cancel</text>
  </box>
);
