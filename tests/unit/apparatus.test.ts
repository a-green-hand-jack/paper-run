/**
 * The apparatus channel.
 *
 * On PaperWrite-Bench pwb-0011 the manuscript's experimental section cited
 * three works, all three of them row labels of the supplied results table,
 * against a ground truth that cites twenty-one there. The benchmarks, the
 * evaluation harness and the serving engine were never named at all — they
 * live in the supplied code, which the run read and did not write from,
 * because the plan had scoped the section to the tables.
 *
 * These tests hold the two halves of the fix: the plan must enumerate the
 * apparatus, and the manuscript must cite what the enumeration names.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  readSetupInventory,
  excusedApparatus,
  inventoryIssues,
  uncitedApparatus,
  describeInventory,
} from "../../src/pipeline/apparatus.js";
import { validateStage } from "../../src/pipeline/validators.js";
import { STAGES } from "../../src/pipeline/stages.js";
import type { Stage, Validator } from "../../src/pipeline/stages.js";
import { PAPER_RUN_DIR } from "../../src/utils/constants.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "paper-run-apparatus-"));
  mkdirSync(join(tmpDir, "paper", "sections"), { recursive: true });
  mkdirSync(join(tmpDir, "materials"), { recursive: true });
  mkdirSync(join(tmpDir, PAPER_RUN_DIR), { recursive: true });
  writeFileSync(join(tmpDir, "materials", "run_benchmark.py"), "TASKS = ['arc_challenge']\n");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const INVENTORY = [
  "# Experiment Contract",
  "",
  "## Experimental setup inventory",
  "",
  "| Entity | Kind | Evidence | Bib key |",
  "|---|---|---|---|",
  "| MMLU | benchmark | materials/run_benchmark.py:14 | hendrycks2020measuring |",
  "| HellaSwag | benchmark | materials/run_benchmark.py:22 | zellers2019hellaswag |",
  "| vLLM | serving engine | materials/vllm_runner.py | vllm |",
  "| WikiText | calibration set | materials/calibration.sh | — |",
  "",
  "## Experiment overview",
  "",
  "Not this section.",
  "",
].join("\n");

function experiments(body: string): void {
  writeFileSync(join(tmpDir, "EXPERIMENTS.md"), body);
}

function bib(keys: string[]): void {
  writeFileSync(
    join(tmpDir, "paper", "refs.bib"),
    keys.map((key) => `@article{${key},\n  title = {Work},\n  year = {2026}\n}`).join("\n\n"),
  );
}

function manuscript(body: string): void {
  writeFileSync(join(tmpDir, "paper", "sections", "06_exp.tex"), body);
  writeFileSync(
    join(tmpDir, "paper", "main.tex"),
    ["\\documentclass{article}", "\\begin{document}", "\\input{sections/06_exp}", "\\end{document}", ""].join("\n"),
  );
}

function stageWith(validator: Validator): Stage {
  return { ...STAGES.revision, validators: [validator] };
}

describe("reading the inventory", () => {
  it("parses the table under its own heading and stops at the next one", () => {
    experiments(INVENTORY);
    const entities = readSetupInventory(tmpDir);

    expect(entities.map((e) => e.name)).toEqual(["MMLU", "HellaSwag", "vLLM", "WikiText"]);
    expect(entities[0]!.kind).toBe("benchmark");
    expect(entities[0]!.evidence).toBe("materials/run_benchmark.py:14");
    expect(entities[0]!.bibKey).toBe("hendrycks2020measuring");
  });

  it("reads an em dash, an n/a, or an empty cell as no bibliography key", () => {
    experiments(INVENTORY);
    expect(readSetupInventory(tmpDir).at(-1)!.bibKey).toBeNull();
  });

  it("locates columns by name rather than position", () => {
    experiments([
      "## Experimental setup inventory",
      "",
      "| Kind | Bib key | Entity | Evidence |",
      "|---|---|---|---|",
      "| benchmark | `hendrycks2020measuring` | MMLU | materials/run_benchmark.py |",
      "",
    ].join("\n"));

    const [entity] = readSetupInventory(tmpDir);
    expect(entity!.name).toBe("MMLU");
    expect(entity!.bibKey).toBe("hendrycks2020measuring");
    expect(entity!.kind).toBe("benchmark");
  });

  it("returns nothing when the section is absent", () => {
    experiments("# Experiment Contract\n\n## Experiment overview\n\nNo inventory here.\n");
    expect(readSetupInventory(tmpDir)).toEqual([]);
  });
});

describe("inventoryIssues", () => {
  it("rejects a bibliography key that does not exist", () => {
    const entities = [
      { name: "MMLU", kind: "benchmark", evidence: "x.py", bibKey: "invented2026" },
    ];
    const issues = inventoryIssues(entities, ["hendrycks2020measuring"], 1);

    expect(issues.join(" ")).toContain("invented2026");
    expect(issues.join(" ")).toContain("do not exist");
  });

  it("requires an evidence path for every entity", () => {
    const entities = [{ name: "MMLU", kind: "benchmark", evidence: "", bibKey: null }];
    expect(inventoryIssues(entities, [], 1).join(" ")).toContain("no evidence path");
  });

  it("accepts a complete inventory", () => {
    experiments(INVENTORY);
    const entities = readSetupInventory(tmpDir);
    const keys = ["hendrycks2020measuring", "zellers2019hellaswag", "vllm"];
    expect(inventoryIssues(entities, keys, 3)).toEqual([]);
  });
});

describe("uncitedApparatus", () => {
  const entities = [
    { name: "MMLU", kind: "benchmark", evidence: "x.py", bibKey: "hendrycks2020measuring" },
    { name: "vLLM", kind: "engine", evidence: "y.py", bibKey: "vllm" },
    { name: "WikiText", kind: "calibration", evidence: "z.sh", bibKey: null },
  ];
  const bibKeys = ["hendrycks2020measuring", "vllm"];

  it("owes nothing for an entity with no bibliography key", () => {
    const owed = uncitedApparatus(entities, ["hendrycks2020measuring", "vllm"], bibKeys, []);
    expect(owed).toEqual([]);
  });

  it("reports an enumerated benchmark the manuscript never cites", () => {
    const owed = uncitedApparatus(entities, ["vllm"], bibKeys, []);
    expect(owed.map((e) => e.name)).toEqual(["MMLU"]);
  });

  it("excuses an entity the plan recorded under PAPER.md ## Unresolved", () => {
    const owed = uncitedApparatus(entities, [], bibKeys, [
      "- MMLU results were not supplied; the utility table aggregates without a breakdown.",
      "- vLLM is named by the teaser asset only.",
    ]);
    expect(owed).toEqual([]);
  });
});

describe("the setup_inventory validator", () => {
  const validator: Validator = {
    type: "setup_inventory",
    minEntities: 3,
    required: true,
    message: "The experimental setup inventory is missing or unusable",
  };

  it("fails a plan that wrote no inventory", async () => {
    experiments("# Experiment Contract\n\n## Experiment overview\n\nnothing\n");
    const result = await validateStage(stageWith(validator), tmpDir);

    expect(result.passed).toBe(false);
    expect(result.checks[0]!.message).toContain("missing or holds no table");
  });

  it("passes a complete inventory", async () => {
    experiments(INVENTORY);
    bib(["hendrycks2020measuring", "zellers2019hellaswag", "vllm"]);
    const result = await validateStage(stageWith(validator), tmpDir);

    expect(result.passed).toBe(true);
  });

  it("stays silent for a project with no supplied materials", async () => {
    rmSync(join(tmpDir, "materials"), { recursive: true, force: true });
    const result = await validateStage(stageWith(validator), tmpDir);

    expect(result.passed).toBe(true);
  });
});

describe("the apparatus_cited validator", () => {
  const validator: Validator = {
    type: "apparatus_cited",
    required: true,
    message: "The manuscript does not cite the apparatus it says it used",
  };

  it("fails the pwb-0011 shape: a full bibliography, an experimental section citing only model cards", async () => {
    experiments(INVENTORY);
    bib(["hendrycks2020measuring", "zellers2019hellaswag", "vllm", "qwen2.5"]);
    manuscript(
      "\\section{Experiments}\nWe evaluate Qwen2.5-7B \\cite{qwen2.5} and report benchmark-average accuracy.\n",
    );

    const result = await validateStage(stageWith(validator), tmpDir);

    expect(result.passed).toBe(false);
    const message = result.checks[0]!.message ?? "";
    expect(message).toContain("MMLU");
    expect(message).toContain("HellaSwag");
    expect(message).toContain("vLLM");
  });

  it("passes once the section names and cites the apparatus", async () => {
    experiments(INVENTORY);
    bib(["hendrycks2020measuring", "zellers2019hellaswag", "vllm", "qwen2.5"]);
    manuscript(
      "\\section{Experiments}\nWe serve each checkpoint with vLLM \\cite{vllm} and report "
        + "accuracy on MMLU \\cite{hendrycks2020measuring} and HellaSwag \\cite{zellers2019hellaswag} "
        + "for Qwen2.5-7B \\cite{qwen2.5}.\n",
    );

    const result = await validateStage(stageWith(validator), tmpDir);
    expect(result.passed).toBe(true);
  });

  it("stays silent when no inventory was written", async () => {
    experiments("# Experiment Contract\n");
    bib(["a"]);
    manuscript("\\section{Experiments}\nNothing cited.\n");

    const result = await validateStage(stageWith(validator), tmpDir);
    expect(result.passed).toBe(true);
  });
});

describe("excusedApparatus", () => {
  it("reads the unresolved list", () => {
    writeFileSync(
      join(tmpDir, "PAPER.md"),
      ["# Paper", "", "## Unresolved", "", "- MMLU has no per-task breakdown.", "", "## Writing style", "", "x", ""].join("\n"),
    );
    expect(excusedApparatus(tmpDir).join(" ")).toContain("MMLU");
    expect(excusedApparatus(tmpDir).join(" ")).not.toContain("Writing style");
  });
});

describe("describeInventory", () => {
  it("renders one line per entity, marking the ones with no key", () => {
    experiments(INVENTORY);
    const lines = describeInventory(readSetupInventory(tmpDir));

    expect(lines[0]).toContain("MMLU");
    expect(lines[0]).toContain("hendrycks2020measuring");
    expect(lines.at(-1)).toContain("no bibliography key");
  });
});
