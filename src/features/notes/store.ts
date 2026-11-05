import { createStore } from "../../lib/store";

/** The single quick note, saved as you type. */
export const note = createStore("", { persist: "note" });

export function setNote(text: string) {
  note.set(text);
}

/** Adds a line to the note without replacing what is already there. */
export function appendNote(text: string) {
  const current = note.get().trimEnd();
  note.set(current ? `${current}\n${text}` : text);
}
