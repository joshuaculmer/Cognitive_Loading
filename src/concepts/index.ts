import { readFileSync } from "node:fs";
import type { Concept } from "../types";

export interface ConceptSource {
  all(): Concept[];
  get(id: string): Concept | undefined;
}

const SEED_PATH = new URL("./seed.json", import.meta.url);

// Loads concepts from a JSON file. Throws on duplicate ids or dangling edges.
export class SeedConceptSource implements ConceptSource {
  private readonly byId = new Map<string, Concept>();

  constructor(path: string | URL = SEED_PATH) {
    const concepts = JSON.parse(readFileSync(path, "utf8")) as Concept[];

    for (const c of concepts) {
      if (this.byId.has(c.id)) throw new Error(`duplicate concept id: ${c.id}`);
      this.byId.set(c.id, c);
    }

    for (const c of concepts) {
      for (const ref of [...c.prerequisites, ...c.related]) {
        if (!this.byId.has(ref)) throw new Error(`${c.id} references unknown concept: ${ref}`);
      }
    }
  }

  all(): Concept[] {
    return [...this.byId.values()];
  }

  get(id: string): Concept | undefined {
    return this.byId.get(id);
  }
}
