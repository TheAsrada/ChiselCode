import type { Skill } from "../skills/skills.js";

/** Preparing a workflow keeps the task in the composer until the user sends it. */
export function skillCommandDraft(
  name: string,
  draft: string,
  skills: readonly Skill[],
): string {
  const command = draft.split(/\s/, 1)[0] ?? "";
  const previous = skills.some(
    (skill) => skill.userInvocable !== false && `/${skill.name}` === command,
  );
  const args = previous ? draft.slice(command.length).trimStart() : draft;
  return `/${name} ${args}`;
}

export function skillEditDraft(
  name: string,
  source: string,
  draft: string,
): string {
  return [
    `/skill-creator Помоги изменить пользовательский скилл ${name}.`,
    "Сохрани настройки вызова и вспомогательные файлы, если я не прошу их изменить. Текущий SKILL.md:",
    "<current_skill>",
    source,
    "</current_skill>",
    "Мои изменения:",
    draft,
  ].join("\n");
}
