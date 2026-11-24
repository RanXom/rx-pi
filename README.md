# rx-pi

My pi setup: header, zentui (zen preset), vendored fast-tui tool cards, local
tools, dictation, and the tutoring skills/prompts. Clone, run `./install.sh`,
log in, done.

## What's inside

| Path | What it is |
|---|---|
| `agent/settings.json` | model defaults (OpenCode Go), theme, compaction, quiet startup |
| `agent/zentui.json` | zentui components: minimalist editor, starship footer, framed messages |
| `agent/themes/palette.json` | ANSI-index theme, no hardcoded colors |
| `agent/extensions/custom-header.ts` | π mark header + cwd/status line |
| `agent/extensions/rx-cards/` | fast-tui cards (transparent, 2-cell padding) + thinking rows |
| `agent/extensions/local-tools/` | `rg`, `fd`, `eza` tools |
| `agent/extensions/web-tools/` | `web_search`, `fetch_url` |
| `agent/extensions/dictate-local/` | local Whisper dictation (`alt+m`) |
| `agent/extensions/ask-user-questions.ts` | question popup with dictation support |
| `agent/skills/`, `agent/prompts/` | tutoring skills and slash commands |
| `AGENTS.md` | global tutoring instructions |

Not tracked: `auth.json` (secrets), `sessions/`, `npm/`, `node_modules/`.

## Install on a new machine

1. Install pi (no system Node needed afterwards):

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

2. Clone and run the installer. `npm` is only needed during install:

```bash
git clone <this-repo> ~/rx-pi
cd ~/rx-pi
nix shell nixpkgs#nodejs_24 -c ./install.sh   # or any Node >= 22.19 on PATH
```

`install.sh` copies `agent/` into `~/.pi/agent`, installs the npm package
(`pi-zentui`), installs extension dependencies, and adds the `zen` preset to
zentui.

3. Log in to OpenCode Go:

```bash
pi auth login opencode-go --api-key
```

4. Start pi. Check `pi --version`, then `/model` and a tool call.

## Notes

- `zentui` is patched in `node_modules` to add the 5th preset (`zen` =
  opencode everywhere except the minimalist editor). Re-run the patch section
  of `install.sh` after `pi install`/update.
- `rx-cards` is vendored from pi-fast-tui 0.9.0 (MIT). It registers tool cards
  and thinking rows only, no header/footer/editor.
- The theme uses ANSI palette indices; change terminal palettes and pi follows.
- `fullscreenExitOutput: "resume-hint"` keeps the terminal clean on exit.
