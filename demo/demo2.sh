#!/bin/bash
# CamelAGI Demo 2 — Telegram admin bot: create agents, configure, monitor
# Run: bash demo/demo2.sh

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

pause() { sleep "${1:-1.5}"; }
out() { echo -e "$1"; }

clear
sleep 0.5

out "${BOLD}${CYAN}═══════════════════════════════════════════════════${RESET}"
out "${BOLD}${CYAN}  Telegram: @CamelAdmin                           ${RESET}"
out "${BOLD}${CYAN}═══════════════════════════════════════════════════${RESET}"
out ""
pause 1

printf "${BOLD}You:${RESET}  "
type_text "/newagent"
echo ""
pause 1
out "${BOLD}Bot:${RESET}  What should I call this agent?"
out ""
pause 0.8

printf "${BOLD}You:${RESET}  "
type_text "Coder"
echo ""
pause 1
out "${BOLD}Bot:${RESET}  Which model? (e.g. claude-sonnet-4-20250514)"
out ""
pause 0.8

printf "${BOLD}You:${RESET}  "
type_text "claude-sonnet-4-20250514"
echo ""
pause 1
out "${BOLD}Bot:${RESET}  Paste a BotFather token for this agent:"
out ""
pause 0.8

printf "${BOLD}You:${RESET}  "
type_text "6293847150:BBx_mNqRtYw3vKpLj7cFhDe9UiOaZs2bXg"
echo ""
pause 1.5

out "${BOLD}Bot:${RESET}  ${GREEN}✅ Agent \"Coder\" created and live!${RESET}"
out "      Model: claude-sonnet-4-20250514"
out "      → Talk to it: ${CYAN}@CoderAssistBot${RESET}"
out ""
pause 2

printf "${BOLD}You:${RESET}  "
type_text "/newagent"
echo ""
pause 1
out "${BOLD}Bot:${RESET}  What should I call this agent?"
out ""
pause 0.8

printf "${BOLD}You:${RESET}  "
type_text "Researcher"
echo ""
pause 1
out "${BOLD}Bot:${RESET}  Which model?"
out ""
pause 0.8

printf "${BOLD}You:${RESET}  "
type_text "claude-opus-4-20250514"
echo ""
pause 1
out "${BOLD}Bot:${RESET}  Paste a BotFather token for this agent:"
out ""
pause 0.8

printf "${BOLD}You:${RESET}  "
type_text "5182736409:CCy_pOsStUx4wLqMk8dGiEf0VjPbAr3cYh"
echo ""
pause 1.5

out "${BOLD}Bot:${RESET}  ${GREEN}✅ Agent \"Researcher\" created and live!${RESET}"
out "      Model: claude-opus-4-20250514"
out "      → Talk to it: ${CYAN}@ResearcherAIBot${RESET}"
out ""
pause 2

printf "${BOLD}You:${RESET}  "
type_text "/agents"
echo ""
pause 1

out "${BOLD}Bot:${RESET}  Your agents:"
out ""
out "      admin Admin (admin) — running"
out "         Model: anthropic/claude-sonnet-4-20250514"
out "         Telegram: configured"
out ""
out "      bot ${GREEN}Coder${RESET} (coder) — running"
out "         Model: claude-sonnet-4-20250514"
out "         Telegram: configured"
out ""
out "      bot ${GREEN}Researcher${RESET} (researcher) — running"
out "         Model: claude-opus-4-20250514"
out "         Telegram: configured"
out ""
pause 2

printf "${BOLD}You:${RESET}  "
type_text "/config approvals.mode smart"
echo ""
pause 1
out "${BOLD}Bot:${RESET}  approvals.mode = smart"
out ""
pause 1

printf "${BOLD}You:${RESET}  "
type_text "/status"
echo ""
pause 1
out "${BOLD}Bot:${RESET}  CamelAGI Status"
out ""
out "      Provider: openai"
out "      Model: anthropic/claude-sonnet-4-20250514"
out "      API Key: set"
out ""
out "      Bots: 3 running"
out "        running: admin"
out "        running: coder"
out "        running: researcher"
out ""
out "      Sessions: 0"
out "      Approvals: smart"
out ""
pause 4
