// Kein Konsolenfenster im Release-Build.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Erhöhter Hilfsaufruf aus "FPS freischalten": Rechte vergeben und sofort beenden —
    // vor run(), sonst würde der Single-Instance-Schutz ihn an die laufende App weiterreichen.
    let args: Vec<String> = std::env::args().collect();
    if let [_, flag, sid] = args.as_slice() {
        if flag == "--fps-unlock" {
            std::process::exit(notch_lib::fps_elevated_unlock(sid));
        }
    }
    notch_lib::run()
}
