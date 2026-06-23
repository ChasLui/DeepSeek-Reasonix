export type PlanStepRisk = "low" | "med" | "high";

export interface PlanStep {
  id: string;
  title: string;
  action: string;
  risk?: PlanStepRisk | undefined;
  targets?: string[] | undefined;
  acceptance?: string | undefined;
  verification?: string[] | undefined;
}

export type StepEvidenceKind = "verification" | "diff" | "checkpoint" | "manual";

export interface StepEvidence {
  kind: StepEvidenceKind;
  summary: string;
  command?: string | undefined;
  paths?: string[] | undefined;
}

export interface StepCompletion {
  kind: "step_completed";
  stepId: string;
  title?: string | undefined;
  result: string;
  notes?: string | undefined;
  evidenceSummary?: string | undefined;
  evidence?: StepEvidence[] | undefined;
}
