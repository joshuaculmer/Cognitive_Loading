// Joined task + attempt rows as JSON lines, for pandas (SPEC §6.6). Covers all users by default.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Store } from "../store";
import type { UserId } from "../types";

export const DEFAULT_EXPORT_PATH = "data/export.jsonl";

export function exportRows(store: Store, userIds: UserId[] = store.users()): Record<string, unknown>[] {
  return userIds.flatMap((userId) =>
    store.history(userId).map(({ task, attempt }) => {
      const o = attempt.outcome;
      const g = o.kind === "submitted" ? o.grade : null;
      return {
        taskId: task.id,
        userId: task.userId,
        sessionId: task.sessionId,
        conceptId: task.conceptId,
        bloomLevel: task.bloomLevel,
        taskType: task.taskType,
        isReview: task.isReview,
        prompt: task.prompt,
        starterCode: task.starterCode,
        rubric: task.rubric,
        hiddenTests: task.hiddenTests,
        issuedAt: task.issuedAt.toISOString(),
        attemptId: attempt.id,
        hintsUsed: attempt.hintsUsed,
        hints: store.hints(task.id).map((h) => ({ rung: h.rung, text: h.text, givenAt: h.givenAt.toISOString() })),
        recordedAt: attempt.recordedAt.toISOString(),
        outcome: o.kind,
        answer: o.kind === "submitted" ? o.answer : null,
        confidence: o.kind === "submitted" ? o.confidence : null,
        durationMs: o.kind === "submitted" ? o.durationMs : null,
        passed: g?.passed ?? null,
        gradedBy: g?.gradedBy ?? null,
        graderConfidence: g?.graderConfidence ?? null,
        criteria: g?.criteria ?? null,
        testsPassed: g?.tests?.passed ?? null,
        testsTotal: g?.tests?.total ?? null,
        failedConceptId: g?.failedConceptId ?? null,
      };
    }),
  );
}

export function writeExport(store: Store, userIds: UserId[] = store.users(), path = DEFAULT_EXPORT_PATH): number {
  const rows = exportRows(store, userIds);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, rows.map((r) => JSON.stringify(r) + "\n").join(""));
  return rows.length;
}
