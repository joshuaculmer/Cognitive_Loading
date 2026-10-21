// End-to-end loop with fake tutor, grader, and claim judge over a temp SQLite db and workspace.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config";
import { SeedConceptSource } from "../src/concepts";
import type { ClaimJudge, Grader } from "../src/grader";
import { RulesPlanner } from "../src/planner";
import { FixedLadderScheduler } from "../src/scheduler";
import { SqliteStore } from "../src/store";
import type { Tutor } from "../src/tutor";
import type { Grade, Task } from "../src/types";
import { exportRows, writeExport } from "../src/cli/export";
import { runCommand, runRepl } from "../src/cli/repl";
import { PassThrough } from "node:stream";
import { Session, type IO } from "../src/cli/session";
import { answerPath } from "../src/cli/workspace";

class ScriptedIO implements IO {
  out: string[] = [];
  prompts: string[] = [];
  constructor(private readonly answers: string[] = []) {}
  async prompt(q: string): Promise<string> {
    this.prompts.push(q);
    const a = this.answers.shift();
    if (a === undefined) throw new Error(`unexpected prompt: ${q}`);
    return a;
  }
  print(t: string): void {
    this.out.push(t);
  }
  queue(...a: string[]): void {
    this.answers.push(...a);
  }
}

// Odd tasks are code tasks, even tasks are prose.
function fakeTutor() {
  const log = { failWrites: 0, transcript: [] as string[], hints: [] as { rung: number; prior: number; draft: string | null }[], clarify: 0, written: 0 };
  const tutor: Tutor = {
    async writeTask(plan) {
      if (log.failWrites > 0) {
        log.failWrites--;
        throw new Error('bad task JSON {"rubric":"SECRET RUBRIC","hiddenTests":"SECRET TESTS"}');
      }
      const code = ++log.written % 2 === 1;
      return {
        conceptId: plan.conceptId,
        bloomLevel: plan.bloomLevel,
        isReview: plan.isReview,
        taskType: plan.suggestedTaskType ?? "explain",
        prompt: `Task ${log.written} on ${plan.conceptId}`,
        starterCode: code ? "export function f() {}\n" : null,
        rubric: [{ id: "c1", statement: "Is right" }],
        hiddenTests: code ? "SECRET TEST SOURCE" : null,
      };
    },
    async hint(_task, rung, prior, draft) {
      log.hints.push({ rung, prior: prior.length, draft });
      return `hint ${rung}`;
    },
    async clarify() {
      log.clarify++;
      return "It asks for f.";
    },
    async intakeFollowUp() {
      return "Have you written a recursive function?";
    },
    async extractClaims(_subject, transcript) {
      log.transcript = transcript;
      return [
        { conceptId: "call-stack", statement: "I know the call stack" },
        { conceptId: "call-stack", statement: "Stack frames hold locals" },
        { conceptId: "not-a-concept", statement: "x" },
      ];
    },
  };
  return { tutor, log };
}

// Passes when the answer contains PASS.
const grader: Grader = {
  async grade(task: Task, answer: string): Promise<Grade> {
    const passed = answer.includes("PASS");
    return {
      passed,
      gradedBy: "llm",
      graderConfidence: 0.9,
      criteria: [{ criterionId: "c1", pYes: passed ? 0.9 : 0.1 }],
      tests: task.hiddenTests ? { passed: passed ? 2 : 0, total: 2, output: "SECRET RUNNER OUTPUT" } : null,
      failedConceptId: passed ? null : task.conceptId,
    };
  },
};

let judgeFails = false;
const claimJudge: ClaimJudge = {
  level: async () => {
    if (judgeFails) throw new Error("judge down");
    return 2;
  },
};

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "cogload-cli-"));
  const store = new SqliteStore(join(dir, "test.db"));
  const workspace = join(dir, "workspace");
  const { tutor, log } = fakeTutor();
  let clock = Date.parse("2026-01-01T12:00:00Z");
  const session = (io: IO) =>
    new Session({
      store,
      concepts: new SeedConceptSource(),
      scheduler: new FixedLadderScheduler(config),
      planner: new RulesPlanner(config),
      tutor,
      grader,
      claimJudge,
      config,
      io,
      workspace,
      now: () => new Date((clock += 60_000)),
    });
  const cleanup = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  const errorLog = join(dir, "data", "errors.log");
  return { dir, store, workspace, log, session, cleanup, errorLog };
}

function answer(s: Session, workspace: string, text: string): void {
  assert.ok(s.current);
  writeFileSync(answerPath(workspace, s.current), text);
}

test("full loop: intake, pass, fail, forced fail, quit, restart, export", async () => {
  const { dir, store, workspace, log, session, cleanup } = setup();
  try {
    const io = new ScriptedIO(["I know some recursion", "Yes, factorial"]);
    const s = session(io);
    const cmd = (line: string) => runCommand(s, line, (t) => io.print(t), join(dir, "errors.log"));
    await s.start("ann");
    const userId = s.userId!;

    // Intake
    assert.match(userId, /^ann\+[0-9a-f-]{36}$/);
    assert.deepEqual(log.transcript, [
      "Tutor: What do you already know about recursion and dynamic programming?",
      "User: I know some recursion",
      "Tutor: Have you written a recursive function?",
      "User: Yes, factorial",
    ]);
    const claims = store.claims(userId);
    assert.equal(claims.length, 1);
    assert.deepEqual([claims[0]!.conceptId, claims[0]!.bloomLevel, claims[0]!.statement], ["call-stack", 2, "I know the call stack"]);

    // First task is a code task in the workspace, saved before it is shown
    const t1 = s.current!;
    assert.deepEqual(store.getTask(t1.id), t1);
    assert.ok(existsSync(join(workspace, t1.id, "TASK.md")));
    assert.equal(readFileSync(join(workspace, t1.id, "solution.ts"), "utf8"), t1.starterCode);
    assert.ok(!readFileSync(join(workspace, t1.id, "TASK.md"), "utf8").includes("SECRET"));

    // Pass, with one rejected confidence entry
    answer(s, workspace, "export function f() { return 'PASS'; }");
    io.queue("40", "75%", "0.75", "75");
    await cmd("submit");
    const a1 = store.attempts(userId).find((a) => a.taskId === t1.id)!;
    assert.equal(a1.outcome.kind, "submitted");
    if (a1.outcome.kind === "submitted") {
      assert.equal(a1.outcome.grade.passed, true);
      assert.equal(a1.outcome.confidence, 0.75);
      assert.equal(a1.outcome.durationMs, a1.recordedAt.getTime() - t1.issuedAt.getTime());
    }
    assert.ok(store.mastery(userId).length > 0);
    const shown = io.out.join("\n");
    assert.match(shown, /PASSED/);
    assert.match(shown, /Tests: 2\/2 passed/);
    assert.ok(!shown.includes("SECRET"));

    // Prose task, fail
    const t2 = s.current!;
    assert.ok(existsSync(join(workspace, t2.id, "answer.md")));
    answer(s, workspace, "wrong");
    io.queue("100");
    await cmd("submit");
    const a2 = store.attempts(userId).find((a) => a.taskId === t2.id)!;
    assert.ok(a2.outcome.kind === "submitted" && !a2.outcome.grade.passed);

    // Ask does not count as a hint; four hints force a fail on a passing answer
    const t3 = s.current!;
    await cmd("ask what should f return?");
    assert.equal(log.clarify, 1);
    await cmd("hint");
    answer(s, workspace, "draft PASS");
    await cmd("hint");
    await cmd("hint");
    await cmd("hint");
    await cmd("hint");
    assert.deepEqual(log.hints.map((h) => [h.rung, h.prior]), [[1, 0], [2, 1], [3, 2], [4, 3]]);
    assert.equal(log.hints[0]!.draft, null);
    assert.equal(log.hints[1]!.draft, "draft PASS");
    assert.match(io.out.at(-1)!, /No more hints/);
    io.queue("50");
    await cmd("submit");
    const a3 = store.attempts(userId).find((a) => a.taskId === t3.id)!;
    assert.equal(a3.hintsUsed, 4);
    assert.ok(a3.outcome.kind === "submitted" && !a3.outcome.grade.passed);
    assert.match(io.out.join("\n"), /full answer was given/);

    // Quit with an open task records an abandon with its hints
    const t4 = s.current!;
    await cmd("hint");
    await cmd("status");
    assert.match(io.out.at(-1)!, /hints used 1\/4/);
    await cmd("quit");
    assert.ok(s.done);
    const a4 = store.attempts(userId).find((a) => a.taskId === t4.id)!;
    assert.deepEqual([a4.outcome.kind, a4.hintsUsed], ["abandoned", 1]);
    assert.equal(store.openTasks(userId).length, 0);

    // A session that ends without quit leaves an open task; restart abandons it and skips intake
    const crashed = session(new ScriptedIO());
    await crashed.start("ann");
    const t5 = crashed.current!;
    await runCommand(crashed, "hint", () => {});
    await runCommand(crashed, "hint", () => {});
    assert.notEqual(crashed.sessionId, s.sessionId);
    assert.deepEqual(store.openTasks(userId).map((t) => t.id), [t5.id]);

    const restarted = session(new ScriptedIO());
    await restarted.start("ann");
    const a5 = store.attempts(userId).find((a) => a.taskId === t5.id)!;
    assert.deepEqual([a5.outcome.kind, a5.hintsUsed], ["abandoned", 2]);
    assert.equal(store.claims(userId).length, 1);

    // Rungs come from the store per task, so the new task starts at rung 1
    const t6 = restarted.current!;
    await runCommand(restarted, "hint", () => {});
    assert.deepEqual(store.hints(t6.id).map((h) => h.rung), [1]);
    assert.deepEqual(log.hints.at(-1)!.prior, 0);
    restarted.quit();
    assert.equal(store.attempts(userId).find((a) => a.taskId === t6.id)!.hintsUsed, 1);

    // Export joins every task with its attempt
    const path = join(dir, "data", "export.jsonl");
    const count = writeExport(store, [userId], path);
    const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(count, 6);
    assert.equal(lines.length, 6);
    assert.deepEqual(lines.map((r) => r.outcome), ["submitted", "submitted", "submitted", "abandoned", "abandoned", "abandoned"]);
    assert.deepEqual(lines.slice(0, 3).map((r) => r.passed), [true, false, false]);
    assert.deepEqual(lines[0].taskId, t1.id);
    assert.equal(lines[0].confidence, 0.75);
    assert.equal(lines[3].answer, null);
    assert.deepEqual(lines[2].hints.map((h: { rung: number }) => h.rung), [1, 2, 3, 4]);
    assert.deepEqual(lines[0].hints, []);
    assert.deepEqual(exportRows(store, [userId]), lines);
  } finally {
    cleanup();
  }
});

test("unknown commands print help and errors do not end the session", async () => {
  const { session, cleanup, errorLog } = setup();
  try {
    const io = new ScriptedIO(["nothing", "no"]);
    const s = session(io);
    await s.start("bob");
    await runCommand(s, "dance", (t) => io.print(t), errorLog);
    assert.match(io.out.at(-1)!, /Commands:/);

    // Submitting with no confidence answer queued makes the prompt throw.
    await runCommand(s, "submit", (t) => io.print(t), errorLog);
    assert.match(io.out.at(-2)!, /^Something went wrong/);
    assert.match(io.out.at(-1)!, /Try the command again/);
    assert.match(readFileSync(errorLog, "utf8"), /unexpected prompt/);
    assert.ok(s.current);
    assert.ok(!s.done);
    s.quit();
  } finally {
    cleanup();
  }
});

test("a tutor failure after submit is logged, not shown, and next recovers", async () => {
  const { store, workspace, log, session, cleanup, errorLog } = setup();
  try {
    const io = new ScriptedIO(["nothing", "no"]);
    const s = session(io);
    const cmd = (line: string) => runCommand(s, line, (t) => io.print(t), errorLog);
    await s.start("cat");
    const t1 = s.current!;

    await cmd("next");
    assert.match(io.out.at(-1)!, /already open/);
    assert.equal(s.current!.id, t1.id);

    answer(s, workspace, "PASS");
    io.queue("50");
    log.failWrites = 1;
    await cmd("submit");
    assert.equal(s.current, null);
    assert.equal(store.attempts(s.userId!).length, 1);
    assert.match(io.out.at(-1)!, /Type next/);

    const shown = io.out.join("\n");
    assert.ok(!shown.includes("SECRET"));
    assert.match(readFileSync(errorLog, "utf8"), /SECRET RUBRIC/);

    await cmd("next");
    const after = (s as Session).current;
    assert.ok(after);
    assert.notEqual(after.id, t1.id);
    s.quit();
  } finally {
    cleanup();
  }
});

test("a claim judge failure during intake saves no claims", async () => {
  const { store, session, cleanup } = setup();
  try {
    judgeFails = true;
    const s = session(new ScriptedIO(["I know stacks", "frames"]));
    await assert.rejects(s.begin("dee"), /judge down/);
    assert.equal(store.claims(s.userId!).length, 0);
  } finally {
    judgeFails = false;
    cleanup();
  }
});

// Answers each prompt with the next line, then closes input.
function scriptedStreams(lines: string[]) {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk: Buffer) => {
    text += chunk.toString();
    if (!text.endsWith("> ")) return;
    const next = lines.shift();
    if (next === undefined) input.end();
    else input.write(next + "\n");
  });
  return { input, output, text: () => text };
}

test("closing input mid-task abandons the open task", async () => {
  const { store, session, cleanup, errorLog } = setup();
  try {
    const streams = scriptedStreams(["I know stacks", "frames", "hint", "status"]);
    let s: Session | undefined;
    await runRepl((io) => (s = session(io)), { ...streams, username: "eve", errorLog });

    assert.ok(s?.done);
    const attempts = store.attempts(s.userId!);
    assert.equal(attempts.length, 1);
    assert.deepEqual([attempts[0]!.outcome.kind, attempts[0]!.hintsUsed], ["abandoned", 1]);
    assert.equal(store.openTasks(s.userId!).length, 0);
    assert.match(streams.text(), /Hint 1\/4/);
  } finally {
    cleanup();
  }
});

test("closing input during the confidence prompt abandons the task", async () => {
  const { store, session, cleanup, errorLog } = setup();
  try {
    const streams = scriptedStreams(["I know stacks", "frames", "submit"]);
    let s: Session | undefined;
    await runRepl((io) => (s = session(io)), { ...streams, username: "fay", errorLog });

    const attempts = store.attempts(s!.userId!);
    assert.deepEqual(attempts.map((a) => a.outcome.kind), ["abandoned"]);
    assert.ok(!existsSync(errorLog));
  } finally {
    cleanup();
  }
});

test("export with no users given covers every user", async () => {
  const { dir, store, session, cleanup } = setup();
  try {
    for (const name of ["gus", "hal"]) {
      const s = session(new ScriptedIO(["nothing", "no"]));
      await s.start(name);
      s.quit();
    }
    const path = join(dir, "data", "export.jsonl");
    assert.equal(writeExport(store, undefined, path), 2);
    const users = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l).userId);
    assert.deepEqual(users.sort(), store.users().sort());
    assert.equal(new Set(users).size, 2);
  } finally {
    cleanup();
  }
});
