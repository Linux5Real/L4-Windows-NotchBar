//! Checks the Ask backend with a real streaming call through the app's code.
//! The key comes from the environment (NOTCH_AI_KEY), never from a file.
//!   NOTCH_AI_KEY=… cargo run --example ai_check -- custom https://…/v1 grok-4.7 low [--store]
//! `--store` also saves the key as "Notch/ai.<provider>".
use std::io::Write;
use std::time::Instant;

use notch_lib::ai::{stream_chat, ChatConfig};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let key = std::env::var("NOTCH_AI_KEY").expect("NOTCH_AI_KEY not set");
    let provider = args[0].clone();
    let config = ChatConfig { provider: provider.clone(), base_url: Some(args[1].clone()), model: args[2].clone(), effort: args.get(3).cloned() };
    let messages: Vec<notch_lib::ai::Msg> = serde_json::from_value(serde_json::json!([{ "role": "user", "content": "Antworte in genau einem kurzen Satz: Was ist eine Notch?" }])).unwrap();

    let start = Instant::now();
    let mut first: Option<f32> = None;
    let mut chunks = 0;
    let result = tauri::async_runtime::block_on(stream_chat(&config, &key, &messages, |t| {
        first.get_or_insert(start.elapsed().as_secs_f32());
        chunks += 1;
        print!("{t}");
        let _ = std::io::stdout().flush();
    }, || false));
    println!("\n---\nresult={result:?} chunks={chunks} first_token={first:?}s total={:.1}s", start.elapsed().as_secs_f32());

    if args.iter().any(|a| a == "--store") {
        let name = format!("ai.{provider}");
        notch_lib::secrets::secret_set(name.clone(), key.clone()).expect("saving failed");
        println!("stored as Notch/{name}, read back ok: {}", notch_lib::secrets::read(&name).as_deref() == Some(key.as_str()));
    }
}
