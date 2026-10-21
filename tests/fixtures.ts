import type { Attempt, Grade, Task, UserId } from "../src/types";

export const DAY = 24 * 60 * 60 * 1000;
export const T0 = new Date("2026-01-01T12:00:00.000Z");

export function at(days: number): Date {
  return new Date(T0.getTime() + days * DAY);
}

let seq = 0;
const nextId = (p: string) => `${p}-${++seq}`;

export function makeTask(userId: UserId, over: Partial<Task> = {}): Task {
  return {
    id: nextId("task"),
    userId,
    sessionId: "s1",
    conceptId: "recursion",
    bloomLevel: 2,
    taskType: "explain",
    isReview: false,
    prompt: "Explain recursion.",
    starterCode: null,
    rubric: [{ id: "c1", statement: "Mentions a smaller subproblem" }],
    hiddenTests: null,
    issuedAt: T0,
    ...over,
  };
}

export function makeGrade(passed: boolean, over: Partial<Grade> = {}): Grade {
  return {
    passed,
    gradedBy: "jev",
    graderConfidence: 0.9,
    criteria: [{ criterionId: "c1", pYes: passed ? 0.9 : 0.1 }],
    tests: null,
    failedConceptId: passed ? null : "recursion",
    ...over,
  };
}

export function submitted(task: Task, passed: boolean, recordedAt: Date, hintsUsed = 0): Attempt {
  return {
    id: nextId("att"),
    taskId: task.id,
    userId: task.userId,
    hintsUsed,
    outcome: { kind: "submitted", answer: "ans", confidence: 0.75, durationMs: 1000, grade: makeGrade(passed) },
    recordedAt,
  };
}

export function abandoned(task: Task, recordedAt: Date): Attempt {
  return { id: nextId("att"), taskId: task.id, userId: task.userId, hintsUsed: 0, outcome: { kind: "abandoned" }, recordedAt };
}

