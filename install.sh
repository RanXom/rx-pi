#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
agent="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"

if ! command -v pi >/dev/null 2>&1; then
  echo "pi is not on PATH. Install it first: curl -fsSL https://pi.dev/install.sh | sh" >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required for this install step only." >&2
  echo "Run: nix shell nixpkgs#nodejs_24 -c ./install.sh" >&2
  exit 1
fi

mkdir -p "$agent"
cp -a "$here/agent/." "$agent/"
[ -f "$HOME/AGENTS.md" ] || cp "$here/AGENTS.md" "$HOME/AGENTS.md"

# npm packages declared in settings
pi install npm:pi-zentui >/dev/null 2>&1 || true

# extension dependencies
for pkg in "$agent"/extensions/*/package.json; do
  [ -f "$pkg" ] || continue
  dir="$(dirname "$pkg")"
  (cd "$dir" && npm install --no-audit --no-fund >/dev/null)
done

# 5th zentui preset: zen = opencode everywhere except the minimalist editor.
python3 - "$agent" <<'PY'
import pathlib, sys
p = pathlib.Path(sys.argv[1]) / "npm" / "node_modules" / "pi-zentui" / "extensions" / "zentui" / "presets.ts"
if not p.exists():
    sys.exit(0)
s = p.read_text()
if 'id: "zen"' in s:
    sys.exit(0)
s = s.replace(
    'export type PresetId = "opencode" | "opencode-copy-friendly" | "rail" | "minimalist";',
    'export type PresetId = "opencode" | "opencode-copy-friendly" | "rail" | "minimalist" | "zen";',
)
s = s.replace('''\t{
\t\tid: "opencode-copy-friendly",''', '''\t{
\t\tid: "zen",
\t\tlabel: "Zen",
\t\tcomponents: {
\t\t\teditor: { enabled: true, style: "minimalist" },
\t\t\tfooter: { style: "starship" },
\t\t\tuserMessages: { enabled: true, style: "compact" },
\t\t},
\t},
\t{
\t\tid: "opencode-copy-friendly",''')
p.write_text(s)
PY

python3 "$here/patches/zentui-compact-rules.py" "$agent"

echo "Installed into $agent"
echo "Next: pi auth login opencode-go --api-key"
