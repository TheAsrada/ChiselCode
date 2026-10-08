import { DOMParser } from "linkedom";

// Failed CI tests remain diagnosable through the Checks API when log storage is
// unavailable. These are bounded fixture diagnostics, never application output.
const escape = (value: string) =>
  value
    .slice(0, 4096)
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
let reported = false;
try {
  const document = new DOMParser().parseFromString(
    await Bun.file("test-results.xml").text(),
    "text/xml",
  );
  for (const failure of [...document.querySelectorAll("failure, error")].slice(0, 50)) {
    const name = failure.parentElement?.getAttribute("name") ?? "Unknown test";
    console.error(`::error title=Test failure::${escape(`${name}: ${failure.getAttribute("message") ?? ""}\n${failure.textContent ?? ""}`)}`);
    reported = true;
  }
} catch {
  // A runner crash can precede the JUnit report.
}
if (!reported) {
  const tail = (await Bun.file("test-results.log").text()).split(/\r?\n/).slice(-40).join("\n");
  console.error(`::error title=Test runner failure::${escape(tail)}`);
}
