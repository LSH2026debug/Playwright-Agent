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
  kind: 'markdown' | 'json' | 'yaml' | 'text' | 'image';
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

export interface ProjectAuthConfig {
  requiresLogin: boolean;
  loginUrl: string | null;
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

export interface WorkflowPayload {
  ok: true;
  step: 'workflow';
  status: 'ready';
  artifacts: ArtifactRef[];
  workflow: WorkflowState;
  documents: {
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

export interface SiteExploreResponse extends StepResponse {
  summary: string;
  metadata: {
    pages: Array<Record<string, unknown>>;
    flows: Array<Record<string, unknown>>;
    screenshots: string[];
  };
}

export interface LoginSessionResponse {
  ok: true;
  session: LoginSessionMeta;
}

export interface PlanResponse extends StepResponse {
  content: string;
  llm: {
    mode: string;
    provider: string;
    model: string;
    warning?: string;
  };
}

export interface CasesResponse extends StepResponse {
  markdown: string;
  cases: Array<Record<string, unknown>>;
  llm: {
    mode: string;
    provider: string;
    model: string;
    warning?: string;
  };
}
