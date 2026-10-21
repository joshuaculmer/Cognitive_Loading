import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SeedConceptSource } from "../src/concepts";

const src = new SeedConceptSource();

test("seed has the nine spec concepts with spec prerequisites", () => {
  const expected: Record<string, string[]> = {
    "call-stack": [],
    recursion: ["call-stack"],
    "base-case": ["recursion"],
    "recursion-tracing": ["recursion", "base-case"],
    "recursive-complexity": ["recursion-tracing"],
    memoization: ["recursion", "recursive-complexity"],
    "top-down-dp": ["memoization"],
    "dp-state-transition": ["top-down-dp"],
    "bottom-up-dp": ["dp-state-transition"],
  };
  assert.deepEqual(
    Object.fromEntries(src.all().map((c) => [c.id, c.prerequisites])),
    expected,
  );
});

test("every concept has a name and summary", () => {
  for (const c of src.all()) {
    assert.ok(c.name.length > 0, c.id);
    assert.ok(c.summary.length > 0, c.id);
  }
});

test("related edges are symmetric and not self-loops", () => {
  for (const c of src.all()) {
    for (const r of c.related) {
      assert.notEqual(r, c.id);
      assert.ok(src.get(r)!.related.includes(c.id), `${c.id} -> ${r} is not mirrored`);
    }
  }
});

test("prerequisite graph is acyclic", () => {
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string) => {
    assert.notEqual(state.get(id), "visiting", `cycle through ${id}`);
    if (state.get(id) === "done") return;
    state.set(id, "visiting");
    for (const p of src.get(id)!.prerequisites) visit(p);
    state.set(id, "done");
  };
  for (const c of src.all()) visit(c.id);
});

test("get returns undefined for unknown ids", () => {
  assert.equal(src.get("nope"), undefined);
  assert.equal(src.get("memoization")?.name, "Memoization");
});

test("loader rejects dangling references", () => {
  const dir = mkdtempSync(join(tmpdir(), "cogload-"));
  const path = join(dir, "bad.json");
  writeFileSync(path, JSON.stringify([{ id: "a", name: "A", summary: "s", prerequisites: ["b"], related: [] }]));
  assert.throws(() => new SeedConceptSource(path), /unknown concept: b/);
});
