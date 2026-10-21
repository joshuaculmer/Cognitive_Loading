// Calls the real Claude API. Skipped without ANTHROPIC_API_KEY.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeTutor } from "../src/tutor";
import { SeedConceptSource } from "../src/concepts";

const skip = !process.env.ANTHROPIC_API_KEY && "ANTHROPIC_API_KEY not set";

test("real API: writeTask produces a valid code task", { skip, timeout: 600_000 }, async () => {
  const concepts = new SeedConceptSource().all();
  const task = await new ClaudeTutor().writeTask(
    { conceptId: "base-case", bloomLevel: 3, isReview: false, suggestedTaskType: "implement", reason: "integration" },
    { subject: "recursion and dynamic programming", concepts, mastery: [], claims: [], recent: [] },
  );

  assert.equal(task.conceptId, "base-case");
  assert.ok(task.rubric.length > 0);
  assert.ok(task.hiddenTests?.includes("./solution.ts"));
  assert.ok(task.starterCode);
});
