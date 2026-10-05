//! Backend-Prüfung ohne UI: cargo run --example backend_check -- <scratch-dir>
fn main() {
    let dir = std::env::args().nth(1).expect("Scratch-Verzeichnis angeben");
    let rt = tauri::async_runtime::block_on(notch_lib::usage::probe_for_test());
    // Nur Anzahl der Fenster bzw. Fehlercode — keine Kontodaten ausgeben.
    for (id, result) in rt {
        println!("usage {id}: {result:?}");
    }

    let png = format!("{dir}/test.png");
    image::RgbaImage::from_fn(64, 48, |x, y| image::Rgba([x as u8 * 4, y as u8 * 5, 120, if x < 10 { 0 } else { 255 }]))
        .save(&png)
        .unwrap();
    for target in ["jpg", "webp", "ico", "bmp", "png"] {
        match notch_lib::convert::convert_for_test(&png, target) {
            Ok(out) => {
                let name = std::path::Path::new(&out).file_name().unwrap().to_string_lossy().into_owned();
                println!("convert png->{target}: OK {name} ({} B)", std::fs::metadata(&out).unwrap().len());
            }
            Err(e) => println!("convert png->{target}: {e}"),
        }
    }
    let webp = format!("{dir}/test.webp");
    println!("convert webp->png: {:?}", notch_lib::convert::convert_for_test(&webp, "png").map(|_| "OK"));
}
