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
const reports: TrialReport[] = [];
const category = value("--category", "coding");
if (!["all", "coding", "context", "editing", "execution"].includes(category))
  throw new Error("Unknown eval category");
const trials = Number(value("--trials", "1"));
if (!Number.isInteger(trials) || trials < 1 || trials > 100)
  throw new Error("--trials must be 1–100");
if (args.includes("--live") && value("--model", "scripted") === "scripted")
  throw new Error("Live evaluation requires an exact --model ID");
for (const selected of category === "all"
  ? ["context", "editing", "execution", "coding"]
  : [category]) {
  const directory = join(import.meta.dir, "tasks", selected);

  for (const name of (await readdir(directory))
    .filter((file) => file.endsWith(".json"))
    .sort()) {
    const task = EvalTaskSchema.parse(
      JSON.parse(await readFile(join(directory, name), "utf8")),
    );
    if (args.includes("--live") && task.mockOnly) continue;
    for (let trial = 1; trial <= trials; trial++)
      reports.push(
        await runTrial(
          task,
          trial,
          args.includes("--live") ? "live" : "mock",
          value("--model", "scripted"),
          value("--provider", "anthropic"),
          value("--profile", "") || undefined,
        ),
      );
  }
}
const output = value("--output", "evals/results/latest.json");
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(reports, null, 2));
await writeFile(`${output.replace(/\.json$/, "")}.md`, markdown(reports));
console.log(markdown(reports));
if (args.includes("--baseline")) {
  const comparisons = compare(
    JSON.parse(await readFile(value("--baseline", ""), "utf8")),
    reports,
  );
  await writeFile(
    `${output.replace(/\.json$/, "")}.comparison.json`,
    JSON.stringify(comparisons, null, 2),
  );
  console.log(JSON.stringify(comparisons, null, 2));
}
process.exitCode = reports.some((report) => !report.task_success) ? 1 : 0;
