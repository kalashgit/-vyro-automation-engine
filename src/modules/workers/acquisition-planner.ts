import type { JobType } from "../queue/types.ts";

/**
 * Pure acquisition routing planner. Queue persistence remains the caller's
 * responsibility; use the returned deterministic idempotency key with enqueue.
 * It never certifies a prospect, verifies an email, or sends a message.
 */
export type AcquisitionStage =
  | "identity" | "enrichment" | "verification" | "suppression"
  | "outreach_preparation" | "operator_review" | "complete" | "blocked";
export interface PipelineSnapshot {
  recordId: string;
  identityStatus: string;
  prospectVerificationStatus: string;
  relevanceStatus: string;
  contactabilityStatus: string;
  enrichmentStatus: "pending" | "staged" | "complete";
  verifiedEmailCount: number;
  suppressionStatus: string;
  suppressionCheckedAt: Date | null;
  outreachStatus: "none" | "prepared" | "approved" | "contacted";
  blocked: boolean;
}
export interface PlannedWork {
  stage: AcquisitionStage;
  jobType: JobType | null;
  idempotencyKey: string | null;
  requiresHumanReview: boolean;
}
export function planNextStep(p: PipelineSnapshot, now = new Date()): PlannedWork {
  if (!/^[A-Z0-9]+-[A-Z0-9-]{1,199}$/.test(p.recordId) ||
      !Number.isSafeInteger(p.verifiedEmailCount) || p.verifiedEmailCount < 0 ||
      !Number.isFinite(now.getTime())) throw new Error("Invalid pipeline snapshot");
  const decision = (stage: AcquisitionStage, jobType: JobType | null = null,
    review = false): PlannedWork => ({
      stage, jobType, idempotencyKey: jobType ? `acquisition:${p.recordId}:${jobType}:v1` : null,
      requiresHumanReview: review
    });
  if (p.blocked || p.relevanceStatus === "irrelevant" || p.contactabilityStatus === "do_not_contact")
    return decision("blocked");
  if (p.identityStatus === "unchecked") return decision("identity", "reconcile_identity");
  if (p.identityStatus !== "certified" || p.prospectVerificationStatus !== "verified" ||
      p.relevanceStatus !== "relevant" || p.contactabilityStatus !== "contactable")
    return decision("operator_review", null, true);
  if (p.enrichmentStatus === "pending") return decision("enrichment", "enrich_contact");
  if (p.enrichmentStatus !== "complete" || p.verifiedEmailCount === 0)
    return decision("verification", p.enrichmentStatus === "complete" ? "verify_contact" : null,
      p.enrichmentStatus !== "complete");
  const suppressionFresh = p.suppressionCheckedAt instanceof Date &&
    Number.isFinite(p.suppressionCheckedAt.getTime()) &&
    p.suppressionCheckedAt.getTime() <= now.getTime() &&
    p.suppressionCheckedAt.getTime() >= now.getTime() - 86400000;
  if (p.suppressionStatus === "suppressed") return decision("blocked");
  if (p.suppressionStatus !== "passed" || !suppressionFresh)
    // The scheduler should attach a fresh epoch/cycle to this idempotency key
    // when refreshing checks after their 24-hour expiry.
    return decision("suppression", "suppression_check");
  if (p.outreachStatus === "contacted") return decision("complete");
  if (p.outreachStatus === "none") return decision("outreach_preparation", "prepare_outreach");
  return decision("operator_review", null, true);
}

/** Capacity is a budget, not an instruction to start 13 outbound senders. */
export function allocateCapacity(
  ready: Readonly<Record<"identity"|"enrichment"|"verification"|"suppression"|"outreach_preparation",number>>,
  totalSlots = 13
): Record<keyof typeof ready,number> {
  if (!Number.isSafeInteger(totalSlots) || totalSlots < 1 || totalSlots > 13 ||
      Object.values(ready).some(v => !Number.isSafeInteger(v) || v < 0))
    throw new Error("Invalid fleet capacity");
  const stages = ["identity","enrichment","verification","suppression","outreach_preparation"] as const;
  const result = Object.fromEntries(stages.map(s => [s,0])) as Record<typeof stages[number],number>;
  // One pass assigns baseline capacity; further passes share slots proportionally
  // to unmet ready work, preventing a large downstream queue from starving checks.
  let slots = totalSlots;
  for (const stage of stages) if (ready[stage] && slots) { result[stage]++; slots--; }
  while (slots) {
    const candidates = stages.filter(s => result[s] < ready[s]);
    if (!candidates.length) break;
    candidates.sort((a,b) => (ready[b]/(result[b]+1))-(ready[a]/(result[a]+1)));
    result[candidates[0]]++; slots--;
  }
  return result;
}
