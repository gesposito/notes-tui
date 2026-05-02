type Props = {
  title: string;
  body: string;
  loading: boolean;
  hasSelection: boolean;
};

export const PreviewPane = ({ title, body, loading, hasSelection }: Props) => (
  <box
    flexGrow={1}
    border
    borderColor="#555"
    title={title}
    flexDirection="column"
  >
    <scrollbox style={{ flexGrow: 1 }}>
      {loading && !body && <text fg="#777">Loading preview…</text>}
      {!hasSelection && <text fg="#777">(no note selected)</text>}
      {body && <text>{body}</text>}
    </scrollbox>
  </box>
);
