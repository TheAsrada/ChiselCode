import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

type Asset = {
  name: string;
  size: number;
  digest: string;
  state: string;
};

export function releaseAssetNames(version: string): string[] {
  const setup = `ChiselCode-Setup-${version}`;
  return [
    `${setup}.exe`,
    `${setup}-macos-arm64.pkg`,
    `${setup}-macos-x64.pkg`,
    `${setup}-linux-amd64.deb`,
    `${setup}-linux-x86_64.rpm`,
    `${setup}-linux-x86_64.pkg.tar.zst`,
    `ChiselCode-${version}-linux-x64.tar.gz`,
    `chiselcode-${version}.tgz`,
    `chiselcode-${version}-aur.tar.gz`,
    "chiselcode.rb",
    "install.sh",
  ].sort();
}

export function assertReleaseAssets(
  expected: Asset[],
  received: Asset[],
): void {
  if (
    received.length !== expected.length ||
    new Set(received.map((asset) => asset.name)).size !== received.length
  ) throw new Error("Список assets содержит лишние, отсутствующие или повторяющиеся файлы.");
  for (const asset of expected) {
    const remote = received.find((candidate) => candidate.name === asset.name);
    if (
      remote?.state !== "uploaded" ||
      remote.size !== asset.size ||
      remote.digest !== asset.digest
    ) throw new Error(`Файл ${asset.name}: имя, статус, размер или SHA-256 не совпали.`);
  }
}

async function localAsset(directory: string, name: string): Promise<Asset> {
  const file = Bun.file(join(directory, name));
  const hash = new Bun.CryptoHasher("sha256");
  for await (const chunk of file.stream()) hash.update(chunk);
  return {
    name,
    size: file.size,
    digest: `sha256:${hash.digest("hex")}`,
    state: "uploaded",
  };
}

if (import.meta.main) {
  const [mode, directory, version, endpoint] = process.argv.slice(2);
  if (!directory || !version || !["seal", "verify"].includes(mode ?? "")) {
    throw new Error("Использование: verify-release-assets.ts seal|verify DIRECTORY VERSION [ASSETS_API]");
  }
  const names = releaseAssetNames(version);
  const manifest = "SHA256SUMS";
  const entries = await readdir(directory, { withFileTypes: true });
  const expected = mode === "seal" ? names : [...names, manifest];
  if (
    entries.length !== expected.length ||
    entries.some((entry) => !entry.isFile() || !expected.includes(entry.name))
  ) throw new Error(`Неожиданный локальный набор файлов: ${entries.map((entry) => entry.name).join(", ")}`);
  const assets = [];
  for (const name of names) assets.push(await localAsset(directory, name));
  if (assets.some((asset) => asset.size <= 0)) throw new Error("Пустой файл релиза.");
  const sums = assets.map(({ name, digest }) => `${digest.slice(7)}  ${name}\n`).join("");
  const sumsPath = join(directory, manifest);
  if (mode === "seal") {
    await Bun.write(sumsPath, sums);
  } else {
    if (!endpoint) throw new Error("Укажите API endpoint assets.");
    if ((await Bun.file(sumsPath).text()) !== sums)
      throw new Error("SHA256SUMS не совпадает с локальными файлами.");
    assets.push(await localAsset(directory, manifest));
    const response = execFileSync("gh", ["api", "--paginate", "--slurp", endpoint], {
      encoding: "utf8",
      timeout: 30_000,
    });
    const received = (JSON.parse(response) as Asset[][]).flat();
    assertReleaseAssets(assets, received);
    console.log(`Проверены размер, статус и SHA-256 всех файлов: ${assets.length}.`);
  }
}
