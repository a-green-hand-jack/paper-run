#!/bin/sh
set -eu

version=${PAPER_RUN_VERSION:-0.2.0}
case "$version" in
  ''|*[!0-9.]* )
    printf '%s\n' "paper-run: invalid version: $version" >&2
    exit 1
    ;;
esac

for command_name in curl npm; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf '%s\n' "paper-run: required command not found: $command_name" >&2
    exit 1
  fi
done

release_url="https://github.com/a-green-hand-jack/paper-run/releases/download/v${version}"
archive_name="paper-run-${version}.tgz"
tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/paper-run-install.XXXXXX")
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM

curl -fsSL "$release_url/$archive_name" -o "$tmp_dir/$archive_name"
curl -fsSL "$release_url/$archive_name.sha256" -o "$tmp_dir/$archive_name.sha256"

expected=
remainder=
read -r expected remainder < "$tmp_dir/$archive_name.sha256"
if [ "${#expected}" -ne 64 ]; then
  printf '%s\n' "paper-run: invalid checksum file" >&2
  exit 1
fi
case "$expected" in
  *[!0-9a-f]* )
    printf '%s\n' "paper-run: invalid checksum file" >&2
    exit 1
    ;;
esac
if command -v sha256sum >/dev/null 2>&1; then
  digest_line=$(sha256sum "$tmp_dir/$archive_name")
else
  digest_line=$(shasum -a 256 "$tmp_dir/$archive_name")
fi
actual=${digest_line%% *}
if [ "$actual" != "$expected" ]; then
  printf '%s\n' "paper-run: checksum verification failed" >&2
  exit 1
fi

npm install -g "$tmp_dir/$archive_name"
installed=$(paper-run --version)
if [ "$installed" != "$version" ]; then
  printf '%s\n' "paper-run: installed version $installed, expected $version" >&2
  exit 1
fi

printf '%s\n' "paper-run $installed installed"
