import { invoke } from "@tauri-apps/api/core";
import { createStore } from "../lib/store";
import { isNative } from "./native";
import { showcase } from "../dev/showcase-data";

/*
 * Bridge to the vault (src-tauri/src/vault.rs). Rust holds the file (DPAPI),
 * checks the PIN and copies secrets itself; the UI only gets names, usernames,
 * 2FA codes and, after the PIN, a password to show.
 *
 * Error codes: locked, wrong:<left>, lockout:<secs>, no-pin, pin-format, missing,
 * secret, not-otp, no-image, no-qr, no-scan, unreadable.
 */

export type VaultKind = "password" | "totp";

export interface VaultItem {
  id: string;
  kind: VaultKind;
  name: string;
  username: string;
  period: number;
}

export interface VaultStatus {
  hasPin: boolean;
  unlocked: boolean;
  pinPasswords: boolean;
  pinTotp: boolean;
  lockedFor: number;
  unreadable: boolean;
  items: VaultItem[];
}

export interface VaultCode {
  id: string;
  code: string;
  remaining: number;
  period: number;
}

/** Last known status; every change reloads it so all views stay in sync. */
export const vaultStatus = createStore<VaultStatus | null>(null);

export async function refreshVault(): Promise<VaultStatus> {
  const s = isNative ? await invoke<VaultStatus>("vault_status") : mock.status();
  vaultStatus.set(s);
  return s;
}

async function call<T>(cmd: string, args: Record<string, unknown> = {}, refresh = true): Promise<T> {
  const result = isNative ? await invoke<T>(cmd, args) : await mock.call<T>(cmd, args);
  if (refresh) await refreshVault();
  return result;
}

export const vault = {
  setup: (pin: string) => call<void>("vault_setup", { pin }),
  unlock: (pin: string) => call<void>("vault_unlock", { pin }),
  lock: () => call<void>("vault_lock"),
  savePassword: (p: { id: string | null; name: string; username: string; password: string }) => call<void>("vault_save_password", p),
  addTotp: (p: { name: string; account: string; secret: string | null }) => call<void>("vault_add_totp", p),
  remove: (id: string) => call<void>("vault_delete", { id }),
  reveal: (id: string) => call<string>("vault_reveal", { id }, false),
  copy: (id: string, field: "username" | "password" | "code") => call<void>("vault_copy", { id, field }, false),
  codes: () => call<VaultCode[]>("vault_codes", {}, false),
  options: (pinPasswords: boolean, pinTotp: boolean) => call<void>("vault_options", { pinPasswords, pinTotp }),
  changePin: (pin: string) => call<void>("vault_change_pin", { pin }),
  reset: () => call<void>("vault_reset"),
  scan: () => call<{ issuer: string; account: string }>("vault_scan", {}, false),
};

/** Error text from a rejected call (Tauri rejects with the plain string). */
export function vaultError(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
}

// ---------- Browser mock (same rules, kept in memory) ----------

interface MockItem extends VaultItem {
  secret: string;
}

const mock = (() => {
  let pin: string | null = showcase ? "1234" : null;
  let unlocked = false;
  let pinPasswords = true;
  let pinTotp = true;
  let fails = 0;
  let lockedUntil = 0;
  let pending: { issuer: string; account: string } | null = null;
  let items: MockItem[] = showcase
    ? [
        { id: "p1", kind: "password", name: "GitHub", username: "linus@hey.com", secret: "vR7#kq2Lw9!mZt4x", period: 30 },
        { id: "p2", kind: "password", name: "Steam", username: "l4_player", secret: "Gq8&nWb3sX!e2Ru", period: 30 },
        { id: "p3", kind: "password", name: "Figma", username: "linus@hey.com", secret: "t9Pz!4mKc2#Vw8sa", period: 30 },
        { id: "p4", kind: "password", name: "Notion", username: "linus@hey.com", secret: "Hm3$wQ7xLp2!dZ9e", period: 30 },
        { id: "p5", kind: "password", name: "Router", username: "admin", secret: "Ys6!pT2vRk9#Lq4n", period: 30 },
        { id: "t1", kind: "totp", name: "GitHub", username: "linus@hey.com", secret: "", period: 30 },
        { id: "t2", kind: "totp", name: "Google", username: "linus.l4@gmail.com", secret: "", period: 30 },
        { id: "t3", kind: "totp", name: "Discord", username: "l4_player", secret: "", period: 30 },
        { id: "t4", kind: "totp", name: "Binance", username: "linus@hey.com", secret: "", period: 30 },
      ]
    : [];

  const now = () => Math.floor(Date.now() / 1000);
  const need = (on: boolean) => {
    if (on && !unlocked) throw "locked";
  };
  // Stable fake code per entry and 30 s window.
  const code = (id: string, window: number) => {
    let h = 2166136261 ^ window;
    for (const c of id) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    return String(Math.abs(h) % 1_000_000).padStart(6, "0");
  };

  return {
    status: (): VaultStatus => ({
      hasPin: pin !== null,
      unlocked,
      pinPasswords,
      pinTotp,
      lockedFor: Math.max(0, lockedUntil - now()),
      unreadable: false,
      items: items.map(({ secret: _, ...i }) => i),
    }),
    async call<T>(cmd: string, a: Record<string, unknown>): Promise<T> {
      await new Promise((r) => setTimeout(r, 60));
      const s = (k: string) => String(a[k] ?? "");
      switch (cmd) {
        case "vault_setup":
          if (!/^\d{4}$/.test(s("pin"))) throw "pin-format";
          pin = s("pin");
          unlocked = true;
          break;
        case "vault_unlock":
          if (lockedUntil > now()) throw `lockout:${lockedUntil - now()}`;
          if (s("pin") === pin) {
            fails = 0;
            unlocked = true;
            break;
          }
          fails++;
          if (fails >= 5) {
            const secs = Math.min(900, 30 << Math.min(10, fails - 5));
            lockedUntil = now() + secs;
            throw `lockout:${secs}`;
          }
          throw `wrong:${5 - fails}`;
        case "vault_lock":
          unlocked = false;
          pending = null;
          break;
        case "vault_save_password": {
          if (!s("name").trim() || !s("password")) throw "missing";
          const id = a.id as string | null;
          if (id) {
            need(pinPasswords);
            items = items.map((i) => (i.id === id ? { ...i, name: s("name").trim(), username: s("username").trim(), secret: s("password") } : i));
          } else {
            items.push({ id: crypto.randomUUID(), kind: "password", name: s("name").trim(), username: s("username").trim(), secret: s("password"), period: 30 });
          }
          break;
        }
        case "vault_add_totp": {
          if (!s("name").trim()) throw "missing";
          const secret = a.secret as string | null;
          if (secret === null && !pending) throw "no-scan";
          if (secret !== null && !/^[A-Za-z2-7\s=-]{16,}$/.test(secret.trim()) && !secret.startsWith("otpauth://")) throw "secret";
          items.push({ id: crypto.randomUUID(), kind: "totp", name: s("name").trim(), username: s("account").trim() || pending?.account || "", secret: "", period: 30 });
          pending = null;
          break;
        }
        case "vault_delete":
          need(true);
          items = items.filter((i) => i.id !== a.id);
          break;
        case "vault_reveal":
          need(pinPasswords);
          return (items.find((i) => i.id === a.id)?.secret ?? "") as T;
        case "vault_copy": {
          const field = s("field");
          need(field === "password" ? pinPasswords : field === "code" ? pinTotp : false);
          break;
        }
        case "vault_codes": {
          need(pinTotp);
          const t = now();
          return items.filter((i) => i.kind === "totp").map((i) => ({ id: i.id, code: code(i.id, Math.floor(t / 30)), remaining: 30 - (t % 30), period: 30 })) as T;
        }
        case "vault_options":
          need((!a.pinPasswords && pinPasswords) || (!a.pinTotp && pinTotp));
          pinPasswords = !!a.pinPasswords;
          pinTotp = !!a.pinTotp;
          break;
        case "vault_change_pin":
          if (!/^\d{4}$/.test(s("pin"))) throw "pin-format";
          need(true);
          pin = s("pin");
          break;
        case "vault_reset":
          pin = null;
          unlocked = false;
          items = [];
          fails = 0;
          lockedUntil = 0;
          break;
        case "vault_scan":
          pending = { issuer: "GitHub", account: "linus@hey.com" };
          return pending as T;
      }
      return undefined as T;
    },
  };
})();
