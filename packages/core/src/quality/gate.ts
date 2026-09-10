/**
 * Streaming quality gate: weighted multi-dimension scoring with
 * deterministic (structural) and LLM-backed judge profiles.
 */
import type { AssistantMessage } from "../types/messages";
import type { LlmProvider } from "../types/provider";
import type {
  GateArtifact,
  JudgeFn,
  QualityDimensionScore,
  QualityScore,
  Rubric,
} from "../types/quality";

export interface QualityGateOptions {
  judge?: JudgeFn;
}

const FILLER_MARKERS = ["TODO", "FIXME", "lorem", "placeholder", "coming soon"] as const;

function countFillers(content: string): number {
  let count = 0;
  for (const marker of FILLER_MARKERS) {
    let idx = content.indexOf(marker);
    while (idx >= 0) {
      count += 1;
      idx = content.indexOf(marker, idx + marker.length);
    }
  }
  return count;
}

function normalizeWeights(rubric: Rubric): Rubric {
  const total = rubric.dimensions.reduce((acc, d) => acc + d.weight, 0);
  if (total <= 0) {
    throw new Error("rubric weights must sum to a positive number");
  }
  if (Math.abs(total - 1) < 1e-9) return rubric;
  return {
    ...rubric,
    dimensions: rubric.dimensions.map((d) => ({ ...d, weight: d.weight / total })),
  };
}

function assemble(dimensions: QualityDimensionScore[], threshold: number): QualityScore {
  const weighted =
    Math.round(dimensions.reduce((acc, d) => acc + d.weight * d.score, 0) * 100) / 100;
  const passed = weighted >= threshold;
  const reasons = passed
    ? []
    : dimensions.filter((d) => d.score < 8).map((d) => `${d.name}: ${d.reason}`);
  return { dimensions, weighted, passed, reasons };
}

/**
 * Deterministic judge — no LLM. Scores criteria coverage, substance
 * (length), and penalizes filler markers. Same score for every dimension
 * of the same artifact: heuristics are content-level, not dimension-level.
 */
export const structuralJudge: JudgeFn = async (artifact, rubric) => {
  const normalized = normalizeWeights(rubric);
  const content = artifact.content;
  const minChars = artifact.kind === "text" ? 1 : 200;
  let score = 10;
  const parts: string[] = [];
  const criteria = artifact.criteria ?? [];
  if (criteria.length > 0) {
    let covered = 0;
    for (const c of criteria) {
      if (content.toLowerCase().includes(c.toLowerCase())) covered += 1;
    }
    const ratio = covered / criteria.length;
    const coverageScore = Math.round(ratio * 10);
    score = Math.min(score, coverageScore);
    parts.push(`criteria coverage ${covered}/${criteria.length}`);
  }
  if (content.trim().length < minChars) {
    score = Math.min(score, 2);
    parts.push(`content too short (${content.trim().length} < ${minChars} chars)`);
  }
  const fillers = countFillers(content);
  if (fillers > 0) {
    score = Math.min(score, 4);
    parts.push(`${fillers} filler marker(s) found`);
  }
  if (parts.length === 0) parts.push("all structural checks passed");
  const reason = parts.join("; ");
  const dims: QualityDimensionScore[] = normalized.dimensions.map((d) => ({
    name: d.name,
    weight: d.weight,
    score,
    reason,
  }));
  return assemble(dims, rubric.threshold);
};

/**
 * LLM-backed judge. Prompts the provider for strict JSON
 * `{dimensions:[{name, score, reason}]}`; unparsed/missing dimensions
 * score 5 with reason 'not judged'.
 */
export function createLlmJudge(
  provider: LlmProvider,
  _options?: { maxTokensEstimate?: number },
): JudgeFn {
  return async (artifact, rubric) => {
    const normalized = normalizeWeights(rubric);
    const rubricDesc = normalized.dimensions
      .map((d) => `- ${d.name} (weight ${d.weight.toFixed(2)}): ${d.instruction}`)
      .join("\n");
    const criteriaDesc =
      artifact.criteria && artifact.criteria.length > 0
        ? `\nAcceptance criteria (must all be covered):\n${artifact.criteria.map((c) => `- ${c}`).join("\n")}`
        : "";
    const prompt = `You are a strict quality judge. Score the ARTIFACT below against each rubric dimension on 0-10 (integer). Respond with STRICT JSON only, no prose, in this exact shape: {"dimensions":[{"name":"<dimension name>","score":<0-10>,"reason":"<short explanation>"}]}\n\nRUBRIC:\n${rubricDesc}${criteriaDesc}\n\nARTIFACT (${artifact.kind}):\n"""\n${artifact.content}\n"""`;
    const request = {
      systemPrompt: "You output only valid JSON. No markdown fences, no commentary.",
      messages: [{ role: "user" as const, content: prompt }],
      tools: [],
    };
    let text = "";
    for await (const ev of provider.stream(request)) {
      if (ev.type === "text_delta") text += ev.delta;
      else if (ev.type === "done") {
        text = ev.message.text || text;
        break;
      } else if (ev.type === "error") {
        throw ev.error;
      }
    }
    const dims: QualityDimensionScore[] = [];
    const jsonStart = text.indexOf("{");
    const jsonEnd = text.lastIndexOf("}");
    let parsed: { dimensions?: Array<{ name?: string; score?: number; reason?: string }> } = {};
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      try {
        parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as typeof parsed;
      } catch {
        parsed = {};
      }
    }
    const judged = new Map<string, { score: number; reason: string }>();
    for (const d of parsed.dimensions ?? []) {
      if (typeof d.name === "string" && typeof d.score === "number" && Number.isFinite(d.score)) {
        judged.set(d.name, {
          score: Math.max(0, Math.min(10, Math.round(d.score))),
          reason: typeof d.reason === "string" ? d.reason : "not judged",
        });
      }
    }
    for (const d of normalized.dimensions) {
      const hit = judged.get(d.name);
      if (hit) {
        dims.push({ name: d.name, weight: d.weight, score: hit.score, reason: hit.reason });
      } else {
        dims.push({ name: d.name, weight: d.weight, score: 5, reason: "not judged" });
      }
    }
    return assemble(dims, rubric.threshold);
  };
}

/** Default build-time rubric: correctness .3 / efficiency .3 / maintainability .2 / principles .2. */
export function createDefaultRubric(): Rubric {
  return {
    id: "default",
    threshold: 8.0,
    dimensions: [
      {
        name: "correctness",
        weight: 0.3,
        instruction:
          "Technical correctness and completeness: real types, real flows, edge cases handled; no stubs.",
      },
      {
        name: "efficiency",
        weight: 0.3,
        instruction:
          "Efficiency of design: minimal complexity, sensible parallelism, no redundant work.",
      },
      {
        name: "maintainability",
        weight: 0.2,
        instruction:
          "Maintainability and clarity: explicit names, stable interfaces, explicit error handling.",
      },
      {
        name: "principleAdherence",
        weight: 0.2,
        instruction:
          "Adherence to minimal-core + extensions principle; no scope creep into the core; anti-slop (no filler, no empty abstractions).",
      },
    ],
  };
}

/** Convenience: an AssistantMessage-driven artifact for gating agent outputs. */
export function artifactFromAssistant(
  message: AssistantMessage,
  kind: GateArtifact["kind"] = "text",
  criteria?: string[],
): GateArtifact {
  return {
    kind,
    content: message.text,
    ...(criteria !== undefined ? { criteria } : {}),
  };
}

export class QualityGate {
  private readonly judge: JudgeFn;

  constructor(options?: QualityGateOptions) {
    this.judge = options?.judge ?? structuralJudge;
  }

  async evaluate(artifact: GateArtifact, rubric: Rubric): Promise<QualityScore> {
    const normalized = normalizeWeights(rubric);
    const result = await this.judge(artifact, normalized);
    return assemble(result.dimensions, normalized.threshold);
  }
}
