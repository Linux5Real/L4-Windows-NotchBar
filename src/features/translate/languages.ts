/*
 * Languages offered by the translator. Native names on purpose: they need no
 * translation themselves and stay readable no matter the app language.
 */

export interface Language {
  code: string;
  name: string;
}

/** Sorted by code; Google and MyMemory both understand these. */
export const languages: Language[] = [
  { code: "af", name: "Afrikaans" },
  { code: "ar", name: "العربية" },
  { code: "bg", name: "Български" },
  { code: "bn", name: "বাংলা" },
  { code: "ca", name: "Català" },
  { code: "cjk", name: "日本語" },
  { code: "cs", name: "Čeština" },
  { code: "da", name: "Dansk" },
  { code: "de", name: "Deutsch" },
  { code: "el", name: "Ελληνικά" },
  { code: "en", name: "English" },
  { code: "es", name: "Español" },
  { code: "et", name: "Eesti" },
  { code: "fa", name: "فارسی" },
  { code: "fi", name: "Suomi" },
  { code: "fr", name: "Français" },
  { code: "he", name: "עברית" },
  { code: "hi", name: "हिन्दी" },
  { code: "hr", name: "Hrvatski" },
  { code: "hu", name: "Magyar" },
  { code: "id", name: "Indonesia" },
  { code: "it", name: "Italiano" },
  { code: "ja", name: "日本語" },
  { code: "ko", name: "한국어" },
  { code: "lt", name: "Lietuvių" },
  { code: "lv", name: "Latviešu" },
  { code: "ms", name: "Melayu" },
  { code: "nl", name: "Nederlands" },
  { code: "no", name: "Norsk" },
  { code: "pl", name: "Polski" },
  { code: "pt", name: "Português" },
  { code: "ro", name: "Română" },
  { code: "ru", name: "Русский" },
  { code: "sk", name: "Slovenčina" },
  { code: "sl", name: "Slovenščina" },
  { code: "sq", name: "Shqip" },
  { code: "sr", name: "Српски" },
  { code: "sv", name: "Svenska" },
  { code: "th", name: "ไทย" },
  { code: "tr", name: "Türkçe" },
  { code: "uk", name: "Українська" },
  { code: "ur", name: "اردو" },
  { code: "vi", name: "Tiếng Việt" },
  { code: "zh", name: "中文 (简体)" },
  { code: "zh-CN", name: "中文 (简体)" },
  { code: "zh-TW", name: "中文 (繁體)" },
];

/** Detected codes that differ from our list (older Google spellings, variants). */
const aliases: Record<string, string> = {
  iw: "he",
  in: "id",
  ji: "yi",
  zh: "zh-CN",
  "zh-Hans": "zh-CN",
  "zh-Hant": "zh-TW",
  "pt-BR": "pt",
  "pt-PT": "pt",
};

/** Native name for a code ("de" → "Deutsch"); unknown codes show the code itself. */
export function languageLabel(code: string | undefined): string {
  if (!code) return "";
  const normalized = aliases[code] ?? code;
  const exact = languages.find((l) => l.code === normalized);
  if (exact) return exact.name;
  const base = normalized.split("-")[0];
  return languages.find((l) => l.code === (aliases[base] ?? base))?.name ?? code.toUpperCase();
}
