// No console window in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Elevated helper call from "Unlock FPS": grant rights and exit. Must run
    // before run(), otherwise single-instance would hand it to the running app.
    let args: Vec<String> = std::env::args().collect();
    if let [_, flag, sid] = args.as_slice() {
        if flag == "--fps-unlock" {
            std::process::exit(notch_lib::fps_elevated_unlock(sid));
        }
    }
    notch_lib::run()
}
