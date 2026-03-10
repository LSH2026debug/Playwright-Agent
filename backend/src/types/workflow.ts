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

export interface ProjectAuthConfig {
  requiresLogin: boolean;
  loginUrl: string | null;
}

export interface ProjectMetadata {
  name: string;
  siteUrl: string;
  operator: string;
  auth: ProjectAuthConfig;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowState {
  project: ProjectMetadata | null;
  steps: Record<StepId, StepState>;
  logs: WorkflowLog[];
  updatedAt: string;
}

export interface LlmGenerationMeta {
  generatedAt: string;
  mode: string;
  provider: string;
  model: string;
  warning?: string;
  count?: number;
}

export interface LoginSessionMeta {
  mode: 'manual';
  browserOpen: boolean;
  profileReady: boolean;
  loginUrl: string | null;
  currentUrl: string | null;
  profilePath: string | null;
  storageStatePath: string | null;
  openedAt: string | null;
  savedAt: string | null;
  updatedAt: string | null;
  authenticatedLikely: boolean;
  note?: string;
}

export interface SiteExploreMeta {
  exploredAt: string;
  siteUrl: string;
  maxPagesRequested: number;
  screenshotCount: number;
  pagesCount: number;
  flowsCount: number;
  requiresLogin: boolean;
  authenticated: boolean;
  loginUrlUsed: string | null;
  authMethod: 'none' | 'credentials' | 'manual_session';
}

export interface WorkflowDocuments {
  rawRequirements: string | null;
  normalizedRequirements: string | null;
  normalizedRequirementsMeta: LlmGenerationMeta | null;
  loginSessionMeta: LoginSessionMeta | null;
  siteExploreSummary: string | null;
  siteExploreMeta: SiteExploreMeta | null;
  planDocument: string | null;
  planMeta: LlmGenerationMeta | null;
  casesDocument: string | null;
  casesMeta: LlmGenerationMeta | null;
}
