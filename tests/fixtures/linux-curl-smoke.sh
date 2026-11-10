#!/usr/bin/env bash
set -euo pipefail
packages=${1:?package directory}
old=${2:?old version}
new=${3:?new version}
sha=${4:?binary checksum}
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
export HOME="$work/home" XDG_DATA_HOME="$work/data" XDG_CONFIG_HOME="$work/config"
export PATH="$work/tools:$HOME/.local/bin:$PATH"
export packages old new
mkdir -p "$work/tools" "$HOME" "$work/project"

# Replace only the transport so the unpublished assets can be used by the real installer.
cat > "$work/tools/curl" <<'TRANSPORT'
#!/usr/bin/env bash
set -eu
while [[ $1 != --output ]]; do shift; done
output=$2 url=$3
case "$url" in
  "https://github.com/TheAsrada/ChiselCode/releases/download/v$old/ChiselCode-$old-linux-x64.tar.gz")
    cp "$packages/old/${url##*/}" "$output" ;;
  "https://github.com/TheAsrada/ChiselCode/releases/download/v$new/ChiselCode-$new-linux-x64.tar.gz")
    if [[ ${CORRUPT:-} == 1 ]]; then
      printf 'corrupt\n' > "$output"
    else
      cp "$packages/new/${url##*/}" "$output"
    fi ;;
  *) exit 2 ;;
esac
TRANSPORT
chmod +x "$work/tools/curl"
bash "$packages/old/install.sh"
target="$HOME/.local/bin/chisel"
test "$(command -v chisel)" = "$target"
test "$(chisel --version)" = "$old"
old_target=$(readlink "$target")
if CORRUPT=1 bash "$packages/new/install.sh" > "$work/corrupt.log" 2>&1; then
  echo 'The installer accepted a damaged archive' >&2
  exit 1
fi
grep -F 'SHA-256' "$work/corrupt.log"
test "$(readlink "$target")" = "$old_target"
test "$(chisel --version)" = "$old"
mkdir -p "$XDG_DATA_HOME/chiselcode/sessions"
printf 'fixture-session\n' > "$XDG_DATA_HOME/chiselcode/sessions/keep"
bash "$packages/new/install.sh"
test "$(chisel --version)" = "$new"
echo "$sha  $target" | sha256sum -c
timeout 30 chisel --cwd "$work/project" /code-review > "$work/cli.log" 2>&1 || test "$?" = 1
test -s "$XDG_DATA_HOME/chiselcode/skills/bundled/extension-creator/SKILL.md"
rm -- "$target"
rm -r -- "$XDG_DATA_HOME/chiselcode-cli"
hash -r
if [[ $(command -v chisel) == "$target" ]]; then
  echo "chisel is still in PATH after removal" >&2
  exit 1
fi
test "$(cat "$XDG_DATA_HOME/chiselcode/sessions/keep")" = fixture-session
printf 'install.sh: install, rejected corruption, upgrade, PATH, skills and data preservation passed\n'
