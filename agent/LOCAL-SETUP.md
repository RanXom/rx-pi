# Local Pi setup

What this machine adds on top of stock pi. Everything here is adjustable.

## Install shape

Pi runs from the **standalone release** at `~/.local/share/pi/1.6.0/`, symlinked
to `~/.local/bin/pi`. The binary is Bun-compiled and self-contained: no Node.js
runtime, no `/nix/store` dependencies, works with `PATH=/usr/bin:/bin`.

Update with `pi update` (it checks the release channel), or re-download
`pi-linux-x64.tar.gz` from the release page and replace the directory.

## Models — OpenCode Go

Defaults: `opencode-go/deepseek-v4.1-flash`. Auth lives in
`~/.pi/agent/auth.json` (`pi auth login opencode-go --api-key`).

- Switch: `/model`, `Ctrl+P` to cycle, `pi --model opencode-go/kimi-k3`
- Thinking levels: `/thinking` or `provider/model:high`
- Limit the cycle list with `enabledModels`, pin startup levels with `modelThinkingLevels`
- `pi --list-models opencode-go` shows the plan's models

## Compaction

Automatic compaction is on by default and triggers when
`contextTokens > contextWindow - reserveTokens` (default reserve: 16,384).

This machine compacts `opencode-go/deepseek-v4.1-flash` at ~800k instead of
~984k:

```json
"compaction": {
  "modelOverrides": {
    "opencode-go/deepseek-v4.1-flash": { "reserveTokens": 200000 }
  }
}
```

Keep 20k of recent context (`keepRecentTokens`), force a summary with
`/compact`, or disable with `compaction.enabled: false`.

## Tools

| Tool | Binary | Notes |
|---|---|---|
| `rg` | `/usr/bin/rg` | content search, gitignore-aware, glob + type filters |
| `fd` | `/usr/bin/fd` | filename search, extension/depth filters |
| `eza` | `/usr/bin/eza` | listings and trees |
| `web_search` | Bing RSS → Google CSE | keyless; set `GOOGLE_SEARCH_API_KEY` + `GOOGLE_CSE_ID` for Google |
| `fetch_url` | Readability → r.jina.ai | markdown extraction, PDF via Jina |

Pi's own `grep`/`find`/`ls` stay disabled; `bash` stays.

Search provider order: `PI_SEARCH_PROVIDERS=bing,google`. DuckDuckGo currently
answers bot challenges (HTTP 202) on many networks; add `ddg` to the list if it
works for you.

## Dictation (local, no cloud)

`alt+m` toggles, `alt+n` cancels. Transcripts append to the focused input,
including `ask_user_question` popups (Tab into a text field for opaque selects).

- Model: `~/.local/share/opencode-voice/models/sherpa-onnx-whisper-small.en`
- Capture: ffmpeg/pulse, `arecord` optional
- Runtime: under the standalone binary the model loads **in-process** (~1.5 s,
  ~0.5–1 s decode); under an npm install it uses `transcribe-daemon.cjs`
- Unload after 10 idle minutes, or `/dictate-unload`
- Config: `~/.pi/agent/dictate.json`
- Memory while loaded: roughly +700 MB (ONNX runtime + int8 weights)

## Learning setup

- Skills: `~/.pi/agent/skills/` — code-review, debugging, examination, retrieval, stop-slop
- Prompt templates: `~/.pi/agent/prompts/` — learn, hint, debug, code-review, retrieve, explain, autopsy, read, test, arch, explore, api
- `~/.agents/**` stays excluded from pi; remove `"!~/.agents/**"` to include it

## UI

Theme is pi's `system` default (terminal palette). UI packages are chosen by the
user; `pi-zentui` is installed. `pi remove npm:<pkg>` undoes any of them.

Startup header lives in `~/.pi/agent/extensions/custom-header.ts`: a four-line
π mark (half-block grid) beside cwd, input prefixes, agent status, and
`version · model · branch`. Edit `MARK` / `MARK_COLORS` / `HINTS` there, then
`/reload`. `/builtin-header` restores pi's header for the session.

Transcript styling lives in `~/.pi/agent/extensions/rx-chat/`, ported from
[pi-slate](https://github.com/GaganSD/coding-agent-toolkit/tree/main/pi-slate)
(MIT). It only owns the chat transcript; zentui keeps the editor, footer and
selector chrome.

- Tool cards collapse to one row plus a `└ N lines · timeout=60s · 165ms`
  detail; consecutive calls fold into `Done (N tool calls) ctrl+o to expand`.
- `edit`/`write` render a split before/after diff with syntax highlighting and
  word-level emphasis (`edit` uses Pi's own `details.patch`; `write` snapshots
  the file in a `tool_call` hook).
- Diff panels and user/custom message panels paint terminal palette slot 0
  (regular black = the palette's muted dark gray), 22/52 for added/removed rows,
  28/88 for word emphasis. Change `BG` in `diff.ts` to taste; nothing there
  depends on npm packages. Slot 8 is bright black (light gray here), so it is
  not used for panels.
- Collapsed reasoning rows read `Thought` / `Thinking…` / `Thought for 12s`.
- GitHub callouts (`> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`,
  `[!CAUTION]`) draw a colored rail and bold title.

Vendored files: `tool-style.ts`, `tool-groups.ts`, `chat-surface.ts`,
`thinking.ts`, `callouts.ts`, `render-lines.ts`. Local: `diff.ts` (patch
generation, parsing and rendering) and `index.ts` (wiring). Move the directory
and `/reload` to fall back to Pi's native transcript.

`fullscreenExitOutput: "resume-hint"` keeps the terminal clean on exit;
`quietStartup: "header"` hides the startup resource listing (`pi --verbose`
brings it back for one run).
