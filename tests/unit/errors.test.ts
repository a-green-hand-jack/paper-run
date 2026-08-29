import { describe, it, expect } from "vitest";
import { PaperRunError, EXIT_CODES } from "../../src/utils/errors.js";
import {
  NotAProjectError,
  DirectoryNotEmptyError,
  MissingDependencyError,
  StateSchemaError,
  StageValidationError,
  PipelineBlockedError,
  StageTimeoutError,
  ConcurrentRunError,
  OpencodeError,
  InterruptedError,
  errorMessage,
} from "../../src/utils/errors.js";

describe("PaperRunError", () => {
  it("defaults to exit code 1", () => {
    const err = new PaperRunError("test");
    expect(err.exitCode).toBe(EXIT_CODES.ERROR);
    expect(err.message).toBe("test");
    expect(err.name).toBe("PaperRunError");
  });

  it("accepts a custom exit code and hint", () => {
    const err = new PaperRunError("fail", {
      exitCode: EXIT_CODES.BLOCKED,
      hint: "try again",
    });
    expect(err.exitCode).toBe(EXIT_CODES.BLOCKED);
    expect(err.hint).toBe("try again");
  });
});

describe("specific error classes", () => {
  it("NotAProjectError", () => {
    const err = new NotAProjectError("/some/path");
    expect(err.message).toContain("/some/path");
    expect(err.hint).toContain("paper-run init");
    expect(err.exitCode).toBe(EXIT_CODES.ERROR);
  });

  it("DirectoryNotEmptyError", () => {
    const err = new DirectoryNotEmptyError("/occupied");
    expect(err.message).toContain("/occupied");
    expect(err.hint).toContain("adoption");
  });

  it("MissingDependencyError", () => {
    const err = new MissingDependencyError("python3", "apt install python3");
    expect(err.message).toContain("python3");
    expect(err.hint).toContain("apt install");
  });

  it("StateSchemaError", () => {
    const err = new StateSchemaError("run.json", "schema_version mismatch");
    expect(err.message).toContain("run.json");
    expect(err.message).toContain("schema_version mismatch");
  });

  it("StageValidationError uses BLOCKED exit code", () => {
    const err = new StageValidationError("drafting", ["check-a failed", "check-b failed"]);
    expect(err.exitCode).toBe(EXIT_CODES.BLOCKED);
    expect(err.stageId).toBe("drafting");
    expect(err.failures).toHaveLength(2);
  });

  it("PipelineBlockedError", () => {
    const err = new PipelineBlockedError("material_assessment", "unusable");
    expect(err.exitCode).toBe(EXIT_CODES.BLOCKED);
    expect(err.stageId).toBe("material_assessment");
    expect(err.reason).toBe("unusable");
  });

  it("StageTimeoutError", () => {
    const err = new StageTimeoutError("canonical_drafting", 600_000);
    expect(err.stageId).toBe("canonical_drafting");
    expect(err.message).toContain("600s");
  });

  it("ConcurrentRunError", () => {
    const err = new ConcurrentRunError(12345);
    expect(err.message).toContain("12345");
  });

  it("OpencodeError", () => {
    const err = new OpencodeError("connection refused");
    expect(err.message).toContain("OpenCode");
    expect(err.message).toContain("connection refused");
  });

  it("InterruptedError uses exit code 3", () => {
    const err = new InterruptedError();
    expect(err.exitCode).toBe(EXIT_CODES.INTERRUPTED);
  });
});

describe("errorMessage", () => {
  it("extracts message from Error", () => {
    expect(errorMessage(new Error("hello"))).toBe("hello");
  });

  it("passes through strings", () => {
    expect(errorMessage("raw string")).toBe("raw string");
  });

  it("stringifies other values", () => {
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(null)).toBe("null");
  });
});
