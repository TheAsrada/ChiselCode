import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { runTrial } from "./harness.js";
import { compare, markdown } from "./reporters/index.js";
import { EvalTaskSchema } from "./task-schema.js";
import type { TrialReport } from "./trial.js";

const args = process.argv.slice(2);
const value = (name: string, fallback: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
};
const directory = join(import.meta.dir, "tasks", value("--category", "coding"));
const reports: TrialReport[] = [];
for (const name of (await readdir(directory))
  .filter((file) => file.endsWith(".json"))
  .sort()) {
  const task = EvalTaskSchema.parse(
    JSON.parse(await readFile(join(directory, name), "utf8")),
  );
  for (let trial = 1; trial <= Number(value("--trials", "1")); trial++)
    reports.push(
      await runTrial(
        task,
        trial,
        args.includes("--live") ? "live" : "mock",
        value("--model", "scripted"),
        value("--provider", "anthropic"),
      ),
    );
}
const output = value("--output", "evals/results/latest.json");
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(reports, null, 2));
await writeFile(`${output.replace(/\.json$/, "")}.md`, markdown(reports));
console.log(markdown(reports));
if (args.includes("--baseline"))
  console.log(
    JSON.stringify(
      compare(
        JSON.parse(await readFile(value("--baseline", ""), "utf8")),
        reports,
      ),
      null,
      2,
    ),
  );
process.exitCode = reports.some((report) => !report.task_success) ? 1 : 0;
