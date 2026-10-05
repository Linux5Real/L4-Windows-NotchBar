import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowsClockwise, Check, ClipboardText, QrCode, Trash } from "@phosphor-icons/react";
import { content } from "../../design/motion";
import { HeaderActions, HeaderButton } from "../../notch/header";
import { Button, Group, Meter, Row, Slider, Switch, TextField } from "../../ui/controls";
import { createStore } from "../../lib/store";
import { vault, vaultError, type VaultItem } from "../../platform/vault";
import { generatePassword, strengthBits, type GeneratorOptions } from "./generator";
import { errorText } from "./errors";
import { t } from "../../i18n";

/** Generator settings are remembered (no secrets in here). */
const generator = createStore<GeneratorOptions>({ length: 20, digits: true, symbols: true }, { persist: "vault-generator" });

const FIELD = "w-[300px]";

// ---------- Password ----------

export function PasswordForm(props: {
  item: VaultItem | null;
  password: string;
  onDone: () => void;
  run: (action: () => Promise<void>) => Promise<void>;
}) {
  const [name, setName] = useState(props.item?.name ?? "");
  const [username, setUsername] = useState(props.item?.username ?? "");
  const [password, setPassword] = useState(props.password);
  const [generated, setGenerated] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const opts = generator.use();

  const generate = (o: GeneratorOptions = opts) => {
    setPassword(generatePassword(o));
    setGenerated(true);
  };
  const setOpts = (patch: Partial<GeneratorOptions>) => {
    const next = { ...opts, ...patch };
    generator.set(next);
    // Options only matter for a generated password; a typed one stays.
    if (generated) generate(next);
  };

  useEffect(() => {
    if (!confirmDelete) return;
    const id = window.setTimeout(() => setConfirmDelete(false), 3000);
    return () => window.clearTimeout(id);
  }, [confirmDelete]);

  const canSave = name.trim() !== "" && password !== "";
  const save = () =>
    canSave &&
    void props.run(async () => {
      await vault.savePassword({ id: props.item?.id ?? null, name, username, password });
      props.onDone();
    });

  const bits = strengthBits(password);
  const strength = bits >= 80 ? t("Stark") : bits >= 55 ? t("Mittel") : t("Schwach");
  return (
    <div className="flex h-full flex-col gap-2">
      {props.item && (
        <HeaderActions>
          <HeaderButton
            label={confirmDelete ? t("Wirklich löschen?") : t("Löschen")}
            active={confirmDelete}
            onClick={() =>
              confirmDelete
                ? void props.run(async () => {
                    await vault.remove(props.item!.id);
                    props.onDone();
                  })
                : setConfirmDelete(true)
            }
          >
            <Trash size={14} weight="bold" className={confirmDelete ? "text-red" : undefined} />
          </HeaderButton>
        </HeaderActions>
      )}
      <Group>
        <Row label={t("Name")}>
          <TextField value={name} onChange={setName} placeholder={t("z. B. GitHub")} width={FIELD} onSubmit={save} autoFocus={!props.item} />
        </Row>
        <Row label={t("Benutzername / E-Mail")}>
          <TextField value={username} onChange={setUsername} placeholder={t("optional")} width={FIELD} onSubmit={save} />
        </Row>
        <Row label={t("Passwort")}>
          <div className="flex items-center gap-1">
            <TextField
              value={password}
              onChange={(v) => {
                setPassword(v);
                setGenerated(false);
              }}
              secret
              revealed={generated}
              placeholder={t("Eingeben oder erzeugen")}
              width="w-[266px]"
              onSubmit={save}
            />
            <button
              aria-label={t("Passwort erzeugen")}
              title={t("Passwort erzeugen")}
              onClick={() => generate()}
              className="pressable pressable-fill flex size-7 items-center justify-center rounded-full bg-fill-2 text-label-2 hover:text-label"
            >
              <ArrowsClockwise size={13} weight="bold" />
            </button>
          </div>
        </Row>
      </Group>

      <div className="flex h-7 items-center gap-3 px-3 text-caption text-label-3">
        <span>{t("Länge")}</span>
        <div className="w-24">
          <Slider value={opts.length} min={8} max={64} onChange={(length) => setOpts({ length })} label={t("Länge")} />
        </div>
        <span className="tabular w-4 text-label-2">{opts.length}</span>
        <span className="ml-2">{t("Ziffern")}</span>
        <Switch checked={opts.digits} onChange={(digits) => setOpts({ digits })} label={t("Ziffern")} />
        <span className="ml-1">{t("Symbole")}</span>
        <Switch checked={opts.symbols} onChange={(symbols) => setOpts({ symbols })} label={t("Symbole")} />
      </div>

      <div className="mt-auto flex items-center gap-2">
        {password && (
          <div className="flex items-center gap-2 pl-1 text-caption text-label-3">
            <div className="w-14">
              <Meter percent={Math.min(100, (bits / 100) * 100)} height={4} color={bits >= 80 ? "var(--color-green)" : bits >= 55 ? "var(--color-orange)" : "var(--color-red)"} />
            </div>
            {strength}
          </div>
        )}
        <div className="ml-auto flex gap-2">
          <Button onClick={props.onDone}>{t("Abbrechen")}</Button>
          <Button primary disabled={!canSave} onClick={save}>
            {props.item ? t("Sichern") : t("Hinzufügen")}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------- 2FA ----------

export function TotpForm(props: { onDone: () => void }) {
  const [scan, setScan] = useState<{ issuer: string; account: string } | null>(null);
  const [secret, setSecret] = useState("");
  const [name, setName] = useState("");
  const [account, setAccount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const paste = async () => {
    setBusy(true);
    setError(null);
    try {
      setScan(await vault.scan());
    } catch (e) {
      setError(errorText(vaultError(e)));
    }
    setBusy(false);
  };

  // Ctrl+V outside a text field reads the QR code from the clipboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey && e.key.toLowerCase() === "v")) return;
      // In a field, Ctrl+V pastes text as usual (e.g. a copied key).
      if (e.target instanceof HTMLInputElement) return;
      e.preventDefault();
      void paste();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const canSave = name.trim() !== "" && (scan !== null || secret.trim() !== "");
  const save = async () => {
    if (!canSave) return;
    try {
      await vault.addTotp({ name, account: scan ? scan.account : account, secret: scan ? null : secret });
      props.onDone();
    } catch (e) {
      setError(errorText(vaultError(e)));
    }
  };

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex h-14 shrink-0 items-center gap-3 rounded-[12px] bg-fill-1 px-3">
        <span
          className={`flex size-8 shrink-0 items-center justify-center rounded-[9px] transition-colors duration-200 ${
            scan ? "bg-green/15 text-green" : "bg-fill-2 text-label-2"
          }`}
        >
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={scan ? "ok" : "qr"}
              className="flex"
              initial={{ opacity: 0, transform: "scale(0.9)" }}
              animate={{ opacity: 1, transform: "scale(1)", transition: content.enter }}
              exit={{ opacity: 0, transition: content.exit }}
            >
              {scan ? <Check size={16} weight="bold" /> : <QrCode size={16} weight="bold" />}
            </motion.span>
          </AnimatePresence>
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-body text-label">{scan ? t("QR-Code erkannt") : t("QR-Code mit Strg+V einfügen")}</div>
          <div className="truncate text-caption text-label-3">
            {error ? (
              <span className="text-red">{error}</span>
            ) : scan ? (
              [scan.issuer, scan.account].filter(Boolean).join(" · ") || t("Schlüssel übernommen")
            ) : (
              t("Screenshot mit Win+Umschalt+S, dann hier einfügen")
            )}
          </div>
        </div>
        {scan ? (
          <Button onClick={() => setScan(null)}>{t("Verwerfen")}</Button>
        ) : (
          <Button icon={ClipboardText} disabled={busy} onClick={() => void paste()}>
            {t("Einfügen")}
          </Button>
        )}
      </div>

      <Group>
        <Row label={t("Name")} hint={scan?.issuer ? t("Vorschlag: {name}", { name: scan.issuer }) : undefined}>
          <TextField value={name} onChange={setName} placeholder={t("z. B. GitHub")} width={FIELD} onSubmit={() => void save()} />
        </Row>
        {!scan && (
          <>
            <Row label={t("Schlüssel")}>
              <TextField value={secret} onChange={setSecret} secret placeholder={t("Base32 oder otpauth://")} width={FIELD} onSubmit={() => void save()} />
            </Row>
            <Row label={t("Konto")}>
              <TextField value={account} onChange={setAccount} placeholder={t("optional")} width={FIELD} onSubmit={() => void save()} />
            </Row>
          </>
        )}
      </Group>

      <div className="mt-auto flex justify-end gap-2">
        <Button onClick={props.onDone}>{t("Abbrechen")}</Button>
        <Button primary disabled={!canSave} onClick={() => void save()}>
          {t("Hinzufügen")}
        </Button>
      </div>
    </div>
  );
}
