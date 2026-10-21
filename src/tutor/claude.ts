// Tutor backed by the Claude API, using JSON-schema structured output.

import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config";
import type { Concept, Plan, Task } from "../types";
import type { ExtractedClaim, HintRung, Tutor, TutorContext, WrittenTask } from "./index";
import * as P from "./prompts";
import { CLARIFY_SCHEMA, TASK_SCHEMA, TEXT_SCHEMA, claimsSchema, parseClaims, parseClarification, parseTask, parseText } from "./schemas";

type Effort = "low" | "medium" | "high";

// The slice of the Anthropic client the tutor uses. Tests pass a fake.
export interface MessagesClient {
  beta: {
    messages: {
      create(params: Anthropic.Beta.MessageCreateParamsNonStreaming): PromiseLike<Anthropic.Beta.BetaMessage>;
    };
  };
}

export class ClaudeTutor implements Tutor {
  constructor(
    private readonly client: MessagesClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
    private readonly model: string = config.tutorModel,
  ) {}

  async writeTask(plan: Plan, ctx: TutorContext): Promise<WrittenTask> {
    const concept = ctx.concepts.find((c) => c.id === plan.conceptId);
    if (!concept) throw new Error(`tutor: unknown concept ${plan.conceptId}`);

    const raw = await this.ask(P.taskSystem(ctx.subject), P.taskUser(plan, ctx, concept), TASK_SCHEMA, "high");
    const t = parseTask(raw);
    return {
      conceptId: plan.conceptId,
      bloomLevel: plan.bloomLevel,
      isReview: plan.isReview,
      ...t,
    };
  }

  async hint(task: Task, rung: HintRung, priorHints: string[], draft: string | null): Promise<string> {
    if (rung !== priorHints.length + 1) {
      throw new Error(`tutor: rung ${rung} requested after ${priorHints.length} hints`);
    }
    const raw = await this.ask(P.HINT_SYSTEM, P.hintUser(task, rung, priorHints, draft), TEXT_SCHEMA("hint"), "medium");
    return parseText(raw, "hint");
  }

  async clarify(task: Task, question: string): Promise<string> {
    const raw = await this.ask(P.CLARIFY_SYSTEM, P.clarifyUser(task, question), CLARIFY_SCHEMA, "low");
    const c = parseClarification(raw);
    return c.seeksSolutionHelp ? P.CLARIFY_DECLINE : c.answer;
  }

  async intakeFollowUp(subject: string, firstAnswer: string): Promise<string> {
    const raw = await this.ask(P.INTAKE_SYSTEM, P.intakeUser(subject, firstAnswer), TEXT_SCHEMA("question"), "low");
    return parseText(raw, "question");
  }

  async extractClaims(subject: string, transcript: string[], concepts: Concept[]): Promise<ExtractedClaim[]> {
    const ids = concepts.map((c) => c.id);
    if (ids.length === 0) return [];

    const raw = await this.ask(P.CLAIMS_SYSTEM, P.claimsUser(subject, transcript, concepts), claimsSchema(ids), "medium");

    // Keep known concepts only, one claim per concept.
    const known = new Set(ids);
    const seen = new Set<string>();
    return parseClaims(raw).filter((c) => {
      if (!known.has(c.conceptId) || seen.has(c.conceptId)) return false;
      seen.add(c.conceptId);
      return true;
    });
  }

  private async ask(system: string, user: string, schema: object, effort: Effort): Promise<unknown> {
    const res = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: 16000,
      system,
      messages: [{ role: "user", content: user }],
      output_config: { effort, format: { type: "json_schema", schema: schema as Record<string, unknown> } },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });

    if (res.stop_reason !== "end_turn") {
      throw new Error(`tutor: model stopped with ${res.stop_reason}`);
    }
    const text = res.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`tutor: response is not JSON: ${text.slice(0, 500)}`);
    }
  }
}
