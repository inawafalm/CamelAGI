// Generic adapter: converts a ToolDef into Claude Agent SDK or OpenAI tool format

import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { ToolDef } from "../core/types.js";

/** OpenAI function-calling tool shape */
interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * Adapt an CamelAGI ToolDef to a Claude Agent SDK tool.
 * The schema's `.shape` is passed directly — Zod shapes are compatible
 * with the SDK's parameter definition format.
 */
export function adaptToolDef(def: ToolDef) {
  return tool(
    def.name,
    def.description,
    def.schema.shape,
    async (args) => {
      const result = await def.execute(args as Record<string, unknown>);
      return { content: [{ type: "text" as const, text: result }] };
    },
  );
}

/**
 * Adapt an CamelAGI ToolDef to OpenAI's function-calling format.
 * Uses Zod 4's native .toJSONSchema() for reliable conversion.
 */
export function adaptToolDefToOpenAI(def: ToolDef): OpenAITool {
  const jsonSchema = def.schema.toJSONSchema() as Record<string, unknown>;
  // Remove $schema key — OpenAI doesn't want it in parameters
  delete jsonSchema.$schema;

  return {
    type: "function",
    function: {
      name: def.name,
      description: def.description,
      parameters: jsonSchema,
    },
  };
}
