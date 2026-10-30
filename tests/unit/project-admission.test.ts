import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globalConfigPath } from "../../src/paths/config.js";
import {
  admitWorkspace,
  revalidateWorkspace,
} from "../../src/projects/admission.js";
import { resolveLaunchWorkspace } from "../../src/projects/launch.js";
import { ProjectOpenService } from "../../src/projects/opening.js";
import {
  type ApplicationPaths,
  applicationPaths,
  canonicalApplicationPath,
  isPrivatePath,
  pathContains,
  pathIdentity,
  registerApplicationPrivatePath,
} from "../../src/projects/paths.js";
import { WorkspacePolicy } from "../../src/security/workspace-policy.js";

let directory: string, project: string, home: string, paths: ApplicationPaths;
beforeEach(async () => {
  directory = await realpath(
    await mkdtemp(join(tmpdir(), "chisel-admission-")),
  );
  project = join(directory, "Проект с пробелами");
  home = join(directory, "Home");
  await mkdir(project);
  await mkdir(home);
  paths = { home, privateRoots: [home] };
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

test("launch preserves explicit, terminal and launcher intent without defaulting service roots", async () => {
  const base = { invocationCwd: home, paths };
  expect(await resolveLaunchWorkspace(base)).toBeUndefined();
  expect(
    await resolveLaunchWorkspace({
      ...base,
      invocationCwd: project,
      launcher: true,
    }),
  ).toBeUndefined();
  const selected = await resolveLaunchWorkspace({
    ...base,
    launcher: true,
    explicitCwd: project,
  });
  expect(selected).toMatchObject({
    root: pathIdentity(project),
    source: "explicit",
    kind: "directory",
  });
  expect(
    (await resolveLaunchWorkspace({ ...base, invocationCwd: project }))?.source,
  ).toBe("terminal");
  for (const intent of [
    { prompt: true },
    { resume: "saved" },
    { explicitCwd: home },
    { prompt: true, launcher: true },
  ])
    await expect(
      resolveLaunchWorkspace({ ...base, ...intent }),
    ).rejects.toThrow("--cwd");
});

test("non-Git folder, relative path, file-parent and lookalike prefixes remain valid", async () => {
  const file = join(project, "файл.txt");
  await writeFile(file, "content");
  expect((await admitWorkspace(file, { allowFile: true, paths })).root).toBe(
    pathIdentity(project),
  );
  await expect(admitWorkspace(file, { paths })).rejects.toThrow("недоступна");
  expect(
    (await admitWorkspace("Проект с пробелами", { base: directory, paths }))
      .root,
  ).toBe(pathIdentity(project));
  const lookalike = `${home}2`;
  await mkdir(lookalike);
  expect(pathContains(home, lookalike)).toBe(false);
  expect((await admitWorkspace(lookalike, { paths })).kind).toBe("directory");
});

test("the default configuration file stays private without blocking its broad parent, including Windows without APPDATA", async () => {
  const original = process.env.APPDATA;
  try {
    if (process.platform === "win32") delete process.env.APPDATA;
    const actual = await applicationPaths();
    const config = await canonicalApplicationPath(globalConfigPath());
    expect(isPrivatePath(actual, config)).toBe(true);
    expect(isPrivatePath(actual, directory)).toBe(false);
  } finally {
    if (original === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = original;
  }
});

test("private children, aliases and forged managed descriptors never grant admission", async () => {
  const child = join(home, "sessions");
  await mkdir(child);
  await expect(admitWorkspace(child, { paths })).rejects.toThrow("служебная");
  const alias = join(directory, "alias");
  await symlink(home, alias, process.platform === "win32" ? "junction" : "dir");
  await expect(admitWorkspace(alias, { paths })).rejects.toThrow("служебная");
  await expect(
    revalidateWorkspace({ root: home, source: "worktree", kind: "managed" }),
  ).rejects.toThrow("не подтверждён");
  const fakeTree = join(home, "worktrees", "a".repeat(64), "trees", "fake");
  await mkdir(fakeTree, { recursive: true });
  await expect(admitWorkspace(fakeTree, { paths })).rejects.toThrow(
    "служебная",
  );
});

test("an admitted directory cannot be replaced before project activation", async () => {
  const ref = await admitWorkspace(project, { paths });
  expect(Object.isFrozen(ref)).toBe(true);
  await rename(project, `${project}.old`);
  await mkdir(project);
  await expect(revalidateWorkspace(ref)).rejects.toThrow("изменилась");
});

test("a broader workspace cannot read private files, even through junctions registered after policy creation", async () => {
  const file = join(home, "credential.json");
  const ordinary = join(project, "source.txt");
  await writeFile(file, "private");
  await writeFile(ordinary, "project");
  const policy = new WorkspacePolicy(directory, []);
  expect(await policy.resolve(ordinary)).toBe(await realpath(ordinary));
  await registerApplicationPrivatePath(home);
  await expect(policy.resolve(file)).rejects.toThrow("Служебные данные");
  const alias = join(project, "service-link");
  await symlink(home, alias, process.platform === "win32" ? "junction" : "dir");
  await expect(policy.resolve(join(alias, "credential.json"))).rejects.toThrow(
    "Служебные данные",
  );
  expect(await policy.resolve(ordinary)).toBe(await realpath(ordinary));
});

test("cancellation rejects before admission and performs no project preparation", async () => {
  const abort = new AbortController();
  abort.abort();
  await expect(
    admitWorkspace(project, { paths, signal: abort.signal }),
  ).rejects.toThrow();
  let preparations = 0;
  const service = new ProjectOpenService(async () => {
    preparations++;
  });
  await expect(
    service.open(
      home,
      { base: directory, signal: abort.signal, isCurrent: () => true },
      () => {},
    ),
  ).rejects.toThrow();
  expect(preparations).toBe(0);
});

test("late opening A cannot replace B; cancellation waits for its own cleanup only", async () => {
  const second = join(directory, "B");
  await mkdir(second);
  let releaseA!: () => void;
  let enteredA!: () => void;
  const entered = new Promise<void>((done) => {
    enteredA = done;
  });
  const gate = new Promise<void>((done) => {
    releaseA = done;
  });
  const service = new ProjectOpenService(async (ref) => {
    if (ref.root === pathIdentity(project)) {
      enteredA();
      await gate;
    }
    return ref.root;
  });
  const owner = {
    base: directory,
    signal: new AbortController().signal,
    isCurrent: () => true,
  };
  const commits: string[] = [];
  const a = service.open(project, owner, (ref) => commits.push(ref.root));
  const failedA = a.catch(() => {});
  await entered;
  await service.open(second, owner, (ref) => commits.push(ref.root));
  releaseA();
  await failedA;
  expect(commits).toEqual([pathIdentity(second)]);
});
