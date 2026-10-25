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
    corruptAsset = false,
    holdReference = false,
    link = false,
    redirect = "",
    errorStatus = 0,
    errorBody: string | Buffer = "",
    errorEncoding: string | undefined,
    errorLength: number | undefined,
    holdError = false,
    retryAfter: string | undefined,
    block: (() => void) | undefined;
  return {
    files,
    hits,
    set corrupt(value: boolean) {
      corrupt = value;
    },
    set corruptAsset(value: boolean) {
      corruptAsset = value;
    },
    set holdReference(value: boolean) {
      holdReference = value;
    },
    set link(value: boolean) {
      link = value;
    },
    set responseError(value: {
      status: number;
      body: string | Buffer;
      encoding?: string;
      contentLength?: number;
      hold?: boolean;
      retryAfter?: string;
    }) {
      errorStatus = value.status;
      errorBody = value.body;
      errorEncoding = value.encoding;
      errorLength = value.contentLength;
      holdError = value.hold === true;
      retryAfter = value.retryAfter;
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
      if (errorStatus) {
        if (errorLength !== undefined) {
          res.setHeader("Content-Length", errorLength);
          res.setHeader("Connection", "close");
        }
        if (errorEncoding) res.setHeader("Content-Encoding", errorEncoding);
        res.writeHead(
          errorStatus,
          retryAfter ? { "Retry-After": retryAfter } : {},
        );
        if (holdError) res.flushHeaders();
        else res.end(errorBody);
        return;
      }
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
        if (
          ![skillCommit, "b".repeat(40), "c".repeat(40)].includes(treeSha ?? "")
        ) {
          res.writeHead(422);
          res.end(
            JSON.stringify({
              message:
                "Invalid object requested. SHA must identify a commit or a tree.",
              status: "422",
            }),
          );
          return;
        }
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
        const entry = [...files].find(
          ([, bytes]) => sha(bytes) === url.pathname.split("/").at(-1),
        );
        const bytes = entry?.[1];
        if (holdReference && entry?.[0].includes("references/")) return;
        if (bytes) {
          res.end(
            JSON.stringify({
              encoding: "base64",
              content: (corrupt ||
              (corruptAsset && entry?.[0].includes("assets/"))
                ? Buffer.from("corrupt")
                : bytes
              ).toString("base64"),
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
