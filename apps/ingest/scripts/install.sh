#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BM_PILOT_BINARY_BASE_URL:-https://github.com/pella-labs/bematist-simplified/releases/latest/download}"
INSTALL_DIR="${BM_PILOT_INSTALL_DIR:-$HOME/.local/bin}"
BIN_NAME="bm-pilot"

os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
  Darwin)
    case "$arch" in
      arm64) target="bm-pilot-darwin-arm64" ;;
      x86_64) target="bm-pilot-darwin-x64" ;;
      *) echo "unsupported macOS arch: $arch" >&2; exit 1 ;;
    esac
    ;;
  Linux)
    case "$arch" in
      x86_64) target="bm-pilot-linux-x64" ;;
      *) echo "unsupported Linux arch: $arch" >&2; exit 1 ;;
    esac
    ;;
  MINGW*|MSYS*|CYGWIN*|Windows_NT)
    target="bm-pilot-win32-x64.exe"
    BIN_NAME="bm-pilot.exe"
    ;;
  *)
    echo "unsupported OS: $os" >&2
    exit 1
    ;;
esac

url="$BASE_URL/$target"
checksum_url="$url.sha256"

mkdir -p "$INSTALL_DIR"
tmp="$(mktemp "${TMPDIR:-/tmp}/bm-pilot-XXXXXX")"
trap 'rm -f "$tmp" "$tmp.sha256"' EXIT

echo "downloading $url"
if ! curl -fSL --retry 3 --retry-delay 2 -o "$tmp" "$url"; then
  echo "download failed: $url" >&2
  exit 1
fi

if curl -fSL --retry 2 --retry-delay 1 -o "$tmp.sha256" "$checksum_url" 2>/dev/null; then
  echo "verifying sha256 against $checksum_url"
  expected="$(awk '{print $1}' "$tmp.sha256")"
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$tmp" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$tmp" | awk '{print $1}')"
  else
    echo "no sha256 tool available (sha256sum/shasum)" >&2
    exit 1
  fi
  if [ "$expected" != "$actual" ]; then
    echo "sha256 mismatch: expected=$expected actual=$actual" >&2
    exit 1
  fi
else
  echo "no sha256 sidecar at $checksum_url — skipping verification"
fi

chmod +x "$tmp"
mv "$tmp" "$INSTALL_DIR/$BIN_NAME"
trap - EXIT

echo ""
echo "installed $INSTALL_DIR/$BIN_NAME"
echo "make sure $INSTALL_DIR is on your PATH, then run:"
echo "  $BIN_NAME login"
