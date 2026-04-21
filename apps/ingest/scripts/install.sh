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

# Seed a minimal config with the api URL so `bm-pilot login` posts to the
# right host. {{API_URL}} is substituted at serve time by the web `/install.sh`
# route. If the substitution wasn't performed (e.g. running the raw script
# from GitHub), fall back to an env override or skip config seeding.
CONFIG_DIR="${BM_PILOT_CONFIG_DIR:-$HOME/.bm-pilot}"
API_URL_TEMPLATE="{{API_URL}}"
API_URL_RESOLVED=""
case "$API_URL_TEMPLATE" in
  "{{API_URL}}")
    API_URL_RESOLVED="${BM_PILOT_API_URL:-}"
    ;;
  *)
    API_URL_RESOLVED="$API_URL_TEMPLATE"
    ;;
esac
if [ -n "$API_URL_RESOLVED" ]; then
  mkdir -p "$CONFIG_DIR"
  config_path="$CONFIG_DIR/config.json"
  if [ ! -f "$config_path" ]; then
    if command -v uuidgen >/dev/null 2>&1; then
      device_id="$(uuidgen | tr '[:upper:]' '[:lower:]')"
    elif [ -r /proc/sys/kernel/random/uuid ]; then
      device_id="$(cat /proc/sys/kernel/random/uuid)"
    else
      device_id=""
    fi
    installed_at="$(date -u +%Y-%m-%dT%H:%M:%S+00:00)"
    if [ -n "$device_id" ]; then
      cat > "$config_path" <<JSON
{"apiUrl":"$API_URL_RESOLVED","ingestKey":null,"deviceId":"$device_id","adapters":{},"installedAt":"$installed_at"}
JSON
      chmod 600 "$config_path"
      echo "seeded config at $config_path (apiUrl=$API_URL_RESOLVED)"
    else
      echo "no uuidgen tool available — skipping config seed; $BIN_NAME will create one on first run"
    fi
  else
    echo "config already exists at $config_path — not overwriting"
  fi
fi

echo ""
echo "installed $INSTALL_DIR/$BIN_NAME"
echo "make sure $INSTALL_DIR is on your PATH, then run:"
echo "  $BIN_NAME login <token>"
echo "  $BIN_NAME start"
