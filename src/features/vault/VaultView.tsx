import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Check,
  Eye,
  EyeSlash,
  Key,
  LockSimple,
  LockSimpleOpen,
  MagnifyingGlass,
  PencilSimple,
  Plus,
  QrCode,
  Trash,
  User,
  WarningCircle,
  type Icon,
} from "@phosphor-icons/react";
import { content, tick } from "../../design/motion";
import { createStore } from "../../lib/store";
import { HeaderActions, HeaderButton } from "../../notch/header";
import { Button, Empty, Segmented, Skeleton } from "../../ui/controls";
import { refreshVault, vault, vaultError, vaultStatus, type VaultCode, type VaultItem, type VaultKind } from "../../platform/vault";
import { PinEntry, unlockResult } from "./PinEntry";
import { HelloPrompt } from "./HelloPrompt";
import { PasswordForm, TotpForm } from "./forms";
import { errorText } from "./errors";
import { t } from "../../i18n";

/** Hide a shown password again after this long. */
const REVEAL_MS = 15_000;
const FEEDBACK_MS = 1400;

/** Last segment survives closing the notch. */
let savedKind: VaultKind = "password";

type Screen = { kind: "list" } | { kind: "password"; item: VaultItem | null; password: string } | { kind: "totp" };

/**
 * Vault: passwords and 2FA codes, encrypted on this PC (src-tauri/src/vault.rs).
 * Leaving the tool or closing the notch locks it again.
 */
export function VaultView() {
  const status = vaultStatus.use();
  const [kind, setKindState] = useState<VaultKind>(savedKind);
  const [screen, setScreen] = useState<Screen>({ kind: "list" });
  /** Action that hit "locked"; runs again after the PIN. */
  const [prompt, setPrompt] = useState<null | (() => Promise<void>)>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const setKind = (k: VaultKind) => {
    savedKind = k;
    setKindState(k);
  };

  useEffect(() => {
    void refreshVault();
    return () => {
      revealStore.set(null);
      void vault.lock();
    };
  }, []);

  /** Runs an action; if Rust says "locked", asks for the PIN and tries again. */
  const run = async (action: () => Promise<void>) => {
    try {
      await action();
    } catch (e) {
      if (vaultError(e) === "locked") setPrompt(() => action);
      else setNotice(errorText(vaultError(e)));
    }
  };

  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(null), 2600);
    return () => window.clearTimeout(id);
  }, [notice]);

  let body: ReactNode;
  let key: string;
  if (!status) {
    key = "loading";
    body = (
      <div className="flex flex-col gap-2 pt-1">
        <Skeleton className="h-7 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  } else if (status.unreadable) {
    key = "unreadable";
    body = <Unreadable />;
  } else if (!status.hasPin) {
    key = "setup";
    body = <Setup />;
  } else if (prompt && status.hello) {
    key = "hello";
    body = (
      <HelloPrompt
        onCancel={() => setPrompt(null)}
        onUnlocked={async () => {
          const retry = prompt;
          setPrompt(null);
          await run(retry);
        }}
      />
    );
  } else if (prompt) {
    key = "pin";
    body = (
      <PinEntry
        title={t("PIN eingeben")}
        lockedFor={status.lockedFor}
        onCancel={() => setPrompt(null)}
        onSubmit={async (pin) => {
          try {
            await vault.unlock(pin);
          } catch (e) {
            return unlockResult(vaultError(e));
          }
          const retry = prompt;
          setPrompt(null);
          await run(retry);
          return null;
        }}
      />
    );
  } else if (screen.kind === "password") {
    key = `password-${screen.item?.id ?? "new"}`;
    body = (
      <PasswordForm
        item={screen.item}
        password={screen.password}
        onDone={() => setScreen({ kind: "list" })}
        run={run}
      />
    );
  } else if (screen.kind === "totp") {
    key = "totp";
    body = <TotpForm onDone={() => setScreen({ kind: "list" })} run={run} />;
  } else {
    key = "list";
    body = (
      <List
        kind={kind}
        setKind={setKind}
        items={status.items}
        unlocked={status.unlocked}
        codesNeedPin={status.pinTotp}
        run={run}
        onAdd={() => setScreen(kind === "password" ? { kind: "password", item: null, password: "" } : { kind: "totp" })}
        onEdit={(item) => void run(async () => setScreen({ kind: "password", item, password: await vault.reveal(item.id) }))}
      />
    );
  }

  const ready = status?.hasPin && !status.unreadable;
  return (
    <div className="relative flex h-full flex-col px-4 pt-1 pb-3">
      {ready && key === "list" && (
        <HeaderActions>
          <HeaderButton
            label={status.unlocked ? t("Sperren") : t("Entsperren")}
            active={status.unlocked}
            onClick={() => (status.unlocked ? (revealStore.set(null), void vault.lock()) : setPrompt(() => async () => {}))}
          >
            {status.unlocked ? <LockSimpleOpen size={14} weight="bold" /> : <LockSimple size={14} weight="bold" />}
          </HeaderButton>
          <HeaderButton
            label={kind === "password" ? t("Passwort hinzufügen") : t("2FA hinzufügen")}
            onClick={() => setScreen(kind === "password" ? { kind: "password", item: null, password: "" } : { kind: "totp" })}
          >
            <Plus size={14} weight="bold" />
          </HeaderButton>
        </HeaderActions>
      )}
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.div
          key={key}
          className="flex min-h-0 flex-1 flex-col"
          initial={{ opacity: 0, filter: "blur(4px)" }}
          animate={{ opacity: 1, filter: "blur(0px)", transition: content.enter }}
          exit={{ opacity: 0, filter: "blur(4px)", transition: content.exit }}
        >
          {body}
        </motion.div>
      </AnimatePresence>
      <AnimatePresence>
        {notice && (
          <motion.div
            className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center"
            initial={{ opacity: 0, transform: "translateY(4px)" }}
            animate={{ opacity: 1, transform: "translateY(0px)", transition: content.enter }}
            exit={{ opacity: 0, transition: content.exit }}
          >
            <span className="flex items-center gap-1.5 rounded-full bg-elevated px-3 py-1 text-caption text-label-2 shadow-[0_6px_18px_rgb(0_0_0/0.45)]">
              <WarningCircle size={12} weight="bold" className="text-orange" />
              {notice}
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ---------- Setup ----------

function Setup() {
  const [first, setFirst] = useState<string | null>(null);
  return first === null ? (
    <PinEntry
      key="new"
      setup
      title={t("Tresor einrichten")}
      hint={t("Lege einen 4-stelligen PIN fest. Alles bleibt verschlüsselt auf diesem PC.")}
      onSubmit={async (pin) => {
        setFirst(pin);
        return null;
      }}
    />
  ) : (
    <PinEntry
      key="confirm"
      setup
      title={t("PIN bestätigen")}
      hint={t("Gib den PIN noch einmal ein.")}
      onCancel={() => setFirst(null)}
      onSubmit={async (pin) => {
        if (pin !== first) return t("PINs stimmen nicht überein");
        try {
          await vault.setup(pin);
        } catch (e) {
          return errorText(vaultError(e));
        }
        return null;
      }}
    />
  );
}

function Unreadable() {
  const [confirm, setConfirm] = useState(false);
  return (
    <Empty
      icon={WarningCircle}
      title={t("Tresor nicht lesbar")}
      text={t("Er gehört zu einem anderen Windows-Konto oder ist beschädigt.")}
      action={
        <Button onClick={() => (confirm ? void vault.reset() : setConfirm(true))}>{confirm ? t("Wirklich alles löschen?") : t("Tresor zurücksetzen")}</Button>
      }
    />
  );
}

// ---------- List ----------

function List(props: {
  kind: VaultKind;
  setKind: (k: VaultKind) => void;
  items: VaultItem[];
  unlocked: boolean;
  codesNeedPin: boolean;
  run: (action: () => Promise<void>) => Promise<void>;
  onAdd: () => void;
  onEdit: (item: VaultItem) => void;
}) {
  const [query, setQuery] = useState("");
  const counts = { password: 0, totp: 0 };
  for (const i of props.items) counts[i.kind]++;
  const q = query.trim().toLowerCase();
  const items = props.items
    .filter((i) => i.kind === props.kind && (!q || i.name.toLowerCase().includes(q) || i.username.toLowerCase().includes(q)))
    .sort((a, b) => a.name.localeCompare(b.name));
  const showCodes = !props.codesNeedPin || props.unlocked;

  return (
    <>
      <div className="flex shrink-0 items-center gap-2">
        <Segmented
          id="vault-kind"
          value={props.kind}
          onChange={props.setKind}
          options={[
            { value: "password", label: <Count label={t("Passwörter")} n={counts.password} /> },
            { value: "totp", label: <Count label={t("2FA")} n={counts.totp} /> },
          ]}
        />
        <label className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-[8px] bg-fill-1 px-2 text-label-3 focus-within:bg-fill-2">
          <MagnifyingGlass size={12} weight="bold" className="shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("Suchen")}
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-footnote text-label outline-none placeholder:text-label-4"
          />
        </label>
      </div>

      <div
        className="-mx-1 mt-1.5 min-h-0 flex-1 overflow-y-auto px-1 pb-3 [scrollbar-width:none]"
        style={{ maskImage: "linear-gradient(180deg, #000 calc(100% - 20px), transparent)" }}
      >
        {counts[props.kind] === 0 ? (
          props.kind === "password" ? (
            <Empty
              icon={Key}
              title={t("Noch keine Passwörter")}
              text={t("Zugangsdaten bleiben verschlüsselt auf diesem PC.")}
              action={<Button icon={Plus} onClick={props.onAdd}>{t("Passwort hinzufügen")}</Button>}
            />
          ) : (
            <Empty
              icon={QrCode}
              title={t("Noch keine 2FA-Codes")}
              text={t("QR-Code mit Strg+V einfügen oder den Schlüssel eintippen.")}
              action={<Button icon={Plus} onClick={props.onAdd}>{t("2FA hinzufügen")}</Button>}
            />
          )
        ) : items.length === 0 ? (
          <div className="flex h-full items-center justify-center text-body text-label-3">{t("Nichts gefunden")}</div>
        ) : props.kind === "password" ? (
          items.map((item, i) => <PasswordRow key={item.id} item={item} index={i} run={props.run} onEdit={() => props.onEdit(item)} />)
        ) : (
          <Codes items={items} show={showCodes} run={props.run} />
        )}
      </div>
    </>
  );
}

function Count({ label, n }: { label: string; n: number }) {
  return (
    <span className="flex items-center gap-1.5">
      {label}
      {n > 0 && <span className="tabular text-label-3">{n}</span>}
    </span>
  );
}

function Row(props: { index: number; children: ReactNode; onClick?: () => void; label?: string }) {
  return (
    <motion.div
      role={props.onClick ? "button" : undefined}
      aria-label={props.label}
      onClick={props.onClick}
      initial={{ opacity: 0, transform: "translateY(4px)" }}
      animate={{ opacity: 1, transform: "translateY(0px)", transition: { ...content.enter, delay: 0.05 + props.index * 0.035 } }}
      className={`group flex h-11 items-center gap-2.5 rounded-[10px] px-2 hover:bg-fill-1 ${props.onClick ? "pressable cursor-pointer" : ""}`}
    >
      {props.children}
    </motion.div>
  );
}

function Monogram({ name }: { name: string }) {
  return (
    <span className="flex size-7 shrink-0 items-center justify-center rounded-[8px] bg-fill-2 text-footnote font-semibold text-label-2">
      {(name.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}

function RowIcon(props: { label: string; icon: Icon; onClick: () => void; active?: boolean; danger?: boolean }) {
  const I = props.icon;
  return (
    <button
      aria-label={props.label}
      title={props.label}
      onClick={(e) => {
        e.stopPropagation();
        props.onClick();
      }}
      className={`pressable pressable-fill flex size-7 items-center justify-center rounded-full ${
        props.danger ? "bg-red/15 text-red" : props.active ? "text-label" : "text-label-3 hover:text-label-2"
      }`}
    >
      <I size={14} weight="bold" />
    </button>
  );
}

/**
 * Short "copied" line in place of the subtitle. A store, not row state: after a PIN
 * prompt the list is rebuilt and the retried action must still reach the new row.
 */
const feedbackStore = createStore<{ id: string; text: string } | null>(null);
let feedbackTimer: number | undefined;

function useFeedback(id: string) {
  const current = feedbackStore.use();
  const show = (text: string) => {
    feedbackStore.set({ id, text });
    window.clearTimeout(feedbackTimer);
    feedbackTimer = window.setTimeout(() => feedbackStore.set(null), FEEDBACK_MS);
  };
  return [current?.id === id ? current.text : null, show] as const;
}

function Copied({ text }: { text: string }) {
  return (
    <span className="flex items-center gap-1 text-green">
      <Check size={11} weight="bold" />
      {text}
    </span>
  );
}

/** One shown password at a time; a store for the same reason as the feedback. */
const revealStore = createStore<{ id: string; password: string } | null>(null);
let revealTimer: number | undefined;

function PasswordRow(props: { item: VaultItem; index: number; run: (a: () => Promise<void>) => Promise<void>; onEdit: () => void }) {
  const { item, run } = props;
  const revealed = revealStore.use();
  const shown = revealed?.id === item.id ? revealed.password : null;
  const setShown = (password: string | null) => {
    window.clearTimeout(revealTimer);
    revealStore.set(password === null ? null : { id: item.id, password });
    if (password !== null) revealTimer = window.setTimeout(() => revealStore.set(null), REVEAL_MS);
  };
  const [feedback, showFeedback] = useFeedback(item.id);

  const copy = (field: "username" | "password") =>
    void run(async () => {
      await vault.copy(item.id, field);
      showFeedback(field === "username" ? t("Benutzername kopiert") : t("Passwort kopiert · wird in 30 s geleert"));
    });

  return (
    <Row index={props.index}>
      <Monogram name={item.name} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-body text-label">{item.name}</div>
        <div className="truncate text-caption text-label-3">
          {feedback ? (
            <Copied text={feedback} />
          ) : shown !== null ? (
            <span className="tabular tracking-wide text-label select-text">{shown}</span>
          ) : (
            item.username || t("Kein Benutzername")
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100">
        {item.username && <RowIcon label={t("Benutzername kopieren")} icon={User} onClick={() => copy("username")} />}
        <RowIcon
          label={shown !== null ? t("Verbergen") : t("Anzeigen")}
          icon={shown !== null ? EyeSlash : Eye}
          active={shown !== null}
          onClick={() => (shown !== null ? setShown(null) : void run(async () => setShown(await vault.reveal(item.id))))}
        />
        <RowIcon label={t("Bearbeiten")} icon={PencilSimple} onClick={props.onEdit} />
      </div>
      <RowIcon label={t("Passwort kopieren")} icon={Key} onClick={() => copy("password")} />
    </Row>
  );
}

// ---------- 2FA codes ----------

/** Codes plus when they were fetched; refetched when the shortest window rolls over. */
function Codes(props: { items: VaultItem[]; show: boolean; run: (a: () => Promise<void>) => Promise<void> }) {
  const [codes, setCodes] = useState<{ list: VaultCode[]; at: number } | null>(null);
  const [now, setNow] = useState(Date.now());
  const ids = props.items.map((i) => i.id).join();

  useEffect(() => {
    if (!props.show) return setCodes(null);
    let cancelled = false;
    let timer: number | undefined;
    const load = async () => {
      try {
        const list = await vault.codes();
        if (cancelled) return;
        const at = Date.now();
        setCodes({ list, at });
        const next = Math.min(...list.map((c) => c.remaining), 30);
        timer = window.setTimeout(load, next * 1000 + 60);
      } catch {
        if (!cancelled) setCodes(null);
      }
    };
    void load();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [props.show, ids]);

  useEffect(() => {
    if (!props.show) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [props.show]);

  const byId = useMemo(() => new Map(codes?.list.map((c) => [c.id, c]) ?? []), [codes]);
  return props.items.map((item, i) => {
    const c = byId.get(item.id);
    const left = c && codes ? Math.max(0, Math.ceil(c.remaining - (now - codes.at) / 1000)) : null;
    return <TotpRow key={item.id} item={item} index={i} code={c && left ? c.code : null} left={left} period={c?.period ?? item.period} run={props.run} />;
  });
}

function TotpRow(props: { item: VaultItem; index: number; code: string | null; left: number | null; period: number; run: (a: () => Promise<void>) => Promise<void> }) {
  const { item, run } = props;
  const [feedback, showFeedback] = useFeedback(item.id);
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    if (!confirm) return;
    const id = window.setTimeout(() => setConfirm(false), 3000);
    return () => window.clearTimeout(id);
  }, [confirm]);

  const copy = () =>
    void run(async () => {
      await vault.copy(item.id, "code");
      showFeedback(t("Code kopiert"));
    });

  return (
    <Row index={props.index} onClick={copy} label={t("{name}: Code kopieren", { name: item.name })}>
      <Monogram name={item.name} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-body text-label">{item.name}</div>
        <div className="truncate text-caption text-label-3">{feedback ? <Copied text={feedback} /> : item.username || " "}</div>
      </div>
      <div className="opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100">
        <RowIcon
          label={confirm ? t("Wirklich löschen?") : t("Löschen")}
          icon={Trash}
          danger={confirm}
          onClick={() => (confirm ? void run(() => vault.remove(item.id)) : setConfirm(true))}
        />
      </div>
      <span className={`tabular text-title font-medium tracking-[0.06em] ${props.code ? "text-label" : "text-label-4"}`}>
        {props.code ? `${props.code.slice(0, Math.ceil(props.code.length / 2))} ${props.code.slice(Math.ceil(props.code.length / 2))}` : "••• •••"}
      </span>
      <Ring left={props.left} period={props.period} />
    </Row>
  );
}

const R = 7;
const CIRC = 2 * Math.PI * R;

/** Time left for the code; runs down once per second, red in the last 5 s. */
function Ring({ left, period }: { left: number | null; period: number }) {
  const fraction = left === null ? 1 : left / period;
  const urgent = left !== null && left <= 5;
  return (
    <span className="relative flex size-[18px] shrink-0 items-center justify-center">
      <svg viewBox="0 0 18 18" className="absolute inset-0 -rotate-90">
        <circle cx="9" cy="9" r={R} fill="none" strokeWidth="2" className="stroke-fill-2" />
        {left !== null && (
          <motion.circle
            cx="9"
            cy="9"
            r={R}
            fill="none"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={CIRC}
            initial={false}
            animate={{ strokeDashoffset: CIRC * (1 - fraction) }}
            transition={left >= period - 1 ? { duration: 0 } : tick}
            className={`transition-[stroke] duration-200 ${urgent ? "stroke-red" : "stroke-label-2"}`}
          />
        )}
      </svg>
      {left === null && <LockSimple size={9} weight="bold" className="text-label-4" />}
    </span>
  );
}

