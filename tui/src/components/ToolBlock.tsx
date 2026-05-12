// Dispatches per-tool renderers. Add a new tool? Add a case here +
// a renderer in components/tools/.

import type { ChatEntry } from "../state/reducer.js"
import { BashTool } from "./tools/BashTool.js"
import { EditTool } from "./tools/EditTool.js"
import { ReadTool } from "./tools/ReadTool.js"
import { WriteTool } from "./tools/WriteTool.js"
import { SearchTool } from "./tools/SearchTool.js"
import { DefaultTool } from "./tools/DefaultTool.js"

type Tool = Extract<ChatEntry, { kind: "tool" }>

export function ToolBlock({ tool }: { tool: Tool }) {
  switch (tool.name) {
    case "Bash":           return <BashTool tool={tool} />
    case "Edit":           return <EditTool tool={tool} />
    case "Write":          return <WriteTool tool={tool} />
    case "Read":           return <ReadTool tool={tool} />
    case "Glob":
    case "Grep":           return <SearchTool tool={tool} />
    default:               return <DefaultTool tool={tool} />
  }
}
