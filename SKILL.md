---
name: argon-pc-subagent
description: >-
  Check whether the Gemini desktop app is running on this Windows PC and delegate
  tasks to Gemini 4 Argon (with low, medium, or high thinking level) using your
  Gemini subscription inside the Gemini desktop app (via cua-driver), with
  fallback to the Antigravity CLI (agy) when the desktop app window is closed or
  unavailable. Use when the user asks to check Gemini PC app status or delegate
  analysis, code review, or security audits to Argon.
---

# Argon PC Subagent

Bridge Google Antigravity to **Gemini 4 Argon** (`gemini-4-argon`) on Windows using your existing Gemini / Antigravity subscriptions:

1. **Tier 1 — Gemini Desktop App (`Gemini.exe`)**: Driven via `cua-driver` when the desktop app has an active UI window and the `cua-driver` daemon is running. Uses your Gemini subscription directly with no API key.
2. **Tier 2 — Antigravity CLI (`agy`)**: Non-interactive delegation via `agy -p ... --model <model> --mode plan --output-format json` using your signed-in Antigravity account.

## Step 1: Preflight Status Check

Always run the status script first so you report verified local state before delegating:

```powershell
node "<skill_dir>/scripts/check_status.mjs"
```

Inspect the JSON output:
- `desktopApp.status`:
  - `"open"`: `Gemini.exe` has a live window (`MainWindowHandle != 0` or reported by `cua-driver call list_windows`).
  - `"running_window_unverified"`: `Gemini.exe` processes are running, but `cua-driver` daemon is stopped and `MainWindowHandle` is `0` in this session (common when running inside an isolated desktop session).
  - `"background_process_no_window"` or `"background_launcher_only"`: Only background launcher/tray processes are active; no open chat window was found.
  - `"closed"` or `"not_installed"`: App is not running.
- `cuaDriver.daemonRunning`: Must be `true` for automated GUI delegation to `Gemini.exe`.
- `agy.available` & `agy.hasArgonModel`: Whether `agy` is installed and exposes `gemini-4-argon` (or fallback models) in `agy models`.

## Step 2: Route & Delegate

### Tier 1: Gemini Desktop App (GUI via `cua-driver`)

Use Tier 1 **only** when:
- `desktopApp.status === "open"` (or the user explicitly asks to launch/focus the Gemini desktop window), **and**
- `cuaDriver.daemonRunning === true`.

Follow the installed `cua-driver` skill guidelines (`~/.agents/skills/cua-driver/SKILL.md` and `WINDOWS.md`):
1. Never probe undocumented local IPC/ports, unpack `app.asar`, or use raw `Start-Process` / `SendInput` focus-stealing hacks.
2. In PowerShell 5.1, always **pipe JSON via stdin** to `cua-driver call` (positional JSON args lose quotes in PowerShell 5.1). First confirm the window PID/HWND from `check_status.mjs` or:
   ```powershell
   '{"app":"Gemini"}' | cua-driver call list_windows
   ```
3. Capture the Gemini window state and screenshot (`Gemini.exe` exposes only window-chrome buttons in Windows UIA, so use the screenshot to locate the **Argon** model selector and prompt input `(x, y)`):
   ```powershell
   '{"pid":<pid>,"window_id":<window_id>}' | cua-driver call get_window_state --screenshot-out-file "<scratch_dir>/gemini-state.png"
   ```
4. For directory-based tasks (such as auditing `src/`), pack secret-filtered source context first with:
   ```powershell
   node "<skill_dir>/scripts/delegate_argon.mjs" --pack-only --target "<path>" --prompt "<prompt>"
   ```
5. Because `Gemini.exe` renders its chat UI in a Chromium/Electron viewport without inner UIA elements, confirm foreground control with the user before interacting via `delivery_mode:"foreground"` (`click` on the model selector/input box, `clipboard_set` + paste or `type_text`, and re-observe with `get_window_state` to read the completed response).
6. If `cuaDriver.daemonRunning === false` or the window cannot be reached, tell the user the exact blocker (`cua-driver` daemon not running in desktop session) and offer Tier 2 (`agy`).

### Tier 2: Antigravity CLI (`agy`) Fallback

Run the delegation script:

```powershell
node "<skill_dir>/scripts/delegate_argon.mjs" `
  --prompt "<task instructions>" `
  --target "<optional file or dir, e.g. src>" `
  --thinking high `
  --backend agy
```

Supported flags:
- `--thinking <low|medium|high>` (default: `high`)
- `--backend <auto|agy>` (default: `auto`; `--backend api` is strictly opt-in if ever explicitly requested)
- `--target <path>` (repeatable; passed via `--add-dir` to `agy` and filtered for secrets/binaries/symlinks)
- `--allow-agy-fallback-model <model>` (optional; only use if the user agrees to substitute an available `agy` subscription model when `gemini-4-argon` is absent from `agy models`)
- `--pack-only` (outputs packed context preview without calling any backend)
- `--dry-run` (shows routing decision, file list, and sanitized request summary without executing)

### Strict Honesty & Safety Rules

1. **Never ask for or prompt about `GEMINI_API_KEY`**: This skill operates in subscription-first mode (`Gemini Desktop` + `agy` CLI). Do not ask the user to configure API keys.
2. **Never silently substitute a different model**: If `gemini-4-argon` is not listed in `agy models`, do not silently swap models. Route via Tier 1 (Gemini Desktop App) or ask before using `--allow-agy-fallback-model` (e.g., `gemini-3.8-flash-high` or `claude-opus-4-6-thinking`).
3. **Exclude secrets when packing directories**: `delegate_argon.mjs` automatically skips symlinks/junctions, `.git`, `node_modules`, build artifacts, binary files, and `.env*` / key files (`*.pem`, `*.key`, `.npmrc`, `credentials.json`, etc.).
4. **Report exact execution metadata**: Always tell the user which tier executed (`desktop` / `agy`), the exact model ID and thinking level used, and any blockers if a tier was skipped.
