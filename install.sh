#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${VROUTER_REPO_URL:-https://github.com/VRouter1.0/VRouter1.0.git}"
INSTALL_DIR="${VROUTER_HOME:-$HOME/.vrouter}"
BIN_DIR="${VROUTER_BIN_DIR:-$HOME/.local/bin}"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 veya üzeri gerekli." >&2
  exit 1
fi

if [ -d "$INSTALL_DIR/.git" ]; then
  git -C "$INSTALL_DIR" pull --ff-only
else
  if [ -e "$INSTALL_DIR" ]; then
    echo "Kurulum klasörü zaten mevcut ve Git deposu değil: $INSTALL_DIR" >&2
    echo "VROUTER_HOME ile boş veya farklı bir klasör seçin." >&2
    exit 1
  fi
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"
npm install --omit=dev
mkdir -p "$BIN_DIR"
ln -sf "$INSTALL_DIR/bin/vrouter.js" "$BIN_DIR/vrouter"

echo
echo "VRouter kuruldu: $INSTALL_DIR"
echo "Komut: $BIN_DIR/vrouter start"
case ":${PATH}:" in
  *":$BIN_DIR:"*) ;;
  *) echo "PATH'e eklemek için: export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
