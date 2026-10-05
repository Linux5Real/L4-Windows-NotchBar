/*
 * Alarm-Töne per WebAudio — keine Audiodateien nötig. Klassische Wecker-Muster:
 * jedes Muster ist eine kurze Phrase, die bis zur gewählten Dauer wiederholt wird.
 */
export type AlarmSound = "chime" | "bell" | "digital" | "radar" | "marimba" | "soft";
/** Sekunden; 0 = einmal, -1 = bis zum Stoppen (max. 2 Minuten). */
export type AlarmDuration = 0 | 5 | 15 | 30 | -1;

export const alarmSounds: { value: AlarmSound; label: string }[] = [
  { value: "chime", label: "Gong" },
  { value: "bell", label: "Glocke" },
  { value: "digital", label: "Digitalwecker" },
  { value: "radar", label: "Radar" },
  { value: "marimba", label: "Marimba" },
  { value: "soft", label: "Sanft" },
];

interface Note {
  freq: number;
  at: number;
  /** Abklingzeit in s. */
  decay: number;
  type?: OscillatorType;
  /** Obertöne (Vielfache + relative Lautstärke) für Glocken-Klang. */
  partials?: [number, number][];
  gain?: number;
}

/** Eine Phrase pro Ton; `length` = Abstand bis zur Wiederholung. */
const patterns: Record<AlarmSound, { notes: Note[]; length: number }> = {
  chime: {
    notes: [
      { freq: 880, at: 0, decay: 1.4 },
      { freq: 1318.5, at: 0.16, decay: 1.4 },
    ],
    length: 1.8,
  },
  bell: {
    notes: [{ freq: 660, at: 0, decay: 2.4, partials: [[2, 0.5], [3, 0.25], [4.2, 0.18], [5.4, 0.1]] }],
    length: 1.6,
  },
  digital: {
    notes: [0, 0.14, 0.28, 0.42].map((at) => ({ freq: 2048, at, decay: 0.09, type: "square" as const, gain: 0.35 })),
    length: 1.0,
  },
  radar: {
    notes: [0, 0.12, 0.24, 0.36].map((at, i) => ({ freq: 1046.5 * (1 + i * 0.06), at, decay: 0.16, type: "triangle" as const, gain: 0.8 })),
    length: 1.1,
  },
  marimba: {
    notes: [
      { freq: 523.25, at: 0, decay: 0.5, partials: [[4, 0.15]] },
      { freq: 659.25, at: 0.15, decay: 0.5, partials: [[4, 0.15]] },
      { freq: 783.99, at: 0.3, decay: 0.5, partials: [[4, 0.15]] },
      { freq: 1046.5, at: 0.45, decay: 0.8, partials: [[4, 0.15]] },
    ],
    length: 1.5,
  },
  soft: {
    notes: [
      { freq: 587.33, at: 0, decay: 1.8, gain: 0.7 },
      { freq: 880, at: 0.5, decay: 2.2, gain: 0.55 },
    ],
    length: 2.8,
  },
};

const MAX_RING_S = 120;
let ctx: AudioContext | null = null;
let stopCurrent: (() => void) | null = null;

/** Spielt den Alarm; gibt eine Stopp-Funktion zurück. Ein neuer Alarm stoppt den alten. */
export function playAlarm(sound: AlarmSound, volume: number, duration: AlarmDuration): () => void {
  stopCurrent?.();
  ctx ??= new AudioContext();
  const c = ctx;
  void c.resume();
  const master = c.createGain();
  master.gain.value = Math.max(0, Math.min(1, volume)) * 0.5;
  master.connect(c.destination);

  const { notes, length } = patterns[sound];
  const total = duration === 0 ? length : duration === -1 ? MAX_RING_S : duration;
  const repeats = Math.max(1, Math.floor(total / length));
  const start = c.currentTime + 0.02;
  const nodes: OscillatorNode[] = [];

  for (let r = 0; r < repeats; r++) {
    for (const n of notes) {
      const t = start + r * length + n.at;
      for (const [mult, rel] of [[1, 1], ...(n.partials ?? [])] as [number, number][]) {
        const osc = c.createOscillator();
        const g = c.createGain();
        osc.type = n.type ?? "sine";
        osc.frequency.value = n.freq * mult;
        const peak = 0.25 * (n.gain ?? 1) * rel;
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(peak, t + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, t + n.decay);
        osc.connect(g).connect(master);
        osc.start(t);
        osc.stop(t + n.decay + 0.05);
        nodes.push(osc);
      }
    }
  }

  const stop = () => {
    // Weich ausblenden statt hart abschneiden.
    master.gain.cancelScheduledValues(c.currentTime);
    master.gain.setTargetAtTime(0, c.currentTime, 0.05);
    window.setTimeout(() => {
      nodes.forEach((o) => {
        try {
          o.stop();
        } catch {
          // Schon beendet.
        }
      });
      master.disconnect();
    }, 300);
    if (stopCurrent === stop) stopCurrent = null;
  };
  stopCurrent = stop;
  window.setTimeout(() => stopCurrent === stop && (stopCurrent = null), (repeats * length + 2) * 1000);
  return stop;
}

/** Läuft gerade ein Alarm? */
export function alarmRinging(): boolean {
  return stopCurrent !== null;
}

export function stopAlarm() {
  stopCurrent?.();
}
