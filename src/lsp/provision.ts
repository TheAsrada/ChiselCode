import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { chiselHomeDir } from "../paths/home.js";
import { cancelled, RuntimeError } from "../runtime/errors.js";
import { SafeWebHttpClient } from "../web/http-client.js";
import { WebLimitsSchema } from "../web/schema.js";
import { extractBackendArchive } from "./archive.js";
import type { LspServerDescriptor } from "./catalog.js";
import type { LspLaunch } from "./config.js";
import goSdk from "./go-sdk.json" with { type: "json" };
import npmPackages from "./npm-packages.json" with { type: "json" };
import { runPreparation } from "./preparation-process.js";
import releaseAssets from "./release-assets.json" with { type: "json" };
import rubyGems from "./ruby-gems.json" with { type: "json" };

interface Artifact {
  url: string;
  sha256?: string;
  sha512?: string;
  integrity?: string;
  format: "zip" | "tar.gz" | "gz";
}
interface NpmPackage {
  version: string;
  resolved: string;
  integrity: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  os?: string[];
}
const packages = npmPackages as Record<string, NpmPackage>;
const releases = releaseAssets as unknown as Record<
  string,
  Record<string, Artifact>
>;
const hash = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
const platform = () => `${process.platform}-${process.arch}`;
const deliveryHosts = new Set([
  "registry.npmjs.org",
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
  "go.dev",
  "dl.google.com",
  "download.eclipse.org",
  "rubygems.org",
  "storage.googleapis.com",
  "nodejs.org",
  "builds.dotnet.microsoft.com",
  "static.rust-lang.org",
]);
const outside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
};

/** Package delivery is core-owned infrastructure, restricted to immutable catalog artifacts.
 * Its finite destination check is never exposed as an agent network capability. */
async function download(
  artifact: Artifact,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!artifact.sha256 && !artifact.sha512 && !artifact.integrity)
    throw new RuntimeError(
      "LSP_UNAVAILABLE",
      "Language server artifact has no verified integrity.",
    );
  const url = new URL(artifact.url);
  if (
    url.protocol !== "https:" ||
    !deliveryHosts.has(url.hostname) ||
    url.username ||
    url.password
  )
    throw new RuntimeError(
      "LSP_UNAVAILABLE",
      "Unknown language server delivery source.",
    );
  const client = new SafeWebHttpClient({
    ...WebLimitsSchema.parse({}),
    requestTimeoutMs: 180000,
    maxResponseBytes: 384 * 1024 * 1024,
    maxDecompressedBytes: 384 * 1024 * 1024,
  });
  const response = await client.get(artifact.url, {
    signal,
    authorization: {
      assertDestination(host) {
        if (!deliveryHosts.has(host))
          throw new RuntimeError(
            "LSP_UNAVAILABLE",
            "Unknown language server download redirect.",
          );
      },
    },
  });
  const bytes = response.bytes;
  const valid = artifact.sha256
    ? hash(bytes) === artifact.sha256
    : artifact.sha512
      ? createHash("sha512").update(bytes).digest("hex") === artifact.sha512
      : artifact.integrity ===
        `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (!valid)
    throw new RuntimeError(
      "LSP_UNAVAILABLE",
      "Language server download failed its integrity check.",
    );
  return bytes;
}
export async function findLspRuntime(
  root: string,
  executable: string,
): Promise<string | undefined> {
  const candidates = [
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean),
    "/usr/bin",
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/usr/local/swift/usr/bin",
    "/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin",
    "/Library/Developer/CommandLineTools/usr/bin",
    ...(process.env.JAVA_HOME ? [join(process.env.JAVA_HOME, "bin")] : []),
    ...(process.env.GOROOT ? [join(process.env.GOROOT, "bin")] : []),
    ...(process.env.RUSTUP_HOME
      ? [join(process.env.RUSTUP_HOME, "toolchains")]
      : []),
  ];
  for (const directory of [...new Set(candidates)]) {
    if (!directory || !outside(root, resolve(directory))) continue;
    try {
      const path = await realpath(
        join(
          directory,
          `${executable}${process.platform === "win32" && executable !== "gem" ? ".exe" : ""}`,
        ),
      );
      if (outside(root, path) && (await stat(path)).isFile()) return path;
    } catch {
      /* Try the next user-installed SDK; never search workspace node_modules. */
    }
  }
  return undefined;
}
function packageClosure(name: string): [string, NpmPackage][] {
  const selected = new Map<string, NpmPackage>();
  const visit = (path: string) => {
    if (selected.has(path)) return;
    const record = packages[path];
    if (!record)
      throw new RuntimeError(
        "LSP_UNAVAILABLE",
        "Curated language server dependency is missing.",
      );
    if (record.os && !record.os.includes(process.platform)) return;
    selected.set(path, record);
    for (const dependency of Object.keys({
      ...record.dependencies,
      ...record.optionalDependencies,
      ...record.peerDependencies,
    })) {
      let parent = path;
      let target: string | undefined;
      for (;;) {
        const candidate = `${parent}/node_modules/${dependency}`;
        if (packages[candidate]) {
          target = candidate;
          break;
        }
        const index = parent.lastIndexOf("/node_modules/");
        if (index >= 0) parent = parent.slice(0, index);
        else {
          const global = `node_modules/${dependency}`;
          if (packages[global]) target = global;
          break;
        }
      }
      if (target) visit(target);
      else if (record.dependencies?.[dependency])
        throw new RuntimeError(
          "LSP_UNAVAILABLE",
          "Unresolved curated server dependency.",
        );
    }
  };
  visit(`node_modules/${name}`);
  return [...selected].sort(([a], [b]) => a.localeCompare(b));
}
async function cachedTree(
  destination: string,
  populate: (directory: string) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  cancelled(signal);
  const intact = async () => {
    try {
      if ((await realpath(destination)) !== destination) return false;
      const manifest = JSON.parse(
        await readFile(join(destination, ".chisel-integrity.json"), "utf8"),
      ) as Record<string, string>;
      if (Object.keys(manifest).length > 30000) return false;
      for (const [name, digest] of Object.entries(manifest)) {
        cancelled(signal);
        if (
          !name ||
          name.split(/[\\/]/).includes("..") ||
          name.startsWith("/") ||
          name.includes(":")
        )
          return false;
        const path = join(destination, name);
        if (
          !(await lstat(path)).isFile() ||
          (await realpath(path)) !== path ||
          hash(await readFile(path)) !== digest
        )
          return false;
      }
      return Object.keys(manifest).length > 0;
    } catch {
      cancelled(signal);
      return false;
    }
  };
  if (await intact()) return;
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const previous = `${destination}.${randomUUID()}.old`;
  await mkdir(temporary, { mode: 0o700 });
  try {
    await populate(temporary);
    cancelled(signal);
    const manifest: Record<string, string> = {};
    const walk = async (directory: string) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        cancelled(signal);
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile())
          manifest[relative(temporary, path).split(sep).join("/")] = hash(
            await readFile(path),
          );
        else
          throw new RuntimeError(
            "LSP_UNAVAILABLE",
            "Unsafe language server cache entry.",
          );
      }
    };
    await walk(temporary);
    await writeFile(
      join(temporary, ".chisel-integrity.json"),
      JSON.stringify(manifest),
      { flag: "wx", mode: 0o600 },
    );
    if (await intact()) return;
    try {
      await rename(destination, previous);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await rename(temporary, destination);
    } catch (error) {
      if (!(await intact())) throw error;
    }
    if (!(await intact()))
      throw new RuntimeError(
        "LSP_UNAVAILABLE",
        "Language server cache validation failed.",
      );
  } finally {
    await writableCleanup(temporary);
    await writableCleanup(previous);
  }
}
async function writableCleanup(directory: string): Promise<void> {
  try {
    await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const makeWritable = async (path: string): Promise<void> => {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      await chmod(path, 0o700);
      for (const name of await readdir(path))
        await makeWritable(join(path, name));
    } else await chmod(path, 0o600);
  };
  await makeWritable(directory);
  await rm(directory, { recursive: true, force: true });
}
async function cacheRoot(root: string, key: string): Promise<string> {
  const home = join(chiselHomeDir(), "lsp", "servers");
  // Resolve the existing ancestor without creating files during status/prepare.
  let ancestor = home;
  const suffix: string[] = [];
  for (;;) {
    try {
      ancestor = await realpath(ancestor);
      break;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" ||
        dirname(ancestor) === ancestor
      )
        throw error;
      suffix.unshift(basename(ancestor));
      ancestor = dirname(ancestor);
    }
  }
  const path = join(ancestor, ...suffix, key);
  if (!outside(root, path))
    throw new RuntimeError(
      "LSP_UNAVAILABLE",
      "Language server data must be outside the workspace.",
    );
  return path;
}
async function makeExecutables(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await chmod(path, 0o700);
      await makeExecutables(path);
    } else if (entry.isFile()) await chmod(path, 0o700);
  }
}
function nativeEntry(
  descriptor: LspServerDescriptor,
  artifact: Artifact,
): string {
  if (artifact.format === "gz") return "server";
  if (descriptor.id === "auto-cpp")
    return `clangd_${descriptor.version}/bin/clangd${process.platform === "win32" ? ".exe" : ""}`;
  if (descriptor.id === "auto-lua")
    return `bin/lua-language-server${process.platform === "win32" ? ".exe" : ""}`;
  if (descriptor.id === "auto-csharp")
    return `OmniSharp${process.platform === "win32" ? ".exe" : ""}`;
  return `rust-analyzer${process.platform === "win32" ? ".exe" : ""}`;
}
async function javaRuntime(
  root: string,
  materialize: boolean,
  signal?: AbortSignal,
): Promise<string> {
  const artifact = releases["java-sdk"]?.[platform()];
  if (!artifact)
    throw new RuntimeError(
      "LSP_UNSUPPORTED",
      "No verified Java runtime for this platform. Install Java ≥21 outside the workspace.",
    );
  const directory = await cacheRoot(
    root,
    `java-21.0.12.1-${hash(JSON.stringify(artifact)).slice(0, 16)}`,
  );
  if (materialize)
    await cachedTree(
      directory,
      async (temporary) => {
        await extractBackendArchive(
          await download(artifact, signal),
          artifact.format,
          temporary,
          signal,
        );
        await makeExecutables(temporary);
      },
      signal,
    );
  return join(
    directory,
    "jdk-21.0.12.1+1-jre",
    ...(process.platform === "darwin" ? ["Contents", "Home"] : []),
    "bin",
    process.platform === "win32" ? "java.exe" : "java",
  );
}
async function nodeRuntime(
  root: string,
  materialize: boolean,
  signal?: AbortSignal,
): Promise<string> {
  const artifact = releases["node-sdk"]?.[platform()];
  if (!artifact)
    throw new RuntimeError(
      "LSP_UNSUPPORTED",
      "No verified Node runtime for this platform.",
    );
  const directory = await cacheRoot(
    root,
    `node-24.19.0-${hash(JSON.stringify(artifact)).slice(0, 16)}`,
  );
  const entry = `node-v24.19.0-${process.platform === "win32" ? "win" : process.platform}-${process.arch}`;
  if (materialize)
    await cachedTree(
      directory,
      async (temporary) => {
        await extractBackendArchive(
          await download(artifact, signal),
          artifact.format,
          temporary,
          signal,
        );
        await makeExecutables(temporary);
      },
      signal,
    );
  return join(
    directory,
    entry,
    ...(process.platform === "win32" ? [] : ["bin"]),
    process.platform === "win32" ? "node.exe" : "node",
  );
}
async function rustRuntime(
  root: string,
  materialize: boolean,
  signal?: AbortSignal,
): Promise<string> {
  const artifacts = (
    releaseAssets["rust-sdk"] as Record<string, Record<string, Artifact>>
  )[platform()];
  if (!artifacts?.rustc || !artifacts.cargo || !artifacts["rust-std"])
    throw new RuntimeError(
      "LSP_UNSUPPORTED",
      "No verified Rust SDK for this platform.",
    );
  const directory = await cacheRoot(
    root,
    `rust-1.99.0-${hash(JSON.stringify(artifacts)).slice(0, 16)}`,
  );
  if (materialize)
    await cachedTree(
      directory,
      async (temporary) => {
        const staging = join(temporary, ".archives");
        await mkdir(staging);
        const merge = async (from: string, to: string): Promise<void> => {
          await mkdir(to, { recursive: true, mode: 0o700 });
          for (const entry of await readdir(from, { withFileTypes: true })) {
            if (entry.isDirectory())
              await merge(join(from, entry.name), join(to, entry.name));
            else if (entry.isFile())
              await rename(join(from, entry.name), join(to, entry.name));
          }
        };
        for (const [component, artifact] of Object.entries(artifacts)) {
          const extraction = join(staging, component);
          await mkdir(extraction);
          await extractBackendArchive(
            await download(artifact, signal),
            artifact.format,
            extraction,
            signal,
          );
          const [prefix] = await readdir(extraction);
          if (!prefix)
            throw new RuntimeError(
              "LSP_UNAVAILABLE",
              "Invalid Rust component archive.",
            );
          const parent = join(extraction, prefix);
          const candidates = (
            await readdir(parent, { withFileTypes: true })
          ).filter(
            (item) => item.isDirectory() && item.name.startsWith(component),
          );
          if (candidates.length !== 1 || !candidates[0])
            throw new RuntimeError(
              "LSP_UNAVAILABLE",
              "Invalid Rust SDK component layout.",
            );
          await merge(join(parent, candidates[0].name), temporary);
        }
        await rm(staging, { recursive: true, force: true });
        await makeExecutables(join(temporary, "bin"));
      },
      signal,
    );
  return directory;
}
async function rubyEnvironment(
  root: string,
  ruby: string,
): Promise<Record<string, string>> {
  const prefix = dirname(dirname(ruby));
  const lib = join(prefix, "lib/ruby");
  const paths: string[] = [];
  try {
    for (const entry of await readdir(lib, { withFileTypes: true }))
      if (entry.isDirectory() && /^\d+\.\d+\.\d+$/.test(entry.name)) {
        paths.push(join(lib, entry.name));
        for (const arch of await readdir(join(lib, entry.name), {
          withFileTypes: true,
        }))
          if (
            arch.isDirectory() &&
            /^(x86_64|aarch64|arm64|x64)-/.test(arch.name)
          )
            paths.push(join(lib, entry.name, arch.name));
      }
  } catch {
    /* System Ruby has its own compiled standard-library paths. */
  }
  const executablePaths = new Set([dirname(ruby)]);
  for (const candidate of [
    ...(process.env.PATH ?? "").split(delimiter),
    "/usr/bin",
    "/bin",
  ]) {
    if (!isAbsolute(candidate)) continue;
    try {
      const path = await realpath(candidate);
      if (outside(root, path) && (await stat(path)).isDirectory())
        executablePaths.add(path);
    } catch {
      /* Missing SDK/toolchain folders are not inherited. */
    }
  }
  return {
    PATH: [...executablePaths].join(delimiter),
    ...(paths.length
      ? {
          RUBYLIB: paths.join(delimiter),
          ...(process.platform === "linux"
            ? { LD_LIBRARY_PATH: join(prefix, "lib") }
            : {}),
        }
      : {}),
  };
}
async function prepareNpm(
  directory: string,
  closure: [string, NpmPackage][],
  signal?: AbortSignal,
): Promise<void> {
  const staging = join(directory, ".downloads");
  await mkdir(staging);
  try {
    for (let offset = 0; offset < closure.length; offset += 4) {
      const batch = await Promise.allSettled(
        closure.slice(offset, offset + 4).map(async ([path, pkg]) => {
          const extraction = join(staging, hash(path));
          await mkdir(extraction);
          const bytes = await download(
            { url: pkg.resolved, integrity: pkg.integrity, format: "tar.gz" },
            signal,
          );
          await extractBackendArchive(
            bytes,
            "tar.gz",
            extraction,
            signal,
            path === "node_modules/intelephense" && pkg.version === "1.18.5",
          );
          const files = await readdir(extraction);
          if (files.length !== 1 || !files[0])
            throw new RuntimeError(
              "LSP_UNAVAILABLE",
              "Invalid npm server archive layout.",
            );
          const content = join(extraction, files[0]);
          const metadata = JSON.parse(
            await readFile(join(content, "package.json"), "utf8"),
          );
          if (
            metadata.version !== pkg.version ||
            metadata.name !== path.split("node_modules/").at(-1)
          )
            throw new RuntimeError(
              "LSP_UNAVAILABLE",
              "Unexpected npm server package identity.",
            );
          await rename(content, join(extraction, "content"));
        }),
      );
      const failed = batch.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    }
    for (const [path] of [...closure].sort(
      ([a], [b]) =>
        a.split("/").length - b.split("/").length || a.localeCompare(b),
    )) {
      cancelled(signal);
      const destination = join(directory, path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await rename(join(staging, hash(path), "content"), destination);
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** No install or process on preview. Only a supported explicit read/restart prepares a backend. */
export async function catalogLspLaunch(
  root: string,
  descriptor: LspServerDescriptor,
  materialize = false,
  signal?: AbortSignal,
): Promise<LspLaunch> {
  cancelled(signal);
  const recipe = descriptor.installation;
  const rubySdk =
    recipe.type === "ruby" ? await findLspRuntime(root, "ruby") : undefined;
  const rubyStamp = rubySdk ? await stat(rubySdk) : undefined;
  const closure = recipe.type === "npm" ? packageClosure(recipe.package) : [];
  const assetName =
    recipe.type === "release"
      ? recipe.assets[platform()]
      : recipe.type === "jvm" || recipe.type === "jdtls"
        ? recipe.asset
        : undefined;
  const artifact =
    assetName &&
    (recipe.type === "release" ||
      recipe.type === "jvm" ||
      recipe.type === "jdtls")
      ? releases[recipe.type === "jdtls" ? "jdtls" : recipe.repository]?.[
          assetName
        ]
      : undefined;
  if (
    (recipe.type === "release" ||
      recipe.type === "jvm" ||
      recipe.type === "jdtls") &&
    !artifact?.sha256
  )
    throw new RuntimeError(
      "LSP_UNSUPPORTED",
      "No verified Auto package for this server/platform. Use a trusted custom stdio server.",
    );
  const verifiedArtifact = () => {
    if (!artifact)
      throw new RuntimeError(
        "LSP_UNAVAILABLE",
        "Curated language server artifact is missing.",
      );
    return artifact;
  };
  const digest = hash(
    JSON.stringify([
      descriptor,
      closure,
      artifact,
      recipe.type === "ruby" ? rubyGems : null,
      rubySdk ? [rubySdk, rubyStamp?.size, rubyStamp?.mtimeMs] : null,
      platform(),
      "layout-v2",
    ]),
  );
  const directory = await cacheRoot(
    root,
    `${descriptor.id}-${descriptor.version}-${digest.slice(0, 16)}`,
  );
  let command = process.execPath;
  let serverVersion = descriptor.version;
  const settings = structuredClone(descriptor.settings ?? {});
  let args: string[] = [];
  let environment: Record<string, string> = {};
  if (recipe.type === "npm") {
    command = await nodeRuntime(root, materialize, signal);
    if (materialize)
      await cachedTree(
        directory,
        (temporary) => prepareNpm(temporary, closure, signal),
        signal,
      );
    args = [
      join(directory, "node_modules", recipe.package, recipe.entry),
      ...(recipe.args ?? ["--stdio"]),
    ];
  } else if (recipe.type === "release") {
    const entry = nativeEntry(descriptor, verifiedArtifact());
    if (materialize)
      await cachedTree(
        directory,
        async (temporary) => {
          await extractBackendArchive(
            await download(verifiedArtifact(), signal),
            verifiedArtifact().format,
            temporary,
            signal,
          );
          await chmod(join(temporary, entry), 0o700);
        },
        signal,
      );
    command = join(directory, entry);
    args = [...(recipe.args ?? [])];
    if (descriptor.id === "auto-csharp") {
      const runtime = releases["dotnet-sdk"]?.[platform()];
      if (!runtime)
        throw new RuntimeError(
          "LSP_UNSUPPORTED",
          "No verified .NET 10 runtime for this platform.",
        );
      const dotnet = await cacheRoot(
        root,
        `dotnet-10.0.401-${hash(JSON.stringify(runtime)).slice(0, 16)}`,
      );
      if (materialize)
        await cachedTree(
          dotnet,
          async (temporary) => {
            await extractBackendArchive(
              await download(runtime, signal),
              runtime.format,
              temporary,
              signal,
            );
            await chmod(
              join(
                temporary,
                process.platform === "win32" ? "dotnet.exe" : "dotnet",
              ),
              0o700,
            );
          },
          signal,
        );
      environment = {
        DOTNET_ROOT: dotnet,
        DOTNET_MULTILEVEL_LOOKUP: "0",
        DOTNET_CLI_TELEMETRY_OPTOUT: "1",
        DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
      };
    }
    if (descriptor.id === "auto-rust") {
      const sdk = await rustRuntime(root, materialize, signal);
      environment = {
        PATH: join(sdk, "bin"),
        RUSTC: join(
          sdk,
          "bin",
          process.platform === "win32" ? "rustc.exe" : "rustc",
        ),
        RUST_SRC_PATH: join(sdk, "lib/rustlib/src/rust/library"),
        CARGO_NET_OFFLINE: "true",
        RUSTUP_NO_UPDATE_CHECK: "1",
        CARGO_HOME: join(directory, "analysis/cargo"),
      };
      const analyzer = settings["rust-analyzer"] as Record<string, unknown>;
      analyzer.cargo = {
        ...(analyzer.cargo as Record<string, unknown>),
        sysroot: sdk,
        sysrootSrc: join(sdk, "lib/rustlib/src/rust/library"),
        extraEnv: { RUSTC: environment.RUSTC, CARGO_NET_OFFLINE: "true" },
      };
    }
  } else if (recipe.type === "go") {
    const sdkArtifact = (goSdk.assets as Record<string, Artifact>)[platform()];
    if (!sdkArtifact)
      throw new RuntimeError(
        "LSP_UNSUPPORTED",
        "No Auto Go SDK for this platform.",
      );
    if (materialize)
      await cachedTree(
        directory,
        async (temporary) => {
          await extractBackendArchive(
            await download(sdkArtifact, signal),
            sdkArtifact.format,
            temporary,
            signal,
          );
          const go = join(
            temporary,
            "go/bin",
            process.platform === "win32" ? "go.exe" : "go",
          );
          await makeExecutables(join(temporary, "go/bin"));
          await makeExecutables(join(temporary, "go/pkg/tool"));
          await mkdir(join(temporary, "bin"));
          const env: NodeJS.ProcessEnv = {
            PATH: dirname(go),
            GOROOT: join(temporary, "go"),
            GOPATH: join(temporary, "build"),
            GOBIN: join(temporary, "bin"),
            GOCACHE: join(temporary, "build/cache"),
            GOPROXY: "https://proxy.golang.org",
            GOSUMDB: "sum.golang.org",
            GOTOOLCHAIN: "local",
            CGO_ENABLED: "0",
            ...(process.platform === "win32"
              ? { SystemRoot: process.env.SystemRoot }
              : {}),
            HTTPS_PROXY: process.env.HTTPS_PROXY,
            HTTP_PROXY: process.env.HTTP_PROXY,
          };
          await runPreparation(
            go,
            ["install", `${recipe.module}@${recipe.version}`],
            temporary,
            env,
            signal,
          );
          await makeExecutables(join(temporary, "build"));
          await rm(join(temporary, "build"), { recursive: true, force: true });
        },
        signal,
      );
    command = join(
      directory,
      "bin",
      process.platform === "win32" ? "gopls.exe" : "gopls",
    );
    environment = {
      PATH: join(directory, "go/bin"),
      GOROOT: join(directory, "go"),
      GOCACHE: join(directory, "analysis/cache"),
      GOMODCACHE: join(directory, "analysis/mod"),
      GOPATH: join(directory, "analysis"),
      GOPROXY: "off",
      GOTOOLCHAIN: "local",
      GOFLAGS: "-mod=readonly",
      CGO_ENABLED: "0",
      GOTELEMETRY: "off",
    };
  } else if (recipe.type === "jvm") {
    const java = await javaRuntime(root, materialize, signal);
    if (materialize)
      await cachedTree(
        directory,
        async (temporary) =>
          extractBackendArchive(
            await download(verifiedArtifact(), signal),
            verifiedArtifact().format,
            temporary,
            signal,
          ),
        signal,
      );
    command = java;
    args = ["-cp", join(directory, "server/lib/*"), recipe.main];
    environment = { JAVA_HOME: dirname(dirname(java)), PATH: dirname(java) };
  } else if (recipe.type === "jdtls") {
    const java = await javaRuntime(root, materialize, signal);
    if (materialize)
      await cachedTree(
        directory,
        async (temporary) =>
          extractBackendArchive(
            await download(verifiedArtifact(), signal),
            verifiedArtifact().format,
            temporary,
            signal,
          ),
        signal,
      );
    command = java;
    args = [
      "-Declipse.application=org.eclipse.jdt.ls.core.id1",
      "-Dosgi.bundles.defaultStartLevel=4",
      "-Declipse.product=org.eclipse.jdt.ls.core.product",
      "-Djava.import.gradle.enabled=false",
      "-Djava.import.maven.enabled=false",
      "-Xmx512m",
      "--add-modules=ALL-SYSTEM",
      "--add-opens",
      "java.base/java.util=ALL-UNNAMED",
      "--add-opens",
      "java.base/java.lang=ALL-UNNAMED",
      "-jar",
      join(directory, "plugins", recipe.launcher),
      "-configuration",
      join(
        directory,
        process.platform === "win32"
          ? "config_win"
          : process.platform === "darwin"
            ? "config_mac"
            : "config_linux",
      ),
      "-data",
      join(directory, "workspaces", hash(root).slice(0, 24)),
    ];
    environment = { JAVA_HOME: dirname(dirname(java)), PATH: dirname(java) };
  } else if (recipe.type === "dart") {
    const installed = await findLspRuntime(root, "dart");
    if (installed) {
      command = installed;
      serverVersion = "Installed SDK (version unverified)";
    } else {
      const dartArtifact = releases["dart-sdk"]?.[platform()];
      if (!dartArtifact)
        throw new RuntimeError(
          "LSP_UNSUPPORTED",
          "No verified Dart SDK for this platform.",
        );
      if (materialize)
        await cachedTree(
          directory,
          async (temporary) => {
            await extractBackendArchive(
              await download(dartArtifact, signal),
              dartArtifact.format,
              temporary,
              signal,
            );
            await makeExecutables(join(temporary, "dart-sdk/bin"));
          },
          signal,
        );
      command = join(
        directory,
        "dart-sdk/bin",
        process.platform === "win32" ? "dart.exe" : "dart",
      );
    }
    args = ["language-server", "--protocol=lsp"];
    environment = { PATH: dirname(command), DART_SUPPRESS_ANALYTICS: "true" };
  } else if (recipe.type === "ruby") {
    const ruby = rubySdk;
    const gem = await findLspRuntime(root, "gem");
    if (!ruby || !gem)
      throw new RuntimeError(
        "LSP_UNAVAILABLE",
        "Для Ruby Auto нужен установленный Ruby/RubyGems SDK вне проекта; пути определяются автоматически.",
      );
    const rubyEnv = await rubyEnvironment(root, ruby);
    if (materialize)
      await cachedTree(
        directory,
        async (temporary) => {
          const archives = join(temporary, ".packages");
          await mkdir(archives);
          const artifacts = rubyGems.map(
            (gem) =>
              ("platforms" in gem
                ? (gem.platforms as Record<
                    string,
                    { url: string; sha256: string }
                  >)
                : undefined)?.[platform()] ?? gem,
          );
          const fileFor = (artifact: { url: string }) =>
            join(archives, basename(new URL(artifact.url).pathname));
          const files = artifacts.map(fileFor);
          for (let offset = 0; offset < artifacts.length; offset += 4) {
            cancelled(signal);
            const batch = await Promise.allSettled(
              artifacts.slice(offset, offset + 4).map(async (artifact) => {
                await writeFile(
                  fileFor(artifact),
                  await download({ ...artifact, format: "tar.gz" }, signal),
                  { flag: "wx", mode: 0o600 },
                );
              }),
            );
            const failed = batch.find((result) => result.status === "rejected");
            if (failed?.status === "rejected") throw failed.reason;
          }
          await writeFile(join(temporary, ".gemrc"), "--- {}\n", {
            mode: 0o600,
          });
          await runPreparation(
            ruby,
            [
              gem,
              "install",
              "--local",
              "--ignore-dependencies",
              "--install-dir",
              temporary,
              "--no-document",
              ...files,
              ...((
                await stat(
                  join(dirname(dirname(ruby)), "include/yaml.h"),
                ).catch(() => undefined)
              )?.isFile()
                ? ["--", `--with-libyaml-dir=${dirname(dirname(ruby))}`]
                : []),
            ],
            temporary,
            {
              ...rubyEnv,
              GEM_HOME: temporary,
              GEM_PATH: temporary,
              GEMRC: join(temporary, ".gemrc"),
              ...(process.platform === "win32"
                ? { SystemRoot: process.env.SystemRoot }
                : {}),
            },
            signal,
          );
          await rm(archives, { recursive: true, force: true });
        },
        signal,
      );
    command = ruby;
    args = [join(directory, "bin", recipe.gem), ...recipe.args];
    const gemLibs = rubyGems.map((gem) => {
      const variant = (
        "platforms" in gem
          ? (gem.platforms as Record<string, { url: string }>)
          : undefined
      )?.[platform()];
      const name = variant
        ? basename(new URL(variant.url).pathname, ".gem")
        : `${gem.name}-${gem.version}`;
      return join(directory, "gems", name, "lib");
    });
    environment = {
      ...rubyEnv,
      GEM_HOME: directory,
      GEM_PATH: directory,
      SOLARGRAPH_CACHE: join(directory, "analysis/solargraph"),
      RUBYLIB: [...gemLibs, ...(rubyEnv.RUBYLIB ? [rubyEnv.RUBYLIB] : [])].join(
        delimiter,
      ),
    };
  } else if (recipe.type === "sdk") {
    const sdk = await findLspRuntime(root, recipe.executable);
    if (!sdk)
      throw new RuntimeError(
        "LSP_UNAVAILABLE",
        `${descriptor.title}: ${descriptor.prerequisites ?? "нужен установленный SDK вне проекта"}. Исполняемый файл не найден; сервер не запущен.`,
      );
    command = sdk;
    args = [...recipe.args];
    environment = { PATH: dirname(sdk) };
  } else
    throw new RuntimeError(
      "LSP_UNAVAILABLE",
      "Use the bundled TypeScript backend.",
    );
  return {
    id: descriptor.id,
    kind: "auto",
    backend: descriptor.id,
    command,
    args,
    environment,
    settings,
    initializationOptions: structuredClone(
      descriptor.initializationOptions ?? {},
    ),
    serverVersion,
    fingerprint: JSON.stringify([
      descriptor.id,
      digest,
      command,
      args,
      environment,
    ]),
  };
}
