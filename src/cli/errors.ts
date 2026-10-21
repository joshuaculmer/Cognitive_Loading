// Error details go to a file, since they can contain hidden tests or rubric text (SPEC §6.6).

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_ERROR_LOG = "data/errors.log";

export function logError(path: string, err: unknown): void {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `[${new Date().toISOString()}] ${detail}\n\n`);
}

export function genericError(path: string): string {
  return `Something went wrong. Details are in ${path}.`;
}
