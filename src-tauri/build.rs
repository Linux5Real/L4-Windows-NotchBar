fn main() {
    // Das exe-Icon wird als Ressource eingebettet; ohne diese Zeile bleibt nach
    // `tauri icon` das alte Icon in der exe, bis Cargo das Build-Skript zufällig neu ausführt.
    println!("cargo:rerun-if-changed=icons/icon.ico");
    tauri_build::build()
}
