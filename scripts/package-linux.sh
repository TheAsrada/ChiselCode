#!/usr/bin/env bash
set -euo pipefail

# The version and compiled binary come from the same source checkout.
version=${1:?version}
binary=${2:?compiled chisel}
out=${3:?output directory}
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
test "$("$binary" --version)" = "$version"
mkdir -p "$out"
out=$(realpath "$out")
repo=$(realpath "$(dirname "$0")/..")
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT

archive="ChiselCode-$version-linux-x64.tar.gz"
setup="ChiselCode-Setup-$version-linux"
source_url="https://github.com/TheAsrada/ChiselCode/releases/download/v$version/$archive"
payload="$work/payload"
install -Dm755 "$binary" "$payload/chisel"
install -Dm644 "$repo/LICENSE" "$payload/LICENSE"
mkdir -p "$payload/skills"
cp -R "${4:-$repo/skills/bundled}" "$payload/skills/bundled"
tar -czf "$out/$archive" -C "$payload" chisel LICENSE skills
digest=$(sha256sum "$out/$archive" | cut -d' ' -f1)

render() {
  sed -e "s|@VERSION@|$version|g" -e "s|@ARCHIVE_SHA256@|$digest|g" \
    -e "s|@SOURCE@|$source_url|g" "$repo/installer/linux/$1"
}
render install.sh > "$out/install.sh"
render chiselcode.rb > "$out/chiselcode.rb"

root="$work/deb"
install -Dm755 "$payload/chisel" "$root/usr/bin/chisel"
install -Dm644 "$payload/LICENSE" "$root/usr/share/doc/chiselcode/copyright"
mkdir -p "$root/DEBIAN" "$root/usr/share/chiselcode/skills"
cp -R "$payload/skills/bundled" "$root/usr/share/chiselcode/skills/"
cat > "$root/DEBIAN/control" <<CONTROL
Package: chiselcode
Version: $version
Section: utils
Priority: optional
Architecture: amd64
Maintainer: ChiselCode <https://github.com/TheAsrada/ChiselCode>
Depends: libc6, libgcc-s1, libstdc++6, ca-certificates
Description: ChiselCode coding agent for the terminal
CONTROL
dpkg-deb --root-owner-group -Zxz -z3 --build "$root" "$out/$setup-amd64.deb"

mkdir -p "$work/rpm/SOURCES"
cp "$out/$archive" "$work/rpm/SOURCES/payload.tar.gz"
render chiselcode.spec > "$work/chiselcode.spec"
rpmbuild --define "_topdir $work/rpm" --define "_binary_payload w3.zstdio" -bb "$work/chiselcode.spec"
cp "$work/rpm/RPMS/x86_64/chiselcode-$version-1.x86_64.rpm" "$out/$setup-x86_64.rpm"

arch="$work/arch"
mkdir -m 0777 "$arch" "$arch/native" "$arch/aur"
sed -e 's|@PACKAGE@|chiselcode|' -e '/^@AUR_METADATA@$/d' \
  -e 's|^source=.*|source=("ChiselCode-$pkgver-linux-x64.tar.gz")|' \
  < <(render PKGBUILD) > "$arch/native/PKGBUILD"
sed -e 's|@PACKAGE@|chiselcode-bin|' \
  -e "s|@AUR_METADATA@|provides=('chiselcode')\nconflicts=('chiselcode')|" \
  < <(render PKGBUILD) > "$arch/aur/PKGBUILD"
cp "$out/$archive" "$arch/native/"
# makepkg uses an ordinary build user in the Arch container. The bind mount
# contains generated recipes and the already checksummed portable archive.
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$arch:/build" archlinux:base-devel bash -euc '
    cd /build/native
    makepkg --noconfirm
    cd /build/aur
    makepkg --printsrcinfo > .SRCINFO
  '
cp "$arch/native/chiselcode-$version-1-x86_64.pkg.tar.zst" "$out/$setup-x86_64.pkg.tar.zst"
tar -czf "$out/chiselcode-$version-aur.tar.gz" -C "$arch/aur" PKGBUILD .SRCINFO
