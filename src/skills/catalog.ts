import { utf8Prefix } from "../utils/text.js";
import { modelInvocableSkills, type Skill } from "./skills.js";

const PROMPT_BYTES = 8 * 1024;
const DESCRIPTION_BYTES = 240;
const PAGE_SIZE = 12;

function summary(skill: Skill) {
  const description = skill.description.replace(/\s+/gu, " ").trim();
  const prefix = utf8Prefix(description, DESCRIPTION_BYTES - 3);
  return {
    name: skill.name,
    description: prefix === description ? description : `${prefix}…`,
  };
}

function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function skillsCatalogPrompt(skills: readonly Skill[]): string {
  const available = modelInvocableSkills(skills);
  if (!available.length) return "";
  // Keep bundled workflows discoverable in the initial prompt in a large library.
  available.sort(
    (a, b) => Number(b.source === "bundled") - Number(a.source === "bundled"),
  );
  const open = "<available_skills>";
  const close = "</available_skills>";
  const more =
    "  More skills are available. Use search_skills to find relevant workflows.";
  let remaining =
    PROMPT_BYTES - Buffer.byteLength([open, more, close, ""].join("\n"));
  const entries: string[] = [];
  for (const skill of available) {
    const { name, description } = summary(skill);
    const line = `  <skill><name>${escapeXml(name)}</name><description>${escapeXml(description)}</description></skill>`;
    remaining -= Buffer.byteLength(line) + 1;
    if (remaining < 0) break;
    entries.push(line);
  }
  return [
    open,
    ...entries,
    ...(entries.length < available.length ? [more] : []),
    close,
  ].join("\n");
}

function normalize(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

export function searchSkills(
  skills: readonly Skill[],
  query: string,
  offset: number,
) {
  const normalized = normalize(query).trim();
  const words = normalized.split(/\s+/u).filter(Boolean);
  const matches = modelInvocableSkills(skills)
    .flatMap((skill) => {
      const name = normalize(skill.name);
      const haystack = `${name} ${normalize(skill.description)}`;
      if (!words.every((word) => haystack.includes(word))) return [];
      const rank =
        name === normalized
          ? 2
          : words.every((word) => name.includes(word))
            ? 1
            : 0;
      return [{ skill, rank }];
    })
    .sort(
      (a, b) =>
        b.rank - a.rank || a.skill.name.localeCompare(b.skill.name, "en"),
    );
  const page = matches.slice(offset, offset + PAGE_SIZE);
  return {
    total: matches.length,
    skills: page.map(({ skill }) => summary(skill)),
    ...(offset + page.length < matches.length
      ? { nextOffset: offset + page.length }
      : {}),
  };
}
