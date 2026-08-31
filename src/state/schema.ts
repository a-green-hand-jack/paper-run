/**
 * Zod schemas for the `.paper-run/` state directory.
 *
 * Every file in `.paper-run/` has a corresponding schema here. State files
 * carry a `schema_version` field for forward-compatibility: the reader
 * validates the version and may apply migrations.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared enums
// ---------------------------------------------------------------------------

export const ModeSchema = z.enum(["autonomous", "collaborative"]);

export const StageStatusSchema = z.enum([
  "pending",
  "running",
  "validating",
  "gate_waiting",
  "approved",
  "blocked",
  "completed",
]);

export const GatePolicyAction = z.enum(["auto", "await_human", "skip"]);

export const MaterialVerdict = z.enum(["usable", "partial", "unusable"]);

export const StageTimeoutMultiplierSchema = z.number().finite().positive().max(100);

export const RunPlanSchema = z.object({
  profile: z.string().min(1),
  stages: z.array(z.string().min(1)).min(1),
  skipped: z.array(
    z.object({
      stage: z.string().min(1),
      reason: z.string().min(1),
    }),
  ),
});

export type RunPlan = z.infer<typeof RunPlanSchema>;

// ---------------------------------------------------------------------------
// run.json
// ---------------------------------------------------------------------------

export const RunStateSchema = z.object({
  schema_version: z.literal("paper-run-v1"),
  run_id: z.string().min(1),
  run_branch: z.string().min(1),
  mode: ModeSchema,
  current_stage: z.string().min(1),
  stage_status: StageStatusSchema,
  started_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  template_version: z.string().min(1),
  plan: RunPlanSchema.optional(),
  stage_timeout_multiplier: StageTimeoutMultiplierSchema.optional(),
  material_hash: z.string().optional(),
  session_id: z.string().optional(),
  server_port: z.number().int().positive().optional(),
  timeout_recovery: z
    .object({
      stage: z.string().min(1),
      files: z.record(z.string(), z.string().regex(/^(sha256:[0-9a-f]{64}|missing)$/)),
    })
    .optional(),
  error: z
    .object({
      stage: z.string(),
      message: z.string(),
      at: z.string().datetime(),
    })
    .optional(),
});

export type RunState = z.infer<typeof RunStateSchema>;

// ---------------------------------------------------------------------------
// gate-policy.json
// ---------------------------------------------------------------------------

export const GatePolicySchema = z.object({
  schema_version: z.literal("paper-run-gate-policy-v1"),
  mode: ModeSchema,
  gates: z.record(
    z.string(),
    z.object({
      policy: GatePolicyAction,
    }),
  ),
});

export type GatePolicy = z.infer<typeof GatePolicySchema>;

// ---------------------------------------------------------------------------
// stage-history.json
// ---------------------------------------------------------------------------

const CheckResultSchema = z.object({
  name: z.string(),
  passed: z.boolean(),
  message: z.string().optional(),
});

const StageRecordSchema = z.object({
  stage_id: z.string(),
  status: z.enum(["completed", "blocked", "skipped"]),
  started_at: z.string().datetime(),
  completed_at: z.string().datetime(),
  commit_sha: z.string().min(1),
  validation_result: z
    .object({
      passed: z.boolean(),
      checks: z.array(CheckResultSchema),
    })
    .optional(),
  material_verdict: MaterialVerdict.optional(),
  skip_reason: z.string().min(1).optional(),
});

export type StageRecord = z.infer<typeof StageRecordSchema>;

export const StageHistorySchema = z.object({
  schema_version: z.literal("paper-run-stage-history-v1"),
  stages: z.array(StageRecordSchema),
});

export type StageHistory = z.infer<typeof StageHistorySchema>;

// ---------------------------------------------------------------------------
// performance.json (gitignored runtime telemetry)
// ---------------------------------------------------------------------------

const UsageSchema = z.object({
  model_calls: z.number().int().nonnegative(),
  input_tokens: z.number().nonnegative(),
  output_tokens: z.number().nonnegative(),
  reasoning_tokens: z.number().nonnegative(),
  cache_read_tokens: z.number().nonnegative(),
  cache_write_tokens: z.number().nonnegative(),
  cost: z.number().nonnegative(),
});

const AttemptPerformanceSchema = z.object({
  stage_id: z.string(),
  attempt: z.number().int().nonnegative(),
  session_id: z.string(),
  started_at: z.string().datetime(),
  completed_at: z.string().datetime(),
  turn_ms: z.number().int().nonnegative(),
  validator_ms: z.number().int().nonnegative().optional(),
  checkpoint_ms: z.number().int().nonnegative().optional(),
  usage: UsageSchema,
  transcript_messages: z.number().int().nonnegative().optional(),
  telemetry_available: z.boolean(),
});

export const PerformanceSchema = z.object({
  schema_version: z.literal("paper-run-performance-v1"),
  run_id: z.string().min(1),
  session_id: z.string().min(1),
  started_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  attempts: z.array(AttemptPerformanceSchema),
});

export type Performance = z.infer<typeof PerformanceSchema>;
export type AttemptPerformance = z.infer<typeof AttemptPerformanceSchema>;

const PublicationVariantStatusSchema = z.enum(["pending", "running", "completed", "failed", "timed_out", "canceled"]);
const PublicationVariantSchema = z.object({
  name: z.string().min(1),
  output: z.string().min(1),
  command: z.array(z.string()),
  status: PublicationVariantStatusSchema,
  started_at: z.string().datetime().optional(),
  completed_at: z.string().datetime().optional(),
  error: z.string().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  output_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
});

export const PublicationSchema = z.object({
  schema_version: z.literal("paper-run-publication-v1"),
  updated_at: z.string().datetime(),
  variants: z.array(PublicationVariantSchema),
});

export type Publication = z.infer<typeof PublicationSchema>;

// ---------------------------------------------------------------------------
// session.json (gitignored — ephemeral process state)
// ---------------------------------------------------------------------------

export const SessionStateSchema = z.object({
  schema_version: z.literal("paper-run-session-v1"),
  server_url: z.string().url(),
  session_id: z.string().min(1),
  created_at: z.string().datetime(),
  pid: z.number().int().positive().optional(),
});

export type SessionState = z.infer<typeof SessionStateSchema>;

// ---------------------------------------------------------------------------
// assessment.json (written by agent, validated by controller)
// ---------------------------------------------------------------------------

const CriterionSchema = z.object({
  rating: z.enum(["sufficient", "partial", "absent"]),
  evidence: z.string(),
});

export const AssessmentSchema = z.object({
  schema_version: z.literal("paper-run-assessment-v1"),
  verdict: MaterialVerdict,
  criteria: z.record(z.string(), CriterionSchema),
  summary: z.string(),
  missing_for_usable: z.array(z.string()),
  can_proceed_with: z.array(z.string()),
  blockers: z.array(z.string()),
  assessed_files: z.array(z.string()),
  assessed_at: z.string().datetime(),
});

export type Assessment = z.infer<typeof AssessmentSchema>;
