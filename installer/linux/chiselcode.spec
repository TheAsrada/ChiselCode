# Keep the compiled payload byte-for-byte identical in every package.
%global debug_package %{nil}
%global __os_install_post %{nil}

Name: chiselcode
Version: @VERSION@
Release: 1
Summary: ChiselCode CLI
License: MIT
URL: https://github.com/TheAsrada/ChiselCode
Source0: payload.tar.gz
ExclusiveArch: x86_64
Requires: glibc, libgcc, libstdc++, ca-certificates

%description
ChiselCode coding agent for the terminal.

%prep
%setup -q -c -T
tar -xzf %{SOURCE0}

%install
install -Dm755 chisel "%{buildroot}%{_bindir}/chisel"
install -Dm644 LICENSE "%{buildroot}%{_licensedir}/chiselcode/LICENSE"
install -d "%{buildroot}%{_datadir}/chiselcode/skills"
cp -R skills/bundled "%{buildroot}%{_datadir}/chiselcode/skills/"

%files
%{_bindir}/chisel
%{_datadir}/chiselcode
%license %{_licensedir}/chiselcode/LICENSE
