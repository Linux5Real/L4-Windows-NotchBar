import { createStore } from "../../lib/store";

/** Last used languages and text; survive tab switches and restarts. */
export interface TranslateState {
  from: string;
  to: string;
  input: string;
}

export const translateState = createStore<TranslateState>(
  { from: "auto", to: "en", input: "" },
  { persist: "translate" },
);
