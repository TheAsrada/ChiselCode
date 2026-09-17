import { Box, Text, useInput } from "ink";
import type React from "react";
import { useState } from "react";
import type { Skill, SkillSource } from "../skills/skills.js";

export interface SkillsPanelProps {
  skills: Skill[];
  onClose(): void;
}

/**
 * Браузер скиллов (`/skills`): список доступных скиллов с описаниями,
 * Enter — посмотреть инструкции, Esc — назад/закрыть.
 * Агент подхватывает скиллы сам по описанию (каталог в системном промпте),
 * вручную скилл вызывается как /имя — панель нужна для обзора.
 */
export function SkillsPanel({
  skills,
  onClose,
}: SkillsPanelProps): React.JSX.Element {
  const [selected, setSelected] = useState(0);
  const [detail, setDetail] = useState<Skill | undefined>(undefined);
  const safeSelected =
    skills.length > 0 ? Math.min(selected, skills.length - 1) : 0;

  useInput((_, key) => {
    if (key.escape) {
      if (detail) setDetail(undefined);
      else onClose();
      return;
    }
    if (detail) return;
    if (skills.length === 0) return;
    if (key.upArrow) {
      setSelected(() => (safeSelected - 1 + skills.length) % skills.length);
      return;
    }
    if (key.downArrow) {
      setSelected(() => (safeSelected + 1) % skills.length);
      return;
    }
    if (key.return) {
      const skill = skills[safeSelected];
      if (skill) setDetail(skill);
    }
  });

  return (
    <Box
      flexDirection="column"
      marginTop={1}
      alignItems="stretch"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
    >
      <Box>
        <Text bold color="cyan">
          ◈ Скиллы
        </Text>
        {detail ? <Text dimColor> · /{detail.name}</Text> : null}
      </Box>
      {detail ? (
        <SkillDetail skill={detail} />
      ) : skills.length === 0 ? (
        <Box flexDirection="column">
          <Text>Скиллов пока нет.</Text>
          <Text dimColor>
            Положите инструкции в `.chisel/skills/{"<имя>"}/SKILL.md` проекта
            (или общие в `.agents/skills/`) — агент подхватит их сам по
            описанию, а вызвать можно будет командой /имя.
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          <Text dimColor>
            Агент читает нужный скилл сам, когда задача совпадает с описанием.
          </Text>
          {skills.map((skill, index) =>
            index === safeSelected ? (
              <Text key={skill.name} bold inverse color="green">
                ❯ /{skill.name} — {skill.description}
              </Text>
            ) : (
              <Text key={skill.name} dimColor wrap="truncate-end">
                {"  "}/{skill.name} — {skill.description}
              </Text>
            ),
          )}
        </Box>
      )}
      <Text dimColor>
        {detail
          ? "Esc — назад к списку"
          : "↑/↓ — выбор · Enter — открыть · Esc — закрыть"}
      </Text>
    </Box>
  );
}

function SkillDetail({ skill }: { skill: Skill }): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Text bold>
        /{skill.name} <Text dimColor>· {sourceLabel(skill.source)}</Text>
      </Text>
      <Text dimColor>{skill.dir}</Text>
      <Text>{skill.description}</Text>
      <Box marginTop={1} flexDirection="column">
        <Text wrap="wrap">{skill.instructions}</Text>
      </Box>
      <Text dimColor>
        Вызов вручную: /{skill.name} — агент выполнит инструкции.
      </Text>
    </Box>
  );
}

function sourceLabel(source: SkillSource): string {
  if (source === "project") return "проект";
  if (source === "shared") return ".agents";
  if (source === "global") return "личные";
  return "из коробки";
}
