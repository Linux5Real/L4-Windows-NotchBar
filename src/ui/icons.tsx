import { forwardRef, type ReactElement } from "react";
import { IconBase, type Icon, type IconWeight } from "@phosphor-icons/react";

/**
 * Eigene Symbole im Phosphor-Raster (256er viewBox, runde Enden), wo Phosphor
 * zu verspielt ist. Gleiche API wie Phosphor (`size`, `weight`, `className`).
 */
const stroke: Record<IconWeight, number> = { thin: 8, light: 12, regular: 16, bold: 24, fill: 24, duotone: 16 };

function make(name: string, draw: (w: number) => ReactElement): Icon {
  const weights = new Map<IconWeight, ReactElement>(
    (Object.keys(stroke) as IconWeight[]).map((k) => [
      k,
      <g key={k} fill="none" stroke="currentColor" strokeWidth={stroke[k]} strokeLinecap="round" strokeLinejoin="round">
        {draw(stroke[k])}
      </g>,
    ]),
  );
  const C = forwardRef<SVGSVGElement, Parameters<Icon>[0]>((props, ref) => <IconBase ref={ref} {...props} weights={weights} />);
  C.displayName = name;
  return C as Icon;
}

/** RAM: schlanker Riegel mit vier Kontakten, Kerbe in der Mitte. */
export const RamIcon = make("RamIcon", () => (
  <>
    <rect x="28" y="72" width="200" height="84" rx="18" />
    <path d="M72 156v28M104 156v28M152 156v28M184 156v28" />
  </>
));

/** GPU: Karte mit einem Lüfter, Slotblech links. */
export const GpuIcon = make("GpuIcon", () => (
  <>
    <rect x="44" y="64" width="184" height="112" rx="20" />
    <circle cx="112" cy="120" r="28" />
    <path d="M172 104h24M172 136h24M44 176v24M28 64h16" />
  </>
));

/** Depot: eine ruhige Kurslinie nach oben. */
export const DepotIcon = make("DepotIcon", () => (
  <>
    <path d="M32 184l56-56 40 32 96-88" />
    <path d="M168 72h56v56" />
  </>
));
