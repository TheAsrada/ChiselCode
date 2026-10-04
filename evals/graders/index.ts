import { readFile } from "node:fs/promises";
import { execa } from "execa";
import type { RuntimeEvent } from "../../src/runtime/events.js";
import { resolveProjectPath } from "../../src/utils/paths.js";
import type { EvalTask } from "../task-schema.js";

export async function grade(
  task: EvalTask,
  root: string,
  signal: AbortSignal,
  trace: unknown[] = [],
) {
  return Promise.all(
    task.graders.map(async (grader) => {
      if (grader.type === "command") {
        const result = await execa(grader.command, {
          cwd: root,
          shell: true,
          reject: false,
          cancelSignal: signal,
          all: true,
        });
        return {
          grader,
          pass: result.exitCode === 0,
          output: result.all?.slice(-12000),
        };
      }
      if (grader.type === "trajectory") {
        const count = trace.filter(
          (event) => (event as { type?: string }).type === grader.event,
        ).length;
        return {
          grader,
          pass:
            count >= grader.minimum &&
            (grader.maximum === undefined || count <= grader.maximum),
          count,
        };
      }
      if (grader.type === "tool_result") {
        const matches = (trace as RuntimeEvent[]).filter(
          (event) =>
            (event.type === "tool_completed" || event.type === "tool_failed") &&
            event.name === grader.tool,
        );
        return {
          grader,
          safety: grader.safety,
          pass:
            matches.length >= grader.minimum &&
            (grader.maximum === undefined ||
              matches.length <= grader.maximum) &&
            matches.every(
              ({ result }) =>
                result &&
                (grader.errorCode === undefined
                  ? !result.isError
                  : result.errorCode === grader.errorCode) &&
                (grader.artifact === undefined ||
                  Boolean(result.artifact) === grader.artifact) &&
                (grader.untrusted === undefined ||
                  (result.contentTrust === "untrusted_external") ===
                    grader.untrusted) &&
                (grader.maxOutputChars === undefined ||
                  result.output.length <= grader.maxOutputChars),
            ),
          count: matches.length,
        };
      }
      const path = await resolveProjectPath(root, grader.path);
      try {
        const content = await readFile(path, "utf8");
        return {
          grader,
          pass:
            !grader.absent &&
            (grader.contains === undefined ||
              content.includes(grader.contains)),
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return { grader, pass: grader.absent === true };
      }
    }),
  );
}
