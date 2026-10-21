import { spawn } from "node:child_process";
import { build } from "esbuild";
import type { Message } from "esbuild";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TestResult {
  passed: number;
  total: number;
  output: string;
}

export interface Runner {
  run(solution: string, tests: string, timeoutMs: number): Promise<TestResult>;
}

const SOURCE_FILE = "solution.test.ts";
const TEST_FILE = "solution.test.mjs";
const REPORT_FILE = "report.tap";
const MAX_OUTPUT = 8000;
const POLL_MS = 50;

// Appended last. If it is missing, the test file stopped early, which node may not report.
export const SENTINEL = "cogload:end-of-file";
const SENTINEL_CODE = `\nimport { test as cogloadTest } from "node:test";\ncogloadTest("${SENTINEL}", () => {});\n`;
const SENTINEL_LINE = new RegExp(`^ok \\d+ - ${SENTINEL}$`, "m");

// Runs hidden tests against a solution with `node --test` in a fresh temp dir.
// The tests and solution are bundled to plain JS first, so the file node runs is the file on disk.
// Under a TS loader, assert.ok reads source at the wrong position and can hang.
// The TAP report goes to its own file so the solution's stdout cannot forge it.
// Isolation is off so the whole run is one process and a timeout kill stops it.
export class NodeTestRunner implements Runner {
  async run(solution: string, tests: string, timeoutMs: number): Promise<TestResult> {
    const dir = await mkdtemp(join(tmpdir(), "cogload-run-"));
    try {
      await writeFile(join(dir, "solution.ts"), solution);
      await writeFile(join(dir, SOURCE_FILE), tests + SENTINEL_CODE);
      const bundleError = await bundle(dir);
      if (bundleError) return { passed: 0, total: 1, output: truncate(bundleError) };

      const { console, exitCode, timedOut, stoppedAtEnd } = await exec(dir, timeoutMs);
      const report = await readReport(dir);
      const output = truncate(`${report}\n--- process output ---\n${console}`);

      if (timedOut) {
        return { passed: 0, total: 1, output: `${output}\n[timed out after ${timeoutMs}ms]` };
      }
      return { ...score(report, exitCode, stoppedAtEnd), output };
    } finally {
      // Best effort. A leftover child can hold the dir open, and that must not fail grading.
      await rm(dir, { recursive: true, force: true, maxRetries: 2 }).catch(() => {});
    }
  }
}

// Keeps a fixed head and tail of long output.
export function truncate(text: string, max = MAX_OUTPUT): string {
  if (text.length <= max) return text;
  const keep = Math.floor(max / 2);
  return `${text.slice(0, keep)}\n[... ${text.length - 2 * keep} chars truncated ...]\n${text.slice(-keep)}`;
}

// Counts real test() results and cross-checks them against the summary and exit code.
// stoppedAtEnd means the runner killed the process after the end-of-file test reported,
// so no summary or exit code exists. Any mismatch, early exit, or zero tests scores 0 passed.
export function score(
  report: string,
  exitCode: number | null,
  stoppedAtEnd = false,
): { passed: number; total: number } {
  const lines = report.split(/\r?\n/);
  let total = 0;
  let passed = 0;
  let fileOk = 0;
  let fileFailed = 0;
  let sentinel = false;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^(\s*)(not )?ok \d+ - (.*)$/);
    if (!m) continue;
    const ok = !m[2];

    // With isolation off, the file itself is reported as a test when it has no test() calls or throws.
    if (m[1] === "" && m[3] === TEST_FILE) {
      ok ? fileOk++ : fileFailed++;
      continue;
    }
    if (m[3] === SENTINEL) {
      sentinel = ok;
      continue;
    }
    if (typeOf(lines, i) !== "test") continue;
    total++;
    if (ok) passed++;
  }

  const summaryTests = summary(report, "tests");
  const summaryPass = summary(report, "pass");
  const extra = fileOk + (sentinel ? 1 : 0);
  const summaryOk = stoppedAtEnd || (summaryTests === total + extra && summaryPass === passed + extra);
  const consistent =
    sentinel && fileFailed === 0 && summaryOk && (passed < total || exitCode === 0 || stoppedAtEnd);

  if (total === 0) return { passed: 0, total: 1 };
  return { passed: consistent ? passed : 0, total };
}

// The `type:` field in the YAML block after a result line.
function typeOf(lines: string[], i: number): string | null {
  for (let j = i + 1; j < lines.length; j++) {
    if (/^\s*(not )?ok \d+ - /.test(lines[j]!)) return null;
    const t = lines[j]!.match(/^\s*type: '(\w+)'$/);
    if (t) return t[1]!;
  }
  return null;
}

function summary(report: string, label: string): number | null {
  const m = report.match(new RegExp(`^# ${label} (\\d+)$`, "m"));
  return m ? Number(m[1]) : null;
}

// Returns the build error text, or null on success.
async function bundle(dir: string): Promise<string | null> {
  try {
    await build({
      entryPoints: [join(dir, SOURCE_FILE)],
      outfile: join(dir, TEST_FILE),
      bundle: true,
      platform: "node",
      format: "esm",
      logLevel: "silent",
    });
    return null;
  } catch (err) {
    const errors = (err as { errors?: Message[] }).errors;
    if (!errors) return String(err);
    return errors.map((e) => (e.location ? `${e.location.file}:${e.location.line}: ${e.text}` : e.text)).join("\n");
  }
}

const readReport = (dir: string) => readFile(join(dir, REPORT_FILE), "utf8").catch(() => "");

interface ExecResult {
  console: string;
  exitCode: number | null;
  timedOut: boolean;
  stoppedAtEnd: boolean;
}

// Stops the process once the end-of-file test reports, so leftover timers cannot hang the run.
function exec(cwd: string, timeoutMs: number): Promise<ExecResult> {
  // A parent `node --test` sets NODE_TEST_CONTEXT, which would change the child's reporter.
  const { NODE_TEST_CONTEXT: _, ...env } = process.env;
  const args = [
    "--test", "--experimental-test-isolation=none",
    "--test-reporter=tap", `--test-reporter-destination=${REPORT_FILE}`,
    TEST_FILE,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env });
    let console = "";
    let timedOut = false;
    let stoppedAtEnd = false;
    let exited = false;
    child.stdout.on("data", (d) => (console = truncate(console + d, MAX_OUTPUT * 2)));
    child.stderr.on("data", (d) => (console = truncate(console + d, MAX_OUTPUT * 2)));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    const poll = setInterval(async () => {
      if (SENTINEL_LINE.test(await readReport(cwd)) && !exited) {
        stoppedAtEnd = true;
        child.kill("SIGKILL");
      }
    }, POLL_MS);

    const done = () => {
      exited = true;
      clearTimeout(timer);
      clearInterval(poll);
    };
    child.on("error", (err) => {
      done();
      reject(err);
    });

    // `exit`, not `close`: a grandchild holding the pipes must not stall the run.
    child.on("exit", (exitCode) => {
      done();
      resolve({ console, exitCode, timedOut, stoppedAtEnd });
    });
  });
}
