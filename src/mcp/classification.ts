import type { Tool } from "@modelcontextprotocol/client";
import type { ToolEffect } from "../tools/effects.js";
import type { McpToolCategory } from "../tools/types.js";

export interface McpClassification {
  effect: ToolEffect;
  category: McpToolCategory;
  reason: string;
}
function dynamicArguments(schema: unknown, depth = 0): boolean {
  if (depth > 20) return true;
  if (!schema || typeof schema !== "object") return false;
  if (Array.isArray(schema))
    return schema.some((item) => dynamicArguments(item, depth + 1));
  const value = schema as Record<string, unknown>;
  if (
    value.properties &&
    typeof value.properties === "object" &&
    Object.keys(value.properties).some((key) =>
      /^(sql|command|script|code|method|mutation|operation|action)$/i.test(key),
    )
  )
    return true;
  return Object.values(value).some((item) => dynamicArguments(item, depth + 1));
}
/** Annotations are untrusted hints. Dangerous semantics take precedence. */
export function classifyMcpTool(
  tool: Pick<
    Tool,
    "name" | "title" | "description" | "annotations" | "inputSchema"
  >,
  options: { localProcess?: boolean } = {},
): McpClassification {
  const name = tool.name.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
  const description = (tool.description ?? "").toLowerCase();
  const words = `${name} ${(tool.title ?? "").toLowerCase()} ${description}`;
  if (
    /(?:^|[\s_.:/-])(delete|remove|drop|truncate|destroy|erase|purge|wipe|overwrite|merge|revoke|terminate|reset|refund|withdraw|cancel_subscription)(?:[\s_.:/-]|$)/.test(
      words,
    ) ||
    tool.annotations?.destructiveHint === true
  )
    return {
      effect: "external_destructive",
      category: "destructive",
      reason: "Potential deletion or irreversible external change.",
    };
  if (
    /(?:^|[\s_.:/-])(execute|exec|shell|bash|powershell|terminal|run_command|eval|script|spawn|install)(?:[\s_.:/-]|$)/.test(
      words,
    )
  )
    return {
      effect: options.localProcess === false ? "external_write" : "process",
      category: "unknown",
      reason: "Arbitrary code or process execution; blocked in Plan.",
    };
  if (
    /(?:^|[\s_.:/-])(create|add|update|edit|write|set|put|post|patch|send|publish|push|commit|comment|insert|upload|deploy|pay|purchase|transfer|modify|mutation|mutate|save|approve|reject|accept|assign|attach|detach|grant|enable|disable|archive|restore|close|resolve|subscribe|unsubscribe|move|rename|replace|append|register|unregister)(?:[\s_.:/-]|$)/.test(
      words,
    )
  )
    return {
      effect: "external_write",
      category: "write",
      reason: "Creates or changes external data.",
    };
  // A general query / browser / request tool may mutate through arguments even
  // when its server claims readOnlyHint. No model-controlled argument can lower it.
  if (
    /query|sql|graphql|request|navigate|browser|rpc/.test(name) ||
    dynamicArguments(tool.inputSchema)
  )
    return {
      effect: "external_write",
      category: "unknown",
      reason: "Arguments may contain executable queries or mutations.",
    };
  const readName =
    /(?:^|[_.:/-])(get|list|search|find|read|fetch|describe|inspect|show|lookup|count|status|health)(?:[_.:/-]|$)/.test(
      name,
    );
  if (readName && tool.annotations?.readOnlyHint !== false)
    return {
      effect: "external_read",
      category: "read",
      reason: "Conservative read operation; no mutation indicators.",
    };
  return {
    effect: "external_write",
    category: "unknown",
    reason: "Unknown effect: explicit approval required by default.",
  };
}
