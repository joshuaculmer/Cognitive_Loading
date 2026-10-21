import { config as defaultConfig, type Config } from "../config";
import type { Store } from "../store";
import type { Attempt, BloomLevel, Mastery, Task, UserId } from "../types";

export interface Scheduler {
  recompute(userId: UserId, history: { task: Task; attempt: Attempt }[], now: Date): Mastery[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

type LadderConfig = Pick<Config, "reviewLadderDays" | "hintsBlockAdvance">;

// Replays attempts in time order over a fixed review ladder (SPEC §6.1).
// Only passes create rows. A pass schedules the next review
// reviewLadderDays[ladderStep] days out. A fail on an existing row resets
// the step and schedules a review the next day. Abandons are ignored.
export class FixedLadderScheduler implements Scheduler {
  constructor(private readonly cfg: LadderConfig = defaultConfig) {}

  recompute(userId: UserId, history: { task: Task; attempt: Attempt }[], _now: Date): Mastery[] {
    const rows = new Map<string, Mastery>();
    const sorted = history
      .filter((h) => h.attempt.userId === userId)
      .sort((a, b) => a.attempt.recordedAt.getTime() - b.attempt.recordedAt.getTime());

    for (const { task, attempt } of sorted) {
      const { outcome, recordedAt: at } = attempt;
      if (outcome.kind === "abandoned") continue;

      if (!outcome.grade.passed) {
        const prev = rows.get(key(task.conceptId, task.bloomLevel));
        if (prev) {
          prev.ladderStep = 0;
          prev.nextReviewAt = new Date(at.getTime() + DAY_MS);
        }
        continue;
      }

      // A pass at level L counts for every level ≤ L.
      for (const level of range(task.bloomLevel)) {
        const current = rows.get(key(task.conceptId, level))?.ladderStep ?? 0;
        const step = attempt.hintsUsed >= this.cfg.hintsBlockAdvance ? current : current + 1;
        rows.set(key(task.conceptId, level), {
          userId,
          conceptId: task.conceptId,
          bloomLevel: level,
          lastVerifiedAt: at,
          nextReviewAt: new Date(at.getTime() + this.intervalDays(step) * DAY_MS),
          ladderStep: step,
        });
      }
    }

    return [...rows.values()];
  }

  private intervalDays(step: number): number {
    const ladder = this.cfg.reviewLadderDays;
    return ladder[Math.min(step, ladder.length - 1)] ?? 1;
  }
}

// Drops and rebuilds a user's mastery rows from their attempt history.
export function rebuildMastery(store: Store, scheduler: Scheduler, userId: UserId, now: Date): Mastery[] {
  const rows = scheduler.recompute(userId, store.history(userId), now);
  store.replaceMastery(userId, rows);
  return rows;
}

export function isMastered(m: Mastery, masteredStep = defaultConfig.masteredStep): boolean {
  return m.ladderStep >= masteredStep;
}

function key(conceptId: string, level: BloomLevel): string {
  return `${conceptId}|${level}`;
}

function range(level: BloomLevel): BloomLevel[] {
  const out: BloomLevel[] = [];
  for (let l = 1; l <= level; l++) out.push(l as BloomLevel);
  return out;
}
