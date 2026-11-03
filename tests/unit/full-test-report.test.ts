import { expect, test } from "bun:test";
import { verifyFullTestReport } from "../../scripts/verify-full-tests.js";

const files = ["tests/unit/a.test.ts", "tests/integration/b.test.ts"];
const xml = `<testsuites tests="3" failures="0" skipped="1"><testsuite>
<testcase file="tests/unit/a.test.ts" name="a"/>
<testcase file="tests/integration/b.test.ts" name="b"/>
<testcase file="tests/integration/host-clipboard.test.tsx" name="native"><skipped/></testcase>
</testsuite></testsuites>`;

test("a complete report accepts the explicit headless Linux clipboard exception", () => {
  expect(
    verifyFullTestReport(
      xml,
      [...files, "tests/integration/host-clipboard.test.tsx"],
      "linux",
    ),
  ).toEqual({ files: 3, tests: 3, skipped: 1 });
  expect(() => verifyFullTestReport(xml, files, "win32")).toThrow("пропущены");
});

test("a successful fast profile or report with omitted source files cannot pass as full tests", () => {
  expect(() =>
    verifyFullTestReport(
      xml,
      [...files, "tests/unit/new-regression.test.ts"],
      "linux",
    ),
  ).toThrow("new-regression");
  expect(() => verifyFullTestReport(xml, [], "linux")).toThrow();
});

test("failed, truncated, empty and wholly skipped reports fail closed", () => {
  for (const report of [
    "",
    "<testsuites/>",
    "<other/>",
    xml.replace('tests="3"', 'tests="0"'),
    xml.replace('failures="0"', 'failures="1"'),
    xml.replace('failures="0"', 'failures="0" errors="1"'),
    xml.replace('skipped="1"', 'skipped="3"'),
    xml.replace('tests="3"', 'tests="NaN"'),
    xml.replace(
      'name="a"/>',
      'name="a"><failure>assertion failed</failure></testcase>',
    ),
    xml.replace('tests="3"', 'tests="4"'),
    xml.replace('skipped="1"', 'skipped="0"'),
    xml.replace('file="tests/unit/a.test.ts"', ""),
    `<!DOCTYPE example>${xml}`,
    xml.replace("</testsuites>", ""),
    xml.replace("<testsuite>", '<testsuite failures="1">'),
  ]) {
    expect(() => verifyFullTestReport(report, files, "linux")).toThrow();
  }
});

test("skipping a full file cannot silently hide an ordinary regression suite", () => {
  const skippedFile = xml
    .replace('name="a"/>', 'name="a"><skipped/></testcase>')
    .replace('skipped="1"', 'skipped="2"');
  expect(() => verifyFullTestReport(skippedFile, files, "linux")).toThrow(
    "a.test.ts",
  );
});

test("Bun file paths normalize Windows separators and dot prefixes", () => {
  const report = xml.replace(
    "tests/unit/a.test.ts",
    ".\\tests\\unit\\a.test.ts",
  );
  expect(verifyFullTestReport(report, files, "linux").tests).toBe(3);
});
