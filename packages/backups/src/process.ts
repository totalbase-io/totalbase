import { spawn, type ChildProcessByStdio } from "node:child_process";
import { join } from "node:path";
import { Transform, type Readable, type Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

/** What a failed command said last - its stderr's tail, enough to tell why without flooding a row. */
const STDERR_TAIL = 1500;

/** A PostgreSQL client tool: in `pgBinDir` when given (the image's `TOTALBASE_PG_BIN`), else on PATH. */
export function pgTool(name: "pg_dump" | "pg_restore" | "psql", pgBinDir?: string): string {
  return pgBinDir ? join(pgBinDir, name) : name;
}

/** A command and its arguments, for `pipeCommands`. */
export interface Command {
  command: string;
  args: string[];
}

/**
 * Runs `from | to`, both with only `env` (and PATH), dropping from the stream the first line equal to each of
 * `dropLines` (whole lines, as written). Rejects with the first failed command's own words, as `runCommand`.
 */
export function pipeCommands(from: Command, to: Command, env: Record<string, string>, dropLines: string[] = []): Promise<void> {
  const childEnv = { PATH: process.env["PATH"] ?? "/usr/bin:/bin", ...env };
  const watch = (command: string, child: ChildProcessByStdio<Writable | null, Readable | null, Readable>) =>
    new Promise<void>((resolve, reject) => {
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-STDERR_TAIL);
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        reject(new Error(error.code === "ENOENT" ? `${command} is not installed - the TotalBase image carries it; elsewhere install PostgreSQL's client tools.` : `${command} could not start: ${error.message}`));
      });
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${command.split("/").pop()} failed (exit ${code}): ${stderr.trim() || "no message"}`));
      });
    });
  const source = spawn(from.command, from.args, { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  const sink = spawn(to.command, to.args, { env: childEnv, stdio: ["pipe", "ignore", "pipe"] });
  const pending = new Set(dropLines);
  // Lines are read as text only until every line to drop is gone (they open the stream); then bytes pass as they are.
  const decoder = new StringDecoder("utf8");
  let carry = "";
  const filter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      if (pending.size === 0) return done(null, chunk);
      const text = carry + decoder.write(chunk);
      const end = text.lastIndexOf("\n") + 1;
      carry = text.slice(end);
      const lines = text.slice(0, end).split("\n").slice(0, -1).filter((line) => !pending.delete(line));
      let out = lines.length ? lines.join("\n") + "\n" : "";
      if (pending.size === 0) {
        out += carry + decoder.end();
        carry = "";
      }
      done(null, out);
    },
    flush(done) {
      done(null, carry + decoder.end());
    },
  });
  // A sink that stops early (psql on an error) closes its stdin: the source's own exit reports why.
  sink.stdin.on("error", () => {});
  source.stdout.pipe(filter).pipe(sink.stdin);
  return Promise.all([watch(from.command, source), watch(to.command, sink)]).then(() => undefined);
}

/**
 * Runs `command` to completion with only `env` (and PATH) in its environment - a password reaches it there,
 * never on its command line. Rejects with the command's own words: its stderr's tail, or why it couldn't start.
 */
export function runCommand(command: string, args: string[], env: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", ...env }, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      reject(new Error(error.code === "ENOENT" ? `${command} is not installed - the TotalBase image carries it; elsewhere install PostgreSQL's client tools.` : `${command} could not start: ${error.message}`));
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command.split("/").pop()} failed (exit ${code}): ${stderr.trim() || "no message"}`));
    });
  });
}
