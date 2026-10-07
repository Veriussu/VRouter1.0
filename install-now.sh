#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${VROUTER_HOME:-$HOME/.vrouter}"
BIN_DIR="${VROUTER_BIN_DIR:-$HOME/.local/bin}"
ARCHIVE_URL="https://codeload.github.com/Veriussu/VRouter1.0/tar.gz/refs/heads/main"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 veya üzeri gerekli." >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1 || ! command -v tar >/dev/null 2>&1; then
  echo "curl ve tar gerekli." >&2
  exit 1
fi

archive_dir=$(mktemp -d)
trap 'rm -rf "$archive_dir"' EXIT
curl -fsSL "$ARCHIVE_URL" | tar -xz -C "$archive_dir"
source_dir=$(find "$archive_dir" -mindepth 1 -maxdepth 1 -type d -print -quit)
if [ -z "$source_dir" ]; then
  echo "VRouter arşivi indirilemedi." >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"
cp -a "$source_dir"/. "$INSTALL_DIR"/
cd "$INSTALL_DIR"
npm install --omit=dev
mkdir -p "$BIN_DIR"
ln -sf "$INSTALL_DIR/bin/vrouter.js" "$BIN_DIR/vrouter"

echo
echo "VRouter kuruldu: $INSTALL_DIR"
echo "Komut: $BIN_DIR/vrouter start"
echo "Web: https://veriussu.com"
echo "İletişim: info@veriussu.com"
case ":${PATH}:" in
  *":$BIN_DIR:"*) ;;
  *) echo "PATH'e eklemek için: export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
