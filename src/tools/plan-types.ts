export type PlanStepRisk = "low" | "med" | "high";

export interface PlanStep {
  id: string;
  title: string;
  action: string;
  risk?: PlanStepRisk;
}

export interface StepCompletion {
  kind: "step_completed";
  stepId: string;
  title?: string;
  result: string;
  notes?: string;
}
