/** @jsxImportSource @opentui/react */
import { useKeyboard } from "@opentui/react";
import { useEffect, useState } from "react";
import type { Skill } from "../skills/skills.js";
import { terminalSafeText } from "./opentui-transcript.js";

export interface OpenTuiSkillsActions {
  load(): Skill[];
  activeNames(): string[];
  toggle(name: string): void;
}

export function OpenTuiSkills({
  actions,
  width,
  height,
  onClose,
}: {
  actions: OpenTuiSkillsActions;
  width: number;
  height: number;
  onClose: () => void;
}) {
  const [skills, setSkills] = useState<Skill[]>(() => actions.load());
  const [active, setActive] = useState(() => actions.activeNames());
  const [selected, setSelected] = useState(0);
  const [detail, setDetail] = useState(false);
  useEffect(() => {
    setSkills(actions.load());
    setActive(actions.activeNames());
  }, [actions]);
  const current = skills[selected];
  useKeyboard((key) => {
    const name = key.name.toLowerCase();
    if (name === "escape") {
      if (detail) setDetail(false);
      else onClose();
    } else if (detail) {
      if (name === "return" && current) {
        actions.toggle(current.name);
        setActive(actions.activeNames());
      }
    } else if (name === "up") setSelected((index) => Math.max(0, index - 1));
    else if (name === "down")
      setSelected((index) => Math.min(skills.length - 1, index + 1));
    else if (name === "return" && current) setDetail(true);
  });
  const listHeight = Math.max(1, height - 4);
  const start = Math.max(
    0,
    Math.min(selected - Math.floor(listHeight / 2), skills.length - listHeight),
  );
  const detailText = current
    ? terminalSafeText(current.instructions, 6_000)
    : "";
  return (
    <box
      width={width}
      height={height}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
      backgroundColor="#111827"
    >
      <text fg="#78c8d4">
        ◈ Скиллы {detail && current ? `· /${current.name}` : ""}
      </text>
      {detail && current ? (
        <>
          <text fg="#aebbc9">{terminalSafeText(current.description, 180)}</text>
          <text fg={active.includes(current.name) ? "#88c89b" : "#8390a0"}>
            {active.includes(current.name)
              ? "● задействован"
              : "○ не задействован"}
          </text>
          <scrollbox height={Math.max(1, height - 5)} viewportCulling>
            <text selectable fg="#d6dce5">
              {detailText}
            </text>
          </scrollbox>
          <text fg="#8390a0">Enter включить/отключить · Esc к списку</text>
        </>
      ) : (
        <>
          <text fg="#8390a0">
            Enter открыть · активные инструкции идут в каждый запрос
          </text>
          <box height={listHeight} flexDirection="column">
            {skills.length === 0 && <text fg="#8390a0">Скиллов нет</text>}
            {skills.slice(start, start + listHeight).map((skill) => (
              <text
                key={skill.name}
                fg={current?.name === skill.name ? "#78c8d4" : "#aebbc9"}
              >
                {current?.name === skill.name ? "❯ " : "  "}
                {skill.userInvocable === false ? skill.name : `/${skill.name}`}{" "}
                ·{" "}
                {terminalSafeText(
                  skill.description,
                  Math.max(12, width - 23),
                ).replace(/\s+/g, " ")}
                {active.includes(skill.name) ? " ●" : ""}
              </text>
            ))}
          </box>
          <text fg="#8390a0">↑/↓ выбрать · Enter открыть · Esc закрыть</text>
        </>
      )}
    </box>
  );
}
