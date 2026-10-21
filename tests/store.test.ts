import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { SqliteStore } from "../src/store";
import { FixedLadderScheduler, rebuildMastery } from "../src/scheduler";
import type { Claim, Hint } from "../src/types";
import { abandoned, at, makeGrade, makeTask, submitted } from "./fixtures";

let store: SqliteStore;
let U: string;

beforeEach(() => {
  store = new SqliteStore(":memory:");
  U = store.createUser("ann");
});

afterEach(() => store.close());

test("users get a username+guid id and are found by name", () => {
  assert.match(U, /^ann\+[0-9a-f-]{36}$/);
  assert.equal(store.findUser("ann"), U);
  assert.equal(store.findUser("bob"), undefined);
  assert.throws(() => store.createUser("ann"));
});

test("tasks round-trip", () => {
  const t = makeTask(U, { starterCode: "export {}", hiddenTests: "test()", isReview: true, taskType: "custom:trace a tree" });
  store.saveTask(t);
  assert.deepEqual(store.getTask(t.id), t);
  assert.deepEqual(store.tasks(U), [t]);
  assert.equal(store.getTask("missing"), undefined);
});

test("submitted and abandoned attempts round-trip", () => {
  const t1 = makeTask(U);
  const t2 = makeTask(U);
  store.saveTask(t1);
  store.saveTask(t2);
  const a1 = submitted(t1, true, at(1), 1);
  a1.outcome = {
    kind: "submitted",
    answer: "x",
    confidence: 0.625,
    durationMs: 42,
    grade: makeGrade(false, { gradedBy: "tests", tests: { passed: 2, total: 3, output: "ok" }, failedConceptId: "base-case" }),
  };
  const a2 = abandoned(t2, at(2));
  store.saveAttempt(a2);
  store.saveAttempt(a1);
  assert.deepEqual(store.attempts(U), [a1, a2]);
  assert.deepEqual(
    store.history(U).map((h) => h.task.id),
    [t1.id, t2.id],
  );
});

test("openTasks lists tasks with no attempt", () => {
  const t1 = makeTask(U);
  const t2 = makeTask(U);
  store.saveTask(t1);
  store.saveTask(t2);
  store.saveAttempt(submitted(t1, true, at(1)));
  assert.deepEqual(store.openTasks(U).map((t) => t.id), [t2.id]);
});

test("users lists every user id", () => {
  const V = store.createUser("bob");
  assert.deepEqual(store.users().sort(), [U, V].sort());
});

test("hints round-trip in givenAt order, per task", () => {
  const t = makeTask(U);
  const other = makeTask(U);
  store.saveTask(t);
  store.saveTask(other);
  const h2: Hint = { id: "h2", taskId: t.id, userId: U, rung: 2, text: "narrower", givenAt: at(2) };
  const h1: Hint = { id: "h1", taskId: t.id, userId: U, rung: 1, text: "nudge", givenAt: at(1) };
  store.saveHint(h2);
  store.saveHint(h1);
  store.saveHint({ ...h1, id: "h3", taskId: other.id });
  assert.deepEqual(store.hints(t.id), [h1, h2]);
  assert.deepEqual(store.hints("missing"), []);
});

test("a hint's user must match its task's user, and each rung is given once", () => {
  const V = store.createUser("bob");
  const t = makeTask(U);
  store.saveTask(t);
  const h: Hint = { id: "h1", taskId: t.id, userId: V, rung: 1, text: "nudge", givenAt: at(1) };
  assert.throws(() => store.saveHint(h), /must match its task/);
  store.saveHint({ ...h, userId: U });
  assert.throws(() => store.saveHint({ ...h, id: "h2", userId: U }), /UNIQUE/);
});

test("claims round-trip", () => {
  const c: Claim = { id: "c1", userId: U, conceptId: "recursion", bloomLevel: 3, statement: "I can write recursive functions", claimedAt: at(0) };
  store.saveClaim(c);
  assert.deepEqual(store.claims(U), [c]);
});

test("saveClaims inserts a batch or nothing", () => {
  const c = (id: string): Claim => ({ id, userId: U, conceptId: "recursion", bloomLevel: 2, statement: "s", claimedAt: at(0) });
  store.saveClaims([c("a"), c("b")]);
  assert.equal(store.claims(U).length, 2);
  assert.throws(() => store.saveClaims([c("x"), c("y"), c("a")]), /UNIQUE/);
  assert.deepEqual(store.claims(U).map((x) => x.id), ["a", "b"]);
});

test("tasks, attempts, and claims are insert-only", () => {
  const t = makeTask(U);
  store.saveTask(t);
  store.saveAttempt(abandoned(t, at(1)));
  store.saveClaim({ id: "c1", userId: U, conceptId: "recursion", bloomLevel: 1, statement: "s", claimedAt: at(0) });
  const db = (store as unknown as { db: Database.Database }).db;
  store.saveHint({ id: "h0", taskId: t.id, userId: U, rung: 1, text: "nudge", givenAt: at(0) });
  for (const table of ["tasks", "attempts", "hints", "claims"]) {
    assert.throws(() => db.exec(`UPDATE ${table} SET id = id`), /insert-only/);
    assert.throws(() => db.exec(`DELETE FROM ${table}`), /insert-only/);
  }
  assert.throws(() => store.saveTask(t), /UNIQUE/);
});

test("a task accepts only one attempt", () => {
  const t = makeTask(U);
  store.saveTask(t);
  store.saveAttempt(submitted(t, true, at(1)));
  assert.throws(() => store.saveAttempt(abandoned(t, at(2))), /UNIQUE/);
});

test("an attempt's user must match its task's user", () => {
  const V = store.createUser("bob");
  const t = makeTask(U);
  store.saveTask(t);
  assert.throws(() => store.saveAttempt({ ...abandoned(t, at(1)), userId: V }), /must match its task/);
});

test("confidence and graderConfidence must lie in 0–1", () => {
  const t1 = makeTask(U);
  const t2 = makeTask(U);
  store.saveTask(t1);
  store.saveTask(t2);
  const bad = submitted(t1, true, at(1));
  if (bad.outcome.kind === "submitted") bad.outcome.confidence = 1.5;
  assert.throws(() => store.saveAttempt(bad), /CHECK/);
  const worse = submitted(t2, true, at(1));
  if (worse.outcome.kind === "submitted") worse.outcome.grade.graderConfidence = -0.1;
  assert.throws(() => store.saveAttempt(worse), /CHECK/);
});

test("CHECK constraint rejects half-filled outcomes", () => {
  const t = makeTask(U);
  store.saveTask(t);
  const db = (store as unknown as { db: Database.Database }).db;
  const insert = (kind: string, answer: string | null) =>
    db
      .prepare(
        `INSERT INTO attempts (id, task_id, user_id, hints_used, kind, answer, recorded_at)
         VALUES (?, ?, ?, 0, ?, ?, ?)`,
      )
      .run(`x-${kind}`, t.id, U, kind, answer, at(0).toISOString());
  assert.throws(() => insert("abandoned", "stray answer"), /CHECK/);
  assert.throws(() => insert("submitted", "missing grade"), /CHECK/);
});

test("mastery can be dropped and rebuilt from attempts + tasks", () => {
  const sched = new FixedLadderScheduler();
  for (const day of [0, 3]) {
    const t = makeTask(U, { bloomLevel: 2 });
    store.saveTask(t);
    store.saveAttempt(submitted(t, true, at(day)));
  }

  const first = rebuildMastery(store, sched, U, at(3));
  assert.deepEqual(store.mastery(U), first);
  assert.equal(first.length, 2);

  store.replaceMastery(U, []);
  assert.deepEqual(store.mastery(U), []);
  assert.deepEqual(rebuildMastery(store, sched, U, at(3)), first);
  assert.deepEqual(store.mastery(U), first);
});

test("data is scoped per user", () => {
  const V = store.createUser("bob");
  store.saveTask(makeTask(V));
  assert.deepEqual(store.tasks(U), []);
  assert.equal(store.tasks(V).length, 1);
});
