#!/bin/bash
set -e

# CamelAGI installer — downloads a single binary, no Node.js or npm needed.
# Usage: curl -fsSL https://raw.githubusercontent.com/inawafalm/CamelAGI/main/install.sh | bash

REPO="inawafalm/CamelAGI"
VERSIONS_DIR="$HOME/.camelagi/versions"
BIN_DIR="$HOME/.camelagi/bin"

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
    exit 1
fi

# Strip v prefix for version directory
version="${latest#v}"
echo -e "  ${DIM}Version: ${version}${NC}"

# Check if already installed at this version
if [ -f "$VERSIONS_DIR/$version" ]; then
    echo -e "  ${GREEN}Already installed (v${version})${NC}"
    echo ""
    exit 0
fi

# Download binary
binary_name="camelagi-${platform}"
download_url="https://github.com/$REPO/releases/download/${latest}/${binary_name}"

echo -e "  ${CYAN}Downloading...${NC}"
mkdir -p "$VERSIONS_DIR"
mkdir -p "$BIN_DIR"
dest="$VERSIONS_DIR/$version"

if command -v curl >/dev/null 2>&1; then
    if ! curl -fsSL -o "$dest" "$download_url"; then
        echo -e "  ${RED}Download failed${NC}"
        echo -e "  ${DIM}URL: $download_url${NC}"
        rm -f "$dest"
        exit 1
    fi
else
    if ! wget -q -O "$dest" "$download_url"; then
        echo -e "  ${RED}Download failed${NC}"
        rm -f "$dest"
        exit 1
    fi
fi

chmod +x "$dest"

# Create symlinks in ~/.camelagi/bin/
ln -sf "$dest" "$BIN_DIR/camel"
ln -sf "$dest" "$BIN_DIR/camelagi"

# Create symlinks in /usr/local/bin (already in PATH — works immediately)
NEEDS_RESTART=false

if [ -d "/usr/local/bin" ] && [ -w "/usr/local/bin" ]; then
    ln -sf "$dest" /usr/local/bin/camel
    ln -sf "$dest" /usr/local/bin/camelagi
    echo -e "  ${DIM}Linked to /usr/local/bin/${NC}"
elif sudo mkdir -p /usr/local/bin 2>/dev/null && \
     sudo ln -sf "$dest" /usr/local/bin/camel && \
     sudo ln -sf "$dest" /usr/local/bin/camelagi; then
    echo -e "  ${DIM}Linked to /usr/local/bin/${NC}"
else
    # Fallback: add to shell profile
    add_to_path() {
        local profile="$1"
        local marker="# CamelAGI"
        if [ -f "$profile" ] && grep -q "$marker" "$profile"; then
            return 0
        fi
        echo "" >> "$profile"
        echo "export PATH=\"$BIN_DIR:\$PATH\" $marker" >> "$profile"
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
    NEEDS_RESTART=true
fi

# Clean old versions (keep last 3)
if [ -d "$VERSIONS_DIR" ]; then
    ls -t "$VERSIONS_DIR" | tail -n +4 | while read old; do
        rm -f "$VERSIONS_DIR/$old"
    done
fi

echo ""
echo -e "  ${GREEN}${BOLD}CamelAGI installed! (v${version})${NC}"
echo ""
if [ "$NEEDS_RESTART" = true ]; then
    echo -e "  ${YELLOW}Restart your terminal, then:${NC}"
else
    echo -e "  ${CYAN}Get started:${NC}"
fi
echo -e "    ${BOLD}camel setup${NC}         Configure AI provider"
echo -e "    ${BOLD}camel chat${NC}          Interactive TUI"
echo -e "    ${BOLD}camel serve${NC}         Start the server"
echo -e "    ${BOLD}camel update${NC}        Update to latest version"
echo ""
