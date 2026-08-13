import type {
  ReviewAssessment,
  ReviewAttempt,
  ReviewChainResult,
  ReviewerConfig,
} from "./types.ts";

export interface ReviewerInvocation {
  reviewer: ReviewerConfig;
}

export type InvokeReviewer = (
  invocation: ReviewerInvocation,
) => Promise<
  | { kind: "assessment"; assessment: ReviewAssessment }
  | { kind: "unavailable" | "failure" | "timeout" | "cancelled"; error: string }
>;

export async function runReviewLevels(options: {
  reviewers: ReviewerConfig[];
  minimumLevel: number;
  invoke: InvokeReviewer;
}): Promise<ReviewChainResult> {
  const attempts: ReviewAttempt[] = [];
  const groups = groupEligibleReviewers(options.reviewers, options.minimumLevel);

  for (const [level, reviewers] of groups) {
    let selected:
      | {
          reviewer: ReviewerConfig;
          result: Awaited<ReturnType<InvokeReviewer>>;
        }
      | undefined;
    for (const reviewer of reviewers) {
      const result = await options.invoke({ reviewer });
      if (result.kind === "unavailable" || result.kind === "failure" || result.kind === "timeout") {
        attempts.push({
          level,
          model: reviewer.model,
          status: result.kind,
          error: result.error,
        });
        continue;
      }
      selected = { reviewer, result };
      break;
    }
    if (!selected) continue;
    const { reviewer, result } = selected;
    if (result.kind === "cancelled") {
      attempts.push({
        level,
        model: reviewer.model,
        status: "cancelled",
        error: result.error,
      });
      return {
        decision: "deny",
        reason: "permission review was cancelled",
        attempts,
      };
    }
    if (result.kind !== "assessment") continue;
    attempts.push({
      level,
      model: reviewer.model,
      status: "decided",
      assessment: result.assessment,
    });
    if (result.assessment.decision === "escalate") continue;
    return {
      decision: result.assessment.decision,
      reason: result.assessment.reason,
      attempts,
    };
  }

  return {
    decision: "human",
    reason: "all configured reviewer levels were exhausted",
    attempts,
  };
}

export function groupEligibleReviewers(
  reviewers: ReviewerConfig[],
  minimumLevel: number,
): Array<[number, ReviewerConfig[]]> {
  const groups = new Map<number, ReviewerConfig[]>();
  for (const reviewer of reviewers) {
    if (reviewer.level < minimumLevel) continue;
    const existing = groups.get(reviewer.level) ?? [];
    existing.push(reviewer);
    groups.set(reviewer.level, existing);
  }
  return [...groups.entries()].sort(([left], [right]) => left - right);
}
