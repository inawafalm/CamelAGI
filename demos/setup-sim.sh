#!/usr/bin/env bash
# CamelAGI setup — fully simulated wizard for screen recording.
# Pretends to be the live wizard: animated menu cursor, typed input, search filter, spinners.
# Nothing real is touched.

# Note: no `set -u` — bash 3.2 (macOS default) chokes on some of the
# parameter expansions used below, and strict mode adds no safety to a
# cosmetic playback script.

# ── Colors (ANSI-C quoted so they're real bytes) ────────────────────
C=$'\033[36m'   # cyan frame
G=$'\033[90m'   # dim
B=$'\033[1m'    # bold
Y=$'\033[33m'
GR=$'\033[32m'
RD=$'\033[31m'
INV=$'\033[7m'  # inverse (highlight)
X=$'\033[0m'

# ── Tunables ────────────────────────────────────────────────────────
T_SHORT=0.18
T_STEP=0.55
T_THINK=0.9
T_KEY=0.04        # cursor move between options
T_TYPE=0.045      # char typing speed
T_TYPE_FAST=0.018
SPIN_TICK=0.11

# ── Low-level ANSI helpers ──────────────────────────────────────────
up()    { printf '\033[%dA' "$1"; }
down()  { printf '\033[%dB' "$1"; }
clr_ln() { printf '\033[2K\r'; }
hide_cursor() { printf '\033[?25l'; }
show_cursor() { printf '\033[?25h'; }
trap 'show_cursor' EXIT INT

# ── Building blocks ─────────────────────────────────────────────────
bar()    { printf "%s│%s\n" "$C" "$X"; }
header() { printf "%s┌%s  %s%s%s\n" "$C" "$X" "$B" "$1" "$X"; bar; }

# Print a "completed" question (◇  Question  /  │  answer  /  │)
answered() {
  local q="$1" a="$2"
  printf "%s◇%s  %s\n" "$C" "$X" "$q"
  printf "%s│%s  %s%s%s\n" "$C" "$X" "$GR" "$a" "$X"
  bar
}

# Print an info bullet ●
info() {
  printf "%s●%s  %b\n" "$C" "$X" "$1"
  bar
}

# Type a string char-by-char to stdout
type_out() {
  local s="$1" speed="${2:-$T_TYPE}" i
  for ((i = 0; i < ${#s}; i++)); do
    printf "%s" "${s:$i:1}"
    sleep "$speed"
  done
}

# Animated select prompt.
# Args: question, target_index, opt1, opt2, ...
# Each option string is "LABEL|HINT" (hint optional).
prompt_select() {
  local q="$1" target="$2"; shift 2
  local opts=("$@")
  local n="${#opts[@]}"
  local cur=0 i

  # Print the active question header
  printf "%s◆%s  %s\n" "$C" "$X" "$q"
  # Print initial menu
  render_menu() {
    local active="$1" i label hint line
    for ((i = 0; i < n; i++)); do
      label="${opts[$i]%%|*}"
      hint=""
      if [[ "${opts[$i]}" == *"|"* ]]; then hint="${opts[$i]#*|}"; fi
      if [ "$i" -eq "$active" ]; then
        line="$C│$X  $GR●$X $B$label$X"
        [ -n "$hint" ] && line+="  $G$hint$X"
      else
        line="$C│$X  $G○$X $label"
        [ -n "$hint" ] && line+="  $G$hint$X"
      fi
      clr_ln
      printf "%b\n" "$line"
    done
  }
  render_menu 0
  sleep "$T_THINK"

  # Animate cursor moves from 0 → target
  while [ "$cur" -lt "$target" ]; do
    cur=$((cur + 1))
    up "$n"
    render_menu "$cur"
    sleep "$T_KEY"
  done
  sleep "$T_SHORT"

  # "Press Enter" → collapse menu into answered form
  up $((n + 1))
  clr_ln
  printf "%s◇%s  %s\n" "$C" "$X" "$q"
  local chosen="${opts[$target]%%|*}"
  clr_ln
  printf "%s│%s  %s%s%s\n" "$C" "$X" "$GR" "$chosen" "$X"
  # Clear remaining option lines
  for ((i = 2; i <= n; i++)); do clr_ln; printf "\n"; done
  up $((n - 1))
  bar
  sleep "$T_STEP"
}

# Animated text input. Args: question, value, [mask:1/0], [type_speed]
prompt_input() {
  local q="$1" val="$2" masked="${3:-0}" speed="${4:-$T_TYPE}"
  printf "%s◆%s  %s\n" "$C" "$X" "$q"
  printf "%s│%s  " "$C" "$X"
  if [ "$masked" = "1" ]; then
    local i
    for ((i = 0; i < ${#val}; i++)); do
      printf "▪"
      sleep "$speed"
    done
  else
    type_out "$val" "$speed"
  fi
  printf "\n"
  sleep "$T_SHORT"
  # Collapse ◆ → ◇
  up 2
  clr_ln
  printf "%s◇%s  %s\n" "$C" "$X" "$q"
  down 1
  printf "\n"
  bar
  sleep "$T_STEP"
}

# Spinner with label, resolves to ◇ done line. Args: label, seconds, [final_label]
spinner() {
  local label="$1" seconds="$2" final="${3:-$1}"
  local frames=("◐" "◓" "◑" "◒")
  local end=$(( $(date +%s) + seconds ))
  local i=0
  hide_cursor
  while [ "$(date +%s)" -lt "$end" ]; do
    clr_ln
    printf "%s%s%s  %s" "$C" "${frames[$((i % 4))]}" "$X" "$label"
    sleep "$SPIN_TICK"
    i=$((i + 1))
  done
  clr_ln
  printf "%s◇%s  %s\n" "$C" "$X" "$final"
  bar
  show_cursor
}

# Inline tick for fetch-like ops (single line, replaced)
tick_line() {
  local label="$1" seconds="$2"
  local end=$(( $(date +%s) + seconds ))
  hide_cursor
  while [ "$(date +%s)" -lt "$end" ]; do
    clr_ln
    printf "%s   %s...%s" "$G" "$label" "$X"
    sleep 0.18
  done
  clr_ln
  show_cursor
}

# Searchable model picker — types into a search box and the list filters down.
# Args: query (e.g. "haiku"), final_choice
prompt_model_search() {
  local query="$1" pick="$2"

  printf "%s◆%s  Model %s(332 available — type to filter)%s\n" "$C" "$X" "$G" "$X"
  printf "%s│%s  %s❯%s " "$C" "$X" "$B" "$X"
  # Reserve 6 option lines
  local i
  for ((i = 0; i < 6; i++)); do printf "\n%s│%s\n" "$C" "$X"; done
  up 12

  # Initial unfiltered list
  local list_full=(
    "openai/gpt-4o"
    "openai/gpt-4o-mini"
    "anthropic/claude-sonnet-4.6"
    "anthropic/claude-opus-4.7"
    "anthropic/claude-haiku-4.5"
    "google/gemini-2.5-pro"
  )

  # Render list helper. $1 = highlighted index, args = entries
  render_list() {
    local hi="$1"; shift
    local items=("$@")
    local k
    # Move to first option line (2 lines below current input line in this layout)
    down 1
    for ((k = 0; k < 6; k++)); do
      clr_ln
      if [ "$k" -lt "${#items[@]}" ]; then
        if [ "$k" -eq "$hi" ]; then
          printf "%s│%s  %s%s ▸ %s%s\n" "$C" "$X" "$INV" "$GR" "${items[$k]}" "$X"
        else
          printf "%s│%s    %s\n" "$C" "$X" "${items[$k]}"
        fi
      else
        printf "%s│%s\n" "$C" "$X"
      fi
    done
    up 7
  }

  render_list 0 "${list_full[@]}"
  # Move cursor back to search line
  sleep "$T_THINK"

  # Type the search query, filtering as we go
  local typed=""
  for ((i = 0; i < ${#query}; i++)); do
    typed+="${query:$i:1}"
    # Move cursor to end of search line and append the char
    clr_ln
    printf "%s│%s  %s❯%s %s" "$C" "$X" "$B" "$X" "$typed"
    # Filter list against $typed (case-insensitive substring)
    local filtered=()
    local m typed_lc m_lc
    typed_lc=$(printf "%s" "$typed" | tr '[:upper:]' '[:lower:]')
    for m in "${list_full[@]}"; do
      m_lc=$(printf "%s" "$m" | tr '[:upper:]' '[:lower:]')
      case "$m_lc" in *"$typed_lc"*) filtered+=("$m") ;; esac
    done
    # Re-render list (use index 0 highlight)
    render_list 0 "${filtered[@]}"
    sleep "$T_TYPE"
  done
  sleep "$T_THINK"

  # If pick differs from filtered[0], animate cursor moving down to it
  local filtered=()
  local query_lc m_lc
  query_lc=$(printf "%s" "$query" | tr '[:upper:]' '[:lower:]')
  for m in "${list_full[@]}"; do
    m_lc=$(printf "%s" "$m" | tr '[:upper:]' '[:lower:]')
    case "$m_lc" in *"$query_lc"*) filtered+=("$m") ;; esac
  done
  local idx=0 j
  for ((j = 0; j < ${#filtered[@]}; j++)); do
    if [ "${filtered[$j]}" = "$pick" ]; then idx="$j"; break; fi
  done
  local hi=0
  while [ "$hi" -lt "$idx" ]; do
    hi=$((hi + 1))
    render_list "$hi" "${filtered[@]}"
    sleep "$T_KEY"
  done
  sleep "$T_SHORT"

  # Collapse to answered form
  # Clear search + 6 list lines
  clr_ln
  printf "%s◇%s  Model\n" "$C" "$X"
  clr_ln
  printf "%s│%s  %s%s%s\n" "$C" "$X" "$GR" "$pick" "$X"
  for ((j = 0; j < 6; j++)); do clr_ln; printf "\n"; done
  up 6
  bar
  sleep "$T_STEP"
}

# ── Storyboard ──────────────────────────────────────────────────────
clear
hide_cursor

header "CamelAGI setup"

# Existing state lines (rendered as already-known facts)
printf "%s◆%s  API: openai / %s~anthropic/claude-haiku-latest%s\n" "$C" "$X" "$G" "$X"
bar
printf "%s◇%s  Telegram: %snot configured%s\n" "$C" "$X" "$G" "$X"
bar
sleep "$T_STEP"

# Q1 — usage mode (cursor lands on "Both" — index 2)
prompt_select "How do you want to use CamelAGI?" 2 \
  "Terminal (TUI)|Just need an API key" \
  "Telegram|Admin bot + agents from Telegram" \
  "Both|Terminal + Telegram"

# Q2 — reconfigure API (cursor on Yes — index 0)
prompt_select "Reconfigure API provider?" 0 \
  "Yes" \
  "No"

# Q3 — provider (cursor lands on OpenRouter — index 2)
prompt_select "Provider" 2 \
  "OpenAI|GPT models, direct" \
  "Anthropic|Claude models, direct" \
  "OpenRouter|332+ models, one key" \
  "Custom (OpenAI-compatible)"

# Q4 — API key typed in (masked, 77 chars)
prompt_input "OpenRouter API key" \
  "sk-or-v1-9f3a2c8b71e64dba0c5e7d419f8b62af0d3c4187be29ff5a8c1e6730bd24a98" \
  1 0.022

# Q5 — fetch & model picker
tick_line "fetching model catalog" 1.6
printf "%s◇%s  %s332 models available%s\n" "$C" "$X" "$GR" "$X"
bar
sleep "$T_SHORT"

prompt_model_search "haiku" "anthropic/claude-haiku-4.5"

printf "%s◆%s  openai / %s%s%s\n" "$C" "$X" "$B" "anthropic/claude-haiku-4.5" "$X"
bar
sleep "$T_STEP"

# Telegram phase
printf "%s◇%s  Telegram Admin Bot\n" "$C" "$X"
bar
info "Create a bot in Telegram via ${B}@BotFather${X} → ${Y}/newbot${X}, then paste the token."

prompt_input "Bot token" \
  "7234567890:AAH8b3kQpL2v9XzY4mNcR5tFwE6gHsKjAaB" \
  1 0.03

spinner "verifying bot" 1.2 "Bot valid: ${B}@CamelAGIDemo_bot${X}"

spinner "Starting admin bot..  ${G}[admin] polling...${X}" 2.2 "Admin bot running"

info "Send any message to ${B}@CamelAGIDemo_bot${X} in Telegram."

# Hold the final frame for the recording
sleep 4
printf "%s└%s  %sWaiting for first message...%s\n\n" "$C" "$X" "$G" "$X"
show_cursor
