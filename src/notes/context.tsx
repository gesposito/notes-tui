import { createContext, useContext, type ReactNode } from "react";
import type { NotesBackend } from "./types.ts";

const NotesContext = createContext<NotesBackend | null>(null);

export const NotesProvider = ({
  backend,
  children,
}: {
  backend: NotesBackend;
  children: ReactNode;
}) => (
  <NotesContext.Provider value={backend}>{children}</NotesContext.Provider>
);

export const useNotes = (): NotesBackend => {
  const value = useContext(NotesContext);
  if (!value) {
    throw new Error("useNotes must be used inside <NotesProvider>");
  }
  return value;
};
