import type { Config } from "../config";
import type { Concept, Grade, Task } from "../types";
import { JevJudge } from "./jev";
import { candidateConcepts } from "./judge";
import type { Judge, Verdict } from "./judge";
import { anthropicAsk, LlmJudge } from "./llm";
import { NodeTestRunner } from "./runner";
import type { Runner } from "./runner";

export interface Grader {
  grade(task: Task, answer: string, concepts: Concept[]): Promise<Grade>;
}

type GraderConfig = Pick<Config, "grader" | "passThreshold" | "uncertainBand" | "runnerTimeoutMs">;

export interface GraderDeps {
  runner: Runner;
  jev: Judge | null;                   // required when config.grader is "jev"
  llm: Judge;
  config: GraderConfig;
}

// SPEC §6.4: tests, then rubric, then LLM escalation for uncertain criteria.
export class CompositeGrader implements Grader {
  constructor(private readonly deps: GraderDeps) {}

  async grade(task: Task, answer: string, concepts: Concept[]): Promise<Grade> {
    const { runner, llm, config } = this.deps;
    validate(task);

    const tests = task.hiddenTests
      ? await runner.run(answer, task.hiddenTests, config.runnerTimeoutMs)
      : null;
    const testsPassed = !tests || (tests.total > 0 && tests.passed === tests.total);

    if (task.rubric.length === 0 && testsPassed) {
      return { passed: true, gradedBy: "tests", graderConfidence: 1, criteria: [], tests, failedConceptId: null };
    }

    const input = {
      prompt: task.prompt,
      rubric: task.rubric,
      answer,
      testOutput: tests?.output ?? null,
      candidates: candidateConcepts(task.conceptId, concepts),
    };

    let gradedBy: Grade["gradedBy"] = config.grader;
    let verdict: Verdict = await this.primary().judge(input);

    const [lo, hi] = config.uncertainBand;
    if (gradedBy === "jev" && verdict.criteria.some((c) => c.pYes >= lo && c.pYes <= hi)) {
      const escalated = await llm.judge(input);
      verdict = { criteria: escalated.criteria, failedConceptId: verdict.failedConceptId };
      gradedBy = "llm";
    }

    const { criteria } = verdict;
    const passed = testsPassed && criteria.every((c) => c.pYes >= config.passThreshold);
    const graderConfidence = criteria.length
      ? Math.min(...criteria.map((c) => Math.max(c.pYes, 1 - c.pYes)))
      : 1;

    return {
      passed,
      gradedBy: criteria.length ? gradedBy : "tests",
      graderConfidence,
      criteria,
      tests,
      failedConceptId: passed ? null : verdict.failedConceptId,
    };
  }

  private primary(): Judge {
    if (this.deps.config.grader === "llm") return this.deps.llm;
    if (!this.deps.jev) throw new Error('config.grader is "jev" but no Jev judge was given');
    return this.deps.jev;
  }
}

// A task needs something to grade against and unambiguous criterion ids.
function validate(task: Task): void {
  if (task.rubric.length === 0 && !task.hiddenTests) {
    throw new Error(`task ${task.id} has no rubric and no hidden tests`);
  }
  const ids = task.rubric.map((c) => c.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup !== undefined) throw new Error(`task ${task.id} has duplicate criterion id: ${dup}`);
}

// Real grader. Builds the Jev client only when config.grader is "jev".
export function createGrader(config: Config): Grader {
  return new CompositeGrader({
    runner: new NodeTestRunner(),
    jev: config.grader === "jev" ? new JevJudge() : null,
    llm: new LlmJudge(anthropicAsk(config.escalationModel)),
    config,
  });
}

export { NodeTestRunner } from "./runner";
export type { Runner, TestResult } from "./runner";
export { createClaimJudge, JevClaimJudge, LlmClaimJudge } from "./claims";
export type { ClaimJudge } from "./claims";
