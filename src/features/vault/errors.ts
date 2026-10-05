import { t } from "../../i18n";

/** Rust error code → short sentence. */
export function errorText(code: string): string {
  switch (code) {
    case "missing":
      return t("Name und Passwort fehlen");
    case "secret":
      return t("Schlüssel ungültig");
    case "not-otp":
      return t("Kein 2FA-QR-Code");
    case "no-image":
      return t("Kein Bild in der Zwischenablage");
    case "no-qr":
      return t("Kein QR-Code erkannt");
    case "no-scan":
      return t("Erst QR-Code einfügen oder Schlüssel eingeben");
    case "clipboard":
      return t("Zwischenablage belegt, nochmal versuchen");
    case "hello-cancel":
      return t("Abgebrochen");
    case "hello-failed":
      return t("Windows Hello hat nicht geklappt");
    case "hello-missing":
      return t("Windows-Hello-Schlüssel fehlt");
    case "unreadable":
      return t("Tresor nicht lesbar");
    default:
      return code;
  }
}
