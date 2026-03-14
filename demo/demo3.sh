#!/bin/bash
# CamelAGI Demo 3 — Talk to an agent + isolated memory
# Run: bash demo/demo3.sh

CYAN='\033[36m'
GREEN='\033[32m'
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
out "${BOLD}${CYAN}  Telegram: @CoderAssistBot                        ${RESET}"
out "${BOLD}${CYAN}═══════════════════════════════════════════════════${RESET}"
out ""
pause 1

printf "${BOLD}You:${RESET}  "
type_text "/start"
echo ""
pause 1
out "${BOLD}Bot:${RESET}  Coder is ready."
out "      Model: claude-sonnet-4-20250514"
out "      Send me a message or type /help for commands."
out ""
pause 1.5

printf "${BOLD}You:${RESET}  "
type_text "Read my project at ~/myapp and explain the architecture"
echo ""
pause 1
out "${BOLD}Bot:${RESET}  ${DIM}🔧 exec(ls ~/myapp/src)${RESET}"
sleep 0.8
out "      ${DIM}🔧 read(~/myapp/src/index.ts)${RESET}"
sleep 0.8
out "      ${DIM}🔧 read(~/myapp/src/routes.ts)${RESET}"
sleep 1.5
out ""
out "      Your project is an Express API with 3 main modules:"
out "      - ${CYAN}index.ts${RESET} — entry point, middleware setup"
out "      - ${CYAN}routes.ts${RESET} — REST endpoints (CRUD for users)"
out "      - ${CYAN}db.ts${RESET} — PostgreSQL connection pool"
out ""
out "      ${DIM}I've saved this to my memory for next time.${RESET}"
out ""
pause 3

clear
sleep 0.5

out ""
out "  ${BOLD}Each agent has isolated memory powered by Claude Agent SDK:${RESET}"
out ""
sleep 0.5

out "  ${DIM}~/.camel/${RESET}"
sleep 0.2
out "  ${DIM}├── config.yaml${RESET}"
sleep 0.2
out "  ${DIM}├── agents/${RESET}"
sleep 0.2
out "  ${DIM}│   ├── ${GREEN}admin/${RESET}"
sleep 0.2
out "  ${DIM}│   │   └── SOUL.md${RESET}"
sleep 0.2
out "  ${DIM}│   ├── ${GREEN}coder/${RESET}"
sleep 0.2
out "  ${DIM}│   │   ├── SOUL.md          ${CYAN}← personality${RESET}"
sleep 0.2
out "  ${DIM}│   │   ├── MEMORY.md        ${CYAN}← curated knowledge${RESET}"
sleep 0.2
out "  ${DIM}│   │   └── memory/${RESET}"
sleep 0.2
out "  ${DIM}│   │       └── 2026-03-14.md ${CYAN}← today's auto-journal${RESET}"
sleep 0.2
out "  ${DIM}│   └── ${GREEN}researcher/${RESET}"
sleep 0.2
out "  ${DIM}│       ├── SOUL.md          ${CYAN}← personality${RESET}"
sleep 0.2
out "  ${DIM}│       ├── MEMORY.md        ${CYAN}← curated knowledge${RESET}"
sleep 0.2
out "  ${DIM}│       └── memory/${RESET}"
sleep 0.2
out "  ${DIM}└── workspace/${RESET}"
sleep 0.2
out "  ${DIM}    ├── AGENTS.md${RESET}"
sleep 0.2
out "  ${DIM}    ├── SOUL.md${RESET}"
sleep 0.2
out "  ${DIM}    └── USER.md${RESET}"
out ""
pause 2

out "  ${BOLD}${GREEN}All managed from Telegram. No terminal needed.${RESET}"
out ""
pause 4
