import { spawn } from "node:child_process";
import { join } from "node:path";

/** What a failed command said last - its stderr's tail, enough to tell why without flooding a row. */
const STDERR_TAIL = 1500;

/** A PostgreSQL client tool: in `pgBinDir` when given (the image's `TOTALBASE_PG_BIN`), else on PATH. */
export function pgTool(name: "pg_dump" | "pg_restore", pgBinDir?: string): string {
  return pgBinDir ? join(pgBinDir, name) : name;
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
