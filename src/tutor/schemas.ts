// JSON schemas for structured output, and validators for the parsed results.

import type { RubricCriterion, TaskType } from "../types";

const LISTED_TYPES: readonly string[] = [
  "define", "predict-output", "explain", "implement",
  "debug", "review", "compare-designs", "design-build",
];

const CODE_TYPES: readonly string[] = ["implement", "debug"];

const NODE_TEST_IMPORT = /^\s*import\s[^;]*\bfrom\s+["']node:test["']/m;
const SOLUTION_IMPORT = /^\s*import\s[^;]*\bfrom\s+["']\.\/solution\.ts["']/m;
const ASSERTION = /\bassert(\.\w+)*\s*\(/;

export const TASK_SCHEMA = {
  type: "object",
  properties: {
    taskType: { type: "string" },
    prompt: { type: "string" },
    starterCode: { anyOf: [{ type: "string" }, { type: "null" }] },
    rubric: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, statement: { type: "string" } },
        required: ["id", "statement"],
        additionalProperties: false,
      },
    },
    hiddenTests: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
  required: ["taskType", "prompt", "starterCode", "rubric", "hiddenTests"],
  additionalProperties: false,
} as const;

export const TEXT_SCHEMA = (field: string) => ({
  type: "object",
  properties: { [field]: { type: "string" } },
  required: [field],
  additionalProperties: false,
});

export const CLARIFY_SCHEMA = {
  type: "object",
  properties: {
    seeksSolutionHelp: { type: "boolean" },
    answer: { type: "string" },
  },
  required: ["seeksSolutionHelp", "answer"],
  additionalProperties: false,
} as const;

export function claimsSchema(conceptIds: string[]) {
  if (conceptIds.length === 0) throw new Error("tutor: claims schema needs at least one concept id");
  return {
    type: "object",
    properties: {
      claims: {
        type: "array",
        items: {
          type: "object",
          properties: {
            conceptId: { type: "string", enum: conceptIds },
            statement: { type: "string" },
          },
          required: ["conceptId", "statement"],
          additionalProperties: false,
        },
      },
    },
    required: ["claims"],
    additionalProperties: false,
  };
}

export interface ParsedTask {
  taskType: TaskType;
  prompt: string;
  starterCode: string | null;
  rubric: RubricCriterion[];
  hiddenTests: string | null;
}

export interface ParsedClaim {
  conceptId: string;
  statement: string;
}

export interface ParsedClarification {
  seeksSolutionHelp: boolean;
  answer: string;
}

function fail(what: string, value: unknown): never {
  throw new Error(`tutor: invalid ${what}: ${JSON.stringify(value)?.slice(0, 500)}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function nonEmpty(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

export function isTaskType(v: unknown): v is TaskType {
  if (typeof v !== "string") return false;
  return LISTED_TYPES.includes(v) || /^custom:\S.*$/.test(v);
}

export function parseTask(raw: unknown): ParsedTask {
  if (!isRecord(raw)) fail("task", raw);
  const { taskType, prompt, starterCode, rubric, hiddenTests } = raw;

  if (!isTaskType(taskType)) fail("taskType", taskType);
  if (!nonEmpty(prompt)) fail("prompt", prompt);
  if (starterCode !== null && typeof starterCode !== "string") fail("starterCode", starterCode);
  if (hiddenTests !== null && typeof hiddenTests !== "string") fail("hiddenTests", hiddenTests);

  if (!Array.isArray(rubric) || rubric.length < 2 || rubric.length > 5) fail("rubric (needs 2 to 5 criteria)", rubric);
  const ids = new Set<string>();
  for (const c of rubric) {
    if (!isRecord(c) || !nonEmpty(c.id) || !nonEmpty(c.statement)) fail("rubric criterion", c);
    if (ids.has(c.id)) fail("duplicate rubric id", c.id);
    ids.add(c.id);
  }
  const criteria: RubricCriterion[] = rubric.map((c) => ({ id: c.id, statement: c.statement }));

  // Code tasks have tests and starter code. Prose tasks have neither.
  if (CODE_TYPES.includes(taskType) && hiddenTests === null) fail(`hiddenTests (${taskType} needs tests)`, hiddenTests);
  if ((hiddenTests === null) !== (starterCode === null)) {
    fail("task (hiddenTests and starterCode must both be set or both be null)", { hiddenTests, starterCode });
  }
  if (hiddenTests !== null) {
    if (!NODE_TEST_IMPORT.test(hiddenTests)) fail("hiddenTests (must import from node:test)", hiddenTests);
    if (!SOLUTION_IMPORT.test(hiddenTests)) fail("hiddenTests (must import from ./solution.ts)", hiddenTests);
  }

  checkNoLeaks(prompt, starterCode, criteria, hiddenTests);
  return { taskType, prompt, starterCode, rubric: criteria, hiddenTests };
}

// Rejects a task whose visible text contains a rubric statement or an assertion line from the tests.
function checkNoLeaks(prompt: string, starterCode: string | null, rubric: RubricCriterion[], hiddenTests: string | null) {
  const visible = `${prompt}\n${starterCode ?? ""}`;

  for (const c of rubric) {
    if (visible.includes(c.statement.trim())) fail("task (visible text contains a rubric statement)", c.statement);
  }
  for (const line of (hiddenTests ?? "").split("\n")) {
    const t = line.trim();
    if (ASSERTION.test(t) && visible.includes(t)) fail("task (visible text contains a test assertion)", t);
  }
}

export function parseText(raw: unknown, field: string): string {
  if (!isRecord(raw) || !nonEmpty(raw[field])) fail(field, raw);
  return raw[field];
}

export function parseClarification(raw: unknown): ParsedClarification {
  if (!isRecord(raw) || typeof raw.seeksSolutionHelp !== "boolean" || typeof raw.answer !== "string") {
    fail("clarification", raw);
  }
  if (!raw.seeksSolutionHelp && !nonEmpty(raw.answer)) fail("clarification answer", raw);
  return { seeksSolutionHelp: raw.seeksSolutionHelp, answer: raw.answer };
}

export function parseClaims(raw: unknown): ParsedClaim[] {
  if (!isRecord(raw) || !Array.isArray(raw.claims)) fail("claims", raw);
  return raw.claims.map((c: unknown) => {
    if (!isRecord(c) || typeof c.conceptId !== "string" || !nonEmpty(c.statement)) fail("claim", c);
    return { conceptId: c.conceptId, statement: c.statement };
  });
}
