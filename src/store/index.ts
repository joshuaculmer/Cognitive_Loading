import type { Attempt, Claim, Hint, Mastery, Task, UserId } from "../types";

export interface Store {
  findUser(username: string): UserId | undefined;
  createUser(username: string): UserId;
  users(): UserId[];

  saveTask(task: Task): void;
  getTask(id: string): Task | undefined;
  tasks(userId: UserId): Task[];
  openTasks(userId: UserId): Task[];            // tasks with no attempt

  saveAttempt(attempt: Attempt): void;
  attempts(userId: UserId): Attempt[];
  history(userId: UserId): { task: Task; attempt: Attempt }[];   // ordered by recordedAt

  saveHint(hint: Hint): void;
  hints(taskId: string): Hint[];                // ordered by givenAt

  saveClaim(claim: Claim): void;
  saveClaims(claims: Claim[]): void;           // all or nothing
  claims(userId: UserId): Claim[];

  mastery(userId: UserId): Mastery[];
  replaceMastery(userId: UserId, rows: Mastery[]): void;

  close(): void;
}

export { SqliteStore, DEFAULT_DB_PATH } from "./sqlite";
