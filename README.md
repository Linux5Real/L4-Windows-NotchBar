# L4-Notchbar

A Dynamic-Island-style notch for Windows. Windows never had one, so I built it. It sits at the top of your screen, stays out of the way until you need it, and opens on hover, click or **Ctrl + Alt + Space**. Music, timers, files, your portfolio and a Discord call are all one glance away.

It runs on **Tauri 2, React 19, TypeScript, Motion and Tailwind 4**. The app uses WebView2 instead of bundling Chromium, so the release build is a single executable of a few megabytes. Animations stay smooth because the window itself never resizes. Only the content inside it moves.

## What it does

### Windows and system

- **Overview** is a small control center: time, weather, what is playing right now, Windows focus and a volume slider.
- **Now Playing** controls anything with a Windows media session (Spotify, browser players and so on) and shows cover, title, progress and a live equalizer driven by the actual audio output.
- **Clipboard** keeps a history of text, links, images and files, with search and previews. Password managers are excluded on purpose, and nothing is written to disk.
- **Shelf** is a parking spot for files. Drop them onto the Notch or press Ctrl + V, then open, copy or reveal them later.
- **Hardware** shows live CPU, RAM, GPU, VRAM and ping, with history that keeps recording while the Notch is closed.
- **Gaming mode** puts FPS, CPU, GPU and RAM into the closed Notch, always or only while a fullscreen app runs. FPS works for DirectX, OpenGL and Vulkan games. Windows only allows this for members of the *Performance Log Users* group: click **Settings → Display → Unlock FPS** once, confirm the Windows prompt, then sign out and back in. A lock icon in the Notch means this step is still missing.
- **Privacy dots** turn green when the microphone or camera is in use and red while the screen is being recorded, like on an iPhone.

### Services

- **Ask** is a chat with Claude, ChatGPT, OpenRouter or any OpenAI-compatible endpoint, with streaming and adjustable reasoning effort.
- **AI usage** shows your subscription limits for Claude, ChatGPT, Gemini and Cursor.
- **Weather** gives current conditions and a 7-day forecast through Open-Meteo. No API key needed.
- **Portfolio** connects to Trading 212 and shows profit and loss and a history chart, live or in demo mode. The app only reads, it never trades.
- **Discord** shows your current voice call with speaking members and buttons for mute, deafen and hang up. In the closed Notch, a green equalizer plays while someone talks.

### Local and offline

- **Timer** with focus and break presets, custom durations, six alarm sounds and a running countdown in the closed Notch. An expired timer stays visible until you dismiss it.
- **To-dos** and **notes** live on your machine and need no account.
- **Converter** handles units, images (PNG, JPG, WebP, ICO, BMP, DDS), documents (PDF, DOCX, TXT, Markdown, HTML), spreadsheets (XLSX, CSV, JSON) and audio or video if ffmpeg is installed.

## Install

1. Download `L4-Notchbar_x.y.z_x64-setup.exe` from the [latest release](https://github.com/Linux5Real/L4-Windows-NotchBar/releases/latest).
2. Run it. No Node, Rust or admin rights needed; it installs for your user only.
3. The notch appears at the top of your screen and starts with Windows from then on.

Built and tested on Windows 11; Windows 10 should work but is untested. If WebView2 is missing, the installer fetches it automatically.

The installer is not code-signed yet, so Windows SmartScreen may warn on first launch. Click **More info → Run anyway**.

### Updates

L4-Notchbar checks once a day whether a new version exists. The check is a single anonymous request to this repository's public release page; no personal data is sent. If an update is available, a dot appears on the gear icon and **Settings → General → Updates** shows the new version. Nothing is downloaded until you click **Update now**; the app then installs the update and restarts. Every update is cryptographically signed and verified before it is installed. You can turn the daily check off in the same place.

## Using it

| Action | How |
| --- | --- |
| Open or close | Hover, click or **Ctrl + Alt + Space** (choose the trigger in settings) |
| Switch tools | Tool bar at the bottom of the open Notch |
| Settings | Gear icon at the end of the tool bar, or **Settings …** in the tray menu |
| Tray icon | Left click opens the Notch, right click shows the menu (open, settings, autostart, quit) |
| Move the Notch | Drag it sideways, either closed or by its header. "Reset to center" is in settings |
| Focus mode | Click the Notch three times quickly. It turns half transparent and clicks pass through. Three more clicks bring it back |
| Add files | Drag them onto the Notch, or paste with Ctrl + V |

Settings are grouped into General, Display, Tools, Timer, AI and Connections. There you can reorder (drag) or hide tools, pick the monitor, hide the Notch automatically during fullscreen apps, enable autostart and switch between German and English.

## Setting up the integrations

All keys and secrets are stored in the Windows Credential Manager, never in a plain file, and they are never sent back to the interface.

**Ask.** Choose a provider in settings and paste your API key. For a custom endpoint, enter the base URL (usually ending in `/v1`) and a model ID.

**Portfolio.** In Trading 212 go to Settings, API (Beta) and create a key with permission for account data and portfolio. Nothing more is required. Paste key and secret into the L4-Notchbar settings.

**Discord.** Discord only hands out voice permissions to your own application:

1. Create an application at [discord.com/developers](https://discord.com/developers).
2. Under OAuth2, copy the **Client ID** and **Client Secret** into the L4-Notchbar settings.
3. Leave the redirect list empty. Discord rejects RPC authorization when one is set.
4. Join a call. Discord asks you once to confirm.

## Development

You need Node 22 or newer and Rust (stable). On Windows, the Visual Studio Build Tools with the C++ workload and a Windows 11 SDK are required for linking.

```bash
npm install
npm run dev        # browser with a fake desktop, ?slow=4 slows animations for tuning
npm run tauri dev  # the real app, run it in PowerShell
npm run typecheck  # before every commit
npm run i18n       # finds missing English strings (add --fix for TODO entries)
```

To build a standalone executable:

```bash
npx tauri build --no-bundle   # result: src-tauri/target/release/notch.exe
```

Release builds with installer and update signature need the signing key:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw "$HOME\.tauri\l4-notchbar.key"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
npx tauri build
```

Run Tauri commands from PowerShell. In Git Bash, `/usr/bin/link` shadows the MSVC linker and the build fails.

## Project layout

```
src/            React frontend: notch shape, tools, design tokens, i18n
src-tauri/      Rust backend: window, hit testing, tray and the Windows APIs
scripts/        Helper scripts such as the i18n check
```

## License

[GPL-3.0](LICENSE). You may use, study, change and share this project, also commercially, but any version you distribute must stay open source under the same license and keep the copyright notice.

The notch proportions were derived from [NotchDrop](https://github.com/Lakr233/NotchDrop) (MIT). The design follows Apple's Dynamic Island and the macOS app OmniNotch; this project is not affiliated with Apple or OmniNotch.
