import { useState } from "react";
import { media, useNowPlaying } from "../platform/media";
import { mockDiscord, mockPrivacy } from "../platform/services";

/**
 * Browser only: fakes a Windows 11 desktop so design and motion can be judged
 * without Tauri. Not rendered in the app.
 */
export function DesktopMock() {
  const [light, setLight] = useState(false);
  const np = useNowPlaying();

  return (
    <div
      className="fixed inset-0"
      style={{
        background: light
          ? "radial-gradient(120% 90% at 70% 110%, #9fc3ff 0%, #dbe7ff 45%, #f3f6fb 80%)"
          : "radial-gradient(90% 70% at 60% 115%, #3c7bff 0%, #1d3fa6 30%, #0b1a4a 60%, #050a1c 100%)",
        transition: "background 400ms ease",
      }}
    >
      {/* A maximized window so the notch sits over real content. */}
      <div
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
      </div>

      {/* Dev panel */}
      <div className="fixed right-4 bottom-16 z-10 flex gap-2 rounded-xl bg-black/60 p-2 text-xs text-white backdrop-blur">
        <DevButton onClick={media.toggle}>{np?.isPlaying ? "Pause" : "Play"}</DevButton>
        <DevButton onClick={media.next}>Nächster Song</DevButton>
        <DevButton onClick={() => mockDiscord.toggleCall()}>Discord-Anruf</DevButton>
        <DevButton onClick={() => (mockPrivacy.mic = !mockPrivacy.mic)}>Mikro</DevButton>
        <DevButton onClick={() => (mockPrivacy.screen = !mockPrivacy.screen)}>Aufnahme</DevButton>
        <DevButton onClick={() => setLight((l) => !l)}>{light ? "Dunkel" : "Hell"}</DevButton>
      </div>

      {/* Fake taskbar */}
      <div
        className="fixed inset-x-0 bottom-0 h-12 backdrop-blur-xl"
        style={{ background: light ? "rgb(243 243 243 / 0.8)" : "rgb(28 28 28 / 0.8)" }}
      />
    </div>
  );
}

function DevButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="rounded-lg bg-white/10 px-3 py-1.5 hover:bg-white/20">
      {children}
    </button>
  );
}
