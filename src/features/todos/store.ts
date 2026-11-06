import { createStore } from "../../lib/store";

export interface Todo {
  id: string;
  text: string;
  done: boolean;
  starred: boolean;
}

export const todos = createStore<Todo[]>([], { persist: "todos" });

/** Flagged on top, done at the bottom, otherwise in input order. */
export const todoOrder = (todo: Todo) => (todo.done ? 2 : todo.starred ? 0 : 1);

export function addTodo(text: string, starred = false): Todo {
  const todo: Todo = { id: crypto.randomUUID(), text, done: false, starred };
  todos.set((list) => [todo, ...list]);
  return todo;
}

export function patchTodo(id: string, patch: Partial<Todo>) {
  todos.set((list) => list.map((todo) => (todo.id === id ? { ...todo, ...patch } : todo)));
}

export function removeTodo(id: string) {
  todos.set((list) => list.filter((todo) => todo.id !== id));
}

export function clearDone() {
  todos.set((list) => list.filter((todo) => !todo.done));
}

/** Removes every task, including finished ones. */
export function clearAll() {
  todos.set([]);
}

/**
 * Finds a task by text: exact match first, then the query inside a task, then
 * the task text inside the query (the model may repeat the whole sentence).
 */
export function findTodo(match: string): Todo | undefined {
  const query = match.trim().toLowerCase();
  if (!query) return undefined;
  const list = todos.get();
  return (
    list.find((todo) => todo.text.trim().toLowerCase() === query) ??
    list.find((todo) => todo.text.toLowerCase().includes(query)) ??
    list.find((todo) => query.includes(todo.text.trim().toLowerCase()))
  );
}
