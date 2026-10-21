// Tutor interface (SPEC §5).

import type { Attempt, Claim, Concept, Mastery, Plan, Task } from "../types";

// Read-only data for writing a task. Holds no store handles.
export interface TutorContext {
  readonly subject: string;
  readonly concepts: readonly Concept[];
  readonly mastery: readonly Mastery[];
  readonly claims: readonly Claim[];
  readonly recent: readonly { task: Task; attempt: Attempt }[];
}

export type HintRung = 1 | 2 | 3 | 4;

export type WrittenTask = Omit<Task, "id" | "userId" | "sessionId" | "issuedAt">;

// A claimed concept and the user's words. ClaimJudge assigns the level.
export type ExtractedClaim = { conceptId: string; statement: string };

export interface Tutor {
  writeTask(plan: Plan, ctx: TutorContext): Promise<WrittenTask>;
  hint(task: Task, rung: HintRung, priorHints: string[], draft: string | null): Promise<string>;
  clarify(task: Task, question: string): Promise<string>;
  intakeFollowUp(subject: string, firstAnswer: string): Promise<string>;
  extractClaims(subject: string, transcript: string[], concepts: Concept[]): Promise<ExtractedClaim[]>;
}

export { ClaudeTutor } from "./claude";
