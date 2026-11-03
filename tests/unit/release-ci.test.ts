import { expect, test } from "bun:test";
import {
  assertVerifiedSourceCI,
  requiredCIJobs,
  requiredCISteps,
  selectSourceCI,
} from "../../scripts/verify-release-ci.js";

const source = "a".repeat(40);
const run = {
  id: 123,
  head_sha: source,
  head_branch: "main",
  event: "workflow_dispatch",
  path: ".github/workflows/ci.yml",
  status: "completed",
  conclusion: "success",
  html_url: "https://github.com/example/project/actions/runs/123",
};
const jobs = () =>
  requiredCIJobs.map((name) => ({
    name,
    head_sha: source,
    status: "completed",
    conclusion: "success",
    steps: requiredCISteps(name).map((name) => ({
      name,
      status: "completed",
      conclusion: "success",
    })),
  }));

test("release accepts exact source with all native checks, including retained jobs after a partial rerun", () => {
  expect(() => assertVerifiedSourceCI(source, run, jobs())).not.toThrow();
  const retained = jobs().map((job, i) => ({
    ...job,
    run_attempt: i === 0 ? 2 : 1,
  }));
  expect(() =>
    assertVerifiedSourceCI(
      source,
      { ...run, event: "workflow_dispatch" },
      retained,
    ),
  ).not.toThrow();
});

test("release accepts automatic main CI and refuses another source, PRs, non-main runs and another workflow", () => {
  expect(() =>
    assertVerifiedSourceCI(source, { ...run, event: "push" }, jobs()),
  ).not.toThrow();
  for (const patch of [
    { head_sha: "b".repeat(40) },
    { event: "pull_request" },
    { head_branch: "other" },
    { path: ".github/workflows/other.yml" },
  ])
    expect(() =>
      assertVerifiedSourceCI(source, { ...run, ...patch }, jobs()),
    ).toThrow();
});

test("release cannot use an older green run while the newest source run is pending or failed", () => {
  for (const patch of [
    { status: "in_progress", conclusion: null },
    { status: "completed", conclusion: "failure" },
  ]) {
    const latest = { ...run, id: 124, ...patch };
    const selected = selectSourceCI([run, latest], source);
    expect(selected.id).toBe(124);
    expect(() => assertVerifiedSourceCI(source, selected, jobs())).toThrow();
  }
});

test("green job names cannot hide skipped or missing required checks", () => {
  for (const name of requiredCIJobs) {
    for (const step of requiredCISteps(name)) {
      for (const conclusion of ["skipped", "failure", "cancelled", null]) {
        const changed = jobs().map((job) =>
          job.name === name
            ? {
                ...job,
                steps: job.steps.map((item) =>
                  item.name === step ? { ...item, conclusion } : item,
                ),
              }
            : job,
        );
        expect(() => assertVerifiedSourceCI(source, run, changed)).toThrow(
          step,
        );
      }
    }
  }
  expect(() =>
    assertVerifiedSourceCI(
      source,
      run,
      jobs().map((job) => ({ ...job, steps: undefined })),
    ),
  ).toThrow();
});

test("CI workflow actually runs the complete test command and platform clipboard case", async () => {
  const ci = Bun.YAML.parse(
    await Bun.file(".github/workflows/ci.yml").text(),
  ) as {
    on: { push: { branches: string[] } };
    jobs: Record<string, { steps: { name?: string; run?: string }[] }>;
  };
  expect(ci.on.push.branches).toContain("main");
  const sourceSteps = ci.jobs.source?.steps ?? [];
  const full = sourceSteps.find(
    (step) => step.name === "All source tests once",
  );
  expect(full?.run).toContain("bun test --reporter=junit");
  expect(full?.run).not.toContain("test:fast");
  expect(full?.run).not.toContain("test:full");
  const actualNames = sourceSteps.map((step) => step.name ?? `Run ${step.run}`);
  for (const step of requiredCISteps("Full source (ubuntu-latest)"))
    expect(actualNames).toContain(step);
  expect(
    actualNames.indexOf("Verify complete source test report"),
  ).toBeGreaterThan(actualNames.indexOf("All source tests once"));
  const platform = ci.jobs.native?.steps.find(
    (step) =>
      step.name ===
      "Platform paths, atomic storage, shell and process ownership",
  );
  expect(platform?.run).toContain("tests/integration/host-clipboard.test.tsx");
  for (const [jobName, key] of [
    ["LSP lifecycle (windows-latest)", "lsp"],
    ["Native smoke (windows-latest)", "native"],
  ]) {
    const names =
      ci.jobs[key ?? ""]?.steps.map((step) => step.name ?? `Run ${step.run}`) ??
      [];
    for (const step of requiredCISteps(jobName ?? ""))
      expect(names).toContain(step);
  }
});

test("release builders pin the verified source and recheck CI and tag before publication", async () => {
  const workflow = Bun.YAML.parse(
    await Bun.file(".github/workflows/release.yml").text(),
  ) as {
    jobs: Record<
      string,
      {
        needs?: string | string[];
        outputs?: Record<string, string>;
        steps: {
          name?: string;
          uses?: string;
          run?: string;
          with?: Record<string, string>;
        }[];
      }
    >;
  };
  expect(workflow.jobs.verify?.outputs?.source).toBe(
    `\${{ steps.source.outputs.sha }}`,
  );
  for (const [key, job] of Object.entries(workflow.jobs)) {
    if (key === "verify") continue;
    const checkout = job.steps.find(
      (step) => step.uses === "actions/checkout@v4",
    );
    expect(checkout?.with?.ref).toBe(`\${{ needs.verify.outputs.source }}`);
    expect([job.needs].flat()).toContain("verify");
  }
  const publication =
    workflow.jobs.publish?.steps.find(
      (step) => step.name === "Create draft, upload assets, then publish",
    )?.run ?? "";
  const check = publication.lastIndexOf("bun scripts/verify-release-ci.ts");
  expect(check).toBeGreaterThan(-1);
  expect(check).toBeLessThan(
    publication.indexOf('gh release edit "$RELEASE_TAG" --draft=false'),
  );
  expect(publication).toContain('"$VERIFIED_SOURCE"');
  expect(publication).toContain("/commits/$RELEASE_TAG");
});

test("quick CI without native checks, skipped checks, duplicate jobs and mismatched job source block release", () => {
  expect(() =>
    assertVerifiedSourceCI(
      source,
      run,
      jobs().filter((job) => !job.name.startsWith("LSP lifecycle")),
    ),
  ).toThrow("LSP lifecycle");
  const oldMatrix = jobs().filter(
    (job) => !job.name.startsWith("Native smoke"),
  );
  expect(() => assertVerifiedSourceCI(source, run, oldMatrix)).toThrow();
  for (const patch of [
    { conclusion: "skipped" },
    { conclusion: "cancelled" },
    { status: "in_progress" },
    { head_sha: "b".repeat(40) },
  ]) {
    const changed = jobs().map((job, i) =>
      i === 0 ? { ...job, ...patch } : job,
    );
    expect(() => assertVerifiedSourceCI(source, run, changed)).toThrow();
  }
  const duplicate = jobs();
  expect(() =>
    assertVerifiedSourceCI(source, run, [...duplicate, ...duplicate]),
  ).toThrow();
  expect(() =>
    assertVerifiedSourceCI(source, run, [
      ...jobs(),
      { name: "extra", status: "completed", conclusion: "failure" },
    ]),
  ).toThrow();
});
