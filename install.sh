#!/bin/bash
set -e

# CamelAGI installer — downloads a single binary, no Node.js or npm needed.
# Usage: curl -fsSL https://raw.githubusercontent.com/inawafalm/CamelAGI/main/install.sh | bash

REPO="inawafalm/CamelAGI"
INSTALL_DIR="$HOME/.camelagi/bin"

# Colors
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

echo ""
echo -e "  ${CYAN}${BOLD}CamelAGI Installer${NC}"
echo -e "  ${DIM}Personal AI assistant powered by Claude Agent SDK${NC}"
echo ""

# Detect platform
case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux) os="linux" ;;
    *) echo -e "  ${RED}Unsupported OS: $(uname -s)${NC}"; exit 1 ;;
esac

case "$(uname -m)" in
    x86_64|amd64) arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) echo -e "  ${RED}Unsupported architecture: $(uname -m)${NC}"; exit 1 ;;
esac

# Detect Rosetta
if [ "$os" = "darwin" ] && [ "$arch" = "x64" ]; then
    if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = "1" ]; then
        arch="arm64"
    fi
fi

platform="${os}-${arch}"
echo -e "  ${DIM}Platform: ${platform}${NC}"

# Get latest release tag from GitHub
echo -e "  ${DIM}Checking latest version...${NC}"
if command -v curl >/dev/null 2>&1; then
    latest=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"//;s/".*//')
elif command -v wget >/dev/null 2>&1; then
    latest=$(wget -qO- "https://api.github.com/repos/$REPO/releases/latest" | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"//;s/".*//')
else
    echo -e "  ${RED}curl or wget is required${NC}"
    exit 1
fi

if [ -z "$latest" ]; then
    echo -e "  ${RED}Could not determine latest version${NC}"
    echo -e "  ${DIM}Check https://github.com/$REPO/releases${NC}"
    exit 1
fi

echo -e "  ${DIM}Version: ${latest}${NC}"

# Download binary
binary_name="camelagi-${platform}"
download_url="https://github.com/$REPO/releases/download/${latest}/${binary_name}"

echo -e "  ${CYAN}Downloading...${NC}"
mkdir -p "$INSTALL_DIR"
dest="$INSTALL_DIR/camel"

if command -v curl >/dev/null 2>&1; then
    if ! curl -fsSL -o "$dest" "$download_url"; then
        echo -e "  ${RED}Download failed${NC}"
        echo -e "  ${DIM}URL: $download_url${NC}"
        echo -e "  ${DIM}Binary for your platform may not be available yet.${NC}"
        exit 1
    fi
else
    if ! wget -q -O "$dest" "$download_url"; then
        echo -e "  ${RED}Download failed${NC}"
        exit 1
    fi
fi

chmod +x "$dest"

# Create camelagi symlink
ln -sf "camel" "$INSTALL_DIR/camelagi"

# Add to PATH
add_to_path() {
    local profile="$1"
    local marker="# CamelAGI"
    if [ -f "$profile" ] && grep -q "$marker" "$profile"; then
        return 0  # Already added
    fi
    echo "" >> "$profile"
    echo "export PATH=\"$INSTALL_DIR:\$PATH\" $marker" >> "$profile"
    echo -e "  ${DIM}Added to PATH in $profile${NC}"
}

SHELL_NAME=$(basename "$SHELL")
case "$SHELL_NAME" in
    zsh)  add_to_path "$HOME/.zshrc" ;;
    bash)
        if [ -f "$HOME/.bash_profile" ]; then
            add_to_path "$HOME/.bash_profile"
        else
            add_to_path "$HOME/.bashrc"
        fi
        ;;
    *)    add_to_path "$HOME/.profile" ;;
esac

echo ""
echo -e "  ${GREEN}${BOLD}✅ CamelAGI installed!${NC}"
echo ""
echo -e "  ${DIM}Location: $dest${NC}"
echo -e "  ${DIM}Version:  $latest${NC}"
echo ""
echo -e "  ${CYAN}Get started:${NC}"
echo -e "    ${BOLD}camel bootstrap${NC}     First-time setup"
echo -e "    ${BOLD}camel serve${NC}         Start the server"
echo -e "    ${BOLD}camel chat${NC}          Interactive TUI"
echo ""
echo -e "  ${DIM}Restart your terminal or run:${NC}"
echo -e "    source ~/.${SHELL_NAME}rc"
echo ""
