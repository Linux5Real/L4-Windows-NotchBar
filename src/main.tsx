import { StrictMode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { createRoot } from "react-dom/client";
import { MotionConfig } from "motion/react";
import "./styles/global.css";
import { Notch } from "./notch/Notch";
import { DesktopMock } from "./dev/DesktopMock";
import { isNative } from "./platform/native";
import { startDropListener } from "./platform/drop";
import { settings } from "./settings/store";
import { applyDisplay } from "./notch/drag";
import { startFocusMode } from "./notch/focus";
import { startSystemPolling } from "./features/system/store";
import { startGamingWatch } from "./features/system/gaming";
import { startDiscord } from "./features/discord/store";
import { startUpdateWatch } from "./lib/update";

startDropListener();
startFocusMode();
startSystemPolling();
startGamingWatch();
startDiscord();
startUpdateWatch();

// Darstellung (Monitor, Vollbild, Versatz, Gaming) an Rust geben — beim Start und bei jeder Änderung.
let lastDisplay = "";
const syncDisplay = () => {
  const { display, gaming } = settings.get();
  const key = `${display.visibility}|${display.monitor}|${display.offset}|${gaming.mode}`;
  if (key === lastDisplay) return;
  lastDisplay = key;
  applyDisplay();
};
syncDisplay();
settings.subscribe(syncDisplay);

// Sprache: Tray-Menü in Rust mitziehen und das lang-Attribut setzen.
let lastLang = "";
const applyLanguage = () => {
  const { language } = settings.get();
  if (language === lastLang) return;
  lastLang = language;
  document.documentElement.lang = language;
  if (isNative) void invoke("set_language", { lang: language });
};
applyLanguage();
settings.subscribe(applyLanguage);

// Die Notch ist keine Webseite: kein Browser-Kontextmenü (außer in Textfeldern für
// Ausschneiden/Einfügen) und in der App keine Browser-Kürzel wie Neu laden oder Drucken.
window.addEventListener("contextmenu", (e) => {
  if (!(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) e.preventDefault();
});
if (isNative) {
  window.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    if (e.key === "F5" || e.key === "F7" || e.key === "F12" || (e.ctrlKey && ["r", "p", "f", "g", "j", "u", "s"].includes(k))) e.preventDefault();
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* reducedMotion="user": Motion respektiert die Windows-Einstellung "Animationseffekte". */}
    <MotionConfig reducedMotion="user">
      {!isNative && <DesktopMock />}
      <Notch />
    </MotionConfig>
  </StrictMode>,
);
