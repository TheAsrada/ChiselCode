import { expect, test } from "bun:test";
import {
  assertVerifiedSourceCI,
  requiredCIJobs,
  selectSourceCI,
} from "../../scripts/verify-release-ci.js";

const source = "a".repeat(40);
const run = {
  id: 123,
  head_sha: source,
  head_branch: "main",
  event: "push",
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

test("release refuses another source, PRs, non-main runs and another workflow", () => {
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
    const selected = selectSourceCI([latest, run], source);
    expect(selected.id).toBe(124);
    expect(() => assertVerifiedSourceCI(source, selected, jobs())).toThrow();
  }
});

test("old CI without packaging, skipped checks, duplicate jobs and mismatched job source block release", () => {
  const oldMatrix = jobs().filter((job) => !job.name.startsWith("Packaging"));
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
