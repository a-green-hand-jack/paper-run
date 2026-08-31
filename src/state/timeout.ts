import { StageTimeoutMultiplierSchema } from "./schema.js";
import { PaperRunError } from "../utils/errors.js";

export const DEFAULT_STAGE_TIMEOUT_MULTIPLIER = 1;

export function parseStageTimeoutMultiplier(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  const result = StageTimeoutMultiplierSchema.safeParse(parsed);
  if (!result.success) {
    throw new PaperRunError("Invalid stage timeout multiplier.", {
      hint: "Pass a finite number greater than 0 and no more than 100, for example `--stage-timeout-multiplier 2`.",
    });
  }
  return result.data;
}

export function resolveStageTimeoutMultiplier(
  configured: number | undefined,
  requested: unknown,
  environmentValue?: string,
): number {
  const override = requested !== undefined
    ? parseStageTimeoutMultiplier(requested)
    : environmentValue !== undefined
      ? parseStageTimeoutMultiplier(environmentValue)
      : undefined;
  if (configured !== undefined && override !== undefined && configured !== override) {
    throw new PaperRunError(
      `This run is locked to a stage timeout multiplier of ${configured}x, not ${override}x.`,
      { hint: "Resume without the override, or initialize a new run." },
    );
  }
  return configured ?? override ?? DEFAULT_STAGE_TIMEOUT_MULTIPLIER;
}
