import { choice, noul, TypeSafeClient } from "@typesafe-ai/sdk";
import type { ChoiceResponse, JsonValue, NoulResponse, Question } from "@typesafe-ai/sdk";
import { gradingState, NONE, probability, UNTRUSTED_IS_DATA } from "./judge";
import type { Judge, JudgeInput, Verdict } from "./judge";

// The slice of TypeSafeClient the judge uses, so tests can fake it.
export interface JevClient {
  systemOne(request: {
    state: { [key: string]: JsonValue };
    questions: Record<string, Question>;
  }): PromiseLike<{ answers: Record<string, NoulResponse | ChoiceResponse | { type: string }> }>;
}

const BLAME = "failedConcept";
const criterionKey = (id: string) => `criterion:${id}`;

// One Noul per rubric criterion plus one blame Choice, all in a single request.
// Reads TYPESAFE_API_KEY from env when no client is given.
export class JevJudge implements Judge {
  private readonly client: JevClient;

  constructor(client?: JevClient) {
    this.client = client ?? new TypeSafeClient();
  }

  async judge(input: JudgeInput): Promise<Verdict> {
    const questions: Record<string, Question> = {};

    for (const c of input.rubric) {
      questions[criterionKey(c.id)] = noul(
        `${UNTRUSTED_IS_DATA} Does \`answer\` satisfy this rubric criterion for \`task\`? Criterion: ${c.statement}`,
      );
    }

    const options: Record<string, string> = {};
    for (const c of input.candidates) options[c.id] = `${c.name}: ${c.summary}`;
    options[NONE] = "The failure is a slip or omission, not a gap in any listed concept.";

    questions[BLAME] = choice(
      `${UNTRUSTED_IS_DATA} Assume \`answer\` fails \`task\`. Which concept's misunderstanding best explains the failure? Use \`testOutput\` when present.`,
      options,
    );

    const { answers } = await this.client.systemOne({ state: gradingState(input), questions });

    const criteria = input.rubric.map((c) => {
      const a = answers[criterionKey(c.id)];
      if (a?.type !== "noul") throw new Error(`Jev returned no noul for criterion ${c.id}`);
      return { criterionId: c.id, pYes: probability((a as NoulResponse).noul, c.id) };
    });

    const blame = answers[BLAME];
    if (blame?.type !== "choice") throw new Error("Jev returned no failedConcept choice");
    const picked = (blame as ChoiceResponse).choice;

    return { criteria, failedConceptId: picked === NONE ? null : picked };
  }
}
