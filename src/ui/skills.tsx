import { Box, Text, useInput } from "ink";
import type React from "react";
import { useState } from "react";
import type { Skill, SkillSource } from "../skills/skills.js";

export interface SkillsPanelProps {
  skills: Skill[];
  /** Имена задействованных скиллов (их инструкции идут в каждый запрос). */
  activeNames: string[];
  /** Задействовать/отключить скилл для текущей сессии. */
  onToggle(skill: Skill): void;
  onClose(): void;
}

/**
 * Браузер скиллов (`/skills`): мини-меню доступных скиллов.
 * Enter на списке — детали, Enter в деталях — задействовать скилл
 * (его инструкции приложатся к следующим запросам) или отключить.
 * Агент и сам подхватывает скиллы по описанию; вручную скилл также
 * вызывается как /имя (кроме скрытых из команд).
 */
export function SkillsPanel({
  skills,
  activeNames,
  onToggle,
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
    if (detail) {
      if (key.return) onToggle(detail);
      return;
    }
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
        {detail ? <Text dimColor> · {detail.name}</Text> : null}
      </Box>
      {detail ? (
        <SkillDetail
          skill={detail}
          active={activeNames.includes(detail.name)}
        />
      ) : skills.length === 0 ? (
        <Box flexDirection="column">
          <Text>Скиллов пока нет.</Text>
          <Text dimColor>
            Новые скиллы сохраняются только в личную папку (см. скилл
            skill-creator) — агент подхватит их сам по описанию, а вызвать можно
            будет командой /имя.
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          <Text dimColor>
            Агент читает нужный скилл сам, когда задача совпадает с описанием. ●
            — задействован для всех запросов.
          </Text>
          {skills.map((skill, index) => {
            const label =
              skill.userInvocable === false ? skill.name : `/${skill.name}`;
            const manual = skill.userInvocable !== false;
            const automatic = skill.disableModelInvocation !== true;
            const modes =
              manual && automatic
                ? "вручную и автоматически"
                : manual
                  ? "только вручную"
                  : automatic
                    ? "только агент"
                    : "вызов отключён";
            const row = `${label} — ${skill.description} [${modes}]${activeNames.includes(skill.name) ? " ●" : ""}`;
            return index === safeSelected ? (
              <Text key={skill.name} bold inverse color="green">
                ❯ {row}
              </Text>
            ) : (
              <Text key={skill.name} dimColor wrap="truncate-end">
                {"  "}
                {row}
              </Text>
            );
          })}
        </Box>
      )}
      <Text dimColor>
        {detail
          ? "Enter — задействовать/отключить · Esc — назад к списку"
          : "↑/↓ — выбор · Enter — открыть · Esc — закрыть"}
      </Text>
    </Box>
  );
}

function SkillDetail({
  skill,
  active,
}: {
  skill: Skill;
  active: boolean;
}): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Text bold>
        {skill.userInvocable === false ? skill.name : `/${skill.name}`}{" "}
        <Text dimColor>· {sourceLabel(skill.source)}</Text>
      </Text>
      <Text dimColor>{skill.dir}</Text>
      <Text>{skill.description}</Text>
      {active ? (
        <Text color="green">
          ● задействован — инструкции идут в каждый запрос
        </Text>
      ) : (
        <Text dimColor>○ не задействован</Text>
      )}
      <Box marginTop={1} flexDirection="column">
        <Text wrap="wrap">{skill.instructions}</Text>
      </Box>
      <Text dimColor>
        {skill.userInvocable === false
          ? "Ручной вызов отключён."
          : `Вызов вручную: /${skill.name} — инструкции применятся разово.`}
        {skill.disableModelInvocation === true
          ? " Автоматическая загрузка отключена."
          : " Агент может загрузить навык по задаче."}
      </Text>
    </Box>
  );
}

function sourceLabel(source: SkillSource): string {
  if (source === "user") return "личные";
  return "из коробки";
}
