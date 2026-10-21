import { test } from "node:test";
import assert from "node:assert/strict";
import { FixedLadderScheduler, isMastered } from "../src/scheduler";
import type { Attempt, Mastery, Task } from "../src/types";
import { abandoned, at, makeTask, submitted } from "./fixtures";

const U = "ann+1";
const sched = new FixedLadderScheduler({ reviewLadderDays: [1, 3, 7, 14, 30], hintsBlockAdvance: 2 });

function row(rows: Mastery[], conceptId: string, level: number): Mastery | undefined {
  return rows.find((r) => r.conceptId === conceptId && r.bloomLevel === level);
}

test("empty history yields no rows", () => {
  assert.deepEqual(sched.recompute(U, [], at(0)), []);
});

test("passes climb the ladder and schedule ladder[step] days out", () => {
  const t = makeTask(U, { bloomLevel: 1 });
  const h = [0, 3, 10].map((d) => ({ task: t, attempt: submitted(t, true, at(d)) }));
  const r = row(sched.recompute(U, h, at(10)), "recursion", 1)!;
  assert.equal(r.ladderStep, 3);
  assert.deepEqual(r.lastVerifiedAt, at(10));
  assert.deepEqual(r.nextReviewAt, at(10 + 14));
  assert.ok(isMastered(r, 3));
});

test("a hint-blocked first pass creates a row at step 0 with a 1-day review", () => {
  const t = makeTask(U, { bloomLevel: 1 });
  const rows = sched.recompute(U, [{ task: t, attempt: submitted(t, true, at(0), 2) }], at(0));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.ladderStep, 0);
  assert.deepEqual(rows[0]!.nextReviewAt, at(1));
});

test("a pass at level L counts for every level ≤ L", () => {
  const t = makeTask(U, { bloomLevel: 3 });
  const rows = sched.recompute(U, [{ task: t, attempt: submitted(t, true, at(0)) }], at(0));
  assert.deepEqual(rows.map((r) => r.bloomLevel).sort(), [1, 2, 3]);
  assert.ok(rows.every((r) => r.ladderStep === 1));
});

test("hintsUsed ≥ hintsBlockAdvance holds the step on a pass", () => {
  const t = makeTask(U, { bloomLevel: 1 });
  const h = [
    { task: t, attempt: submitted(t, true, at(0)) },
    { task: t, attempt: submitted(t, true, at(3), 2) },
  ];
  const r = row(sched.recompute(U, h, at(3)), "recursion", 1)!;
  assert.equal(r.ladderStep, 1);
  assert.deepEqual(r.nextReviewAt, at(3 + 3));
});

test("a fail resets only its level, schedules the next day, and keeps lastVerifiedAt", () => {
  const hi = makeTask(U, { bloomLevel: 2 });
  const h: { task: Task; attempt: Attempt }[] = [
    { task: hi, attempt: submitted(hi, true, at(0)) },
    { task: hi, attempt: submitted(hi, true, at(3)) },
    { task: hi, attempt: submitted(hi, false, at(10)) },
  ];
  const rows = sched.recompute(U, h, at(10));
  assert.equal(row(rows, "recursion", 2)!.ladderStep, 0);
  assert.deepEqual(row(rows, "recursion", 2)!.nextReviewAt, at(11));
  assert.deepEqual(row(rows, "recursion", 2)!.lastVerifiedAt, at(3));
  assert.equal(row(rows, "recursion", 1)!.ladderStep, 2);
});

test("a fail on a level with no row changes nothing", () => {
  const lo = makeTask(U, { bloomLevel: 1 });
  const hi = makeTask(U, { bloomLevel: 2 });
  const h = [
    { task: lo, attempt: submitted(lo, true, at(0)) },
    { task: hi, attempt: submitted(hi, false, at(1)) },
  ];
  const rows = sched.recompute(U, h, at(1));
  assert.equal(rows.length, 1);
  assert.equal(row(rows, "recursion", 1)!.ladderStep, 1);
});

test("an abandon never changes mastery", () => {
  const t = makeTask(U, { bloomLevel: 1 });
  const pass = { task: t, attempt: submitted(t, true, at(0)) };
  const quit = { task: t, attempt: abandoned(t, at(2)) };
  assert.deepEqual(sched.recompute(U, [pass, quit], at(2)), sched.recompute(U, [pass], at(2)));
  assert.deepEqual(sched.recompute(U, [quit], at(2)), []);
});

test("history is replayed in recordedAt order regardless of input order", () => {
  const t = makeTask(U, { bloomLevel: 1 });
  const h = [
    { task: t, attempt: submitted(t, true, at(5)) },
    { task: t, attempt: submitted(t, false, at(0)) },
  ];
  assert.equal(row(sched.recompute(U, h, at(5)), "recursion", 1)!.ladderStep, 1);
});

test("step past the ladder end reuses the last interval", () => {
  const t = makeTask(U, { bloomLevel: 1 });
  const days = [0, 3, 10, 24, 54, 84, 114];
  const h = days.map((d) => ({ task: t, attempt: submitted(t, true, at(d)) }));
  const r = row(sched.recompute(U, h, at(114)), "recursion", 1)!;
  assert.equal(r.ladderStep, 7);
  assert.deepEqual(r.nextReviewAt, at(114 + 30));
});

test("concepts are tracked independently", () => {
  const a = makeTask(U, { conceptId: "recursion", bloomLevel: 1 });
  const b = makeTask(U, { conceptId: "base-case", bloomLevel: 1 });
  const rows = sched.recompute(
    U,
    [
      { task: a, attempt: submitted(a, true, at(0)) },
      { task: b, attempt: submitted(b, false, at(1)) },
    ],
    at(1),
  );
  assert.equal(row(rows, "recursion", 1)!.ladderStep, 1);
  assert.equal(row(rows, "base-case", 1), undefined);
});
