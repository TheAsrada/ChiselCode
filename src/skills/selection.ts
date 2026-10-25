import type { SkillSource } from "./source.js";

export interface SkillSelection {
  matches: string[];
  path?: string;
  needsMetadataMatch?: boolean;
  reason?: "canonical_directory";
}

/** A requested path wins. Bare names prefer the standard skills/<name> layout
 * within the explicitly requested source folder; other collisions stay explicit. */
export function selectSkillPath(
  candidates: readonly string[],
  source: Extract<SkillSource, { kind: "github" }>,
): SkillSelection {
  const requested = source.skill;
  if (!requested)
    return candidates.length === 1
      ? { matches: [...candidates], path: candidates[0] }
      : { matches: [...candidates] };
  const absolute = (path: string) =>
    source.path ? `${source.path}/${path}` : path;
  const directory = (path: string) =>
    path === "SKILL.md" ? "" : path.slice(0, -9);
  const exact =
    requested.includes("/") || requested === "SKILL.md"
      ? candidates.filter((path) =>
          [
            path,
            absolute(path),
            directory(path),
            directory(absolute(path)),
          ].includes(requested),
        )
      : [];
  if (exact.length === 1) return { matches: exact, path: exact[0] };
  const matches = exact.length
    ? exact
    : candidates.filter(
        (path) =>
          (directory(absolute(path)).split("/").at(-1) ||
            source.repository.split("/").at(-1)) === requested,
      );
  if (matches.length === 1) return { matches, path: matches[0] };
  if (!requested.includes("/") && matches.length > 1) {
    const canonical =
      matches.find((path) => path === `skills/${requested}/SKILL.md`) ??
      matches.find((path) => path === "SKILL.md");
    if (canonical)
      return { matches, path: canonical, reason: "canonical_directory" };
  }
  if (!matches.length && candidates.length === 1 && !requested.includes("/"))
    return {
      matches: [...candidates],
      path: candidates[0],
      needsMetadataMatch: true,
    };
  return { matches };
}
