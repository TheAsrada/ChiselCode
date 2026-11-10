#!/usr/bin/env bash
set -euo pipefail
umask 022

version='@VERSION@'
archive_sha256='@ARCHIVE_SHA256@'
archive="ChiselCode-${version}-linux-x64.tar.gz"
url="https://github.com/TheAsrada/ChiselCode/releases/download/v${version}/${archive}"
bin="$HOME/.local/bin"
store="${XDG_DATA_HOME:-$HOME/.local/share}/chiselcode-cli"

die() { printf 'ChiselCode: %s\n' "$*" >&2; exit 1; }

[[ $# == 0 ]] || die 'Скрипт запускается без аргументов.'
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] ||
  die 'Поддерживается Linux x64 с glibc.'
getconf GNU_LIBC_VERSION >/dev/null 2>&1 || die 'Требуется glibc.'
[[ $store == /* && $bin == /* ]] || die 'HOME и XDG_DATA_HOME должны быть абсолютными путями.'
[[ $archive_sha256 =~ ^[a-f0-9]{64}$ ]] || die 'Требуется install.sh из GitHub Release.'

target="$bin/chisel"
if [[ -e $target || -L $target ]]; then
  old=$(readlink -f -- "$target") || die "Не удалось определить владельца $target."
  [[ -L $target && $old == "$store/releases/"*/chisel && -f ${old%/*}/.chisel-install-channel ]] ||
    die "$target принадлежит другой установке."
fi

mkdir -p -- "$store/releases" "$bin"
work=$(mktemp -d -- "$store/.install.XXXXXXXX")
linkdir=
cleanup() {
  rm -rf -- "$work"
  if [[ -n $linkdir ]]; then rm -rf -- "$linkdir"; fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
  --connect-timeout 15 --max-time 300 --output "$work/$archive" "$url"
printf '%s  %s\n' "$archive_sha256" "$archive" |
  (cd "$work"; sha256sum --check --status) || die 'SHA-256 архива не совпадает.'
mkdir -- "$work/payload"
tar -xzf "$work/$archive" -C "$work/payload" --no-same-owner --no-same-permissions
[[ $("$work/payload/chisel" --version) == "$version" ]] || die 'Версия в архиве не совпадает.'
for skill in skill-creator code-review extension-creator; do
  [[ -s "$work/payload/skills/bundled/$skill/SKILL.md" ]] || die "Отсутствует навык $skill."
done
printf 'curl\n' > "$work/payload/.chisel-install-channel"

release="$store/releases/$version.${work##*.}"
linkdir=$(mktemp -d -- "$bin/.chisel-link.XXXXXXXX")
mv -T -- "$work/payload" "$release"
ln -s -- "$release/chisel" "$linkdir/chisel"
mv -Tf -- "$linkdir/chisel" "$target"
printf 'Установлен ChiselCode %s — %s\n' "$version" "$target"
case ":$PATH:" in
  *":$bin:"*) ;;
  *) printf 'Добавьте каталог в PATH текущей оболочки: export PATH="$HOME/.local/bin:$PATH"\n' ;;
esac
