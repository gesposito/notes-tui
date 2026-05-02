import { SHORTCUTS } from "../lib/shortcuts.ts";

const KEY_COLUMN_WIDTH = 18;

export const HelpDialog = () => (
  <box
    position="absolute"
    top="10%"
    left="15%"
    right="15%"
    bottom="10%"
    border
    borderColor="#33ccff"
    title="Keyboard shortcuts"
    backgroundColor="#0d1117"
    zIndex={100}
    flexDirection="column"
    paddingX={2}
    paddingY={1}
  >
    {SHORTCUTS.map((group, i) => (
      <box
        key={group.name}
        flexDirection="column"
        marginTop={i === 0 ? 0 : 1}
      >
        <text fg="#33ccff">{group.name}</text>
        {group.bindings.map((b) => (
          <box key={b.key} flexDirection="row">
            <text fg="#aaa">{b.key.padEnd(KEY_COLUMN_WIDTH)}</text>
            <text>{b.description}</text>
          </box>
        ))}
      </box>
    ))}
    <box flexGrow={1} />
    <text fg="#666">(press ? or Esc to close)</text>
  </box>
);
