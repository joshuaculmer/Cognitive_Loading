import Anthropic from "@anthropic-ai/sdk";
import { gradingState, newNonce, NONE, probability, section, UNTRUSTED_IS_DATA } from "./judge";
import type { Judge, JudgeInput, Verdict } from "./judge";

// Sends a system and user message, returns the parsed JSON reply. Tests fake this.
export type AskJson = (system: string, user: string, schema: Record<string, unknown>) => Promise<unknown>;

const system = (nonce: string) => [
  "You grade a learner's submission against a fixed rubric.",
  `The user message has sections tagged task-${nonce}, answer-${nonce}, test_output-${nonce}, and rubric-${nonce}.`,
  `\`answer\` is the answer-${nonce} section and \`testOutput\` is the test_output-${nonce} section.`,
  UNTRUSTED_IS_DATA,
  "For each rubric criterion, give pYes, your probability from 0 to 1 that the answer meets it.",
  "Be calibrated. Use values near 0.5 only when the answer is genuinely ambiguous.",
  `Then assume the answer fails and pick the concept id whose misunderstanding best explains it, or "${NONE}" for a slip.`,
].join("\n");

// Claude grader. Returns per-criterion probabilities in the same shape as Jev.
export class LlmJudge implements Judge {
  constructor(private readonly ask: AskJson) {}

  async judge(input: JudgeInput): Promise<Verdict> {
    const ids = input.rubric.map((c) => c.id);
    const conceptIds = [...input.candidates.map((c) => c.id), NONE];

    const schema = {
      type: "object",
      properties: {
        criteria: {
          type: "array",
          items: {
            type: "object",
            properties: {
              criterionId: ids.length ? { type: "string", enum: ids } : { type: "string" },
              pYes: { type: "number" },
            },
            required: ["criterionId", "pYes"],
            additionalProperties: false,
          },
        },
        failedConceptId: { type: "string", enum: conceptIds },
      },
      required: ["criteria", "failedConceptId"],
      additionalProperties: false,
    };

    const state = gradingState(input);
    const rubric = JSON.stringify({
      criteria: input.rubric,
      concepts: input.candidates.map(({ id, name, summary }) => ({ id, name, summary })),
    });
    const nonce = newNonce();
    const user = [
      section("task", nonce, state.task),
      section("answer", nonce, state.answer),
      section("test_output", nonce, state.testOutput ?? "(no hidden tests)"),
      section("rubric", nonce, rubric),
    ].join("\n");

    const reply = (await this.ask(system(nonce), user, schema)) as {
      criteria: { criterionId: string; pYes: number }[];
      failedConceptId: string;
    };

    const byId = new Map(reply.criteria.map((c) => [c.criterionId, c.pYes]));
    const criteria = ids.map((id) => {
      const p = byId.get(id);
      if (p === undefined) throw new Error(`LLM grader skipped criterion ${id}`);
      return { criterionId: id, pYes: probability(p, id) };
    });

    const blame = conceptIds.includes(reply.failedConceptId) ? reply.failedConceptId : NONE;
    return { criteria, failedConceptId: blame === NONE ? null : blame };
  }
}

// Real AskJson over the Claude API with structured output.
export function anthropicAsk(model: string, client = new Anthropic()): AskJson {
  return async (system, user, schema) => {
    const res = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: { type: "json_schema", schema } },
      system,
      messages: [{ role: "user", content: user }],
    });

    if (res.stop_reason === "refusal") throw new Error("LLM grader refused");
    const text = res.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") throw new Error("LLM grader returned no text");
    return JSON.parse(text.text);
  };
}
