import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import logUpdate from "../../node_modules/ink/build/log-update.js";

/** Minimal VT screen for the cursor motions used by Ink's frame writer. */
class Screen {
  readonly lines = Array.from({ length: 5 }, () => Array(20).fill(" "));
  x = 0;
  y = 0;

  feed(data: string): void {
    for (let i = 0; i < data.length; ) {
      if (data[i] === "\x1b" && data[i + 1] === "[") {
        const match = /^\[([?\d;]*)([A-Za-z])/.exec(data.slice(i + 1));
        if (!match) throw new Error("Unsupported VT sequence");
        const numbers =
          match[1]?.replace(/^\?/, "").split(";").map(Number) ?? [];
        const amount = numbers[0] || 1;
        switch (match[2]) {
          case "H":
            this.y = Math.max(0, Math.min(4, amount - 1));
            this.x = Math.max(0, Math.min(19, (numbers[1] || 1) - 1));
            break;
          case "A":
            this.y = Math.max(0, this.y - amount);
            break;
          case "B":
            this.y = Math.min(4, this.y + amount);
            break;
          case "E":
            this.y = Math.min(4, this.y + amount);
            this.x = 0;
            break;
          case "F":
            this.y = Math.max(0, this.y - amount);
            this.x = 0;
            break;
          case "G":
            this.x = Math.max(0, Math.min(19, amount - 1));
            break;
          case "J":
            if (amount === 2) for (const line of this.lines) line.fill(" ");
            break;
          case "K":
            if (numbers[0] === 2) this.lines[this.y]?.fill(" ");
            else this.lines[this.y]?.fill(" ", this.x);
            break;
          case "h":
          case "l":
          case "m":
            break;
          default:
            throw new Error(`Unsupported VT command: ${match[2]}`);
        }
        i += 1 + match[0].length;
        continue;
      }
      if (data[i] === "\n") {
        this.y = Math.min(4, this.y + 1);
        this.x = 0;
      } else if (data[i] === "\r") {
        this.x = 0;
      } else if (this.x < 20) {
        const line = this.lines[this.y];
        const character = data[i];
        if (line && character) line[this.x++] = character;
      }
      i++;
    }
  }

  row(y: number): string {
    return this.lines[y]?.join("").trimEnd() ?? "";
  }
}

test("Windows incremental frame repairs a shifted console cursor without duplicating input", () => {
  if (process.platform !== "win32") return;
  const stream = new PassThrough() as PassThrough & { isTTY: boolean };
  stream.isTTY = true;
  const screen = new Screen();
  stream.on("data", (chunk: Buffer) => screen.feed(chunk.toString()));
  const render = logUpdate.create(stream, { incremental: true });

  render("HEAD\n\nINPUT\nHINT");
  expect(screen.row(2)).toBe("INPUT");
  expect(screen.row(3)).toBe("HINT");

  // A console mode change during startup can leave the host cursor one row
  // below the frame while Ink still believes it is on the last output row.
  screen.y = 4;
  screen.x = 0;
  render("HEAD\n\nDRAFT\nHINT");
  expect(screen.row(2)).toBe("DRAFT");
  expect(screen.row(3)).toBe("HINT");
  expect(screen.lines.flat().join("")).not.toContain("INPUT");
});
