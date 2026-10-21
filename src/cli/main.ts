// Composition root. Run with `npm start [-- <username>]`.

import { stdin, stdout } from "node:process";
import { config } from "../config";
import { SeedConceptSource } from "../concepts";
import { createClaimJudge, createGrader } from "../grader";
import { RulesPlanner } from "../planner";
import { FixedLadderScheduler } from "../scheduler";
import { DEFAULT_DB_PATH, SqliteStore } from "../store";
import { ClaudeTutor } from "../tutor";
import { DEFAULT_ERROR_LOG, genericError, logError } from "./errors";
import { runRepl } from "./repl";
import { Session } from "./session";
import { DEFAULT_WORKSPACE } from "./workspace";

function missingEnv(): string[] {
  const keys = ["ANTHROPIC_API_KEY", ...(config.grader === "jev" ? ["TYPESAFE_API_KEY"] : [])];
  return keys.filter((k) => !process.env[k]);
}

async function main(): Promise<void> {
  const missing = missingEnv();
  if (missing.length) {
    console.error(`Missing env vars: ${missing.join(", ")}`);
    if (config.grader === "jev") console.error('Set config.grader = "llm" in src/config.ts to run without Jev.');
    process.exitCode = 1;
    return;
  }

  const store = new SqliteStore(DEFAULT_DB_PATH);
  try {
    const deps = {
      store,
      concepts: new SeedConceptSource(),
      scheduler: new FixedLadderScheduler(config),
      planner: new RulesPlanner(config),
      tutor: new ClaudeTutor(),
      grader: createGrader(config),
      claimJudge: createClaimJudge(config),
      config,
      workspace: DEFAULT_WORKSPACE,
    };
    await runRepl((io) => new Session({ ...deps, io }), { input: stdin, output: stdout, username: process.argv[2] });
  } finally {
    store.close();
  }
}

main()
  .catch((err) => {
    logError(DEFAULT_ERROR_LOG, err);
    console.error(genericError(DEFAULT_ERROR_LOG));
    process.exitCode = 1;
  })
  .finally(() => process.exit());
