/**
 * Bright accent color from a cover, like Apple Music / Dynamic Island.
 * Shrink the image to 24×24, weight pixels by saturation, then raise the lightness
 * so the color reads well on black.
 */
const FALLBACK = "#ffffff";
const cache = new Map<string, string>();

export async function accentFrom(src: string | null): Promise<string> {
  if (!src) return FALLBACK;
  const hit = cache.get(src);
  if (hit) return hit;

  const img = new Image();
  img.src = src;
  try {
    await img.decode();
  } catch {
    return FALLBACK;
  }

  const size = 24;
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return FALLBACK;
  ctx.drawImage(img, 0, 0, size, size);
  const data = ctx.getImageData(0, 0, size, size).data;

  let r = 0, g = 0, b = 0, total = 0;
  for (let i = 0; i < data.length; i += 4) {
    const [, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    // Colorful mid-light pixels count a lot; gray, black and white barely.
    const weight = s * s * (1 - Math.abs(l - 0.5) * 2) + 0.001;
    r += data[i] * weight;
    g += data[i + 1] * weight;
    b += data[i + 2] * weight;
    total += weight;
  }

  const [h, s, l] = rgbToHsl(r / total, g / total, b / total);
  // Almost gray covers → neutral white instead of a muddy color.
  const color = s < 0.12 ? FALLBACK : hsl(h, Math.min(1, s * 1.15 + 0.1), Math.min(0.72, Math.max(0.6, l)));
  cache.set(src, color);
  return color;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function hsl(h: number, s: number, l: number): string {
  return `hsl(${h.toFixed(0)} ${(s * 100).toFixed(0)}% ${(l * 100).toFixed(0)}%)`;
}
