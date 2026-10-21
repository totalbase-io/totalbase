import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pipeCommands } from "./process.js";

describe("pipeCommands", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "tb-pipe-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("drops the first line equal to each given one, even split across chunks, and passes the rest as written", async () => {
    const out = join(dir, "out.txt");
    // The source writes in pieces with pauses, so the line to drop arrives in several chunks.
    const source = `printf 'SET a = 1;\\nSET transac'; sleep 0.1; printf 'tion_timeout = 0;\\nSET b = 2;\\n'; sleep 0.1; printf 'ñandú\\nSET transaction_timeout = 0;\\nlast'`;
    await pipeCommands({ command: "sh", args: ["-c", source] }, { command: "sh", args: ["-c", `cat > ${out}`] }, {}, ["SET transaction_timeout = 0;"]);
    expect(await readFile(out, "utf8")).toBe("SET a = 1;\nSET b = 2;\nñandú\nSET transaction_timeout = 0;\nlast");
  });

  it("rejects with the failing command's own words", async () => {
    await expect(pipeCommands({ command: "sh", args: ["-c", "echo hi"] }, { command: "sh", args: ["-c", "cat >/dev/null; echo broken >&2; exit 3"] }, {})).rejects.toThrow("sh failed (exit 3): broken");
  });
});
