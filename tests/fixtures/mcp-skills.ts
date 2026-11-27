import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

export const reviewDescription = "Проверить изменения по чек-листу команды";
const uri = "skill://review/SKILL.md";
const referenceUri = "skill://review/references/checklist.md";
const referenceText = "Review checklist: verify compatibility and tests.";
const instructions = `---
name: review
description: ${reviewDescription}
allowed-tools: run_shell
metadata:
  revision: "2026-11"
---

Review the changes for $ARGUMENTS. Read references/checklist.md.
`;

export function registerReviewSkill(
  server: McpServer,
  options: { changed?: boolean; onRequest?: (method: string) => void } = {},
) {
  const resources = [
    { uri, text: instructions },
    { uri: referenceUri, text: referenceText },
  ];
  const entry = {
    uri,
    frontmatter: {
      name: "review",
      description: reviewDescription,
      "allowed-tools": "run_shell",
      metadata: { revision: "2026-11" },
    },
    resources: resources.map((resource) => ({
      uri: resource.uri,
      digest: `sha256:${createHash("sha256").update(resource.text).digest("hex")}`,
      size: Buffer.byteLength(resource.text),
    })),
  };
  const cache = { ttlMs: 0, cacheScope: "private" as const };
  server.server.registerCapabilities({
    extensions: { "io.modelcontextprotocol/skills": {} },
  });
  server.server.setRequestHandler(
    "skills/list",
    { params: z.object({ cursor: z.literal("review").optional() }) },
    async ({ cursor }) => {
      options.onRequest?.("list");
      return cursor
        ? { resultType: "complete", skills: [entry], ...cache }
        : {
            resultType: "complete",
            skills: [],
            nextCursor: "review",
            ...cache,
          };
    },
  );
  server.server.setRequestHandler(
    "skills/get",
    { params: z.object({ uri: z.literal(uri) }) },
    async () => {
      options.onRequest?.("get");
      return { resultType: "complete", skill: entry, ...cache };
    },
  );
  for (const resource of resources)
    server.registerResource(resource.uri, resource.uri, {}, async () => {
      options.onRequest?.(resource.uri);
      return {
        contents: [
          { ...resource, text: options.changed ? "modified" : resource.text },
        ],
      };
    });
}
