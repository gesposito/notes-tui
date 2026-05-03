import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  availableBackends,
  type BackendChoice,
} from "./index.ts";
import type { NotesBackend } from "./types.ts";

type CtxValue = {
  backend: NotesBackend;
  choice: BackendChoice;
  setChoice: (c: BackendChoice) => void;
};

const NotesContext = createContext<CtxValue | null>(null);

/**
 * Provides the active NotesBackend + a setter so consumers can swap at
 * runtime (the TUI's backend picker). Pass `backend` to override the
 * registry lookup — useful in tests with a mock backend, where `choice`
 * stays at its initial value and `setChoice` is a no-op upstream.
 *
 * `onChoiceChange` runs whenever a consumer calls `setChoice`. The entry
 * point uses it to persist the choice to disk (see lib/settings.ts).
 */
export const NotesProvider = ({
  backend,
  initialChoice = "osa",
  onChoiceChange,
  children,
}: {
  /** When provided, used as the static backend; `setChoice` becomes a no-op. */
  backend?: NotesBackend;
  initialChoice?: BackendChoice;
  onChoiceChange?: (c: BackendChoice) => void;
  children: ReactNode;
}) => {
  const [choice, setChoice] = useState<BackendChoice>(initialChoice);

  // Wrap setChoice so the persistence callback runs alongside the state
  // update. Using useCallback so the context value is stable for memoization.
  const setChoiceWithSideEffect = useCallback(
    (next: BackendChoice) => {
      setChoice(next);
      onChoiceChange?.(next);
    },
    [onChoiceChange],
  );

  const value = useMemo<CtxValue>(
    () => ({
      backend: backend ?? availableBackends[choice],
      choice,
      setChoice: backend ? () => {} : setChoiceWithSideEffect,
    }),
    [backend, choice, setChoiceWithSideEffect],
  );
  return (
    <NotesContext.Provider value={value}>{children}</NotesContext.Provider>
  );
};

export const useNotes = (): NotesBackend => {
  const value = useContext(NotesContext);
  if (!value) {
    throw new Error("useNotes must be used inside <NotesProvider>");
  }
  return value.backend;
};

export const useBackendChoice = (): {
  choice: BackendChoice;
  setChoice: (c: BackendChoice) => void;
} => {
  const value = useContext(NotesContext);
  if (!value) {
    throw new Error("useBackendChoice must be used inside <NotesProvider>");
  }
  return { choice: value.choice, setChoice: value.setChoice };
};
