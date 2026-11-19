#!/usr/bin/env bash
set -euo pipefail

forge_version=2.0.13
forge_checksum=df23b237095cfc5ff97a4711946b25ff852da9ff43b916c40783f6b5a41ce855
destination="${1:?Pass the directory in which to install Forge.}"
jar="forge-gui-desktop-${forge_version}-jar-with-dependencies.jar"

valid_install() {
    [[ -s "$1/$jar" && -d "$1/res/editions" ]]
}

if [[ -e "$destination" ]]; then
    valid_install "$destination"
    printf '%s\n' "$destination"
    exit 0
fi

mkdir -p "$(dirname "$destination")"
work="$(mktemp -d "$(dirname "$destination")/.forge.XXXXXX")"
trap 'rm -rf -- "$work"' EXIT
archive="$work/forge.tar.bz2"
curl --fail --silent --show-error --location --retry 3 --max-time 360 \
    "https://github.com/Card-Forge/forge/releases/download/forge-${forge_version}/forge-installer-${forge_version}.tar.bz2" \
    --output "$archive"
if ! printf '%s  %s\n' "$forge_checksum" "$archive" | sha256sum --check --status; then
    echo "Forge $forge_version download did not match the published SHA-256." >&2
    exit 1
fi
mkdir "$work/extracted"
tar --extract --bzip2 --file "$archive" --directory "$work/extracted" \
    --no-same-owner --no-same-permissions
jar_path="$(find "$work/extracted" -type f -name "$jar" -print -quit)"
[[ -n "$jar_path" ]] || { echo "Forge archive does not contain $jar." >&2; exit 1; }
install_dir="$(dirname "$jar_path")"
valid_install "$install_dir" || { echo 'Forge archive does not contain the edition resources.' >&2; exit 1; }
chmod -R a+rX,go-w "$install_dir"
mv --no-target-directory "$install_dir" "$destination"
printf '%s\n' "$destination"
