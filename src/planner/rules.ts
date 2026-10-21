import { config as defaultConfig, type Config } from "../config";
import type { Attempt, BloomLevel, Plan, Task, TaskType } from "../types";
import type { Planner, PlannerContext } from "./index";

type RulesConfig = Pick<
  Config,
  | "maxTasksPerSession" | "maxReviewsPerDay" | "rollingWindow" | "paceTarget"
  | "maxLevel" | "maxNewConceptsPerSession" | "newConceptAtLevel" | "taskTypesByLevel"
>;

type Pair = { task: Task; attempt: Attempt };

const DAY_MS = 24 * 60 * 60 * 1000;
const PREREQ_LEVEL = 3;
const REMEDIAL_LEVEL = 2;

// Deterministic rules from SPEC §6.2. The first rule that applies wins.
export class RulesPlanner implements Planner {
  constructor(private readonly cfg: RulesConfig = defaultConfig) {}

  next(ctx: PlannerContext): Plan | null {
    const history = [...ctx.history].sort(
      (a, b) => a.attempt.recordedAt.getTime() - b.attempt.recordedAt.getTime(),
    );

    // Rule 1
    const sessionTasks = history.filter((h) => h.task.sessionId === ctx.sessionId).length;
    if (sessionTasks >= this.cfg.maxTasksPerSession) return null;

    // Rule 2
    const last = history.at(-1);
    const blamed = last && blamedConcept(last, ctx);
    if (blamed) {
      const level = Math.min(REMEDIAL_LEVEL, this.cfg.maxLevel) as BloomLevel;
      return plan(blamed, level, false, null, `rule 2: last attempt failed and blamed ${blamed}`);
    }
    const origin = returnTarget(history, ctx);
    if (last && origin) {
      const { conceptId, bloomLevel, isReview } = origin;
      return plan(conceptId, bloomLevel, isReview, null, `rule 2: remediation on ${last.task.conceptId} passed, return to ${conceptId} L${bloomLevel}`);
    }

    // Rule 3
    const reviewsToday = history.filter(
      (h) => h.task.isReview && ctx.now.getTime() - h.task.issuedAt.getTime() < DAY_MS,
    ).length;
    if (reviewsToday < this.cfg.maxReviewsPerDay) {
      const due = ctx.mastery
        .filter((m) => m.nextReviewAt.getTime() <= ctx.now.getTime())
        .sort(
          (a, b) =>
            a.nextReviewAt.getTime() - b.nextReviewAt.getTime() ||
            b.bloomLevel - a.bloomLevel ||
            a.conceptId.localeCompare(b.conceptId),
        )[0];
      if (due) {
        return plan(due.conceptId, due.bloomLevel, true, null, `rule 3: review ${due.conceptId} L${due.bloomLevel}, most overdue`);
      }
    }

    // The current concept and level come from the last non-review task.
    const lessons = history.filter((h) => !h.task.isReview);
    const currentPair = lessons.at(-1);
    if (!currentPair) return this.newConcept(ctx, history, null, true, "rule 7: no current concept");
    const current = currentPair.task;

    // Rule 4
    const window = history.slice(-Math.max(1, this.cfg.rollingWindow));
    const rate = window.filter((h) => passed(h.attempt)).length / window.length;
    const rateText = `rate ${rate.toFixed(2)} vs target ${this.cfg.paceTarget}`;

    // Rule 5
    if (rate >= this.cfg.paceTarget) {
      if (current.bloomLevel === this.cfg.newConceptAtLevel && passed(currentPair.attempt)) {
        const why = `rule 5: ${rateText}, ${current.conceptId} passed L${current.bloomLevel}`;
        const fresh = this.newConcept(ctx, history, current.conceptId, true, why);
        if (fresh) return fresh;
      }
      const nextLevel = current.bloomLevel + 1;
      if (nextLevel <= this.cfg.maxLevel) {
        return plan(current.conceptId, nextLevel as BloomLevel, false, null, `rule 5: ${rateText}, advance ${current.conceptId} to L${nextLevel}`);
      }
      const why = `rule 5: ${rateText}, ${current.conceptId} at max level`;
      return this.startedConcept(ctx, lessons, current.conceptId, why) ?? this.newConcept(ctx, history, current.conceptId, false, why);
    }

    // Rule 6
    const atLevel = history.filter(
      (h) => h.task.conceptId === current.conceptId && h.task.bloomLevel === current.bloomLevel,
    );
    const lastTwo = atLevel.slice(-2);
    if (lastTwo.length === 2 && lastTwo.every((h) => !passed(h.attempt)) && current.bloomLevel > 1) {
      const lower = (current.bloomLevel - 1) as BloomLevel;
      const type = this.unusedType(history, current.conceptId, lower);
      return plan(current.conceptId, lower, false, type, `rule 6: ${rateText}, last two at L${current.bloomLevel} failed, drop to L${lower}`);
    }
    const type = this.unusedType(history, current.conceptId, current.bloomLevel);
    return plan(current.conceptId, current.bloomLevel, false, type, `rule 6: ${rateText}, stay at L${current.bloomLevel} with a different task type`);
  }

  // Rule 5.1: the first other started concept whose next level is within maxLevel.
  private startedConcept(ctx: PlannerContext, lessons: Pair[], currentId: string, why: string): Plan | null {
    for (const c of ctx.concepts) {
      if (c.id === currentId) continue;
      const last = lessons.filter((h) => h.task.conceptId === c.id).at(-1);
      if (!last) continue;
      const level = last.task.bloomLevel + (passed(last.attempt) ? 1 : 0);
      if (level <= this.cfg.maxLevel) {
        return plan(c.id, level as BloomLevel, false, null, `${why}, resume ${c.id} at L${level}`);
      }
    }
    return null;
  }

  // Rules 5 and 7: an unstarted concept whose prerequisites are satisfied.
  // Concepts that build on the current one come first, then list order.
  private newConcept(ctx: PlannerContext, history: Pair[], currentId: string | null, capped: boolean, why: string): Plan | null {
    const firstSeen = new Map<string, string>();
    for (const h of history) {
      if (!firstSeen.has(h.task.conceptId)) firstSeen.set(h.task.conceptId, h.task.sessionId);
    }
    const newThisSession = [...firstSeen.values()].filter((s) => s === ctx.sessionId).length;
    const overCap = newThisSession >= this.cfg.maxNewConceptsPerSession;
    if (capped && overCap) return null;

    const eligible = ctx.concepts.filter(
      (c) => !firstSeen.has(c.id) && c.prerequisites.every((p) => prereqSatisfied(p, ctx, history)),
    );
    const concept = eligible.find((c) => currentId !== null && c.prerequisites.includes(currentId)) ?? eligible[0];
    if (!concept) return null;

    const claimed = ctx.claims.filter((c) => c.conceptId === concept.id).map((c) => c.bloomLevel);
    const level = Math.min(Math.max(1, ...claimed), this.cfg.maxLevel) as BloomLevel;
    const from = claimed.length > 0 ? `claimed L${level}` : `L${level}`;
    const bypass = overCap ? ", new-concept cap bypassed as the only way forward" : "";
    return plan(concept.id, level, false, null, `${why}, start new concept ${concept.id} at ${from}${bypass}`);
  }

  // The first type for the level not yet used on this concept at this level.
  private unusedType(history: Pair[], conceptId: string, level: BloomLevel): TaskType | null {
    const used = new Set(
      history.filter((h) => h.task.conceptId === conceptId && h.task.bloomLevel === level).map((h) => h.task.taskType),
    );
    return this.cfg.taskTypesByLevel[level].find((t) => !used.has(t)) ?? null;
  }
}

// Demonstrated at level ≥ 3, or claimed at level ≥ 3 and not disproved.
function prereqSatisfied(conceptId: string, ctx: PlannerContext, history: Pair[]): boolean {
  if (ctx.mastery.some((m) => m.conceptId === conceptId && m.bloomLevel >= PREREQ_LEVEL)) return true;
  return ctx.claims.some(
    (c) => c.conceptId === conceptId && c.bloomLevel >= PREREQ_LEVEL && !disproved(conceptId, c.bloomLevel, history),
  );
}

// The latest submitted attempt at this (concept, level) failed.
function disproved(conceptId: string, level: BloomLevel, history: Pair[]): boolean {
  const tested = history.filter(
    (h) => h.task.conceptId === conceptId && h.task.bloomLevel === level && h.attempt.outcome.kind === "submitted",
  );
  const latest = tested.at(-1);
  return latest !== undefined && !passed(latest.attempt);
}

function passed(a: Attempt): boolean {
  return a.outcome.kind === "submitted" && a.outcome.grade.passed;
}

// A failed attempt's blamed concept, when it is known and differs from the task's own.
function blamedConcept(h: Pair, ctx: PlannerContext): string | null {
  if (h.attempt.outcome.kind !== "submitted" || h.attempt.outcome.grade.passed) return null;
  const blamed = h.attempt.outcome.grade.failedConceptId;
  if (!blamed || blamed === h.task.conceptId || !ctx.concepts.some((c) => c.id === blamed)) return null;
  return blamed;
}

// The task to return to when the last attempt closes an open remediation.
// Open remediations stack, so nested blames unwind one pass at a time.
function returnTarget(history: Pair[], ctx: PlannerContext): Task | null {
  const open: { origin: Task; target: string }[] = [];
  let closed: Task | null = null;
  for (const h of history) {
    closed = null;
    const blamed = blamedConcept(h, ctx);
    if (blamed) open.push({ origin: h.task, target: blamed });
    else if (passed(h.attempt) && open.at(-1)?.target === h.task.conceptId) closed = open.pop()!.origin;
  }
  return closed;
}

function plan(conceptId: string, bloomLevel: BloomLevel, isReview: boolean, suggestedTaskType: TaskType | null, reason: string): Plan {
  return { conceptId, bloomLevel, isReview, suggestedTaskType, reason };
}
