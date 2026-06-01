#!/usr/bin/env bash
# =============================================================================
# GeminiClaw CLI Installer
# Installs `geminiclaw` and `gc` commands to your system.
#
# Usage:
#   bash scripts/install.sh           # install (auto-detect prefix)
#   bash scripts/install.sh --uninstall  # remove installed commands
#   bash scripts/install.sh --prefix /usr/local  # specify install prefix
# =============================================================================

set -euo pipefail

# ── colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

ok()   { echo -e "${GREEN}✅ $*${RESET}"; }
info() { echo -e "${CYAN}ℹ️  $*${RESET}"; }
warn() { echo -e "${YELLOW}⚠️  $*${RESET}"; }
fail() { echo -e "${RED}❌ $*${RESET}"; exit 1; }
header() { echo -e "\n${BOLD}$*${RESET}"; }

# ── parse args ───────────────────────────────────────────────────────────────
UNINSTALL=false
INSTALL_PREFIX=""

for arg in "$@"; do
  case "$arg" in
    --uninstall) UNINSTALL=true ;;
    --prefix=*) INSTALL_PREFIX="${arg#--prefix=}" ;;
    --prefix)   shift; INSTALL_PREFIX="$1" ;;
    -h|--help)
      echo "Usage: bash scripts/install.sh [--uninstall] [--prefix <dir>]"
      echo ""
      echo "Options:"
      echo "  --uninstall        Remove geminiclaw and gc from the system"
      echo "  --prefix <dir>     Install prefix (default: auto-detect)"
      echo "  -h, --help         Show this help"
      exit 0
      ;;
  esac
done

# ── locate project root ───────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

header "🦀 GeminiClaw CLI Installer"
info "Project root: $PROJECT_ROOT"

# ── resolve install prefix ────────────────────────────────────────────────────
resolve_prefix() {
  # 1. explicit --prefix
  if [[ -n "$INSTALL_PREFIX" ]]; then
    echo "$INSTALL_PREFIX"
    return
  fi
  # 2. writable /usr/local/bin (most macOS / Linux setups)
  if [[ -d /usr/local/bin && -w /usr/local/bin ]]; then
    echo "/usr/local"
    return
  fi
  # 3. Homebrew prefix
  if command -v brew &>/dev/null; then
    echo "$(brew --prefix)"
    return
  fi
  # 4. ~/.local (user-level, no sudo needed)
  echo "$HOME/.local"
}

PREFIX="$(resolve_prefix)"
BIN_DIR="$PREFIX/bin"
info "Install prefix: $PREFIX  (bin: $BIN_DIR)"

# ── uninstall ─────────────────────────────────────────────────────────────────
if $UNINSTALL; then
  header "🗑  Uninstalling GeminiClaw CLI"
  removed=0
  for cmd in geminiclaw gc; do
    target="$BIN_DIR/$cmd"
    if [[ -L "$target" || -f "$target" ]]; then
      rm -f "$target"
      ok "Removed $target"
      removed=$((removed + 1))
    else
      warn "$target not found, skipping"
    fi
  done
  [[ $removed -gt 0 ]] && ok "Uninstall complete." || warn "Nothing was removed."
  exit 0
fi

# ── pre-flight checks ─────────────────────────────────────────────────────────
header "🔍 Pre-flight checks"

# Node.js >= 20
if ! command -v node &>/dev/null; then
  fail "Node.js not found. Please install Node.js >= 20 first."
fi
NODE_VER="$(node -e 'process.stdout.write(process.version)')"
NODE_MAJOR="${NODE_VER//v/}"; NODE_MAJOR="${NODE_MAJOR%%.*}"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  fail "Node.js >= 20 required (found $NODE_VER)"
fi
ok "Node.js $NODE_VER"

# dist/cli/index.js must exist
ENTRY="$PROJECT_ROOT/dist/cli/index.js"
if [[ ! -f "$ENTRY" ]]; then
  warn "dist/cli/index.js not found — building now..."
  cd "$PROJECT_ROOT"
  if command -v pnpm &>/dev/null; then
    pnpm build || fail "Build failed. Fix errors above and retry."
  elif command -v npx &>/dev/null; then
    npx tsc || fail "Build failed. Fix errors above and retry."
  else
    fail "Neither pnpm nor npx found. Please build manually: npx tsc"
  fi
  ok "Build succeeded"
else
  ok "dist/cli/index.js exists"
fi

# Ensure shebang is present
SHEBANG="$(head -1 "$ENTRY")"
if [[ "$SHEBANG" != "#!/usr/bin/env node" ]]; then
  warn "Adding shebang to dist/cli/index.js"
  TMP="$(mktemp)"
  { echo "#!/usr/bin/env node"; cat "$ENTRY"; } > "$TMP"
  mv "$TMP" "$ENTRY"
fi
chmod +x "$ENTRY"
ok "Entry point is executable"

# ── create bin dir if needed ──────────────────────────────────────────────────
if [[ ! -d "$BIN_DIR" ]]; then
  info "Creating $BIN_DIR"
  mkdir -p "$BIN_DIR" || fail "Cannot create $BIN_DIR — try sudo or use --prefix"
fi

if [[ ! -w "$BIN_DIR" ]]; then
  fail "$BIN_DIR is not writable. Try:\n  sudo bash scripts/install.sh\nor:\n  bash scripts/install.sh --prefix ~/.local"
fi

# ── install symlinks ──────────────────────────────────────────────────────────
header "🔗 Installing commands"

for cmd in geminiclaw gc; do
  TARGET="$BIN_DIR/$cmd"
  if [[ -e "$TARGET" && ! -L "$TARGET" ]]; then
    warn "$TARGET exists and is not a symlink — skipping (remove it manually if needed)"
    continue
  fi
  ln -sf "$ENTRY" "$TARGET"
  ok "Installed $TARGET -> $ENTRY"
done

# ── PATH check ────────────────────────────────────────────────────────────────
header "🔎 PATH check"

if echo "$PATH" | tr ':' '\n' | grep -qx "$BIN_DIR"; then
  ok "$BIN_DIR is in your PATH"
else
  warn "$BIN_DIR is NOT in your PATH"
  echo ""
  echo "  Add the following to your shell profile (~/.zshrc / ~/.bashrc):"
  echo ""
  echo -e "    ${CYAN}export PATH=\"$BIN_DIR:\$PATH\"${RESET}"
  echo ""
  echo "  Then reload:"
  echo -e "    ${CYAN}source ~/.zshrc${RESET}   # or source ~/.bashrc"
fi

# ── smoke test ────────────────────────────────────────────────────────────────
header "🧪 Smoke test"

if "$BIN_DIR/geminiclaw" --version &>/dev/null; then
  VERSION="$("$BIN_DIR/geminiclaw" --version 2>&1)"
  ok "geminiclaw $VERSION is working"
else
  warn "geminiclaw --version failed — check the log above"
fi

# ── done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}🎉 Installation complete!${RESET}"
echo ""
echo "  Commands installed:"
echo -e "    ${CYAN}geminiclaw${RESET}  — full command"
echo -e "    ${CYAN}gc${RESET}          — short alias"
echo ""
echo "  Quick start:"
echo -e "    ${CYAN}geminiclaw --help${RESET}"
echo -e "    ${CYAN}geminiclaw status${RESET}"
echo -e "    ${CYAN}geminiclaw start${RESET}"
echo ""
