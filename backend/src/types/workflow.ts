export const stepIds = [
  'project_init',
  'requirements_upload',
  'requirements_normalize',
  'site_explore',
  'plan_generate',
  'cases_generate',
  'tests_generate',
  'tests_run',
] as const;

export type StepId = (typeof stepIds)[number];

export const stepStatuses = [
  'draft',
  'ai_generated',
  'human_reviewed',
  'approved',
  'completed',
] as const;

export type StepStatus = (typeof stepStatuses)[number];

export type ArtifactKind = 'markdown' | 'json' | 'yaml' | 'text' | 'image';

export interface ArtifactRef {
  label: string;
  path: string;
  kind: ArtifactKind;
}

export interface ApprovalRecord {
  stepId: StepId;
  action: 'reviewed' | 'approved';
  actor: string;
  timestamp: string;
  notes?: string;
}

export interface WorkflowLog {
  id: string;
  stepId: StepId | 'workflow';
  action: string;
  actor: string;
  message: string;
  timestamp: string;
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

export interface WorkflowDocuments {
  rawRequirements: string | null;
  normalizedRequirements: string | null;
  siteExploreSummary: string | null;
  planDocument: string | null;
  casesDocument: string | null;
}
