#!/bin/bash
# CamelAGI Bootstrap Demo — simulated terminal session for screen recording
# Run: bash demo/demo.sh

CYAN='\033[36m'
GREEN='\033[32m'
YELLOW='\033[33m'
DIM='\033[90m'
BOLD='\033[1m'
RESET='\033[0m'

type_text() {
  local text="$1"
  for ((i=0; i<${#text}; i++)); do
    printf '%s' "${text:$i:1}"
    sleep 0.04
  done
}

type_cmd() {
  printf "${GREEN}\$ ${RESET}"
  type_text "$1"
  sleep 0.3
  echo ""
  sleep 0.5
}

pause() { sleep "${1:-1.5}"; }
out() { echo -e "$1"; }

spin() {
  local text="$1"
  local duration="${2:-1.5}"
  local frames=("⠋" "⠙" "⠹" "⠸" "⠼" "⠴" "⠦" "⠧" "⠇" "⠏")
  local end=$((SECONDS + ${duration%.*}))
  while [ $SECONDS -lt $end ]; do
    for f in "${frames[@]}"; do
      printf "\r  ${CYAN}${f}${RESET} ${DIM}${text}${RESET}"
      sleep 0.08
    done
  done
}

spin_succeed() {
  printf "\r  ${GREEN}✔${RESET} $1\033[K\n"
}

# ═══════════════════════════════════════════════════════════
# SCENE 1: Command + Step 1 (Bot token)
# ═══════════════════════════════════════════════════════════

clear
sleep 1

type_cmd "camel bootstrap"
sleep 0.3

out ""
out "  ${CYAN}CamelAGI Bootstrap${RESET}"
out "  ${DIM}Sets up your admin bot, verifies your identity, then configures AI.${RESET}"
out "  ${DIM}After this, manage everything from Telegram.${RESET}"
out ""
out "  ${CYAN}Step 1: Telegram Admin Bot${RESET}"
out "  ${DIM}This bot lets you manage CamelAGI from Telegram.${RESET}"
out ""
out "  ${CYAN}┌──────────────────────────────────────────┐${RESET}"
out "  ${CYAN}│${RESET}  1. Open Telegram → ${BOLD}@BotFather${RESET} → ${BOLD}/newbot${RESET} ${CYAN}│${RESET}"
out "  ${CYAN}│${RESET}  2. Copy the bot token                  ${CYAN}│${RESET}"
out "  ${CYAN}└──────────────────────────────────────────┘${RESET}"
out ""

printf "  ${CYAN}Bot token:${RESET} "
sleep 0.8
type_text "7841923650:AAH_kX9mPvRzN3qWdL8fTjYc5VbEuKo1sAg"
echo ""

spin "Validating bot token..." 2
spin_succeed "Bot valid: @CamelAdmin (CamelAGI Admin)"
pause 0.3
spin_succeed "Admin bot configured"
pause 0.3

spin "Starting server..." 2
spin_succeed "Server running"

pause 2

# ═══════════════════════════════════════════════════════════
# SCENE 2: Step 2 (Pairing + OTP)
# ═══════════════════════════════════════════════════════════

clear
sleep 0.5

out ""
out "  ${CYAN}Step 2: Verify Your Identity${RESET}"
out ""
out "  ${CYAN}┌──────────────────────────────────────────┐${RESET}"
out "  ${CYAN}│${RESET}  Open Telegram and send any message to  ${CYAN}│${RESET}"
out "  ${CYAN}│${RESET}  ${BOLD}${CYAN}@CamelAdmin                            ${RESET}${CYAN}│${RESET}"
out "  ${CYAN}└──────────────────────────────────────────┘${RESET}"
out ""

spin "Waiting for your Telegram message..." 3
spin_succeed "Pairing request from @CamelBOT"
out ""
out "  ${CYAN}┌──────────────────────┐${RESET}"
out "  ${CYAN}│${RESET}  Code: ${BOLD}${YELLOW}FBV9KY${RESET}          ${CYAN}│${RESET}"
out "  ${CYAN}│${RESET}  User: ${BOLD}@CamelBOT${RESET}      ${CYAN}│${RESET}"
out "  ${CYAN}│${RESET}  ID:   100000001     ${CYAN}│${RESET}"
out "  ${CYAN}└──────────────────────┘${RESET}"
out ""
pause 1

printf "  ${CYAN}Approve @CamelBOT? (Y/n):${RESET} "
sleep 0.8
type_text "Y"
echo ""
pause 0.5

spin_succeed "Approved!"
out ""
out "  ${CYAN}┌──────────────────────────────────────────┐${RESET}"
out "  ${CYAN}│${RESET}                                          ${CYAN}│${RESET}"
out "  ${CYAN}│${RESET}   Your verification code:  ${BOLD}${YELLOW}70346${RESET}          ${CYAN}│${RESET}"
out "  ${CYAN}│${RESET}                                          ${CYAN}│${RESET}"
out "  ${CYAN}│${RESET}   Enter this code in the Telegram chat.  ${CYAN}│${RESET}"
out "  ${CYAN}│${RESET}                                          ${CYAN}│${RESET}"
out "  ${CYAN}└──────────────────────────────────────────┘${RESET}"
out ""

spin "Waiting for OTP verification..." 3
spin_succeed "@CamelBOT verified! You are now the admin."

pause 2

# ═══════════════════════════════════════════════════════════
# SCENE 3: Step 3 (API Setup)
# ═══════════════════════════════════════════════════════════

clear
sleep 0.5

printf "\n  ${CYAN}Step 3: Configure AI provider now? (Y/n):${RESET} "
sleep 0.8
type_text "Y"
echo ""
pause 0.5

out ""
out "  ${CYAN}Which provider?${RESET}"
out "    ${YELLOW}1${RESET}) anthropic  — Claude (direct)"
out "    ${YELLOW}2${RESET}) openai     — GPT (direct)"
out "    ${YELLOW}3${RESET}) openrouter — Any model via OpenRouter"
out "    ${YELLOW}4${RESET}) ollama     — Local models"
out "    ${YELLOW}5${RESET}) custom     — Custom OpenAI-compatible endpoint"
out ""

printf "  Pick [1-5]: "
sleep 0.8
type_text "3"
echo ""
pause 0.5

printf "\n  ${CYAN}OpenRouter API key:${RESET} "
sleep 0.5
type_text "sk-or-v1-a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1"
echo ""
pause 0.5

out ""
out "  ${CYAN}Which model?${RESET}"
out "    ${YELLOW}1${RESET}) anthropic/claude-sonnet-4-20250514"
out "    ${YELLOW}2${RESET}) anthropic/claude-opus-4-20250514"
out "    ${YELLOW}3${RESET}) anthropic/claude-haiku-4-20250506"
out "    ${YELLOW}4${RESET}) openai/gpt-4o"
out "    ${YELLOW}5${RESET}) openai/gpt-4o-mini"
out "    ${YELLOW}6${RESET}) google/gemini-2.5-pro"
out "    ${YELLOW}7${RESET}) deepseek/deepseek-r1"
out "    ${DIM}  ... (33 models available)${RESET}"
out ""

printf "  Pick [1-33]: "
sleep 0.8
type_text "1"
echo ""
pause 0.5

spin_succeed "API configured"
out "  ${DIM}  provider: openai${RESET}"
out "  ${DIM}  model:    anthropic/claude-sonnet-4-20250514${RESET}"
out "  ${DIM}  baseUrl:  https://openrouter.ai/api/v1${RESET}"
out "  ${DIM}  apiKey:   ***c2d1${RESET}"

pause 2

# ═══════════════════════════════════════════════════════════
# SCENE 4: Done
# ═══════════════════════════════════════════════════════════

clear
sleep 0.5

out ""
out ""
out ""
out "  ${CYAN}┌──────────────────────────────────────────┐${RESET}"
out "  ${CYAN}│${RESET}                                          ${CYAN}│${RESET}"
out "  ${CYAN}│${RESET}   ${GREEN}✅ Bootstrap complete!${RESET}                  ${CYAN}│${RESET}"
out "  ${CYAN}│${RESET}                                          ${CYAN}│${RESET}"
out "  ${CYAN}│${RESET}   Use ${BOLD}/newagent${RESET} in Telegram to create    ${CYAN}│${RESET}"
out "  ${CYAN}│${RESET}   your first AI agent.                   ${CYAN}│${RESET}"
out "  ${CYAN}│${RESET}                                          ${CYAN}│${RESET}"
out "  ${CYAN}│${RESET}   Server is running.                     ${CYAN}│${RESET}"
out "  ${CYAN}│${RESET}   Press Ctrl+C to stop.                  ${CYAN}│${RESET}"
out "  ${CYAN}│${RESET}                                          ${CYAN}│${RESET}"
out "  ${CYAN}└──────────────────────────────────────────┘${RESET}"
out ""
out ""

pause 4
