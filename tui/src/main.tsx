import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { App } from "./App.js"
import { DEFAULT_MODEL } from "./config.js"

const model = process.env.CAMELAGI_MODEL ?? DEFAULT_MODEL
const cwd = process.env.CAMELAGI_CWD ?? process.cwd()
const wsUrl = process.env.CAMELAGI_WS_URL
const token = process.env.CAMELAGI_TOKEN

const renderer = await createCliRenderer({ exitOnCtrlC: false, useMouse: false })
createRoot(renderer).render(<App model={model} cwd={cwd} wsUrl={wsUrl} token={token} />)
