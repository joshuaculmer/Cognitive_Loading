// Line-based REPL over a Session. Works on any input/output stream pair.

import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { DEFAULT_ERROR_LOG, genericError, logError } from "./errors";
import type { IO, Session } from "./session";

export const HELP = "Commands: ask <question>, hint, submit, next, status, quit";

// Thrown by a prompt when input closes (Ctrl+C or end of input).
export class InputClosed extends Error {}

export async function runCommand(session: Session, line: string, print: (text: string) => void, errorLog = DEFAULT_ERROR_LOG): Promise<void> {
  const trimmed = line.trim();
  const cmd = trimmed.split(/\s+/)[0];

  await guard(session, print, errorLog, async () => {
    switch (cmd) {
      case "":
        return;
      case "ask":
        return session.ask(trimmed.slice(3).trim());
      case "hint":
        return session.hint();
      case "submit":
        return session.submit();
      case "next":
        return session.next();
      case "status":
        return session.status();
      case "quit":
        return session.quit();
      default:
        print(HELP);
    }
  });
}

// Logs the error and shows a generic message with the way forward.
async function guard(session: Session, print: (text: string) => void, errorLog: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof InputClosed) throw err;
    logError(errorLog, err);
    print(genericError(errorLog));
    if (!session.done) print(session.current ? "Try the command again." : "Type next to get a new task.");
  }
}

export interface ReplOptions {
  input: Readable;
  output: Writable;
  username?: string;
  errorLog?: string;
}

// Runs until quit or input closes. Closing with an open task abandons it.
export async function runRepl(makeSession: (io: IO) => Session, opts: ReplOptions): Promise<void> {
  const errorLog = opts.errorLog ?? DEFAULT_ERROR_LOG;
  const rl = createInterface({ input: opts.input, output: opts.output });
  const closed = new Promise<null>((resolve) => rl.once("close", () => resolve(null)));
  rl.on("SIGINT", () => rl.close());

  const print = (text: string) => opts.output.write(text + "\n");
  const prompt = async (q: string) => {
    let pending: Promise<string | null>;
    try {
      pending = rl.question(q).catch(() => null);
    } catch {
      pending = Promise.resolve(null);
    }
    const answer = await Promise.race([pending, closed]);
    if (answer === null) throw new InputClosed();
    return answer;
  };
  const session = makeSession({ prompt, print });

  try {
    const username = opts.username?.trim() || (await prompt("Username: ")).trim();
    if (!username) {
      print("A username is required.");
      return;
    }

    try {
      await session.begin(username);
    } catch (err) {
      if (err instanceof InputClosed) throw err;
      logError(errorLog, err);
      print(genericError(errorLog));
      session.done = true;
      return;
    }

    await guard(session, print, errorLog, () => session.nextTask());
    if (!session.done) print(HELP);
    while (!session.done) await runCommand(session, await prompt("> "), print, errorLog);
  } catch (err) {
    if (!(err instanceof InputClosed)) throw err;
  } finally {
    if (!session.done && session.userId) session.quit();
    rl.close();
  }
}
