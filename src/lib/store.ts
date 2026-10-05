import { useSyncExternalStore } from "react";

export interface Store<T> {
  get(): T;
  set(next: T | ((prev: T) => T)): void;
  subscribe(listener: () => void): () => void;
  use(): T;
}

/**
 * Minimaler globaler Store. Mit `persist` wird der Zustand in localStorage
 * gespiegelt (in Tauri bleibt das WebView-Profil erhalten).
 */
export function createStore<T>(initial: T, options: { persist?: string } = {}): Store<T> {
  const key = options.persist && `notch:${options.persist}`;
  let state = initial;
  if (key) {
    try {
      const raw = localStorage.getItem(key);
      if (raw) state = JSON.parse(raw) as T;
    } catch {
      // Kaputter Eintrag → mit Standardwert weiter.
    }
  }

  const listeners = new Set<() => void>();
  const store: Store<T> = {
    get: () => state,
    set(next) {
      state = typeof next === "function" ? (next as (prev: T) => T)(state) : next;
      if (key) localStorage.setItem(key, JSON.stringify(state));
      listeners.forEach((l) => l());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    use: () => useSyncExternalStore(store.subscribe, store.get),
  };
  return store;
}
