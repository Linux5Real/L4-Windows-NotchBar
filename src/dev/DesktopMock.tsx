import { useEffect, useState } from "react";
import { media, useNowPlaying } from "../platform/media";
import { mockDiscord, mockPrivacy } from "../platform/services";
import { showcase } from "./showcase-data";

/**
 * Browser only: fakes a Windows 11 desktop so design and motion can be judged
 * without Tauri. Not rendered in the app.
 */
export function DesktopMock() {
  const [light, setLight] = useState(false);
  const np = useNowPlaying();

  return (
    <>
    <div
      className="fixed inset-0"
      style={{
        // Showcase: brighter at the top so the black notch reads clearly in captures.
        background: showcase
          ? "radial-gradient(60% 55% at 50% 0%, #6d8cff 0%, rgb(109 140 255 / 0) 72%), radial-gradient(70% 70% at 88% 105%, #8a4dff 0%, rgb(138 77 255 / 0) 62%), linear-gradient(180deg, #2a3c9e 0%, #121a5c 55%, #080c2a 100%)"
          : light
          ? "radial-gradient(120% 90% at 70% 110%, #9fc3ff 0%, #dbe7ff 45%, #f3f6fb 80%)"
          : "radial-gradient(90% 70% at 60% 115%, #3c7bff 0%, #1d3fa6 30%, #0b1a4a 60%, #050a1c 100%)",
        transition: "background 400ms ease",
      }}
    >
      {/* A maximized window so the notch sits over real content (not in the showcase: clean desktop). */}
      {!showcase && <div
        className="absolute inset-x-[12%] top-[14%] bottom-[18%] overflow-hidden rounded-lg shadow-2xl"
        style={{ background: light ? "#ffffff" : "#202020", color: light ? "#111" : "#eee" }}
      >
        <div
          className="flex h-8 items-center px-3 text-xs opacity-70"
          style={{ background: light ? "#f3f3f3" : "#2b2b2b" }}
        >
          Datei-Explorer
        </div>
        <div className="space-y-2 p-6 text-sm opacity-60">
          <div>Dokumente</div>
          <div>Downloads</div>
          <div>Bilder</div>
        </div>
      </div>}

      {/* Dev panel */}
      {!showcase && <div className="fixed right-4 bottom-16 z-10 flex gap-2 rounded-xl bg-black/60 p-2 text-xs text-white backdrop-blur">
        <DevButton onClick={media.toggle}>{np?.isPlaying ? "Pause" : "Play"}</DevButton>
        <DevButton onClick={media.next}>Nächster Song</DevButton>
        <DevButton onClick={() => mockDiscord.toggleCall()}>Discord-Anruf</DevButton>
        <DevButton onClick={() => (mockPrivacy.mic = !mockPrivacy.mic)}>Mikro</DevButton>
        <DevButton onClick={() => (mockPrivacy.screen = !mockPrivacy.screen)}>Aufnahme</DevButton>
        <DevButton onClick={() => setLight((l) => !l)}>{light ? "Dunkel" : "Hell"}</DevButton>
      </div>}

      {/* Fake taskbar */}
      <div
        className="fixed inset-x-0 bottom-0 h-12 backdrop-blur-xl"
        style={{ background: light ? "rgb(243 243 243 / 0.8)" : "rgb(28 28 28 / 0.8)" }}
      >
        {showcase && <WindowsLogo />}
      </div>
    </div>
    {/* Outside the desktop's stacking context so it can sit above the notch. */}
    {showcase && <ShowcaseCursor />}
    </>
  );
}

/** Start button in the middle of the fake taskbar. */
function WindowsLogo() {
  return (
    <div className="absolute top-1/2 left-1/2 grid -translate-x-1/2 -translate-y-1/2 grid-cols-2 gap-[2px]">
      {[0, 1, 2, 3].map((i) => (
        <span key={i} className="size-[9px] rounded-[1px]" style={{ background: "linear-gradient(135deg, #5ec8ff, #1f7ae0)" }} />
      ))}
    </div>
  );
}

/** Headless captures draw no cursor; this one follows the (synthetic) mouse. */
function ShowcaseCursor() {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const move = (e: PointerEvent) => setPos({ x: e.clientX, y: e.clientY });
    window.addEventListener("pointermove", move, { capture: true });
    return () => window.removeEventListener("pointermove", move, { capture: true });
  }, []);
  if (!pos) return null;
  return (
    <svg className="pointer-events-none fixed z-[60]" style={{ left: pos.x - 1, top: pos.y - 1 }} width="17" height="25" viewBox="0 0 17 25" aria-hidden>
      <path d="M1.5 1.5v19.2l4.6-4.4 3 7 3.2-1.4-3-6.9h6.4z" fill="#fff" stroke="#000" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

function DevButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="rounded-lg bg-white/10 px-3 py-1.5 hover:bg-white/20">
      {children}
    </button>
  );
}
