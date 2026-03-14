# Changelog

## 0.5.0 — 2026-03-14

Initial open-source release as **CamelAGI**.

### Features
- **Claude Agent SDK** — dual-path agent runtime (native SDK + OpenAI compat)
- **Telegram Admin Agent** — BotFather-style control plane with agent creation wizard
- **Two-tier memory** — curated MEMORY.md + daily notes with recency-boosted search
- **Agent-scoped memory** — isolated memory per agent (tools + compaction flush)
- **Context compaction** — auto-summarize at 80% capacity with memory flush
- **10 built-in tools** — exec, read, write, edit, apply_patch, fetch, web_search, memory_search, memory_get, cron
- **Gateway server** — Express + WebSocket with rate limiting, request logging
- **TUI** — full terminal UI with overlays, slash commands, streaming
- **Multi-agent** — named agents with per-agent model, thinking, effort, Telegram bot
- **Cron jobs** — config + runtime tool + CLI management with error backoff
- **Approvals** — off/smart/always modes with Telegram forwarding
- **Lifecycle hooks** — before/after tool execution hooks
- **Skills system** — custom skill loader
- **OTP pairing** — secure user onboarding for Telegram bots
- **Daemon** — macOS launchd integration (install/uninstall/status)
- **Doctor** — comprehensive health check suite
- **CLI** — 12 commands (bootstrap, setup, serve, chat, agents, sessions, config, cron, daemon, doctor, logs, reset)
