fn main() {
    // The exe icon is embedded as a resource. Without this, a new icon from `tauri icon`
    // only shows up once Cargo happens to rerun the build script.
    println!("cargo:rerun-if-changed=icons/icon.ico");
    tauri_build::build()
}
