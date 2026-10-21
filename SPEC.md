# Cognitive Loading — v0 Spec

v0 is a tracer bullet. It runs the full learning loop end to end with the simplest implementation behind each interface. Every module must be easy to change (ETC). Swapping an implementation must not touch other modules.

See `README.md` for motivation and `Socratic_Teaching.md.md` for the teaching style the tutor builds on.

## 1. Scope

### In scope

- One user at a time, local CLI
- One hand-written concept graph (§8)
- Full loop: intake → task → hints → submit → confidence → grade → schedule → next task
- Append-only attempt log, exportable for analysis

### Out of scope (v0)

- Web app, multiple concurrent users, auth
- Generated concept graphs (wikifeed integration, §11)
- FSRS or any adaptive scheduling algorithm
- Cognitive-load stopping rules beyond simple caps
- Analysis (Brier scores, calibration curves). v0 only exports the data.

## 2. Core loop

1. User starts a session with a username. New usernames get a GUID.
2. First session on the subject runs intake. The CLI asks what the user knows. The tutor asks one follow-up. The tutor extracts claims (§6.5).
3. Any task left open from a previous session gets an abandoned attempt.
4. The planner picks what to work on (§6.2).
5. The tutor writes the task, rubric, and hidden tests together. The store saves the task before the user sees it.
6. The CLI writes the task to the workspace. The user works in their own editor.
7. The user may request hints (§6.3).
8. The user submits. The CLI asks for confidence on the 9-point scale before showing any grade.
9. The grader grades (§6.4). The store appends the attempt. The scheduler updates mastery.
10. The CLI shows the grade. Loop to step 4 until a cap is hit or the user quits.
11. Quitting with an open task records an abandoned attempt.

## 3. Data model

This section is the shared contract. It lives in `src/types.ts`. Changes require the user's approval.

```ts
type UserId = string;                   // "<username>+<guid>"

// 1 remember, 2 understand, 3 apply, 4 analyze, 5 evaluate, 6 create
type BloomLevel = 1 | 2 | 3 | 4 | 5 | 6;

interface Concept {
  id: string;
  name: string;
  summary: string;
  prerequisites: string[];              // concept ids, directed
  related: string[];                    // concept ids, undirected, for transfer/interleaving
}

type TaskType =
  | "define" | "predict-output" | "explain" | "implement"
  | "debug" | "review" | "compare-designs" | "design-build"
  | `custom:${string}`;                 // tutor-invented, short description

interface RubricCriterion {
  id: string;
  statement: string;                    // yes/no condition on the answer
}

interface Task {                        // immutable once saved
  id: string;
  userId: UserId;
  sessionId: string;
  conceptId: string;
  bloomLevel: BloomLevel;
  taskType: TaskType;
  isReview: boolean;
  prompt: string;
  starterCode: string | null;
  rubric: RubricCriterion[];            // locked before the user answers
  hiddenTests: string | null;           // never shown to the user
  issuedAt: Date;
}

interface Grade {
  passed: boolean;
  gradedBy: "tests" | "jev" | "llm";
  graderConfidence: number;             // 0–1
  criteria: { criterionId: string; pYes: number }[];
  tests: { passed: number; total: number; output: string } | null;
  failedConceptId: string | null;       // concept blamed for a failure
}

type Outcome =
  | { kind: "submitted"; answer: string; confidence: number; durationMs: number; grade: Grade }
  | { kind: "abandoned" };

interface Attempt {                     // append-only
  id: string;
  taskId: string;
  userId: UserId;
  hintsUsed: number;
  outcome: Outcome;
  recordedAt: Date;
}

interface Hint {                        // append-only, saved as each hint is given
  id: string;
  taskId: string;
  userId: UserId;
  rung: 1 | 2 | 3 | 4;
  text: string;
  givenAt: Date;
}

interface Claim {                       // append-only, status derived
  id: string;
  userId: UserId;
  conceptId: string;
  bloomLevel: BloomLevel;
  statement: string;                    // the user's words
  claimedAt: Date;
}

interface Plan {                        // planner → tutor
  conceptId: string;
  bloomLevel: BloomLevel;
  isReview: boolean;
  suggestedTaskType: TaskType | null;
  reason: string;                       // logged, for debugging policy
}

interface Mastery {                     // derived, recomputable from attempts
  userId: UserId;
  conceptId: string;
  bloomLevel: BloomLevel;
  lastVerifiedAt: Date;
  nextReviewAt: Date;
  ladderStep: number;                   // consecutive advancing passes; interval = ladder[min(step, last)]
}
```

- Confidence is collected on a 9-point scale (0, 12.5 … 100%) and stored as 0–1.
- `durationMs` = submit time − `issuedAt`. It is noisy. No v0 logic depends on it.

## 4. Storage

- SQLite via `better-sqlite3`, file at `data/cogload.db` (gitignored)
- Tables: `users`, `tasks`, `attempts`, `hints`, `claims`, `mastery`
- `tasks`, `attempts`, `hints`, `claims` are insert-only
- `Store.users()` lists every user id. Export covers all users by default.
- `Attempt.hintsUsed` is set from the task's saved hints, so a crash never loses the count
- One attempt per task (`UNIQUE(task_id)`). A retry is a new task.
- `mastery` can be dropped and rebuilt from `attempts` + `tasks` at any time
- `attempts` flattens `Outcome` into nullable columns with a CHECK constraint (submitted rows have all fields, abandoned rows have none)
- Rubric, criteria, and test results are stored as JSON columns

## 5. Interfaces

Each interface has one v0 implementation. Tests use fakes.

| Interface | Responsibility | v0 implementation |
|---|---|---|
| `Store` | Persist and query all records | SQLite |
| `ConceptSource` | Provide concepts and edges | `concepts/seed.json` |
| `Scheduler` | Attempt history → mastery rows | Fixed ladder |
| `Planner` | Choose concept, level, review vs new | Deterministic rules (§6.2) |
| `Tutor` | Write tasks, rubrics, tests, hints; extract claims | Claude API |
| `Runner` | Run user code against hidden tests | Local `node --test` with timeout |
| `Grader` | Task + answer → `Grade` | Tests, then Jev, then LLM escalation |

```ts
interface ConceptSource {
  all(): Concept[];
  get(id: string): Concept | undefined;
}

interface Scheduler {
  recompute(userId: UserId, history: { task: Task; attempt: Attempt }[], now: Date): Mastery[];
}

interface Planner {
  next(ctx: PlannerContext): Plan | null;   // null = session done
}

interface Tutor {
  writeTask(plan: Plan, ctx: TutorContext): Promise<Omit<Task, "id" | "userId" | "sessionId" | "issuedAt">>;
  hint(task: Task, rung: 1 | 2 | 3 | 4, priorHints: string[], draft: string | null): Promise<string>;
  clarify(task: Task, question: string): Promise<string>;
  intakeFollowUp(subject: string, firstAnswer: string): Promise<string>;
  extractClaims(subject: string, transcript: string[], concepts: Concept[]): Promise<{ conceptId: string; statement: string }[]>;
}

interface ClaimJudge {                  // lives in src/grader/, Jev or LLM per config.grader
  level(concept: Concept, statement: string): Promise<BloomLevel>;
}

interface Runner {
  run(solution: string, tests: string, timeoutMs: number): Promise<{ passed: number; total: number; output: string }>;
}

interface Grader {
  grade(task: Task, answer: string, concepts: Concept[]): Promise<Grade>;
}
```

`PlannerContext` and `TutorContext` are defined by their builders. They hold read-only data (concepts, mastery, claims, recent task/attempt pairs, config). They never hold store handles.

## 6. Behavior

### 6.1 Scheduler

- Ladder: `config.reviewLadderDays` (default `[1, 3, 7, 14, 30]`)
- A mastery row exists only after a pass. Rows are created by passes and never by fails or abandons.
- A pass at level L counts as a pass for every level ≤ L on that concept
- A pass sets `nextReviewAt` to `recordedAt` + the ladder interval at the new step
- A pass advances `ladderStep` by one, unless `hintsUsed ≥ config.hintsBlockAdvance`. In that case the step stays the same.
- A fail on a level with a row resets `ladderStep` to 0 and sets `nextReviewAt` to the next day. `lastVerifiedAt` keeps the last pass time. Lower levels are untouched.
- A fail on a level with no row changes nothing
- An abandon never changes mastery. It stays in the attempt log as data.
- A concept counts as mastered at level L when `ladderStep ≥ config.masteredStep` (default 3, which means the user survived a 7-day review)

### 6.2 Planner

The rules run in order. The first rule that applies wins.

1. Stop if `config.maxTasksPerSession` is reached
2. If the last attempt failed and blamed a different concept (`failedConceptId`), target that concept at level 2. Once that remediation task passes, return to the original concept at the level that failed.
3. If any mastery row is due, review the most overdue one (capped at `config.maxReviewsPerDay`)
4. Compute the rolling success rate over the last `config.rollingWindow` attempts. Abandoned attempts count as failures.
5. If the rate ≥ `config.paceTarget`, advance.
   - If the current concept just passed level `config.newConceptAtLevel` (default 3) and a new concept is eligible, introduce it, capped by `config.maxNewConceptsPerSession`
   - Otherwise go one level above the current task's level, up to `config.maxLevel`
   - At `maxLevel`, switch to another started concept below `maxLevel`, then a new eligible concept (cap bypassed, since nothing else remains), then end the session
   - A new concept is eligible when its prerequisites are demonstrated or claimed at level ≥ 3
   - Among eligible concepts, prefer ones that list the current concept as a prerequisite, then concept-list order
6. If the rate is below the target, stay at the current level with a different task type, or drop one level if the last two attempts at this level failed. The suggested type is an unused type from `config.taskTypesByLevel` for that level, or null when all are used.
7. A new concept starts at level 1, or at its claimed level if one exists. Claims are trusted until a task tests them.

### 6.3 Hints

- A hint is given only when the user asks
- The tutor gives the lowest rung not yet given
  1. Nudge (restate the goal, point to the relevant area)
  2. A narrower question
  3. A partial step
  4. The full answer
- Rungs 1–2 get the user unstuck. Rungs 3–4 do the thinking for them.
- If rung 4 was given, the attempt is graded as failed. The CLI applies this after grading by setting `passed = false`.
- `hintsUsed` = the number of rungs given

### 6.3a Clarifications

- A clarification answers what the task asks for, never how to solve it
- Clarifications are not attempts and do not count toward `hintsUsed`
- If a question asks for solution help, the tutor declines and points the user to `hint`
- Clarifications are not logged in v0

### 6.4 Grading

- The grader sees only the task prompt, rubric, answer, and test output. It never sees chat or follow-up arguments.
- The answer is passed as delimited data and is never treated as instructions
- Tasks with `hiddenTests` go to the Runner first. They pass only if all tests pass.
- Rubric criteria are checked with one Jev Noul each. The task passes if every `pYes ≥ config.passThreshold`.
- If any `pYes` falls inside `config.uncertainBand`, the grade escalates to the LLM grader with the same inputs
- On failure, a Jev Choice picks `failedConceptId` from the task concept, its prerequisites, and "none"
- `graderConfidence` = min over criteria of `max(p, 1 − p)`. For tests-only grading it is 1.
- `config.grader` selects `"jev"` or `"llm"`, so the loop runs without a Jev key

### 6.5 Claims

- Intake transcript → `Tutor.extractClaims` → the concepts the user claims to know, each with the user's statement
- `ClaimJudge.level` assigns each claim's Bloom level from the statement. Its rubric skews low. A vague claim ("I know recursion") gets level 1. A higher level needs explicit evidence in the user's words (e.g. level 3 needs a description of applying it). Ambiguity resolves to the lower level.
- One `Claim` per (concept, level) results
- Status is derived per (concept, level). A passing attempt confirms the claim, a failing attempt disproves it, and no attempt leaves it unverified.
- The tutor never runs a task just to verify a claim. Claims get tested when the planner reaches the concept or when a task depends on it.

### 6.6 CLI and workspace

- Interactive REPL session with the commands `ask <question>`, `hint`, `submit`, `next`, `quit`, `status`
- `next` retries planning and task writing after a failure. It does nothing while a task is open.
- Errors from the tutor or grader show the user a generic message. Details go to `data/errors.log`, since they can contain hidden tests or rubric text.
- The intake transcript prefixes each turn with `Tutor:` or `User:`
- Each task goes to `workspace/<taskId>/` with `TASK.md`, plus `solution.ts` for code tasks or `answer.md` for prose tasks
- `submit` reads the answer from those files
- On startup, open tasks with no attempt get abandoned attempts
- `export` writes joined task + attempt rows to `data/export.jsonl` for pandas

### 6.7 Tasks

- The tutor picks from the `TaskType` list or invents a `custom:` type when that fits better
- Every task carries a concept, level, and type, whether listed or custom
- Code tasks use TypeScript
- Hidden tests use `node:test` and import from `solution.ts`

## 7. Config

All tunables live in `src/config.ts` and are edited by hand.

| Key | Default |
|---|---|
| `paceTarget` | 0.85 |
| `rollingWindow` | 8 |
| `reviewLadderDays` | [1, 3, 7, 14, 30] |
| `masteredStep` | 3 |
| `hintsBlockAdvance` | 2 |
| `maxTasksPerSession` | 12 |
| `maxReviewsPerDay` | 20 |
| `maxNewConceptsPerSession` | 2 |
| `newConceptAtLevel` | 3 |
| `maxLevel` | 6 |
| `passThreshold` | 0.6 |
| `uncertainBand` | [0.35, 0.65] |
| `grader` | "jev" |
| `runnerTimeoutMs` | 10000 |
| `taskTypesByLevel` | 1 define · 2 predict-output, explain · 3 implement · 4 debug · 5 review, compare-designs · 6 design-build |
| `tutorModel` | "claude-opus-5-5" |
| `escalationModel` | "claude-opus-5-5" |

Secrets come from env vars (`ANTHROPIC_API_KEY` and the TypeSafe key named in its docs). They are never committed.

## 8. Seed concepts

Subject: recursion → dynamic programming. File: `src/concepts/seed.json`.

| id | prerequisites |
|---|---|
| `call-stack` | — |
| `recursion` | call-stack |
| `base-case` | recursion |
| `recursion-tracing` | recursion, base-case |
| `recursive-complexity` | recursion-tracing |
| `memoization` | recursion, recursive-complexity |
| `top-down-dp` | memoization |
| `dp-state-transition` | top-down-dp |
| `bottom-up-dp` | dp-state-transition |

Related edges are left to the builder's judgment.

## 9. Stack and layout

- Node 22+, TypeScript (strict), `tsx`, `better-sqlite3`, `node:test`
- `@anthropic-ai/sdk` for the tutor and the escalation grader
- TypeSafe JS SDK for Jev
- `esbuild` bundles solution + hidden tests to plain JS before the Runner executes them. Running TS through tsx can hang a failing `assert.ok` on large files.

```
src/
  types.ts        shared contract (§3)
  config.ts
  store/
  concepts/       ConceptSource + seed.json
  scheduler/
  planner/
  tutor/
  grader/         runner, jev, llm, composite
  cli/            REPL, workspace, export
tests/
data/             gitignored
workspace/        gitignored
```

## 10. Build order

| Phase | Work | Depends on |
|---|---|---|
| A | Scaffold, `types.ts`, `config.ts`, Store, ConceptSource + seed, Scheduler | — |
| B1 | Planner | A |
| B2 | Tutor | A |
| B3 | Runner + Grader | A |
| C | CLI loop, workspace, export, end-to-end wiring | B1–B3 |

- Each phase has unit tests. LLM and Jev calls are faked in unit tests.
- Grader fixtures (correct, wrong, partly right, confidently wrong answers) run as an integration test, skipped when keys are absent
- Builders do not commit. The user reviews and commits.

## 11. Deferred

- Deep exploration past `maxLevel`. Users who want to keep going deeper on one concept get open-ended, repeated high-level work instead of a concept switch.
- Hidden-test verification. The tutor writes a reference solution, runs it through the Runner, and drops tests the reference fails. Lives inside the Tutor.
- Wikifeed `ConceptSource`. Link graph → `related` edges. Jev Noul over links → candidate prerequisites.
- FSRS scheduler
- Cognitive-load stopping rule (falling success rate, rising hints, falling confidence)
- Pre-task confidence (predicted performance) as a second calibration measure
- Sandboxed runner for a web app. v0 runs the solution in the same process as the tests, so a deliberate user can patch `assert` or `node:test` or overwrite the report file. v0 accepts this for a single local learner.
- Analysis notebooks (Brier score, calibration curves by Bloom level)
- Token and cost logging per session
