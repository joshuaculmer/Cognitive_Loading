import type { Attempt, Claim, Concept, Mastery, Plan, Task } from "../types";

export type { Plan };

// Read-only data for choosing the next task. Holds no store handles.
export interface PlannerContext {
  readonly sessionId: string;
  readonly now: Date;
  readonly concepts: readonly Concept[];   // order breaks ties when picking a concept
  readonly mastery: readonly Mastery[];
  readonly claims: readonly Claim[];
  readonly history: readonly { task: Task; attempt: Attempt }[];   // all of the user's attempts
}

export interface Planner {
  next(ctx: PlannerContext): Plan | null;   // null = session done
}

export { RulesPlanner } from "./rules";
