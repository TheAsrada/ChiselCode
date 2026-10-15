import { execFileSync } from "node:child_process";

type CIRun = {
  id: number;
  head_sha: string;
  head_branch: string | null;
  event: string;
  path: string;
  status: string;
  conclusion: string | null;
  html_url: string;
};

type CIJob = {
  name: string;
  status: string;
  conclusion: string | null;
  head_sha?: string;
};

export const requiredCIJobs = [
  "ubuntu-latest",
  "macos-latest",
  "windows-latest",
].flatMap((os) => [
  `Quality (${os})`,
  `Packaging (${os})`,
  `Real Auto LSP (${os})`,
]);

/** The newest run for this source must pass; never fall back to an older green run. */
export function selectSourceCI(runs: CIRun[], source: string): CIRun {
  const run = runs.find(
    (candidate) =>
      candidate.head_sha === source &&
      candidate.head_branch === "main" &&
      ["push", "workflow_dispatch"].includes(candidate.event) &&
      candidate.path === ".github/workflows/ci.yml",
  );
  if (!run)
    throw new Error(`Нет CI из main на точном release source ${source}.`);
  return run;
}

export function assertVerifiedSourceCI(
  source: string,
  run: CIRun,
  jobs: CIJob[],
): void {
  selectSourceCI([run], source);
  if (run.status !== "completed" || run.conclusion !== "success")
    throw new Error(
      `CI ${run.id} ещё не завершена успешно: ${run.status}/${run.conclusion}.`,
    );
  for (const name of requiredCIJobs) {
    const matching = jobs.filter((job) => job.name === name);
    const job = matching[0];
    if (
      matching.length !== 1 ||
      !job ||
      job.status !== "completed" ||
      job.conclusion !== "success" ||
      (job.head_sha !== undefined && job.head_sha !== source)
    )
      throw new Error(
        `CI ${run.id}: нет однозначной успешной проверки ${name} на ${source}.`,
      );
  }
  if (
    jobs.some(
      (job) => job.status !== "completed" || job.conclusion !== "success",
    )
  )
    throw new Error(`CI ${run.id} содержит незавершённые или неуспешные jobs.`);
}

if (import.meta.main) {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw new Error("Задайте GITHUB_REPOSITORY для проверки release source.");
  const source = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (!/^[a-f0-9]{40}$/.test(source))
    throw new Error("Не удалось определить release source.");
  const records = (endpoint: string, collection: "workflow_runs" | "jobs") => {
    const output = execFileSync(
      "gh",
      ["api", "--paginate", endpoint, "--jq", `.${collection}[] | @json`],
      {
        encoding: "utf8",
        timeout: 30000,
        maxBuffer: 4 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return output
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  };
  const runs: CIRun[] = records(
    `repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${source}&branch=main&per_page=100`,
    "workflow_runs",
  );
  const run = selectSourceCI(runs, source);
  if (!Number.isSafeInteger(run.id) || run.id <= 0)
    throw new Error("GitHub вернул некорректный CI run ID.");
  // filter=latest includes successful jobs retained by a partial rerun on the same source.
  const jobs: CIJob[] = records(
    `repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`,
    "jobs",
  );
  assertVerifiedSourceCI(source, run, jobs);
  console.log(
    `Release source ${source}: ${requiredCIJobs.length} обязательных jobs успешны. ${run.html_url}`,
  );
}
