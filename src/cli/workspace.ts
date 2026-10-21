// Per-task folders the user edits in their own editor (SPEC §6.6).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Task } from "../types";

export const DEFAULT_WORKSPACE = "workspace";

export function isCodeTask(task: Task): boolean {
  return task.starterCode !== null || task.hiddenTests !== null;
}

export function taskDir(root: string, task: Task): string {
  return join(root, task.id);
}

export function answerPath(root: string, task: Task): string {
  return join(taskDir(root, task), isCodeTask(task) ? "solution.ts" : "answer.md");
}

export function writeTaskFiles(root: string, task: Task): void {
  const dir = taskDir(root, task);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "TASK.md"), taskMarkdown(task));
  writeFileSync(answerPath(root, task), isCodeTask(task) ? (task.starterCode ?? "") : "");
}

export function readAnswer(root: string, task: Task): string {
  return readFileSync(answerPath(root, task), "utf8");
}

// The user's work so far, or null if they have not changed the file.
export function readDraft(root: string, task: Task): string | null {
  const text = readAnswer(root, task);
  const initial = isCodeTask(task) ? (task.starterCode ?? "") : "";
  return text.trim() === "" || text === initial ? null : text;
}

function taskMarkdown(task: Task): string {
  const file = isCodeTask(task) ? "solution.ts" : "answer.md";
  return [
    `# Task ${task.id}`,
    "",
    `Concept: ${task.conceptId} · Level: ${task.bloomLevel} · Type: ${task.taskType}${task.isReview ? " · Review" : ""}`,
    "",
    task.prompt,
    "",
    `Write your answer in \`${file}\`, then type \`submit\`.`,
    "",
  ].join("\n");
}
