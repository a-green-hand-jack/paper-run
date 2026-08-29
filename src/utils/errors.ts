/**
 * Error types for paper-run.
 *
 * Every error carries an exit code so the CLI can translate a thrown error
 * into a meaningful process exit status:
 *   0 = success
 *   1 = generic error
 *   2 = blocked (e.g. unusable materials, hard stop)
 *   3 = interrupted (Ctrl+C)
 */

export const EXIT_CODES = {
  SUCCESS: 0,
  ERROR: 1,
  BLOCKED: 2,
  INTERRUPTED: 3,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

/** Base class for all paper-run errors. */
export class PaperRunError extends Error {
  readonly exitCode: ExitCode;
  /** Optional actionable guidance shown to the user after the message. */
  readonly hint?: string;

  constructor(message: string, opts?: { exitCode?: ExitCode; hint?: string; cause?: unknown }) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = new.target.name;
    this.exitCode = opts?.exitCode ?? EXIT_CODES.ERROR;
    if (opts?.hint !== undefined) this.hint = opts.hint;
  }
}

/** The current directory is not a paper-run project. */
export class NotAProjectError extends PaperRunError {
  constructor(searchedFrom: string) {
    super(`Not a paper-run project (searched upward from ${searchedFrom}).`, {
      hint: "Run `paper-run init <directory> --brief <path>` to create one.",
    });
  }
}

/** Target directory already has content and must not be overwritten. */
export class DirectoryNotEmptyError extends PaperRunError {
  constructor(dir: string) {
    super(`Directory is not empty: ${dir}`, {
      hint: "paper-run init never overwrites an existing repository. Choose an empty directory, or use the adoption path for an existing paper repo.",
    });
  }
}

/** A required external tool is missing or unusable. */
export class MissingDependencyError extends PaperRunError {
  constructor(tool: string, hint: string) {
    super(`Required tool not available: ${tool}`, { hint });
  }
}

/** State file failed schema validation. */
export class StateSchemaError extends PaperRunError {
  constructor(file: string, detail: string) {
    super(`Invalid state file ${file}: ${detail}`, {
      hint: "The file may have been written by a different paper-run version or edited by hand.",
    });
  }
}

/** A stage's output failed validation and could not be remediated. */
export class StageValidationError extends PaperRunError {
  readonly stageId: string;
  readonly failures: string[];

  constructor(stageId: string, failures: string[]) {
    super(`Stage "${stageId}" failed validation:\n${failures.map((f) => `  - ${f}`).join("\n")}`, {
      exitCode: EXIT_CODES.BLOCKED,
    });
    this.stageId = stageId;
    this.failures = failures;
  }
}

/** The pipeline hit a hard stop (e.g. unusable materials). */
export class PipelineBlockedError extends PaperRunError {
  readonly stageId: string;
  readonly reason: string;

  constructor(stageId: string, reason: string) {
    super(`Pipeline blocked at stage "${stageId}": ${reason}`, {
      exitCode: EXIT_CODES.BLOCKED,
    });
    this.stageId = stageId;
    this.reason = reason;
  }
}

/** A stage exceeded its time budget. */
export class StageTimeoutError extends PaperRunError {
  readonly stageId: string;

  constructor(stageId: string, timeoutMs: number) {
    super(`Stage "${stageId}" timed out after ${Math.round(timeoutMs / 1000)}s.`, {
      hint: "Re-run `paper-run start` to resume; the stage will be retried from its last checkpoint.",
    });
    this.stageId = stageId;
  }
}

/** Another paper-run process holds the project. */
export class ConcurrentRunError extends PaperRunError {
  constructor(pid: number) {
    super(`Another paper-run instance is active (PID ${pid}).`, {
      hint: "Wait for it to finish, or stop it before starting a new run.",
    });
  }
}

/** Something went wrong talking to the OpenCode server. */
export class OpencodeError extends PaperRunError {
  constructor(message: string, opts?: { hint?: string; cause?: unknown }) {
    super(`OpenCode: ${message}`, opts);
  }
}

/** The user interrupted the run. */
export class InterruptedError extends PaperRunError {
  constructor() {
    super("Interrupted.", { exitCode: EXIT_CODES.INTERRUPTED });
  }
}

/** Narrow an unknown thrown value to a readable message. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return String(err);
}
