#!/usr/bin/env bash
set -euo pipefail

# This branch runs inside a disposable distro root as root for package transactions.
if [[ ${1:-} == distro ]]; then
  channel=${2:?}
  old=${3:?}
  new=${4:?}
  sha=${5:?}
  home=$(mktemp -d)
  trap 'rm -rf -- "$home"' EXIT
  export HOME="$home" XDG_DATA_HOME="$home/data" XDG_CONFIG_HOME="$home/config"
  export PATH=/usr/bin:/bin
  state="$XDG_DATA_HOME/chiselcode"
  case "$channel" in
    arch)
      oldfile="/packages/old/ChiselCode-Setup-$old-linux-x86_64.pkg.tar.zst"
      newfile="/packages/new/ChiselCode-Setup-$new-linux-x86_64.pkg.tar.zst"
      install_package() { pacman -U --noconfirm "$1"; }
      remove_package() { pacman -R --noconfirm chiselcode; }
      ;;
    rpm)
      oldfile="/packages/old/ChiselCode-Setup-$old-linux-x86_64.rpm"
      newfile="/packages/new/ChiselCode-Setup-$new-linux-x86_64.rpm"
      install_package() { dnf -y --disablerepo="*" install "$1"; }
      remove_package() { dnf -y --disablerepo="*" remove chiselcode; }
      ;;
    deb)
      apt-get update
      apt-get install -y --no-install-recommends ca-certificates libstdc++6
      oldfile="/packages/old.deb"
      newfile="/packages/new/ChiselCode-Setup-$new-linux-amd64.deb"
      install_package() { apt-get install -y "$1"; }
      remove_package() { apt-get remove -y chiselcode; }
      ;;
    *) exit 2 ;;
  esac
  mkdir -p "$home/project"
  install_package "$oldfile"
  test "$(command -v chisel)" = /usr/bin/chisel
  test "$(chisel --version)" = "$old"
  if [[ $channel == deb ]]; then
    # The previous official DEB used the layout beside the executable.
    timeout 30 chisel --cwd "$home/project" /code-review > "$home/cli.log" 2>&1 || test "$?" = 1
    test -s "$state/skills/bundled/code-review/SKILL.md"
    rm -r -- "$state/skills/bundled"
  fi
  mkdir -p "$state/sessions" "$state/skills/user/fixture" "$XDG_CONFIG_HOME/chiselcode"
  printf 'fixture-session\n' > "$state/sessions/keep"
  printf 'fixture-skill\n' > "$state/skills/user/fixture/SKILL.md"
  printf 'fixture-setting\n' > "$XDG_CONFIG_HOME/chiselcode/keep"
  install_package "$newfile"
  test "$(chisel --version)" = "$new"
  echo "$sha  /usr/bin/chisel" | sha256sum -c
  timeout 30 chisel --cwd "$home/project" /code-review > "$home/cli.log" 2>&1 || test "$?" = 1
  for skill in skill-creator code-review extension-creator; do
    test "$(sha256sum < "/usr/share/chiselcode/skills/bundled/$skill/SKILL.md")" = \
      "$(sha256sum < "$state/skills/bundled/$skill/SKILL.md")"
  done
  remove_package
  hash -r
  if command -v chisel >/dev/null; then
    echo "chisel is still in PATH after removal" >&2
    exit 1
  fi
  test ! -e /usr/share/chiselcode/skills/bundled/code-review/SKILL.md
  test "$(cat "$state/sessions/keep")" = fixture-session
  test "$(cat "$state/skills/user/fixture/SKILL.md")" = fixture-skill
  test "$(cat "$XDG_CONFIG_HOME/chiselcode/keep")" = fixture-setting
  printf '%s: install, upgrade, PATH, payload, skills, removal and data preservation passed\n' "$channel"
  exit
fi

repo=$(realpath "$(dirname "$0")/../..")
version=${1:?version}
binary=$(realpath "${2:?compiled binary}")
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
old=0.6.51
base='https://github.com/TheAsrada/ChiselCode/releases/download'
curl --fail --silent --show-error --location --retry 2 --retry-max-time 120 --max-time 120 \
  "$base/v$old/ChiselCode-Setup-$old-linux-amd64.deb" -o "$work/old.deb"
echo "a8cfd02050be9cfec5705a235b3c9e7fd52191051bfb4f27deb4a4e390107b27  $work/old.deb" | sha256sum -c
dpkg-deb -x "$work/old.deb" "$work/old-deb"
# RPM and Arch have no historical package for 0.6.51. Wrap that published binary
# and its bundled skills in fixture packages with the same installation layout.
for generation in old new; do
  if [[ $generation == old ]]; then
    stage_version=$old
    stage_binary="$work/old-deb/usr/bin/chisel"
    stage_skills="$work/old-deb/usr/bin/skills/bundled"
  else
    stage_version=$version
    stage_binary=$binary
    stage_skills="$repo/skills/bundled"
  fi
  "$repo/scripts/package-linux.sh" "$stage_version" "$stage_binary" "$work/$generation" "$stage_skills"
done
sha=$(sha256sum "$binary" | cut -d' ' -f1)

for pair in 'arch archlinux:base-devel' 'rpm fedora:43' 'deb ubuntu:24.04'; do
  read -r channel image <<< "$pair"
  docker run --rm -v "$work:/packages:ro" \
    -v "$repo/tests/fixtures/linux-install-smoke.sh:/smoke.sh:ro" \
    "$image" bash /smoke.sh distro "$channel" "$old" "$version" "$sha"
done

"$repo/tests/fixtures/linux-curl-smoke.sh" "$work" "$old" "$version" "$sha"
