import { isNative } from "../platform/native";

/*
 * Browser only: `?showcase` swaps the mock backends for realistic English demo
 * data (README screenshots, launch video). Never active in the app.
 * Pure data here, so the mocks in src/platform can import it without cycles.
 */
export const showcase = !isNative && new URLSearchParams(location.search).has("showcase");

function cover(a: string, b: string, c: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <defs>
      <radialGradient id="g" cx="28%" cy="22%" r="95%">
        <stop offset="0" stop-color="${a}"/><stop offset="0.5" stop-color="${b}"/><stop offset="1" stop-color="${c}"/>
      </radialGradient>
      <linearGradient id="l" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="${c}" stop-opacity="0.9"/><stop offset="1" stop-color="${a}" stop-opacity="0"/></linearGradient>
    </defs>
    <rect width="100" height="100" fill="url(#g)"/>
    <path d="M0 74 Q 30 58 55 70 T 100 62 V 100 H 0 Z" fill="url(#l)"/>
    <circle cx="70" cy="34" r="13" fill="${a}" opacity="0.55"/>
  </svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export const showcaseTracks = [
  { title: "Midnight City", artist: "M83", artwork: cover("#ff8ad8", "#7b3fe4", "#140833"), accent: "#d58bff", duration: 243 },
  { title: "Tadow", artist: "Masego, FKJ", artwork: cover("#ffd27a", "#e8642c", "#3a1206"), accent: "#ff9f5a", duration: 301 },
];

/** Where the first track starts (seconds). */
export const showcaseStartPosition = 72;

// ---------- Trading 212 ----------

/*
 * A plausible depot. Values in EUR; US stocks converted at 1.17 USD/EUR.
 *   VWCE  72 × €138.40            avg €112.35
 *   NVDA  38 × $183.20            avg $121.50
 *   MSFT   9 × $512.30            avg $428.00
 *   AAPL  16 × $246.80            avg $229.40
 *   ASML   4 × €712.60            avg €748.10
 * Positions €26,081.10 + cash €612.45 = €26,693.55. Today +€312.40 (+1.18 %).
 */
const usd = (v: number) => Math.round((v / 1.17) * 100) / 100;
const position = (ticker: string, name: string, quantity: number, averagePrice: number, currentPrice: number, priceCurrency: "EUR" | "USD") => {
  const conv = priceCurrency === "USD" ? usd : (v: number) => Math.round(v * 100) / 100;
  const value = conv(quantity * currentPrice);
  const cost = conv(quantity * averagePrice);
  return { ticker, name, quantity, averagePrice, currentPrice, priceCurrency, value, cost, pnl: Math.round((value - cost) * 100) / 100 };
};

export const showcasePositions = [
  position("VWCE", "Vanguard FTSE All-World (Acc)", 72, 112.35, 138.4, "EUR"),
  position("NVDA", "NVIDIA", 38, 121.5, 183.2, "USD"),
  position("MSFT", "Microsoft", 9, 428.0, 512.3, "USD"),
  position("AAPL", "Apple", 16, 229.4, 246.8, "USD"),
  position("ASML", "ASML Holding", 4, 748.1, 712.6, "EUR"),
];
export const showcaseCash = 612.45;
export const showcaseRealized = 418.2;
export const showcaseDayChange = 312.4;

// ---------- Discord ----------

export const showcaseCall = {
  channelName: "Launch Prep",
  guildName: "Pixel Forge",
  members: [
    { id: "1", name: "alex", avatar: 0 },
    { id: "2", name: "mira.codes", avatar: 1 },
    { id: "3", name: "kenji_42", avatar: 2 },
    { id: "4", name: "theo.wav", avatar: 3 },
  ],
};

// ---------- Clipboard ----------

function screenshot(w: number, h: number): string {
  // A desktop screenshot in miniature: wallpaper, a window and a notch.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">
    <defs><radialGradient id="g" cx="62%" cy="115%" r="95%"><stop offset="0" stop-color="#3c7bff"/><stop offset="0.35" stop-color="#1d3fa6"/><stop offset="0.7" stop-color="#0b1a4a"/><stop offset="1" stop-color="#050a1c"/></radialGradient></defs>
    <rect width="${w}" height="${h}" fill="url(#g)"/>
    <rect x="${w * 0.14}" y="${h * 0.2}" width="${w * 0.72}" height="${h * 0.62}" rx="${h * 0.02}" fill="#202020"/>
    <rect x="${w * 0.14}" y="${h * 0.2}" width="${w * 0.72}" height="${h * 0.05}" rx="${h * 0.02}" fill="#2b2b2b"/>
    <rect x="${w * 0.18}" y="${h * 0.32}" width="${w * 0.3}" height="${h * 0.035}" rx="${h * 0.01}" fill="#3a3a3a"/>
    <rect x="${w * 0.18}" y="${h * 0.4}" width="${w * 0.46}" height="${h * 0.035}" rx="${h * 0.01}" fill="#333"/>
    <rect x="${w * 0.18}" y="${h * 0.48}" width="${w * 0.38}" height="${h * 0.035}" rx="${h * 0.01}" fill="#333"/>
    <rect x="${w * 0.42}" y="0" width="${w * 0.16}" height="${h * 0.045}" rx="${h * 0.015}" fill="#000"/>
    <rect x="0" y="${h * 0.94}" width="${w}" height="${h * 0.06}" fill="#1c1c1c" opacity="0.85"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function photo(w: number, h: number): string {
  // A dusk landscape: warm sky, sun, layered hills.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">
    <defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2b2a6e"/><stop offset="0.45" stop-color="#c2417a"/><stop offset="0.75" stop-color="#ff9a5a"/><stop offset="1" stop-color="#ffd27a"/></linearGradient></defs>
    <rect width="${w}" height="${h}" fill="url(#s)"/>
    <circle cx="${w * 0.64}" cy="${h * 0.6}" r="${h * 0.13}" fill="#ffe3a3" opacity="0.95"/>
    <path d="M0 ${h * 0.66} Q ${w * 0.2} ${h * 0.52} ${w * 0.42} ${h * 0.64} T ${w} ${h * 0.6} V ${h} H 0 Z" fill="#5a2a5e" opacity="0.85"/>
    <path d="M0 ${h * 0.78} Q ${w * 0.3} ${h * 0.66} ${w * 0.58} ${h * 0.78} T ${w} ${h * 0.74} V ${h} H 0 Z" fill="#2e1640"/>
    <path d="M0 ${h * 0.9} Q ${w * 0.35} ${h * 0.82} ${w * 0.7} ${h * 0.9} T ${w} ${h * 0.88} V ${h} H 0 Z" fill="#160a24"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Ages in ms (relative to page load). */
export const showcaseClips = [
  { id: 1, kind: "image" as const, text: "4032 × 3024", thumbnail: photo(4032, 3024), folders: 0, age: 8_000 },
  { id: 2, kind: "link" as const, text: "https://github.com/Linux5Real/L4-Windows-NotchBar", thumbnail: null, folders: 0, age: 130_000 },
  { id: 3, kind: "text" as const, text: "export const open = spring(0.42, 0.24);", thumbnail: null, folders: 0, age: 380_000 },
  { id: 4, kind: "text" as const, text: "Rijksmuseum, Museumstraat 1, 1071 XX Amsterdam", thumbnail: null, folders: 0, age: 1_100_000 },
  { id: 5, kind: "files" as const, text: "Q3-Report.pdf\nBudget-2027.xlsx", thumbnail: null, folders: 0, age: 2_500_000 },
  { id: 6, kind: "text" as const, text: "Running ten minutes late, start without me.", thumbnail: null, folders: 0, age: 4_000_000 },
  { id: 7, kind: "image" as const, text: "2560 × 1440", thumbnail: screenshot(2560, 1440), folders: 0, age: 6_800_000 },
];

// ---------- Converter ----------

export const showcaseFileSizes: Record<string, number> = {
  "Screenshot 2026-10-05 093812.png": 2_518_000,
  "hero-banner.png": 3_204_000,
  "app-icon.png": 421_000,
};

// ---------- Ask ----------

export const showcaseAnswer =
  "Usually 3–6 GB. Chrome gives each site its own process: a light tab (articles, docs) needs about 50–150 MB, " +
  "heavy apps like Gmail, YouTube or Figma 300 MB to 1 GB each.\n\n" +
  "With 16 GB you're fine. On 8 GB, turn on Memory Saver (Settings → Performance) so inactive tabs go to sleep.";
