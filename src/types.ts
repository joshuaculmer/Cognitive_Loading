// Shared data contract (SPEC §3). Changes require the user's approval.

export type UserId = string;                   // "<username>+<guid>"

// 1 remember, 2 understand, 3 apply, 4 analyze, 5 evaluate, 6 create
export type BloomLevel = 1 | 2 | 3 | 4 | 5 | 6;

export interface Concept {
  id: string;
  name: string;
  summary: string;
  prerequisites: string[];              // concept ids, directed
  related: string[];                    // concept ids, undirected, for transfer/interleaving
}

export type TaskType =
  | "define" | "predict-output" | "explain" | "implement"
  | "debug" | "review" | "compare-designs" | "design-build"
  | `custom:${string}`;                 // tutor-invented, short description

export interface RubricCriterion {
  id: string;
  statement: string;                    // yes/no condition on the answer
}

export interface Task {                 // immutable once saved
  id: string;
  userId: UserId;
  sessionId: string;
  conceptId: string;
  bloomLevel: BloomLevel;
  taskType: TaskType;
  isReview: boolean;
  prompt: string;
  starterCode: string | null;
  rubric: RubricCriterion[];            // locked before the user answers
  hiddenTests: string | null;           // never shown to the user
  issuedAt: Date;
}

export interface Grade {
  passed: boolean;
  gradedBy: "tests" | "jev" | "llm";
  graderConfidence: number;             // 0–1
  criteria: { criterionId: string; pYes: number }[];
  tests: { passed: number; total: number; output: string } | null;
  failedConceptId: string | null;       // concept blamed for a failure
}

export type Outcome =
  | { kind: "submitted"; answer: string; confidence: number; durationMs: number; grade: Grade }
  | { kind: "abandoned" };

export interface Attempt {              // append-only
  id: string;
  taskId: string;
  userId: UserId;
  hintsUsed: number;
  outcome: Outcome;
  recordedAt: Date;
}

export interface Hint {                 // append-only, saved as each hint is given
  id: string;
  taskId: string;
  userId: UserId;
  rung: 1 | 2 | 3 | 4;
  text: string;
  givenAt: Date;
}

export interface Claim {                // append-only, status derived
  id: string;
  userId: UserId;
  conceptId: string;
  bloomLevel: BloomLevel;
  statement: string;                    // the user's words
  claimedAt: Date;
}

export interface Plan {                 // planner → tutor
  conceptId: string;
  bloomLevel: BloomLevel;
  isReview: boolean;
  suggestedTaskType: TaskType | null;
  reason: string;                       // logged, for debugging policy
}

export interface Mastery {              // derived, recomputable from attempts
  userId: UserId;
  conceptId: string;
  bloomLevel: BloomLevel;
  lastVerifiedAt: Date;
  nextReviewAt: Date;
  ladderStep: number;                   // consecutive advancing passes; interval = ladder[min(step, last)]
}
