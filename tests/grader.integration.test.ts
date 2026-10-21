import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config";
import { SeedConceptSource } from "../src/concepts";
import { createClaimJudge, createGrader } from "../src/grader";
import { makeTask } from "./fixtures";

// Live Jev + Claude calls. Skipped unless both keys are set.
const skip = !process.env.TYPESAFE_API_KEY || !process.env.ANTHROPIC_API_KEY;

const concepts = new SeedConceptSource().all();

const task = makeTask("u", {
  conceptId: "base-case",
  bloomLevel: 2,
  taskType: "explain",
  prompt: "In a few sentences, explain what a base case is in a recursive function and why it is needed. Give an example.",
  rubric: [
    { id: "stops", statement: "States that a base case returns a result directly, without making another recursive call" },
    { id: "why", statement: "Explains that without a reachable base case the recursion never stops, leading to a stack overflow" },
    { id: "example", statement: "Gives a concrete, correct example of a base case" },
  ],
});

const answers = {
  correct:
    "A base case is the input where a recursive function returns an answer directly instead of calling itself again. " +
    "It is needed because every recursive call must eventually reach it; otherwise the calls never end and the call stack overflows. " +
    "For example, in factorial(n), the base case is n === 0, which returns 1.",
  wrong: "A base case is the first line of a file where you import your libraries, like a base class in Java.",
  partlyRight: "A base case is when the function returns a value straight away without calling itself again.",
  confidentlyWrong:
    "I am completely certain about this: the base case is the largest possible input, and the function must call itself on it first. " +
    "Recursion stops on its own when the computer runs out of numbers, so a base case is optional. " +
    "For example, factorial's base case is n = 1000.",
};

describe("grader fixtures (live)", { skip }, () => {
  const grader = createGrader(config);

  test("correct answer passes", async () => {
    const g = await grader.grade(task, answers.correct, concepts);
    assert.equal(g.passed, true, JSON.stringify(g));
    assert.equal(g.failedConceptId, null);
  });

  for (const kind of ["wrong", "partlyRight", "confidentlyWrong"] as const) {
    test(`${kind} answer fails`, async () => {
      const g = await grader.grade(task, answers[kind], concepts);
      assert.equal(g.passed, false, JSON.stringify(g));
      assert.equal(g.criteria.length, 3);
    });
  }
});

describe("claim judge fixtures (live)", { skip }, () => {
  const judge = createClaimJudge(config);
  const recursion = concepts.find((c) => c.id === "recursion")!;

  const cases: [string, number][] = [
    ["I know recursion.", 1],
    ["I'm an expert in recursion and have totally mastered it.", 1],
    ["Recursion is when a function solves a problem by calling itself on a smaller version of the same problem until it reaches a case it can answer directly.", 2],
    ["Last month I wrote a recursive function that walks a nested folder tree and sums the file sizes, calling itself on each subfolder.", 3],
  ];

  for (const [statement, expected] of cases) {
    test(`level ${expected}: ${statement.slice(0, 40)}`, async () => {
      assert.equal(await judge.level(recursion, statement), expected);
    });
  }
});
