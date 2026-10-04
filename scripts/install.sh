#!/usr/bin/env bash
# Install a verified release runtime and the matching global hard-copy skill.

set -euo pipefail

REPO="${AHELPA_REPO:-alterxyz/ahelpa}"
VERSION="${AHELPA_VERSION:-latest}"
BIN_DIR="${AHELPA_BIN_DIR:-$HOME/.ahelpa/bin}"
EXPECTED_SHA256="${AHELPA_SHA256:-}"
CHECKSUM_URL="${AHELPA_CHECKSUM_URL:-}"

fail() {
  echo "ahelpa installation failed: $*" >&2
  exit 1
}

if [[ ! "$REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  fail "AHELPA_REPO must be an owner/repository name."
fi
if [ -n "$EXPECTED_SHA256" ] && [ -n "$CHECKSUM_URL" ]; then
  fail "Set only one of AHELPA_SHA256 and AHELPA_CHECKSUM_URL."
fi
if [ -n "${AHELPA_ARCHIVE_URL:-}" ] && [ -z "$EXPECTED_SHA256" ] && [ -z "$CHECKSUM_URL" ]; then
  fail "AHELPA_ARCHIVE_URL requires AHELPA_SHA256 or AHELPA_CHECKSUM_URL."
fi

# Check skill-install prerequisites before any download or runtime replacement.
if ! command -v node >/dev/null 2>&1; then
  fail "Node.js >=22.20.0 is required for skills installation; install Node.js and retry."
fi
NODE_VERSION="$(node --version 2>/dev/null)" || fail "Could not run node --version; repair Node.js and retry."
if [[ ! "$NODE_VERSION" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
  fail "Could not read a stable Node.js version; Node.js >=22.20.0 is required."
fi
NODE_MAJOR="${BASH_REMATCH[1]}"
NODE_MINOR="${BASH_REMATCH[2]}"
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 20 ]; }; then
  fail "Node.js >=22.20.0 is required for skills installation; found $NODE_VERSION. Upgrade Node.js and retry."
fi
if ! command -v npx >/dev/null 2>&1; then
  fail "npx is required for skills installation; install Node.js with npm and retry."
fi
if ! npx --version >/dev/null 2>&1; then
  fail "Could not run npx --version; repair Node.js/npm before installing skills."
fi

OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS/$ARCH" in
  Darwin/arm64) PLATFORM="darwin-arm64" ;;
  Darwin/x86_64) PLATFORM="darwin-x64" ;;
  Linux/x86_64 | Linux/amd64) PLATFORM="linux-x64" ;;
  Linux/aarch64 | Linux/arm64) PLATFORM="linux-arm64" ;;
  *) fail "No prebuilt runtime for $OS/$ARCH; build from source with scripts/deploy-local.sh." ;;
esac
ASSET_NAME="ahelpa-${PLATFORM}.tar.gz"

# Resolve latest once so the runtime, checksum, and skill cannot drift apart.
# curl follows GitHub's public redirect; no JSON parser or GitHub token is needed.
if [ "$VERSION" = "latest" ]; then
  RELEASE_URL="$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest")"
  RELEASE_PREFIX="https://github.com/$REPO/releases/tag/"
  case "$RELEASE_URL" in
    "$RELEASE_PREFIX"*) VERSION="${RELEASE_URL#"$RELEASE_PREFIX"}" ;;
    *) fail "Could not resolve the latest release tag." ;;
  esac
fi
if [[ ! "$VERSION" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
  fail "AHELPA_VERSION must be a release tag, such as v0.6.3."
fi

RELEASE_BASE="https://github.com/$REPO/releases/download/$VERSION"
ARCHIVE_URL="${AHELPA_ARCHIVE_URL:-$RELEASE_BASE/$ASSET_NAME}"
CHECKSUM_URL="${CHECKSUM_URL:-$RELEASE_BASE/SHASUMS256.txt}"
SKILL_SOURCE="https://github.com/$REPO/tree/$VERSION/skill"

TMPDIR_INSTALL="$(mktemp -d "${TMPDIR:-/tmp}/ahelpa-install.XXXXXX")"
STAGED_BINARY=""
cleanup() {
  rm -rf -- "$TMPDIR_INSTALL"
  if [ -n "$STAGED_BINARY" ]; then rm -f -- "$STAGED_BINARY"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# The CLI eagerly opens its state database, including for version/install-skill.
# Installer probes and skill installation must not migrate the user's runtime.
export AHELPA_HOME="$TMPDIR_INSTALL/state"
export AHELPA_TMP_DIR="$TMPDIR_INSTALL/runtime"

echo "== download runtime $VERSION ($PLATFORM) =="
ARCHIVE_PATH="$TMPDIR_INSTALL/$ASSET_NAME"
curl -fsSL "$ARCHIVE_URL" -o "$ARCHIVE_PATH"

if [ -z "$EXPECTED_SHA256" ]; then
  curl -fsSL "$CHECKSUM_URL" -o "$TMPDIR_INSTALL/SHASUMS256.txt"
  # Accept sha256sum and shasum manifests, but require exactly one matching entry.
  EXPECTED_SHA256="$(awk -v asset="$ASSET_NAME" '
    { name = $2; sub(/^\*/, "", name); if (name == asset) { count++; digest = $1 } }
    END { if (count != 1) exit 1; print digest }
  ' "$TMPDIR_INSTALL/SHASUMS256.txt")" || fail "Checksum manifest must contain exactly one entry for $ASSET_NAME."
fi
if [[ ! "$EXPECTED_SHA256" =~ ^[A-Fa-f0-9]{64}$ ]]; then
  fail "Expected a 64-character SHA-256 digest."
fi
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL_SHA256="$(sha256sum "$ARCHIVE_PATH")"
elif command -v shasum >/dev/null 2>&1; then
  ACTUAL_SHA256="$(shasum -a 256 "$ARCHIVE_PATH")"
else
  fail "A SHA-256 tool is required (sha256sum or shasum)."
fi
ACTUAL_SHA256="${ACTUAL_SHA256%% *}"
EXPECTED_SHA256="$(printf '%s' "$EXPECTED_SHA256" | tr 'A-F' 'a-f')"
if [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]; then
  fail "SHA-256 mismatch for $ASSET_NAME; the existing installation was not changed."
fi

# Never extract archive paths into the installation directory. Require the one
# regular-file member produced by our release workflow and stream its bytes out.
if [ "$(tar tzf "$ARCHIVE_PATH")" != ahelpa ]; then
  fail "Runtime archive must contain only ahelpa."
fi
ARCHIVE_ENTRY="$(tar tvzf "$ARCHIVE_PATH")"
case "$ARCHIVE_ENTRY" in
  -*) ;;
  *) fail "Runtime archive must contain a regular file, not a link or directory." ;;
esac
tar xOzf "$ARCHIVE_PATH" ahelpa > "$TMPDIR_INSTALL/ahelpa"
if [ ! -s "$TMPDIR_INSTALL/ahelpa" ]; then fail "Runtime archive contains an empty binary."; fi
chmod 755 "$TMPDIR_INSTALL/ahelpa"
RUNTIME_VERSION="$("$TMPDIR_INSTALL/ahelpa" version)" || fail "Downloaded runtime could not execute on this system."
if [ "$RUNTIME_VERSION" != "ahelpa ${VERSION#v}" ]; then
  fail "Downloaded runtime version does not match release $VERSION."
fi

echo "== install runtime -> $BIN_DIR =="
mkdir -p "$BIN_DIR"
if [ -d "$BIN_DIR/ahelpa" ]; then fail "$BIN_DIR/ahelpa is a directory."; fi
STAGED_BINARY="$(mktemp "$BIN_DIR/.ahelpa.install.XXXXXX")"
cp "$TMPDIR_INSTALL/ahelpa" "$STAGED_BINARY"
chmod 755 "$STAGED_BINARY"
if [ -e "$BIN_DIR/ahelpa" ] || [ -L "$BIN_DIR/ahelpa" ]; then
  if [ ! -f "$BIN_DIR/ahelpa" ]; then fail "Existing ahelpa is not a regular file."; fi
  BACKUP_PATH="$(mktemp "$BIN_DIR/ahelpa.backup.XXXXXX")"
  cp -p "$BIN_DIR/ahelpa" "$BACKUP_PATH"
  echo "previous runtime backup > $BACKUP_PATH"
fi
mv -f "$STAGED_BINARY" "$BIN_DIR/ahelpa"
STAGED_BINARY=""

echo "== install matching global skills -> codex + claude-code + kimi-code-cli =="
"$BIN_DIR/ahelpa" install-skill --source "$SKILL_SOURCE"

echo "== installed =="
"$BIN_DIR/ahelpa" version

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo
    echo "Add ahelpa to PATH if your shell cannot find it:"
    printf '  export PATH=%q:$PATH\n' "$BIN_DIR"
    ;;
esac
