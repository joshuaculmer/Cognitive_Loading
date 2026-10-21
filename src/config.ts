// All tunables (SPEC §7). Edit by hand.

import type { BloomLevel, TaskType } from "./types";

export interface Config {
  paceTarget: number;
  rollingWindow: number;
  reviewLadderDays: number[];
  masteredStep: number;
  hintsBlockAdvance: number;
  maxTasksPerSession: number;
  maxReviewsPerDay: number;
  maxNewConceptsPerSession: number;
  newConceptAtLevel: BloomLevel;
  maxLevel: BloomLevel;
  passThreshold: number;
  uncertainBand: [number, number];
  grader: "jev" | "llm";
  runnerTimeoutMs: number;
  taskTypesByLevel: Record<BloomLevel, TaskType[]>;
  tutorModel: string;
  escalationModel: string;
}

export const config: Config = {
  paceTarget: 0.85,
  rollingWindow: 8,
  reviewLadderDays: [1, 3, 7, 14, 30],
  masteredStep: 3,
  hintsBlockAdvance: 2,
  maxTasksPerSession: 12,
  maxReviewsPerDay: 20,
  maxNewConceptsPerSession: 2,
  newConceptAtLevel: 3,
  maxLevel: 6,
  passThreshold: 0.6,
  uncertainBand: [0.35, 0.65],
  grader: "jev",
  runnerTimeoutMs: 10000,
  taskTypesByLevel: {
    1: ["define"],
    2: ["predict-output", "explain"],
    3: ["implement"],
    4: ["debug"],
    5: ["review", "compare-designs"],
    6: ["design-build"],
  },
  tutorModel: "claude-opus-5-5",
  escalationModel: "claude-opus-5-5",
};
