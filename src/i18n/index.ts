import { settings } from "../settings/store";
import { en } from "./en";

/*
 * Translation: the German text lives directly in the code and doubles as the key;
 * `en.ts` provides the English version. Missing entries stay German.
 * Placeholders: t("vor {n} Min.", { n: 5 }).
 *
 * No hook needed: the notch subscribes to the settings and re-renders the whole tree
 * when the language changes. Send module-level constants (label lists) through t()
 * only at render time, otherwise they stay in the startup language.
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

/** Locale for Intl (numbers, dates, weekdays). */
export function locale(): string {
  return lang() === "en" ? "en-GB" : "de-DE";
}

/** Error texts from Rust (AI chat, converter) arrive in German; translate them by pattern. */
const backendPatterns: [RegExp, string][] = [
  [/^Kein Modell eingetragen$/, "No model set"],
  [/^Base-URL muss mit https:\/\/ beginnen$/, "Base URL must start with https://"],
  [/^Unbekannter Anbieter: (.*)$/, "Unknown provider: $1"],
  [/^Schlüssel abgelehnt \((\d+)\) – (.*)$/s, "Key rejected ($1) – $2"],
  [/^Nicht gefunden \(404\) – Base-URL oder Modell prüfen\. (.*)$/s, "Not found (404) – check base URL or model. $1"],
  [/^Limit erreicht \(429\) – kurz warten$/, "Rate limit reached (429) – wait a moment"],
  [/^OpenCode ist nicht installiert\. (.*)$/s, "OpenCode is not installed. $1"],
  [/^OpenCode startet nicht: (.*)$/s, "OpenCode won't start: $1"],
  [/^OpenCode hat die Verbindung abgelehnt \((\d+)\)\. (.*)$/s, "OpenCode rejected the connection ($1). $2"],
  [/^OpenCode-Sitzung nicht gefunden \(404\)\. (.*)$/s, "OpenCode session not found (404). $1"],
  [/^OpenCode-Fehler (\d+): (.*)$/s, "OpenCode error $1: $2"],
  [/^OpenCode: Antwort unterbrochen – bitte erneut senden\.$/, "OpenCode: Response interrupted – please send again."],
  [/^OpenCode: (.*)$/s, "OpenCode: $1"],
  [/^Zeitüberschreitung – OpenCode antwortet nicht\.$/, "Timeout – OpenCode is not responding."],
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
  [/^Datei nicht lesbar$/, "Cannot read file"],
  [/^Bild konnte nicht dekodiert werden$/, "Image could not be decoded"],
  [/^Erkennung fehlgeschlagen$/, "Recognition failed"],
  [/^Kein Text erkannt$/, "No text recognized"],
  [/^App nicht gefunden: (.*)$/, "App not found: $1"],
  [/^Wonach soll gesucht werden\?$/, "What should be searched for?"],
  [/^App konnte nicht geöffnet werden \(Fehler (.*)\)$/, "App could not be opened (error $1)"],
  [/^Diese Sprache ist nicht installiert \(Einstellungen → Zeit & Sprache\)\.$/, "This language is not installed (Settings → Time & language)."],
  [/^Keine OCR-Sprache gefunden – Deutsch oder Arabisch installieren\.$/, "No OCR language found – install German or Arabic."],
  [/^Kein Token$/, "No token received"],
  [/^Kein Code$/, "No code received"],
  [/^Token abgelehnt$/, "Token rejected"],
  [/^Abgelehnt$/, "Declined"],
  [/^Im Portal http:\/\/localhost als Redirect eintragen$/, "Add http://localhost as a redirect in the developer portal"],
];

export function tBackend(msg: string): string {
  if (lang() !== "en") return msg;
  for (const [re, en] of backendPatterns) if (re.test(msg)) return msg.replace(re, en);
  return msg;
}
