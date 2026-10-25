import { createHash } from "node:crypto";
import { z } from "zod";
import { cancelled } from "../runtime/errors.js";
import type { SafeWebHttpClient, WebHttpOptions } from "../web/http-client.js";
import { githubSkillJson } from "./github.js";
import {
  SKILL_PACKAGE_LIMITS,
  type SkillPackage,
  validateSkillPackage,
} from "./package.js";
import { selectSkillPath } from "./selection.js";
import {
  parseSkillSource,
  type SkillSource,
  SkillSourceInput,
  skillSourceUrl,
} from "./source.js";

const Commit = z
  .array(z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }))
  .min(1);
const Tree = z.object({
  truncated: z.boolean().optional(),
  tree: z
    .array(
      z.object({
        path: z.string(),
        sha: z.string().regex(/^[a-f0-9]{40}$/),
        type: z.string(),
        mode: z.string(),
        size: z.number().int().nonnegative().optional(),
      }),
    )
    .max(50000),
});
type TreeEntry = z.infer<typeof Tree>["tree"][number];
export interface SkillInspection {
  source: SkillSource;
  revision?: string;
  candidates: string[];
  selected?: SkillPackage;
  selectionReason?: "choose_skill" | "ambiguous_name";
  selection?: {
    reason: "canonical_directory";
    path: string;
    alternatives: string[];
    alternativeCount: number;
  };
}

/** Uses only the executor-issued network capability and the normal pinned HTTP client. */
export class RemoteSkills {
  constructor(readonly http: SafeWebHttpClient) {}
  async inspect(
    rawInput: SkillSourceInput,
    options: WebHttpOptions,
    download = false,
  ): Promise<SkillInspection> {
    const input = SkillSourceInput.parse(rawInput);
    const source = parseSkillSource(input);
    if (source.kind === "markdown") {
      const response = await this.http.get(source.url, options);
      const fallback =
        source.skill ??
        new URL(source.url).pathname.split("/").at(-2) ??
        "imported-skill";
      const selected = validateSkillPackage(
        new Map([["SKILL.md", response.bytes]]),
        fallback,
        { url: response.finalUrl },
      );
      if (source.skill && source.skill !== selected.metadata.name)
        throw new Error(
          `Имя в SKILL.md — ${selected.metadata.name}, запрошено ${source.skill}.`,
        );
      return { source, candidates: ["SKILL.md"], selected };
    }
    const base = `https://api.github.com/repos/${source.repository}`;
    const requestedRevision = input.revision?.toLowerCase();
    const revision =
      requestedRevision ??
      Commit.parse(
        await githubSkillJson(
          this.http,
          skillSourceUrl(source),
          options,
          "commit",
        ),
      )[0]?.sha;
    if (!revision) throw new Error("GitHub не вернул коммит источника.");
    // Resolve a requested folder using shallow trees, then request only that
    // subtree. This also works for large plugin monorepositories.
    let treeSha = revision;
    for (const part of source.path.split("/").filter(Boolean)) {
      const tree = await this.tree(
        `${base}/git/trees/${treeSha}`,
        options,
        treeSha === revision ? requestedRevision : undefined,
      );
      const folder = tree.find(
        (entry) =>
          entry.path === part &&
          entry.type === "tree" &&
          entry.mode === "040000",
      );
      if (!folder) throw new Error(`Папка навыка не найдена: ${source.path}`);
      treeSha = folder.sha;
    }
    const tree = await this.tree(
      `${base}/git/trees/${treeSha}?recursive=1`,
      options,
      treeSha === revision ? requestedRevision : undefined,
    );
    const candidates = tree
      .filter(
        (entry) =>
          entry.type === "blob" &&
          (entry.path === "SKILL.md" || entry.path.endsWith("/SKILL.md")),
      )
      .map((entry) => entry.path)
      .sort();
    const selection = selectSkillPath(candidates, source);
    const fullPath = (path: string) =>
      source.path ? `${source.path}/${path}` : path;
    if (!selection.path) {
      if (source.skill && !selection.matches.length)
        throw new Error(
          `Навык ${source.skill} не найден. Проверьте имя или вызовите inspect_skills без skill. Доступные пути: ${candidates.slice(0, 100).map(fullPath).join(", ") || "нет SKILL.md"}.`,
        );
      return {
        source,
        revision,
        candidates: selection.matches.map(fullPath),
        selectionReason: source.skill ? "ambiguous_name" : "choose_skill",
      };
    }
    const selectedPath = selection.path;
    const resolution = selection.reason
      ? {
          selection: {
            reason: selection.reason,
            path: fullPath(selectedPath),
            alternatives: selection.matches
              .filter((path) => path !== selectedPath)
              .map(fullPath)
              .slice(0, 20),
            alternativeCount: selection.matches.length - 1,
          },
        }
      : {};
    const prefix = selectedPath.slice(0, -8);
    const entries = tree.filter(
      (entry) => entry.type !== "tree" && entry.path.startsWith(prefix),
    );
    if (
      entries.length > SKILL_PACKAGE_LIMITS.files ||
      entries.some(
        (entry) =>
          entry.type !== "blob" ||
          !["100644", "100755"].includes(entry.mode) ||
          entry.size === undefined ||
          entry.size > SKILL_PACKAGE_LIMITS.fileBytes,
      ) ||
      entries.reduce((total, entry) => total + (entry.size ?? 0), 0) >
        SKILL_PACKAGE_LIMITS.bytes
    )
      throw new Error(
        "Пакет содержит ссылки, неподдерживаемые файлы или превышает пределы размера.",
      );
    const instructionEntry = entries.find(
      (entry) => entry.path === selectedPath,
    );
    if (!instructionEntry) throw new Error("SKILL.md отсутствует в snapshot.");
    if ((instructionEntry.size ?? 0) > SKILL_PACKAGE_LIMITS.instructionsBytes)
      throw new Error("SKILL.md превышает 64 KiB.");
    const instructions = await this.blob(base, instructionEntry, options);
    const files = new Map<string, Uint8Array>([["SKILL.md", instructions]]);
    const fallback =
      selectedPath.split("/").at(-2) ??
      source.path.split("/").at(-1) ??
      source.repository.split("/").at(-1) ??
      "imported-skill";
    const origin = {
      url: `https://github.com/${source.repository}`,
      revision,
      path: `${source.path ? `${source.path}/` : ""}${selectedPath}`,
    };
    const metadataOnly = validateSkillPackage(
      files,
      fallback || "imported-skill",
      origin,
    );
    if (
      selection.needsMetadataMatch &&
      metadataOnly.metadata.name !== source.skill
    )
      throw new Error(
        `Навык ${source.skill} не найден. Имя в SKILL.md: ${metadataOnly.metadata.name}.`,
      );
    if (!download)
      return {
        source,
        revision,
        candidates: candidates.map(fullPath),
        selected: metadataOnly,
        ...resolution,
      };
    const controller = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    const remaining = entries.filter((entry) => entry !== instructionEntry);
    let next = 0;
    let downloadFailure: unknown;
    try {
      const settled = await Promise.allSettled(
        Array.from({ length: Math.min(4, remaining.length) }, async () => {
          while (next < remaining.length) {
            cancelled(signal);
            const entry = remaining[next++];
            if (!entry) break;
            files.set(
              entry.path.slice(prefix.length),
              await this.blob(base, entry, { ...options, signal }),
            );
          }
        }).map((job) =>
          job.catch((error) => {
            if (!controller.signal.aborted) {
              downloadFailure = error;
              controller.abort(error);
            }
            throw error;
          }),
        ),
      );
      const failed = settled.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw downloadFailure ?? failed.reason;
    } finally {
      controller.abort();
    }
    return {
      source,
      revision,
      candidates: candidates.map(fullPath),
      ...resolution,
      selected: validateSkillPackage(files, metadataOnly.metadata.name, origin),
    };
  }
  private async tree(
    url: string,
    options: WebHttpOptions,
    revision?: string,
  ): Promise<TreeEntry[]> {
    const tree = Tree.parse(
      await githubSkillJson(this.http, url, options, "tree", revision),
    );
    if (tree.truncated)
      throw new Error(
        "GitHub обрезал список файлов. Передайте ссылку на папку навыка.",
      );
    return tree.tree;
  }
  private async blob(
    base: string,
    entry: TreeEntry,
    options: WebHttpOptions,
  ): Promise<Uint8Array> {
    const data = z
      .object({
        encoding: z.literal("base64"),
        content: z.string(),
        size: z.number().int().nonnegative(),
      })
      .parse(
        await githubSkillJson(
          this.http,
          `${base}/git/blobs/${entry.sha}`,
          options,
          "blob",
        ),
      );
    const bytes = Buffer.from(data.content.replace(/\s/g, ""), "base64");
    const sha = createHash("sha1")
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest("hex");
    if (
      bytes.length !== entry.size ||
      bytes.length !== data.size ||
      sha !== entry.sha
    )
      throw new Error(
        `GitHub blob не совпадает с закреплённым snapshot: ${entry.path}`,
      );
    return bytes;
  }
}
