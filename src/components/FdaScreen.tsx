import type { FdaHelp } from "../lib/grant-fda.ts";

const PANE =
  "System Settings → Privacy & Security → Full Disk Access (opened for you)";

/**
 * Guided screen for a missing Full Disk Access grant (sqlite backend), in
 * place of the raw error: which binary to turn on (it answers for itself,
 * so the grant covers only it), what the app already opened, and a way out
 * via another backend. Keys are handled in useAppKeybindings.
 */
export const FdaScreen = ({ help }: { help: FdaHelp | null }) => {
  const app = help?.app || "notes-tui";
  const path = help?.path ?? "";
  const ifMissing = `   If it isn't listed, drag it in from the Finder window that shows it: ${path}`;
  // No steps until we know what was opened, rather than guessing for a
  // frame. From source, macOS holds the terminal responsible, so point at
  // the compiled binary, building it first if needed.
  const steps = !help
    ? []
    : !help.fromSource
      ? [
          `1. In ${PANE}, turn on ${app}.`,
          ifMissing,
          `2. Quit ${app} (q) and start it again.`,
        ]
      : path
        ? [
            `1. In ${PANE}, turn on ${app}.`,
            ifMissing,
            `2. Quit (q) and run ${path} instead.`,
          ]
        : [
            "1. Build it with bun run build, then press o to show it in Finder.",
            `2. In ${PANE}, turn on ${app} (drag it in from Finder if it isn't listed).`,
            `3. Quit (q) and run ./${app} from the repo root instead.`,
          ];
  return (
    <box flexDirection="column" padding={1}>
      <text fg="#e6c200">Full Disk Access needed</text>
      <text> </text>
      <text>
        The sqlite backend reads Notes' database directly, which macOS only
        allows for apps with Full Disk Access.
      </text>
      <text> </text>
      {help?.fromSource && (
        <>
          <text>
            Running from source, macOS checks your terminal, and granting that
            would cover everything run in it. Grant the compiled {app} binary
            instead:
          </text>
          <text> </text>
        </>
      )}
      {steps.map((step) => (
        <text key={step}>{step}</text>
      ))}
      <text> </text>
      <text fg="#777">
        Only {app} gets access, not your terminal. Rebuilding it changes its
        identity, so re-add it after each build.
      </text>
      <text>
        Or switch to a backend that doesn't need it: press B and pick osascript.
      </text>
      <text> </text>
      <text fg="#777">
        o reopen Settings &amp; Finder · B switch backend · r retry · q quit
      </text>
    </box>
  );
};
