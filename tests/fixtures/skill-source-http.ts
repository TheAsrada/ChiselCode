import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export const skillCommit = "a".repeat(40);
export const importedSkill = Buffer.from(
  "---\nname: ui-design\ndescription: Design a clear interface.\n---\nRead references/guide.md before designing.\n",
);
export function skillSourceHttp() {
  const files = new Map([
    ["skills/folder-name/SKILL.md", importedSkill],
    [
      "skills/folder-name/references/guide.md",
      Buffer.from("Keep controls readable and preserve keyboard navigation."),
    ],
    ["skills/folder-name/assets/pixel.bin", Buffer.from([0, 255, 128, 13, 10])],
    [
      "skills/other/SKILL.md",
      Buffer.from(
        "---\nname: other\ndescription: Another skill.\n---\nOther instructions.",
      ),
    ],
  ]);
  const sha = (bytes: Uint8Array) =>
    createHash("sha1")
      .update(`blob ${bytes.length}\0`)
      .update(bytes)
      .digest("hex");
  const hits: string[] = [];
  let corrupt = false,
    link = false,
    redirect = "",
    block: (() => void) | undefined;
  return {
    files,
    hits,
    set corrupt(value: boolean) {
      corrupt = value;
    },
    set link(value: boolean) {
      link = value;
    },
    set redirect(value: string) {
      redirect = value;
    },
    set block(value: (() => void) | undefined) {
      block = value;
    },
    handle(req: IncomingMessage, res: ServerResponse) {
      const url = new URL(req.url ?? "/", "https://api.github.com");
      hits.push(req.url ?? "");
      res.setHeader("Content-Type", "application/json");
      if (redirect) {
        res.writeHead(302, { Location: redirect });
        res.end();
        return;
      }
      if (url.pathname === "/standalone/SKILL.md") {
        res.setHeader("Content-Type", "text/markdown");
        res.end(importedSkill);
        return;
      }
      if (url.pathname.endsWith("/commits")) {
        res.end(JSON.stringify([{ sha: skillCommit }]));
        return;
      }
      if (url.pathname.includes("/git/trees/")) {
        const recursive = url.searchParams.has("recursive");
        const treeSha = url.pathname.split("/").at(-1);
        const folder =
          treeSha === "b".repeat(40)
            ? "skills/"
            : treeSha === "c".repeat(40)
              ? "skills/folder-name/"
              : "";
        const tree = recursive
          ? [...files]
              .filter(([name]) => name.startsWith(folder))
              .map(([path, bytes]) => ({
                path: path.slice(folder.length),
                sha: sha(bytes),
                mode: link && path.endsWith("pixel.bin") ? "120000" : "100644",
                type: "blob",
                size: bytes.length,
              }))
          : [
              {
                path: folder ? "folder-name" : "skills",
                sha: (folder ? "c" : "b").repeat(40),
                mode: "040000",
                type: "tree",
              },
            ];
        res.end(JSON.stringify({ tree, truncated: false }));
        return;
      }
      if (url.pathname.includes("/git/blobs/")) {
        if (block) {
          block();
          return;
        }
        const bytes = [...files.values()].find(
          (bytes) => sha(bytes) === url.pathname.split("/").at(-1),
        );
        if (bytes) {
          res.end(
            JSON.stringify({
              encoding: "base64",
              content: (corrupt ? Buffer.from("corrupt") : bytes).toString(
                "base64",
              ),
              size: bytes.length,
            }),
          );
          return;
        }
      }
      res.writeHead(404);
      res.end("not found");
    },
  };
}
