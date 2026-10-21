// One learning session (SPEC §2). The REPL is a thin shell over this class.

import { randomUUID } from "node:crypto";
import type { Config } from "../config";
import type { ConceptSource } from "../concepts";
import type { ClaimJudge, Grader } from "../grader";
import type { Planner } from "../planner";
import { rebuildMastery, type Scheduler } from "../scheduler";
import type { Store } from "../store";
import type { HintRung, Tutor } from "../tutor";
import type { Attempt, Claim, Grade, Task, UserId } from "../types";
import { answerPath, readAnswer, readDraft, writeTaskFiles } from "./workspace";

export const SUBJECT = "recursion and dynamic programming";

export const INTAKE_QUESTION = `What do you already know about ${SUBJECT}?`;

// 0, 12.5 … 100
export const CONFIDENCE_STEPS = Array.from({ length: 9 }, (_, i) => i * 12.5);

export interface IO {
  prompt(question: string): Promise<string>;
  print(text: string): void;
}

export interface SessionDeps {
  store: Store;
  concepts: ConceptSource;
  scheduler: Scheduler;
  planner: Planner;
  tutor: Tutor;
  grader: Grader;
  claimJudge: ClaimJudge;
  config: Pick<Config, "rollingWindow" | "passThreshold">;
  io: IO;
  workspace: string;
  now?: () => Date;
}

export class Session {
  readonly sessionId = randomUUID();
  userId: UserId | null = null;
  current: Task | null = null;
  done = false;

  private readonly now: () => Date;

  constructor(private readonly d: SessionDeps) {
    this.now = d.now ?? (() => new Date());
  }

  // Steps 1–3: user, intake, abandon leftovers.
  async begin(username: string): Promise<void> {
    const { store } = this.d;
    const userId = store.findUser(username) ?? store.createUser(username);
    this.userId = userId;
    this.d.io.print(`User ${userId}, session ${this.sessionId}`);

    if (store.tasks(userId).length === 0 && store.claims(userId).length === 0) await this.intake();

    for (const task of store.openTasks(userId)) this.abandon(task);
  }

  async start(username: string): Promise<void> {
    await this.begin(username);
    await this.nextTask();
  }

  async intake(): Promise<void> {
    const { tutor, io, concepts, claimJudge, store } = this.d;
    const userId = this.requireUser();

    const first = await io.prompt(`${INTAKE_QUESTION}\n> `);
    const followUp = await tutor.intakeFollowUp(SUBJECT, first);
    const second = await io.prompt(`Tutor: ${followUp}\n> `);
    const transcript = [`Tutor: ${INTAKE_QUESTION}`, `User: ${first}`, `Tutor: ${followUp}`, `User: ${second}`];

    const extracted = await tutor.extractClaims(SUBJECT, transcript, concepts.all());

    // Level every claim before saving any, so a judge failure saves nothing.
    const claims = new Map<string, Claim>();
    for (const { conceptId, statement } of extracted) {
      const concept = concepts.get(conceptId);
      if (!concept) continue;
      const bloomLevel = await claimJudge.level(concept, statement);
      const key = `${conceptId}|${bloomLevel}`;
      if (!claims.has(key)) {
        claims.set(key, { id: randomUUID(), userId, conceptId, bloomLevel, statement, claimedAt: this.now() });
      }
    }
    store.saveClaims([...claims.values()]);
    io.print(`Recorded ${claims.size} claim(s).`);
  }

  async nextTask(): Promise<void> {
    const { store, concepts, planner, tutor, io, workspace, config } = this.d;
    const userId = this.requireUser();
    const history = store.history(userId);
    const mastery = store.mastery(userId);
    const claims = store.claims(userId);

    const plan = planner.next({
      sessionId: this.sessionId,
      now: this.now(),
      concepts: concepts.all(),
      mastery,
      claims,
      history,
    });
    if (!plan) {
      this.done = true;
      io.print("Session complete.");
      return;
    }

    const written = await tutor.writeTask(plan, {
      subject: SUBJECT,
      concepts: concepts.all(),
      mastery,
      claims,
      recent: history.slice(-config.rollingWindow),
    });
    const task: Task = { ...written, id: randomUUID(), userId, sessionId: this.sessionId, issuedAt: this.now() };
    store.saveTask(task);
    writeTaskFiles(workspace, task);
    this.current = task;

    io.print(
      `\nNew task: ${task.conceptId}, level ${task.bloomLevel}, ${task.taskType}${task.isReview ? " (review)" : ""}\n` +
        `${task.prompt}\n\nEdit ${answerPath(workspace, task)}, then type submit.`,
    );
  }

  // Retries planning and task writing after a failure.
  async next(): Promise<void> {
    if (this.done) return;
    if (this.current) {
      this.d.io.print("A task is already open.");
      return;
    }
    await this.nextTask();
  }

  async hint(): Promise<void> {
    const task = this.requireTask();
    if (!task) return;
    const prior = this.d.store.hints(task.id);
    const rung = prior.length + 1;
    if (rung > 4) {
      this.d.io.print("No more hints for this task.");
      return;
    }

    const text = await this.d.tutor.hint(task, rung as HintRung, prior.map((h) => h.text), readDraft(this.d.workspace, task));
    this.d.store.saveHint({ id: randomUUID(), taskId: task.id, userId: task.userId, rung: rung as HintRung, text, givenAt: this.now() });
    this.d.io.print(`Hint ${rung}/4: ${text}`);
    if (rung === 3) this.d.io.print("The next hint gives the full answer and fails this task.");
  }

  async ask(question: string): Promise<void> {
    const task = this.requireTask();
    if (!task) return;
    if (!question.trim()) {
      this.d.io.print("Usage: ask <question>");
      return;
    }
    this.d.io.print(`Tutor: ${await this.d.tutor.clarify(task, question)}`);
  }

  // Steps 8–10. Confidence comes before any grade is shown.
  async submit(): Promise<void> {
    const task = this.requireTask();
    if (!task) return;
    const { store, scheduler, grader, concepts, workspace } = this.d;
    const hints = store.hints(task.id);

    const answer = readAnswer(workspace, task);
    const confidence = await this.askConfidence();
    let grade = await grader.grade(task, answer, concepts.all());
    const forcedFail = hints.some((h) => h.rung === 4);
    if (forcedFail) grade = { ...grade, passed: false };

    const recordedAt = this.now();
    store.saveAttempt({
      id: randomUUID(),
      taskId: task.id,
      userId: task.userId,
      hintsUsed: hints.length,
      outcome: {
        kind: "submitted",
        answer,
        confidence,
        durationMs: recordedAt.getTime() - task.issuedAt.getTime(),
        grade,
      },
      recordedAt,
    });
    rebuildMastery(store, scheduler, task.userId, recordedAt);
    this.current = null;

    this.d.io.print(formatGrade(task, grade, forcedFail, this.d.config.passThreshold));
    await this.nextTask();
  }

  status(): void {
    const { store, io } = this.d;
    const userId = this.requireUser();
    const lines = [`User ${userId}`, `Session ${this.sessionId}`];

    if (this.current) {
      const task = this.current;
      lines.push(`Task: ${task.conceptId}, level ${task.bloomLevel}, ${task.taskType}, hints used ${store.hints(task.id).length}/4`);
      lines.push(`File: ${answerPath(this.d.workspace, task)}`);
    } else {
      lines.push("No open task.");
    }

    const done = store.history(userId).filter((h) => h.task.sessionId === this.sessionId).length;
    lines.push(`Tasks finished this session: ${done}`);

    const mastery = store.mastery(userId);
    lines.push(mastery.length ? "Mastery:" : "Mastery: none yet");
    for (const m of mastery) {
      lines.push(`  ${m.conceptId} L${m.bloomLevel}: step ${m.ladderStep}, next review ${m.nextReviewAt.toISOString().slice(0, 10)}`);
    }
    lines.push(`Claims: ${store.claims(userId).length}`);
    io.print(lines.join("\n"));
  }

  // Step 11.
  quit(): void {
    if (this.current) this.abandon(this.current);
    this.current = null;
    this.done = true;
  }

  private abandon(task: Task): void {
    const attempt: Attempt = {
      id: randomUUID(),
      taskId: task.id,
      userId: task.userId,
      hintsUsed: this.d.store.hints(task.id).length,
      outcome: { kind: "abandoned" },
      recordedAt: this.now(),
    };
    this.d.store.saveAttempt(attempt);
  }

  private async askConfidence(): Promise<number> {
    const options = CONFIDENCE_STEPS.join(", ");
    for (;;) {
      const raw = (await this.d.io.prompt(`How confident are you that this passes? (${options})\n> `)).trim();
      if (CONFIDENCE_STEPS.map(String).includes(raw)) return Number(raw) / 100;
      this.d.io.print(`Enter one of: ${options}`);
    }
  }

  private requireUser(): UserId {
    if (!this.userId) throw new Error("session not started");
    return this.userId;
  }

  private requireTask(): Task | null {
    if (!this.current) this.d.io.print("No open task.");
    return this.current;
  }
}

// Shows results without hidden test source or runner output.
export function formatGrade(task: Task, grade: Grade, forcedFail: boolean, passThreshold: number): string {
  const lines = [grade.passed ? "PASSED" : "FAILED"];
  if (forcedFail) lines.push("The full answer was given as a hint, so this task counts as failed.");
  if (grade.tests) lines.push(`Tests: ${grade.tests.passed}/${grade.tests.total} passed`);
  for (const c of grade.criteria) {
    const statement = task.rubric.find((r) => r.id === c.criterionId)?.statement ?? c.criterionId;
    lines.push(`  [${c.pYes >= passThreshold ? "x" : " "}] ${statement} (${c.pYes.toFixed(2)})`);
  }
  return lines.join("\n");
}
