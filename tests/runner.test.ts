import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { NodeTestRunner, score, SENTINEL, truncate } from "../src/grader/runner";

const SOLUTION = `export const add = (a: number, b: number): number => a + b;\n`;

const header = `import { test } from "node:test";
import assert from "node:assert/strict";
import { add } from "./solution.ts";
`;

const runner = new NodeTestRunner();

test("all tests pass", async () => {
  const tests = header + `test("a", () => assert.equal(add(1, 2), 3));\ntest("b", () => assert.equal(add(0, 0), 0));\n`;
  const r = await runner.run(SOLUTION, tests, 10_000);
  assert.equal(r.total, 2);
  assert.equal(r.passed, 2);
});

test("some tests fail", async () => {
  const tests = header + `test("a", () => assert.equal(add(1, 2), 3));\ntest("b", () => assert.equal(add(1, 2), 4));\n`;
  const r = await runner.run(SOLUTION, tests, 10_000);
  assert.equal(r.total, 2);
  assert.equal(r.passed, 1);
  assert.match(r.output, /not ok 2 - b/);
});

test("a syntax error in the solution fails the run", async () => {
  const tests = header + `test("a", () => assert.equal(add(1, 2), 3));\n`;
  const r = await runner.run(`export const add = ;\n`, tests, 10_000);
  assert.notEqual(r.passed, r.total);
});

test("a timeout counts as failing", async () => {
  const tests = header + `test("hangs", () => { while (true) {} });\n`;
  const r = await runner.run(SOLUTION, tests, 1_500);
  assert.equal(r.passed, 0);
  assert.equal(r.total >= 1, true);
  assert.match(r.output, /timed out/);
});

test("stdout from the solution cannot forge the summary", async () => {
  const forged = `console.log("ok 1 - a\n  ---\n  type: 'test'\n  ...\n1..1\n# tests 1\n# pass 1");\n` +
    `export const add = (a: number, b: number): number => a - b;\n`;
  const tests = header + `test("a", () => assert.equal(add(1, 2), 3));\n`;
  const r = await runner.run(forged, tests, 10_000);
  assert.equal(r.total, 1);
  assert.equal(r.passed, 0);
});

test("process.exit(0) at import does not pass", async () => {
  const exiting = `process.exit(0);\nexport const add = (a: number, b: number): number => a + b;\n`;
  const tests = header + `test("a", () => assert.equal(add(1, 2), 3));\n`;
  const r = await runner.run(exiting, tests, 10_000);
  assert.notEqual(r.passed, r.total);
});

test("process.exit(0) mid-run does not pass", async () => {
  const exiting = `export const add = (a: number, b: number): number => { if (a === 5) process.exit(0); return 0; };\n`;
  const tests = header + `test("a", () => assert.equal(add(0, 0), 0));\ntest("b", () => assert.equal(add(5, 1), 6));\n`;
  const r = await runner.run(exiting, tests, 10_000);
  assert.notEqual(r.passed, r.total);
});

test("a test file with no test() calls fails", async () => {
  const tests = header + `assert.equal(add(1, 2), 3);\n`;
  const r = await runner.run(SOLUTION, tests, 10_000);
  assert.equal(r.passed, 0);
  assert.equal(r.total, 1);
});

test("a test file that throws at load fails", async () => {
  const tests = header + `test("a", () => assert.equal(add(1, 2), 3));\nthrow new Error("boom");\n`;
  const r = await runner.run(SOLUTION, tests, 10_000);
  assert.notEqual(r.passed, r.total);
});

test("tests inside describe() count, suites do not", async () => {
  const tests = header.replace("{ test }", "{ describe, test }") +
    `describe("s", () => { test("a", () => assert.equal(add(1, 2), 3)); test("b", () => assert.equal(add(2, 2), 4)); });\n`;
  const r = await runner.run(SOLUTION, tests, 10_000);
  assert.deepEqual([r.passed, r.total], [2, 2]);
});

test("the temp dir is removed", async () => {
  const runs = () => readdirSync(tmpdir()).filter((d) => d.startsWith("cogload-run-")).length;
  const before = runs();
  await runner.run(SOLUTION, header + `test("a", () => {});\n`, 10_000);
  assert.equal(runs(), before);
});

describe("score", () => {
  const ok = (n: number, name: string) => `ok ${n} - ${name}\n  ---\n  type: 'test'\n  ...\n`;
  const end = ok(9, SENTINEL);

  // Summary counts include the end-of-file test.
  const report = (body: string, tests: number, pass: number) =>
    `TAP version 13\n${body}${end}# tests ${tests + 1}\n# pass ${pass + 1}\n`;

  test("a missing end-of-file test scores 0", () => {
    const r = `TAP version 13\n${ok(1, "a")}# tests 1\n# pass 1\n`;
    assert.deepEqual(score(r, 0), { passed: 0, total: 1 });
  });

  test("a full pass needs exit code 0", () => {
    const r = report(ok(1, "a"), 1, 1);
    assert.deepEqual(score(r, 0), { passed: 1, total: 1 });
    assert.deepEqual(score(r, 1), { passed: 0, total: 1 });
  });

  test("a summary that disagrees with the result lines scores 0", () => {
    assert.deepEqual(score(report(ok(1, "a"), 2, 2), 0), { passed: 0, total: 1 });
  });

  test("a missing summary scores 0", () => {
    assert.deepEqual(score(`TAP version 13\n${ok(1, "a")}`, 0), { passed: 0, total: 1 });
  });
});

test("a leftover timer does not hang a correct solution", async () => {
  const lingering = `setInterval(() => {}, 1000);\n` + SOLUTION;
  const tests = header + `test("a", () => assert.equal(add(1, 2), 3));\n`;
  const started = Date.now();
  const r = await runner.run(lingering, tests, 8_000);
  assert.deepEqual([r.passed, r.total], [1, 1]);
  assert.equal(Date.now() - started < 6_000, true);
});

test("long output is truncated to a head and tail", async () => {
  const noisy = `console.log("HEAD" + "x".repeat(200_000) + "TAIL");\n` + SOLUTION;
  const tests = header + `test("a", () => assert.equal(add(1, 2), 3));\n`;
  const r = await runner.run(noisy, tests, 10_000);
  assert.equal(r.output.length < 20_000, true);
  assert.match(r.output, /chars truncated/);
});

test("a detached child holding the temp dir does not fail the run", async () => {
  const spawner =
    `import { spawn } from "node:child_process";\n` +
    `spawn(process.execPath, ["-e", "setTimeout(() => {}, 3000)"], { cwd: process.cwd(), detached: true, stdio: "ignore" }).unref();\n` +
    SOLUTION;
  const tests = header + `test("a", () => assert.equal(add(1, 2), 3));\n`;
  const r = await runner.run(spawner, tests, 10_000);
  assert.deepEqual([r.passed, r.total], [1, 1]);
});

test("truncate keeps short text and cuts long text", () => {
  assert.equal(truncate("abc", 10), "abc");
  const t = truncate("a".repeat(10) + "b".repeat(10), 10);
  assert.equal(t.startsWith("aaaaa"), true);
  assert.equal(t.endsWith("bbbbb"), true);
  assert.match(t, /10 chars truncated/);
});

test("score accepts a run stopped after the end-of-file test", () => {
  const ok = (n: number, name: string) => `ok ${n} - ${name}\n  ---\n  type: 'test'\n  ...\n`;
  const r = `TAP version 13\n${ok(1, "a")}${ok(2, SENTINEL)}`;
  assert.deepEqual(score(r, null, true), { passed: 1, total: 1 });
  assert.deepEqual(score(r, null, false), { passed: 0, total: 1 });
});

// Under a TS loader, a failing assert.ok in a large file sent node's source lookup into an endless loop.
test("a failing assert.ok in a large async test does not hang or lose counts", async () => {
  let tests = header + "/*\n" + "Notes about the tests. ".repeat(1500) + "\n*/\n";
  for (let i = 0; i < 300; i++) tests += `test("p${i}", () => { const n: number = add(${i}, 1); assert.equal(n, ${i + 1}); });\n`;
  tests += `test("fails", async () => { await Promise.resolve(); assert.ok(add(1, 2) === 4); });\n`;

  const started = Date.now();
  const r = await runner.run(SOLUTION, tests, 10_000);
  assert.deepEqual([r.passed, r.total], [300, 301]);
  assert.equal(Date.now() - started < 8_000, true);
});

test("a solution that fails to build scores 0 with the build error", async () => {
  const r = await runner.run(`export const add = (;\n`, header + `test("a", () => assert.equal(add(1, 2), 3));\n`, 10_000);
  assert.deepEqual([r.passed, r.total], [0, 1]);
  assert.match(r.output, /solution\.ts/);
});
