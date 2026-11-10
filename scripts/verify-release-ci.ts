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
  steps?: { name: string; status: string; conclusion: string | null }[];
};

export const requiredCIJobs = [
  "Full source (ubuntu-latest)",
  ...["macos-latest", "windows-latest"].map((os) => `LSP lifecycle (${os})`),
  ...["ubuntu-latest", "macos-latest", "windows-latest"].map(
    (os) => `Native smoke (${os})`,
  ),
];

export function requiredCISteps(job: string): readonly string[] {
  if (job.startsWith("Full source"))
    return [
      "Check documentation",
      "Run bun run typecheck",
      "All source tests once",
      "Verify complete source test report",
      "Run bun run lint",
      "Run bun run eval --category all",
      "Extension Settings and external SDK source UI",
    ];
  if (job.startsWith("LSP lifecycle"))
    return [
      "LSP configuration, cancellation, processes, tools and native menu",
      "Installed and compiled LSP menu smoke",
    ];
  if (job.startsWith("Native smoke"))
    return [
      "Build CLI and public SDK",
      "Installed package starts, executes tools, downloads and loads the SDK",
      "Compiled CLI, real LSP, helpers, worktrees and background processes",
      "Native OpenTUI library loads and renders",
      "Compiled live UI extension authoring and protected actions",
      "Compiled application startup and Settings",
      "Compiled extension controls and media",
      "Compiled worktree manager with real Git, approvals and isolated edits",
      "Compiled design, motion preferences, stable editor and menu search",
      ...(job.includes("ubuntu-latest")
        ? ["Linux packages and curl installation lifecycle"]
        : ["Platform paths, atomic storage, shell and process ownership"]),
      ...(job.includes("windows-latest")
        ? [
            "Windows updater, actual executable replacement and console restart",
            "Windows shortcuts and finish-page launcher",
          ]
        : []),
    ];
  return [];
}

/** The newest run for this source must pass; never fall back to an older green run. */
export function selectSourceCI(runs: CIRun[], source: string): CIRun {
  const run = runs
    .filter(
      (candidate) =>
        candidate.head_sha === source &&
        candidate.head_branch === "main" &&
        ["workflow_dispatch", "push"].includes(candidate.event) &&
        candidate.path === ".github/workflows/ci.yml",
    )
    .sort((a, b) => b.id - a.id)[0];
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
    for (const step of requiredCISteps(name)) {
      const matchingSteps =
        job.steps?.filter((item) => item.name === step) ?? [];
      if (
        matchingSteps.length !== 1 ||
        matchingSteps[0]?.status !== "completed" ||
        matchingSteps[0]?.conclusion !== "success"
      )
        throw new Error(
          `CI ${run.id}: обязательный step ${name} / ${step} не завершился успешно.`,
        );
    }
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
