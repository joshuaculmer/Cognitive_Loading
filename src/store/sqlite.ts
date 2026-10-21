import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type { Store } from "./index";
import type { Attempt, BloomLevel, Claim, Grade, Hint, Mastery, Task, TaskType, UserId } from "../types";

export const DEFAULT_DB_PATH = "data/cogload.db";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  username    TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  session_id    TEXT NOT NULL,
  concept_id    TEXT NOT NULL,
  bloom_level   INTEGER NOT NULL CHECK (bloom_level BETWEEN 1 AND 6),
  task_type     TEXT NOT NULL,
  is_review     INTEGER NOT NULL CHECK (is_review IN (0, 1)),
  prompt        TEXT NOT NULL,
  starter_code  TEXT,
  rubric        TEXT NOT NULL,
  hidden_tests  TEXT,
  issued_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attempts (
  id                 TEXT PRIMARY KEY,
  task_id            TEXT NOT NULL UNIQUE REFERENCES tasks(id),
  user_id            TEXT NOT NULL REFERENCES users(id),
  hints_used         INTEGER NOT NULL CHECK (hints_used >= 0),
  kind               TEXT NOT NULL CHECK (kind IN ('submitted', 'abandoned')),
  answer             TEXT,
  confidence         REAL CHECK (confidence BETWEEN 0 AND 1),
  duration_ms        INTEGER,
  passed             INTEGER CHECK (passed IN (0, 1)),
  graded_by          TEXT CHECK (graded_by IN ('tests', 'jev', 'llm')),
  grader_confidence  REAL CHECK (grader_confidence BETWEEN 0 AND 1),
  criteria           TEXT,
  tests              TEXT,
  failed_concept_id  TEXT,
  recorded_at        TEXT NOT NULL,
  CHECK (
    (kind = 'submitted'
      AND answer IS NOT NULL AND confidence IS NOT NULL AND duration_ms IS NOT NULL
      AND passed IS NOT NULL AND graded_by IS NOT NULL
      AND grader_confidence IS NOT NULL AND criteria IS NOT NULL)
    OR
    (kind = 'abandoned'
      AND answer IS NULL AND confidence IS NULL AND duration_ms IS NULL
      AND passed IS NULL AND graded_by IS NULL AND grader_confidence IS NULL
      AND criteria IS NULL AND tests IS NULL AND failed_concept_id IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS hints (
  id        TEXT PRIMARY KEY,
  task_id   TEXT NOT NULL REFERENCES tasks(id),
  user_id   TEXT NOT NULL REFERENCES users(id),
  rung      INTEGER NOT NULL CHECK (rung BETWEEN 1 AND 4),
  text      TEXT NOT NULL,
  given_at  TEXT NOT NULL,
  UNIQUE (task_id, rung)
);

CREATE TABLE IF NOT EXISTS claims (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  concept_id   TEXT NOT NULL,
  bloom_level  INTEGER NOT NULL CHECK (bloom_level BETWEEN 1 AND 6),
  statement    TEXT NOT NULL,
  claimed_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mastery (
  user_id           TEXT NOT NULL REFERENCES users(id),
  concept_id        TEXT NOT NULL,
  bloom_level       INTEGER NOT NULL CHECK (bloom_level BETWEEN 1 AND 6),
  last_verified_at  TEXT NOT NULL,
  next_review_at    TEXT NOT NULL,
  ladder_step       INTEGER NOT NULL CHECK (ladder_step >= 0),
  PRIMARY KEY (user_id, concept_id, bloom_level)
);

CREATE INDEX IF NOT EXISTS attempts_user ON attempts(user_id, recorded_at);
CREATE INDEX IF NOT EXISTS tasks_user ON tasks(user_id, issued_at);

CREATE INDEX IF NOT EXISTS hints_task ON hints(task_id, given_at);

CREATE TRIGGER IF NOT EXISTS attempts_user_matches_task BEFORE INSERT ON attempts
WHEN NEW.user_id IS NOT (SELECT user_id FROM tasks WHERE id = NEW.task_id)
BEGIN SELECT RAISE(ABORT, 'attempt user_id must match its task'); END;

CREATE TRIGGER IF NOT EXISTS hints_user_matches_task BEFORE INSERT ON hints
WHEN NEW.user_id IS NOT (SELECT user_id FROM tasks WHERE id = NEW.task_id)
BEGIN SELECT RAISE(ABORT, 'hint user_id must match its task'); END;
`;

// Rejects UPDATE and DELETE on the insert-only tables.
const INSERT_ONLY = ["tasks", "attempts", "hints", "claims"]
  .flatMap((t) =>
    ["UPDATE", "DELETE"].map(
      (op) => `
CREATE TRIGGER IF NOT EXISTS ${t}_no_${op.toLowerCase()} BEFORE ${op} ON ${t}
BEGIN SELECT RAISE(ABORT, '${t} is insert-only'); END;`,
    ),
  )
  .join("\n");

type Row = Record<string, unknown>;

export class SqliteStore implements Store {
  private readonly db: Database.Database;

  constructor(path: string = DEFAULT_DB_PATH) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA + INSERT_ONLY);
  }

  findUser(username: string): UserId | undefined {
    const row = this.db.prepare("SELECT id FROM users WHERE username = ?").get(username) as Row | undefined;
    return row ? (row.id as string) : undefined;
  }

  createUser(username: string): UserId {
    const id = `${username}+${randomUUID()}`;
    this.db
      .prepare("INSERT INTO users (id, username, created_at) VALUES (?, ?, ?)")
      .run(id, username, new Date().toISOString());
    return id;
  }

  users(): UserId[] {
    return this.all("SELECT id FROM users ORDER BY created_at, rowid").map((r) => r.id as string);
  }

  saveTask(t: Task): void {
    this.db
      .prepare(
        `INSERT INTO tasks (id, user_id, session_id, concept_id, bloom_level, task_type, is_review,
           prompt, starter_code, rubric, hidden_tests, issued_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.id, t.userId, t.sessionId, t.conceptId, t.bloomLevel, t.taskType, t.isReview ? 1 : 0,
        t.prompt, t.starterCode, JSON.stringify(t.rubric), t.hiddenTests, t.issuedAt.toISOString(),
      );
  }

  getTask(id: string): Task | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined;
    return row ? toTask(row) : undefined;
  }

  tasks(userId: UserId): Task[] {
    return this.all("SELECT * FROM tasks WHERE user_id = ? ORDER BY issued_at, rowid", userId).map(toTask);
  }

  openTasks(userId: UserId): Task[] {
    return this.all(
      `SELECT * FROM tasks t WHERE t.user_id = ?
         AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.task_id = t.id)
       ORDER BY t.issued_at, t.rowid`,
      userId,
    ).map(toTask);
  }

  saveAttempt(a: Attempt): void {
    const o = a.outcome;
    const s = o.kind === "submitted" ? o : null;
    const g = s?.grade ?? null;
    this.db
      .prepare(
        `INSERT INTO attempts (id, task_id, user_id, hints_used, kind, answer, confidence, duration_ms,
           passed, graded_by, grader_confidence, criteria, tests, failed_concept_id, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        a.id, a.taskId, a.userId, a.hintsUsed, o.kind,
        s?.answer ?? null,
        s?.confidence ?? null,
        s?.durationMs ?? null,
        g ? (g.passed ? 1 : 0) : null,
        g?.gradedBy ?? null,
        g?.graderConfidence ?? null,
        g ? JSON.stringify(g.criteria) : null,
        g?.tests ? JSON.stringify(g.tests) : null,
        g?.failedConceptId ?? null,
        a.recordedAt.toISOString(),
      );
  }

  attempts(userId: UserId): Attempt[] {
    return this.all("SELECT * FROM attempts WHERE user_id = ? ORDER BY recorded_at, rowid", userId).map(toAttempt);
  }

  history(userId: UserId): { task: Task; attempt: Attempt }[] {
    const tasks = new Map(this.tasks(userId).map((t) => [t.id, t]));
    return this.attempts(userId).map((attempt) => {
      const task = tasks.get(attempt.taskId);
      if (!task) throw new Error(`attempt ${attempt.id} has no task for user ${userId}`);
      return { task, attempt };
    });
  }

  saveHint(h: Hint): void {
    this.db
      .prepare("INSERT INTO hints (id, task_id, user_id, rung, text, given_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(h.id, h.taskId, h.userId, h.rung, h.text, h.givenAt.toISOString());
  }

  hints(taskId: string): Hint[] {
    return this.all("SELECT * FROM hints WHERE task_id = ? ORDER BY given_at, rowid", taskId).map((r) => ({
      id: r.id as string,
      taskId: r.task_id as string,
      userId: r.user_id as string,
      rung: r.rung as Hint["rung"],
      text: r.text as string,
      givenAt: new Date(r.given_at as string),
    }));
  }

  saveClaim(c: Claim): void {
    this.db
      .prepare(
        `INSERT INTO claims (id, user_id, concept_id, bloom_level, statement, claimed_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(c.id, c.userId, c.conceptId, c.bloomLevel, c.statement, c.claimedAt.toISOString());
  }

  saveClaims(claims: Claim[]): void {
    this.db.transaction(() => claims.forEach((c) => this.saveClaim(c)))();
  }

  claims(userId: UserId): Claim[] {
    return this.all("SELECT * FROM claims WHERE user_id = ? ORDER BY claimed_at, rowid", userId).map((r) => ({
      id: r.id as string,
      userId: r.user_id as string,
      conceptId: r.concept_id as string,
      bloomLevel: r.bloom_level as BloomLevel,
      statement: r.statement as string,
      claimedAt: new Date(r.claimed_at as string),
    }));
  }

  mastery(userId: UserId): Mastery[] {
    return this.all("SELECT * FROM mastery WHERE user_id = ? ORDER BY concept_id, bloom_level", userId).map((r) => ({
      userId: r.user_id as string,
      conceptId: r.concept_id as string,
      bloomLevel: r.bloom_level as BloomLevel,
      lastVerifiedAt: new Date(r.last_verified_at as string),
      nextReviewAt: new Date(r.next_review_at as string),
      ladderStep: r.ladder_step as number,
    }));
  }

  replaceMastery(userId: UserId, rows: Mastery[]): void {
    const del = this.db.prepare("DELETE FROM mastery WHERE user_id = ?");
    const ins = this.db.prepare(
      `INSERT INTO mastery (user_id, concept_id, bloom_level, last_verified_at, next_review_at, ladder_step)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      del.run(userId);
      for (const m of rows) {
        if (m.userId !== userId) throw new Error(`mastery row for ${m.userId} passed to ${userId}`);
        ins.run(
          m.userId, m.conceptId, m.bloomLevel,
          m.lastVerifiedAt.toISOString(), m.nextReviewAt.toISOString(), m.ladderStep,
        );
      }
    })();
  }

  close(): void {
    this.db.close();
  }

  private all(sql: string, ...params: unknown[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }
}

function toTask(r: Row): Task {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    sessionId: r.session_id as string,
    conceptId: r.concept_id as string,
    bloomLevel: r.bloom_level as BloomLevel,
    taskType: r.task_type as TaskType,
    isReview: r.is_review === 1,
    prompt: r.prompt as string,
    starterCode: (r.starter_code as string | null) ?? null,
    rubric: JSON.parse(r.rubric as string),
    hiddenTests: (r.hidden_tests as string | null) ?? null,
    issuedAt: new Date(r.issued_at as string),
  };
}

function toAttempt(r: Row): Attempt {
  const base = {
    id: r.id as string,
    taskId: r.task_id as string,
    userId: r.user_id as string,
    hintsUsed: r.hints_used as number,
    recordedAt: new Date(r.recorded_at as string),
  };
  if (r.kind === "abandoned") return { ...base, outcome: { kind: "abandoned" } };
  return {
    ...base,
    outcome: {
      kind: "submitted",
      answer: r.answer as string,
      confidence: r.confidence as number,
      durationMs: r.duration_ms as number,
      grade: {
        passed: r.passed === 1,
        gradedBy: r.graded_by as Grade["gradedBy"],
        graderConfidence: r.grader_confidence as number,
        criteria: JSON.parse(r.criteria as string),
        tests: r.tests == null ? null : JSON.parse(r.tests as string),
        failedConceptId: (r.failed_concept_id as string | null) ?? null,
      },
    },
  };
}
