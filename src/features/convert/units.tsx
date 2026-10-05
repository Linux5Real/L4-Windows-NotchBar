import { useState } from "react";
import { ArrowsLeftRight } from "@phosphor-icons/react";
import { Segmented, Select } from "../../ui/controls";
import { locale, t } from "../../i18n";

/*
 * Einheiten umrechnen (wie der Converter in OmniNotch): Länge, Gewicht,
 * Temperatur, Volumen, Tempo. Alles über einen Basiswert pro Kategorie;
 * Temperatur hat eigene Formeln.
 */
type Category = "length" | "mass" | "temp" | "volume" | "speed";

interface Unit {
  id: string;
  label: string;
  /** Faktor zur Basiseinheit (Meter, Kilogramm, Liter, m/s). */
  factor?: number;
}

const units: Record<Category, Unit[]> = {
  length: [
    { id: "mm", label: "Millimeter", factor: 0.001 },
    { id: "cm", label: "Zentimeter", factor: 0.01 },
    { id: "m", label: "Meter", factor: 1 },
    { id: "km", label: "Kilometer", factor: 1000 },
    { id: "in", label: "Zoll", factor: 0.0254 },
    { id: "ft", label: "Fuß", factor: 0.3048 },
    { id: "yd", label: "Yard", factor: 0.9144 },
    { id: "mi", label: "Meile", factor: 1609.344 },
  ],
  mass: [
    { id: "mg", label: "Milligramm", factor: 1e-6 },
    { id: "g", label: "Gramm", factor: 0.001 },
    { id: "kg", label: "Kilogramm", factor: 1 },
    { id: "t", label: "Tonne", factor: 1000 },
    { id: "oz", label: "Unze", factor: 0.028349523125 },
    { id: "lb", label: "Pfund (lb)", factor: 0.45359237 },
  ],
  temp: [
    { id: "c", label: "Celsius" },
    { id: "f", label: "Fahrenheit" },
    { id: "k", label: "Kelvin" },
  ],
  volume: [
    { id: "ml", label: "Milliliter", factor: 0.001 },
    { id: "l", label: "Liter", factor: 1 },
    { id: "m3", label: "Kubikmeter", factor: 1000 },
    { id: "tsp", label: "Teelöffel (US)", factor: 0.00492892 },
    { id: "cup", label: "Tasse (US)", factor: 0.2365882365 },
    { id: "floz", label: "fl oz (US)", factor: 0.0295735295625 },
    { id: "gal", label: "Gallone (US)", factor: 3.785411784 },
  ],
  speed: [
    { id: "ms", label: "m/s", factor: 1 },
    { id: "kmh", label: "km/h", factor: 1 / 3.6 },
    { id: "mph", label: "mph", factor: 0.44704 },
    { id: "kn", label: "Knoten", factor: 0.514444 },
  ],
};

const defaults: Record<Category, [string, string]> = {
  length: ["cm", "in"],
  mass: ["kg", "lb"],
  temp: ["c", "f"],
  volume: ["l", "gal"],
  speed: ["kmh", "mph"],
};

function toCelsius(v: number, u: string) {
  return u === "f" ? ((v - 32) * 5) / 9 : u === "k" ? v - 273.15 : v;
}
function fromCelsius(v: number, u: string) {
  return u === "f" ? (v * 9) / 5 + 32 : u === "k" ? v + 273.15 : v;
}

export function convertUnit(cat: Category, value: number, from: string, to: string): number {
  if (cat === "temp") return fromCelsius(toCelsius(value, from), to);
  const f = units[cat].find((u) => u.id === from)!.factor!;
  const t = units[cat].find((u) => u.id === to)!.factor!;
  return (value * f) / t;
}

function format(n: number): string {
  if (!Number.isFinite(n)) return "–";
  const abs = Math.abs(n);
  return n.toLocaleString(locale(), { maximumFractionDigits: abs >= 1000 ? 2 : abs >= 1 ? 4 : 6 });
}

export function UnitsPanel() {
  const [cat, setCat] = useState<Category>("length");
  const [[from, to], setPair] = useState(defaults.length);
  const [input, setInput] = useState("100");

  // Komma und Punkt gelten beide als Dezimaltrenner (1,5 = 1.5).
  const value = Number(input.replace(",", "."));
  const result = input.trim() === "" || Number.isNaN(value) ? null : convertUnit(cat, value, from, to);
  const options = units[cat].map((u) => ({ value: u.id, label: t(u.label) }));

  return (
    <div className="flex h-full flex-col gap-3">
      <Segmented
        id="units-cat"
        size="sm"
        value={cat}
        onChange={(c) => {
          setCat(c);
          setPair(defaults[c]);
        }}
        options={[
          { value: "length", label: t("Länge") },
          { value: "mass", label: t("Gewicht") },
          { value: "temp", label: t("Temperatur") },
          { value: "volume", label: t("Volumen") },
          { value: "speed", label: t("Tempo") },
        ]}
      />
      <div className="flex items-center gap-2">
        <div className="flex flex-1 flex-col gap-1.5 rounded-[12px] bg-fill-1 p-2.5">
          <input
            value={input}
            inputMode="decimal"
            onChange={(e) => setInput(e.target.value.replace(/[^\d.,-]/g, ""))}
            className="tabular w-full bg-transparent text-[22px] leading-7 font-semibold tracking-[-0.02em] text-label outline-none"
          />
          <Select value={from} options={options} onChange={(v) => setPair([v, to])} width="w-full" />
        </div>
        <button
          aria-label={t("Tauschen")}
          onClick={() => setPair([to, from])}
          className="pressable pressable-fill flex size-8 shrink-0 items-center justify-center rounded-full bg-fill-2 text-label-2"
        >
          <ArrowsLeftRight size={14} weight="bold" />
        </button>
        <div className="flex flex-1 flex-col gap-1.5 rounded-[12px] bg-fill-1 p-2.5">
          <div className="tabular truncate text-[22px] leading-7 font-semibold tracking-[-0.02em] text-label">{result === null ? "–" : format(result)}</div>
          <Select value={to} options={options} onChange={(v) => setPair([from, v])} width="w-full" />
        </div>
      </div>
    </div>
  );
}
