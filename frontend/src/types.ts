export type StepId =
  | 'project_init'
  | 'requirements_upload'
  | 'requirements_normalize'
  | 'site_explore'
  | 'plan_generate'
  | 'cases_generate'
  | 'tests_generate'
  | 'tests_run';

export type StepStatus = 'draft' | 'ai_generated' | 'human_reviewed' | 'approved' | 'completed';

export interface ArtifactRef {
  label: string;
  path: string;
  kind: 'markdown' | 'json' | 'yaml' | 'text';
}

export interface WorkflowLog {
  id: string;
  stepId: StepId | 'workflow';
  action: string;
  actor: string;
  message: string;
  timestamp: string;
}

export interface ApprovalRecord {
  stepId: StepId;
  action: 'reviewed' | 'approved';
  actor: string;
  timestamp: string;
  notes?: string;
}

export interface StepState {
  id: StepId;
  title: string;
  status: StepStatus;
  artifacts: ArtifactRef[];
  approvals: ApprovalRecord[];
  updatedAt: string;
}

export interface ProjectMetadata {
  name: string;
  siteUrl: string;
  operator: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowState {
  project: ProjectMetadata | null;
  steps: Record<StepId, StepState>;
  logs: WorkflowLog[];
  updatedAt: string;
}

export interface WorkflowPayload {
  ok: true;
  step: 'workflow';
  status: 'ready';
  artifacts: ArtifactRef[];
  workflow: WorkflowState;
  documents: {
    rawRequirements: string | null;
    normalizedRequirements: string | null;
  };
}

export interface StepResponse {
  ok: true;
  step: StepId;
  status: StepStatus;
  artifacts: ArtifactRef[];
  workflow: WorkflowState;
}

export interface NormalizeResponse extends StepResponse {
  content: string;
  llm: {
    mode: string;
    provider: string;
    model: string;
    warning?: string;
  };
}
