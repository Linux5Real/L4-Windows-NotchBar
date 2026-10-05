import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, Plus, Star, X } from "@phosphor-icons/react";
import { springs } from "../../design/motion";
import { createStore } from "../../lib/store";
import { t } from "../../i18n";

interface Todo {
  id: string;
  text: string;
  done: boolean;
  starred: boolean;
}

const todos = createStore<Todo[]>([], { persist: "todos" });

// Flagged on top, done at the bottom, otherwise in input order.
const order = (t: Todo) => (t.done ? 2 : t.starred ? 0 : 1);

export function TodosView() {
  const items = todos.use();
  const [draft, setDraft] = useState("");
  const sorted = [...items].sort((a, b) => order(a) - order(b));
  const open = items.filter((t) => !t.done).length;

  const add = () => {
    const text = draft.trim();
    if (!text) return;
    todos.set((l) => [{ id: crypto.randomUUID(), text, done: false, starred: false }, ...l]);
    setDraft("");
  };
  const patch = (id: string, p: Partial<Todo>) => todos.set((l) => l.map((t) => (t.id === id ? { ...t, ...p } : t)));
  const remove = (id: string) => todos.set((l) => l.filter((t) => t.id !== id));

  return (
    <div className="flex h-full flex-col px-4 pt-1 pb-1">
      <form
        className="flex h-9 shrink-0 items-center gap-2 rounded-[12px] bg-fill-1 px-3"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <Plus size={14} weight="bold" className="text-label-3" />
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t("Neue Aufgabe")}
          className="min-w-0 flex-1 bg-transparent text-body text-label outline-none placeholder:text-label-4"
        />
        <span className="tabular text-caption text-label-3">{t("{n} offen", { n: open })}</span>
      </form>

      <div className="-mx-1 mt-1.5 flex-1 overflow-y-auto px-1 [scrollbar-width:none]">
        {items.length === 0 && (
          <div className="flex h-full items-center justify-center text-body text-label-3">{t("Alles erledigt")}</div>
        )}
        <AnimatePresence initial={false}>
          {sorted.map((todo) => (
            <motion.div
              key={todo.id}
              layout="position"
              transition={springs.snappy}
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 32 }}
              exit={{ opacity: 0, height: 0, transition: { duration: 0.15 } }}
              className="group flex items-center gap-2.5 overflow-hidden rounded-[10px] px-2 hover:bg-fill-1"
            >
              <button
                aria-label={todo.done ? t("Als offen markieren") : t("Erledigt")}
                onClick={() => patch(todo.id, { done: !todo.done })}
                className={`pressable flex size-[18px] shrink-0 items-center justify-center rounded-full border-[1.5px] ${
                  todo.done ? "border-green bg-green text-black" : "border-label-3"
                }`}
              >
                <AnimatePresence initial={false}>
                  {todo.done && (
                    <motion.span
                      className="flex"
                      initial={{ opacity: 0, transform: "scale(0.5)" }}
                      animate={{ opacity: 1, transform: "scale(1)" }}
                      exit={{ opacity: 0, transform: "scale(0.5)" }}
                      transition={springs.snappy}
                    >
                      <Check size={11} weight="bold" />
                    </motion.span>
                  )}
                </AnimatePresence>
              </button>
              <span
                className={`min-w-0 flex-1 truncate text-body transition-colors duration-200 ${
                  todo.done ? "text-label-3 line-through" : "text-label"
                }`}
              >
                {todo.text}
              </span>
              <button
                aria-label={t("Markieren")}
                onClick={() => patch(todo.id, { starred: !todo.starred })}
                className={`pressable flex size-6 items-center justify-center ${
                  todo.starred ? "text-yellow" : "text-label-4 opacity-0 group-hover:opacity-100"
                }`}
              >
                <Star size={14} weight={todo.starred ? "fill" : "bold"} />
              </button>
              <button
                aria-label={t("Löschen")}
                onClick={() => remove(todo.id)}
                className="pressable flex size-6 items-center justify-center text-label-4 opacity-0 group-hover:opacity-100 hover:text-label-2"
              >
                <X size={13} weight="bold" />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}
