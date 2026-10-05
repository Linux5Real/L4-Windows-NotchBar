import { settings } from "../settings/store";
import { en } from "./en";

/*
 * Übersetzung: Der deutsche Text steht direkt im Code und ist zugleich der Schlüssel,
 * `en.ts` liefert die englische Fassung. Fehlt ein Eintrag, bleibt es deutsch.
 * Platzhalter: t("vor {n} Min.", { n: 5 }).
 *
 * Kein Hook nötig: Die Notch abonniert die Einstellungen und rendert beim Sprachwechsel
 * den ganzen Baum neu. Konstanten auf Modulebene (Listen mit Labels) erst beim Rendern
 * durch t() schicken, sonst bleiben sie in der Startsprache.
 */
export type Language = "de" | "en";

export function lang(): Language {
  return settings.get().language;
}

export function t(de: string, vars?: Record<string, string | number>): string {
  let s = lang() === "en" ? (en[de] ?? de) : de;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

/** Locale für Intl (Zahlen, Datum, Wochentage). */
export function locale(): string {
  return lang() === "en" ? "en-GB" : "de-DE";
}

/** Fehlertexte aus Rust (AI-Chat, Converter) kommen deutsch → hier per Muster übersetzen. */
const backendPatterns: [RegExp, string][] = [
  [/^Kein Modell eingetragen$/, "No model set"],
  [/^Base-URL muss mit https:\/\/ beginnen$/, "Base URL must start with https://"],
  [/^Unbekannter Anbieter: (.*)$/, "Unknown provider: $1"],
  [/^Schlüssel abgelehnt \((\d+)\) – (.*)$/s, "Key rejected ($1) – $2"],
  [/^Nicht gefunden \(404\) – Base-URL oder Modell prüfen\. (.*)$/s, "Not found (404) – check base URL or model. $1"],
  [/^Limit erreicht \(429\) – kurz warten$/, "Rate limit reached (429) – wait a moment"],
  [/^Fehler (\d+): (.*)$/s, "Error $1: $2"],
  [/^Datei nicht mehr vorhanden$/, "File no longer exists"],
  [/^Dateien nicht mehr vorhanden$/, "Files no longer exist"],
  [/^Ist schon in diesem Format$/, "Already in this format"],
  [/^Format wird nicht unterstützt$/, "Format not supported"],
  [/^Kann nicht speichern: (.*)$/s, "Cannot save: $1"],
  [/^Zielformat für Bilder nicht verfügbar$/, "Target format not available for images"],
  [/^Zielformat für Audio\/Video nicht verfügbar$/, "Target format not available for audio/video"],
  [/^Zielformat für Dokumente nicht verfügbar$/, "Target format not available for documents"],
  [/^Zielformat für Tabellen nicht verfügbar$/, "Target format not available for spreadsheets"],
  [/^Datei nicht lesbar: (.*)$/s, "Cannot read file: $1"],
  [/^PDF-Text nicht lesbar \(evtl\. nur Bilder\/Scan\)$/, "Cannot read PDF text (maybe only images/scan)"],
  [/^Keine gültige DOCX-Datei$/, "Not a valid DOCX file"],
  [/^DOCX-Inhalt nicht lesbar$/, "Cannot read DOCX content"],
  [/^Tabelle nicht lesbar$/, "Cannot read spreadsheet"],
  [/^Tabelle hat kein Blatt$/, "Spreadsheet has no sheet"],
  [/^Tabelle ist leer$/, "Spreadsheet is empty"],
  [/^CSV nicht lesbar$/, "Cannot read CSV"],
  [/^Für PDF wird Microsoft Edge oder Chrome benötigt$/, "PDF needs Microsoft Edge or Chrome"],
  [/^PDF konnte nicht erstellt werden$/, "PDF could not be created"],
  [/^PDF-Druck startet nicht: (.*)$/s, "PDF printing failed to start: $1"],
  [/^Umwandlung fehlgeschlagen: (.*)$/s, "Conversion failed: $1"],
  [/^ffmpeg startet nicht: (.*)$/s, "ffmpeg won't start: $1"],
  [/^Client-Secret fehlt$/, "Client secret missing"],
  [/^Keine Verbindung$/, "No connection"],
  [/^Keine Verbindung: (.*)$/s, "No connection: $1"],
  [/^Bild konnte nicht gelesen werden$/, "Cannot read image"],
  [/^Kein Token$/, "No token received"],
  [/^Kein Code$/, "No code received"],
  [/^Token abgelehnt$/, "Token rejected"],
  [/^Abgelehnt$/, "Declined"],
  [/^Weiterleitung im Portal löschen$/, "Remove the redirect in the developer portal"],
];

export function tBackend(msg: string): string {
  if (lang() !== "en") return msg;
  for (const [re, en] of backendPatterns) if (re.test(msg)) return msg.replace(re, en);
  return msg;
}
