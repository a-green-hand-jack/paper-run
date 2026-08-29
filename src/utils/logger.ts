/**
 * Structured console output for the CLI.
 *
 * The controller runs alongside the OpenCode TUI, which owns the terminal.
 * Everything here writes to stderr so it never corrupts stdout, which is
 * reserved for machine-readable command output (e.g. `paper-run status --json`).
 */

import { appendFileSync } from "node:fs";

import chalk from "chalk";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let currentLevel: LogLevel = process.env.PAPER_RUN_DEBUG ? "debug" : "info";

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

function enabled(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel];
}

/**
 * A file every line is also appended to, when one is set.
 *
 * A long `--headless` run writes to stderr, which is easy to lose: piped
 * output is buffered and disappears if the process is killed, and a run
 * started in the background may have nowhere to write at all. Then a run that
 * failed overnight leaves no trace of where it got to. Mirroring to a file
 * inside the project means the transcript survives whatever happened to the
 * terminal.
 */
let mirrorPath: string | null = null;

/** Start mirroring log output to `path`, in addition to stderr. */
export function setLogFile(path: string | null): void {
  mirrorPath = path;
}

function write(line: string): void {
  process.stderr.write(`${line}\n`);

  if (mirrorPath) {
    try {
      // Strip ANSI colours: the file is for reading later, not for a terminal.
      const plain = line.replace(/\[[0-9;]*m/g, "");
      appendFileSync(mirrorPath, `${new Date().toISOString()} ${plain}\n`);
    } catch {
      // A log that cannot be written must never take the run down with it.
    }
  }
}

export const log = {
  debug(message: string): void {
    if (enabled("debug")) write(chalk.dim(`  ${message}`));
  },

  info(message: string): void {
    if (enabled("info")) write(message);
  },

  step(message: string): void {
    if (enabled("info")) write(`${chalk.cyan("→")} ${message}`);
  },

  success(message: string): void {
    if (enabled("info")) write(`${chalk.green("✓")} ${message}`);
  },

  warn(message: string): void {
    if (enabled("warn")) write(`${chalk.yellow("!")} ${message}`);
  },

  error(message: string): void {
    if (enabled("error")) write(`${chalk.red("✗")} ${message}`);
  },

  /** Actionable follow-up shown under an error. */
  hint(message: string): void {
    if (enabled("error")) write(chalk.dim(`  ${message}`));
  },

  /** A blank separator line. */
  blank(): void {
    if (enabled("info")) write("");
  },
};

/** Print a labeled key/value block, aligned on the longest key. */
export function printKeyValues(rows: Array<[string, string]>): void {
  const width = rows.reduce((max, [key]) => Math.max(max, key.length), 0);
  for (const [key, value] of rows) {
    write(`${chalk.dim(key.padEnd(width))}  ${value}`);
  }
}
