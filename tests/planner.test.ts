import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config";
import { RulesPlanner, type PlannerContext } from "../src/planner";
import type { Attempt, BloomLevel, Claim, Concept, Mastery, Plan, Task } from "../src/types";
import { abandoned, at, makeGrade, makeTask, submitted } from "./fixtures";

const U = "ann+1";
const NOW = at(10);

const CFG = {
  maxTasksPerSession: 12,
  maxReviewsPerDay: 20,
  rollingWindow: 8,
  paceTarget: 0.85,
  maxLevel: 6 as BloomLevel,
  maxNewConceptsPerSession: 2,
  newConceptAtLevel: 3 as BloomLevel,
  taskTypesByLevel: config.taskTypesByLevel,
};

const concept = (id: string, prerequisites: string[] = []): Concept => ({ id, name: id, summary: "", prerequisites, related: [] });
const CONCEPTS = [concept("a"), concept("b", ["a"]), concept("c", ["b"])];

type Pair = { task: Task; attempt: Attempt };
let clock = 0;

// One attempt, recorded later than every earlier call.
function attempt(conceptId: string, level: number, result: "pass" | "fail" | "abandon", over: Partial<Task> = {}, blame?: string): Pair {
  clock += 1;
  const when = new Date(NOW.getTime() - 60_000 * (1000 - clock));
  const task = makeTask(U, { conceptId, bloomLevel: level as BloomLevel, issuedAt: when, ...over });
  if (result === "abandon") return { task, attempt: abandoned(task, when) };
  const a = submitted(task, result === "pass", when);
  if (a.outcome.kind === "submitted") a.outcome.grade = makeGrade(result === "pass", { failedConceptId: blame ?? (result === "pass" ? null : conceptId) });
  return { task, attempt: a };
}

function row(conceptId: string, level: number, nextReviewAt = at(30)): Mastery {
  return { userId: U, conceptId, bloomLevel: level as BloomLevel, lastVerifiedAt: at(0), nextReviewAt, ladderStep: 1 };
}

function rows(conceptId: string, upTo: number): Mastery[] {
  return Array.from({ length: upTo }, (_, i) => row(conceptId, i + 1));
}

function claim(conceptId: string, level: number): Claim {
  return { id: `cl-${conceptId}-${level}`, userId: U, conceptId, bloomLevel: level as BloomLevel, statement: "I know it", claimedAt: at(0) };
}

function ctx(over: Partial<PlannerContext> = {}): PlannerContext {
  return { sessionId: "s1", now: NOW, concepts: CONCEPTS, mastery: [], claims: [], history: [], ...over };
}

const planner = new RulesPlanner(CFG);
const fields = (p: Plan | null) => p && [p.conceptId, p.bloomLevel, p.isReview];

test("empty history starts the first concept at level 1", () => {
  const p = planner.next(ctx())!;
  assert.deepEqual(fields(p), ["a", 1, false]);
  assert.match(p.reason, /^rule 7/);
});

test("a new concept starts at its highest claimed level", () => {
  const p = planner.next(ctx({ claims: [claim("a", 2), claim("a", 4)] }))!;
  assert.deepEqual(fields(p), ["a", 4, false]);
  assert.match(p.reason, /claimed L4/);
});

test("a claimed level above maxLevel is clamped", () => {
  const p = new RulesPlanner({ ...CFG, maxLevel: 3 }).next(ctx({ claims: [claim("a", 5)] }))!;
  assert.equal(p.bloomLevel, 3);
});

test("rule 1 stops at maxTasksPerSession, counting only this session", () => {
  const history = [attempt("a", 1, "pass"), attempt("a", 2, "pass"), attempt("a", 3, "pass", { sessionId: "old" })];
  const p = new RulesPlanner({ ...CFG, maxTasksPerSession: 2 });
  assert.equal(p.next(ctx({ history })), null);
  assert.notEqual(p.next(ctx({ history: history.slice(1) })), null);
});

test("rule 2 targets a blamed different concept at level 2", () => {
  const p = planner.next(ctx({ history: [attempt("b", 3, "fail", {}, "a")] }))!;
  assert.deepEqual(fields(p), ["a", 2, false]);
  assert.match(p.reason, /^rule 2/);
});

test("rule 2 ignores own-concept blame, unknown ids, and passes", () => {
  for (const h of [attempt("b", 3, "fail", {}, "b"), attempt("b", 3, "fail", {}, "nope"), attempt("b", 3, "pass", {}, "a")]) {
    assert.doesNotMatch(planner.next(ctx({ history: [h] }))!.reason, /^rule 2/);
  }
});

test("rule 2 wins over a due review", () => {
  const p = planner.next(ctx({ history: [attempt("b", 3, "fail", {}, "a")], mastery: [row("c", 1, at(1))] }))!;
  assert.match(p.reason, /^rule 2/);
});

test("rule 2 returns to the failed level once remediation passes", () => {
  const history = [attempt("b", 3, "fail", {}, "a"), attempt("a", 2, "pass")];
  const p = planner.next(ctx({ history, mastery: [row("a", 1, at(1))] }))!;
  assert.deepEqual(fields(p), ["b", 3, false]);
  assert.match(p.reason, /^rule 2: remediation on a passed/);
});

test("rule 2 returns after a failed-then-passed remediation", () => {
  const history = [attempt("b", 3, "fail", {}, "a"), attempt("a", 2, "fail"), attempt("a", 2, "pass")];
  assert.deepEqual(fields(planner.next(ctx({ history }))), ["b", 3, false]);
});

test("rule 2 keeps isReview when the blamed failure was a review", () => {
  const history = [attempt("b", 3, "fail", { isReview: true }, "a"), attempt("a", 2, "pass")];
  assert.deepEqual(fields(planner.next(ctx({ history }))), ["b", 3, true]);
});

test("rule 2 unwinds nested remediations one pass at a time", () => {
  const history = [attempt("c", 3, "fail", {}, "b"), attempt("b", 2, "fail", {}, "a"), attempt("a", 2, "pass")];
  assert.deepEqual(fields(planner.next(ctx({ history }))), ["b", 2, false]);
  assert.deepEqual(fields(planner.next(ctx({ history: [...history, attempt("b", 2, "pass")] }))), ["c", 3, false]);
});

test("rule 3 reviews the most overdue row, then higher level, then concept id", () => {
  const mastery = [row("a", 1, at(5)), row("c", 2, at(2)), row("b", 1, at(2)), row("b", 2, at(2)), row("c", 1, at(20))];
  const p = planner.next(ctx({ history: [attempt("a", 1, "pass")], mastery }))!;
  assert.deepEqual(fields(p), ["b", 2, true]);
  assert.match(p.reason, /^rule 3/);
});

test("rule 3 wins over advancing", () => {
  const p = planner.next(ctx({ history: [attempt("a", 1, "pass")], mastery: [row("a", 1, at(9))] }))!;
  assert.match(p.reason, /^rule 3/);
});

test("rule 3 skips reviews once maxReviewsPerDay is reached in the last 24 hours", () => {
  const mastery = [row("a", 1, at(9))];
  const capped = new RulesPlanner({ ...CFG, maxReviewsPerDay: 1 });
  const recent = [attempt("a", 1, "pass", { isReview: true }), attempt("a", 1, "pass")];
  assert.doesNotMatch(capped.next(ctx({ history: recent, mastery }))!.reason, /^rule 3/);

  const old = [attempt("a", 1, "pass", { isReview: true, issuedAt: at(8) }), attempt("a", 1, "pass")];
  assert.match(capped.next(ctx({ history: old, mastery }))!.reason, /^rule 3/);
});

test("rule 5 advances one above the current task's level", () => {
  const p = planner.next(ctx({ history: [attempt("a", 2, "pass")], mastery: rows("a", 4) }))!;
  assert.deepEqual(fields(p), ["a", 3, false]);
  assert.match(p.reason, /^rule 5/);
});

test("rule 5 introduces a new concept after passing newConceptAtLevel", () => {
  const concepts = [concept("a"), concept("x"), concept("b", ["a"])];
  const p = planner.next(ctx({ concepts, history: [attempt("a", 3, "pass")], mastery: rows("a", 3) }))!;
  assert.deepEqual(fields(p), ["b", 1, false]);
  assert.match(p.reason, /^rule 5.*passed L3, start new concept b/);
});

test("rule 5 advances past newConceptAtLevel when capped or nothing is eligible", () => {
  const history = [attempt("a", 3, "pass")];
  const capped = new RulesPlanner({ ...CFG, maxNewConceptsPerSession: 1 });
  assert.deepEqual(fields(capped.next(ctx({ history, mastery: rows("a", 3) }))), ["a", 4, false]);
  assert.deepEqual(fields(planner.next(ctx({ history, mastery: rows("a", 2) }))), ["a", 4, false]);
});

test("rule 5 after a step-down advances back to the failed level", () => {
  const history = [attempt("a", 3, "fail"), attempt("a", 3, "fail"), attempt("a", 2, "pass")];
  const p = new RulesPlanner({ ...CFG, rollingWindow: 1 }).next(ctx({ history, mastery: rows("a", 2) }))!;
  assert.deepEqual(fields(p), ["a", 3, false]);
});

test("a review does not change the current concept", () => {
  const history = [attempt("b", 1, "pass"), attempt("a", 3, "pass", { isReview: true })];
  const p = planner.next(ctx({ history, mastery: rows("a", 3) }))!;
  assert.deepEqual(fields(p), ["b", 2, false]);
});

test("rule 5 at maxLevel switches to a started concept, then a new one, then ends", () => {
  const p = new RulesPlanner({ ...CFG, maxLevel: 3, newConceptAtLevel: 4, rollingWindow: 1 });
  const mastery = [...rows("a", 3), ...rows("b", 3)];

  const bPassed = [attempt("b", 2, "pass", { sessionId: "old" }), attempt("a", 3, "pass")];
  assert.deepEqual(fields(p.next(ctx({ history: bPassed, mastery }))), ["b", 3, false]);

  const bFailed = [attempt("b", 3, "fail", { sessionId: "old" }), attempt("a", 3, "pass")];
  const resume = p.next(ctx({ history: bFailed, mastery }))!;
  assert.deepEqual(fields(resume), ["b", 3, false]);
  assert.match(resume.reason, /resume b/);

  const bMaxed = [attempt("b", 3, "pass", { sessionId: "old" }), attempt("a", 3, "pass")];
  const fresh = p.next(ctx({ history: bMaxed, mastery }))!;
  assert.deepEqual(fields(fresh), ["c", 1, false]);
  assert.match(fresh.reason, /new concept c/);

  const allMaxed = [...bMaxed, attempt("c", 3, "pass")];
  assert.equal(p.next(ctx({ history: allMaxed, mastery: [...mastery, ...rows("c", 3)] })), null);
});

test("rule 5 bypasses the new-concept cap when it is the only way forward", () => {
  const p = new RulesPlanner({ ...CFG, maxLevel: 3, maxNewConceptsPerSession: 1 });
  const plan = p.next(ctx({ history: [attempt("a", 3, "pass")], mastery: rows("a", 3) }))!;
  assert.equal(plan.conceptId, "b");
  assert.match(plan.reason, /cap bypassed/);
});

test("rule 7 respects the new-concept cap", () => {
  const history = [attempt("a", 1, "pass", { isReview: true })];
  const p = new RulesPlanner({ ...CFG, maxNewConceptsPerSession: 1 });
  assert.equal(p.next(ctx({ history })), null);
});

test("a prerequisite demonstrated only below level 3 blocks a new concept", () => {
  const p = new RulesPlanner({ ...CFG, maxLevel: 2 });
  assert.equal(p.next(ctx({ history: [attempt("a", 2, "pass")], mastery: rows("a", 2) })), null);
});

test("an untested claim satisfies a prerequisite, and a failed test disproves it", () => {
  const concepts = [concept("c", ["a"]), concept("x"), concept("a")];
  const claims = [claim("a", 3)];
  assert.equal(planner.next(ctx({ concepts, claims }))!.conceptId, "c");
  assert.equal(planner.next(ctx({ concepts }))!.conceptId, "x");

  const history = [attempt("a", 3, "fail", { isReview: true, sessionId: "old" })];
  assert.equal(planner.next(ctx({ concepts, claims, history }))!.conceptId, "x");
});

test("rule 4 counts abandoned attempts as failures", () => {
  const history = [...Array.from({ length: 5 }, () => attempt("a", 1, "pass")), attempt("a", 2, "abandon")];
  assert.match(planner.next(ctx({ history }))!.reason, /^rule 6: rate 0\.83/);
});

test("rule 4 uses only the last rollingWindow attempts", () => {
  const history = [attempt("a", 1, "fail"), attempt("a", 1, "fail"), attempt("a", 1, "pass"), attempt("a", 1, "pass")];
  assert.match(new RulesPlanner({ ...CFG, rollingWindow: 2 }).next(ctx({ history }))!.reason, /^rule 5/);
});

test("rule 4 treats rollingWindow 0 as the last attempt", () => {
  const history = [attempt("a", 1, "fail"), attempt("a", 1, "pass")];
  assert.match(new RulesPlanner({ ...CFG, rollingWindow: 0 }).next(ctx({ history }))!.reason, /^rule 5: rate 1\.00/);
});

test("rule 6 stays at the level and suggests an unused type for it", () => {
  const history = [attempt("a", 2, "pass", { taskType: "predict-output" }), attempt("a", 2, "fail", { taskType: "define" })];
  const p = new RulesPlanner({ ...CFG, rollingWindow: 1 }).next(ctx({ history }))!;
  assert.deepEqual([p.conceptId, p.bloomLevel, p.suggestedTaskType], ["a", 2, "explain"]);
  assert.match(p.reason, /^rule 6.*stay/);
});

test("rule 6 suggests null once every type for the level is used", () => {
  const history = [attempt("a", 2, "pass", { taskType: "predict-output" }), attempt("a", 2, "fail", { taskType: "explain" })];
  const p = new RulesPlanner({ ...CFG, rollingWindow: 1 }).next(ctx({ history }))!;
  assert.equal(p.suggestedTaskType, null);
});

test("rule 6 drops one level after two failures at the level", () => {
  const history = [attempt("a", 3, "fail"), attempt("a", 3, "abandon")];
  const p = planner.next(ctx({ history }))!;
  assert.deepEqual([p.conceptId, p.bloomLevel, p.suggestedTaskType], ["a", 2, "predict-output"]);
  assert.match(p.reason, /^rule 6.*drop to L2/);
});

test("rule 6 does not drop below level 1", () => {
  const p = planner.next(ctx({ history: [attempt("a", 1, "fail"), attempt("a", 1, "fail")] }))!;
  assert.equal(p.bloomLevel, 1);
  assert.match(p.reason, /stay/);
});

test("no eligible new concept and no history ends the session", () => {
  assert.equal(planner.next(ctx({ concepts: [concept("b", ["a"])] })), null);
});
