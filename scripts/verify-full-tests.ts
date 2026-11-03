import { DOMParser } from "linkedom";

const normalizePath = (file: string) =>
  file.replaceAll("\\", "/").replace(/^\.\//, "");

/** A green partial/fast JUnit report is not evidence of a full source run. */
export function verifyFullTestReport(
  xml: string,
  expectedFiles: readonly string[],
  platform: NodeJS.Platform = process.platform,
) {
  if (
    !expectedFiles.length ||
    /<!DOCTYPE|<!ENTITY/i.test(xml) ||
    !/<\/testsuites>\s*$/.test(xml)
  )
    throw new Error(
      "Нет списка source-тестов либо неподдерживаемый XML-отчёт.",
    );
  const document = new DOMParser().parseFromString(xml, "text/xml");
  const root = document.documentElement;
  if (
    root?.localName !== "testsuites" ||
    document.querySelectorAll("testsuites").length !== 1
  )
    throw new Error("Нет корректного JUnit testsuites.");
  const number = (attribute: string, fallback?: number) => {
    const value = root.getAttribute(attribute);
    if (value === null && fallback !== undefined) return fallback;
    if (value === null || !/^\d+$/.test(value))
      throw new Error(`Некорректный JUnit counter: ${attribute}.`);
    return Number(value);
  };
  const cases = [...document.querySelectorAll("testcase")];
  for (const suite of document.querySelectorAll("testsuite"))
    for (const counter of ["failures", "errors"]) {
      const count = suite.getAttribute(counter);
      if (count !== null && (!/^\d+$/.test(count) || Number(count) !== 0))
        throw new Error(
          "JUnit testsuite содержит ошибки либо неверные counters.",
        );
    }
  const total = number("tests"),
    skipped = number("skipped");
  if (
    !total ||
    total !== cases.length ||
    skipped >= total ||
    number("failures") ||
    number("errors", 0) ||
    document.querySelector("failure, error")
  )
    throw new Error(
      "Source-отчёт пуст, неполон, целиком пропущен или содержит ошибки.",
    );
  const files = new Map<string, { total: number; skipped: number }>();
  for (const item of cases) {
    const file = normalizePath(item.getAttribute("file") ?? "");
    if (!file) throw new Error("JUnit testcase не содержит source file.");
    const record = files.get(file) ?? { total: 0, skipped: 0 };
    record.total++;
    if (item.querySelector("skipped")) record.skipped++;
    files.set(file, record);
  }
  if (
    [...files.values()].reduce((sum, file) => sum + file.skipped, 0) !== skipped
  )
    throw new Error("JUnit counters не совпадают с пропущенными testcases.");
  const missing = expectedFiles
    .map(normalizePath)
    .filter((file) => !files.has(file));
  if (missing.length)
    throw new Error(
      `Полный source-набор не выполнен. Нет результатов: ${missing.slice(0, 12).join(", ")}.`,
    );
  for (const [file, result] of files) {
    // This file has one native OS clipboard case; headless Linux has no desktop clipboard.
    const nativeClipboardOnLinux =
      platform === "linux" &&
      file === "tests/integration/host-clipboard.test.tsx";
    if (result.total === result.skipped && !nativeClipboardOnLinux)
      throw new Error(
        `Все тесты файла пропущены без platform-исключения: ${file}.`,
      );
  }
  return { files: files.size, tests: total, skipped };
}

if (import.meta.main) {
  const report = process.argv[2] ?? "test-results.xml";
  const file = Bun.file(report);
  if (file.size > 32 * 1024 * 1024)
    throw new Error("JUnit report превышает 32 MiB.");
  const expectedFiles: string[] = [];
  for (const directory of ["tests/unit", "tests/integration"])
    for await (const path of new Bun.Glob(
      "**/*.{test,spec}.{js,jsx,ts,tsx,mjs,cjs,mts,cts}",
    ).scan(directory))
      expectedFiles.push(`${directory}/${path}`);
  const result = verifyFullTestReport(await file.text(), expectedFiles);
  console.log(
    `Полный source-набор подтверждён: ${result.files} файлов, ${result.tests} тестов, ${result.skipped} platform skips.`,
  );
}
