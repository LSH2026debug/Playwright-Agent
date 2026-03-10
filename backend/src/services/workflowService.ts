import { paths, toRelativePath } from '../utils/paths.js';
import { ApiError } from '../utils/apiError.js';
import { config } from '../config.js';
import {
  readJson,
  readText,
  writeJson,
  writeText,
} from './storage.js';
import type {
  ApprovalRecord,
  ArtifactRef,
  ProjectMetadata,
  StepId,
  StepState,
  StepStatus,
  WorkflowDocuments,
  WorkflowLog,
  WorkflowState,
} from '../types/workflow.js';
import { stepIds } from '../types/workflow.js';

const stepTitles: Record<StepId, string> = {
  project_init: '项目初始化',
  requirements_upload: '需求上传',
  requirements_normalize: '需求规范化',
  site_explore: '站点探索',
  plan_generate: '测试计划生成',
  cases_generate: '测试用例生成',
  tests_generate: '测试脚本生成',
  tests_run: '测试执行',
};

const transitionMap: Record<StepStatus, StepStatus[]> = {
  draft: ['draft', 'ai_generated', 'completed'],
  ai_generated: ['ai_generated', 'human_reviewed'],
  human_reviewed: ['human_reviewed', 'approved'],
  approved: ['approved', 'completed'],
  completed: ['completed'],
};

export interface WorkflowStatePayload {
  ok: true;
  step: 'workflow';
  status: 'ready';
  artifacts: ArtifactRef[];
  workflow: WorkflowState;
  documents: WorkflowDocuments;
}

export async function ensureWorkflowScaffold(): Promise<void> {
  await Promise.all([
    writeMissingText(paths.sitePagesFile, 'pages: []\n'),
    writeMissingText(paths.siteFlowsFile, 'flows: []\n'),
    writeMissingJson(paths.approvalLogFile, []),
    writeMissingJson(paths.workflowStateFile, createInitialState()),
  ]);
}

export async function initializeProject(input: {
  projectName: string;
  siteUrl: string;
  operator?: string;
}): Promise<WorkflowState> {
  const state = await loadState();
  const timestamp = new Date().toISOString();
  const operator = input.operator ?? config.defaultOperator;

  const project: ProjectMetadata = {
    name: input.projectName,
    siteUrl: input.siteUrl,
    operator,
    createdAt: state.project?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };

  state.project = project;
  const approvalRecord = updateStep(state, 'project_init', 'completed', {
    artifacts: [
      {
        label: '项目元数据',
        path: toRelativePath(paths.projectMetaFile),
        kind: 'json',
      },
    ],
    actor: operator,
    action: '初始化',
    message: `已完成项目初始化，目标站点为 ${input.siteUrl}。`,
  });

  if (approvalRecord) {
    await appendApprovalRecord(approvalRecord);
  }

  await writeJson(paths.projectMetaFile, project);
  await persistState(state);
  return state;
}

export async function markRequirementsUploaded(input: {
  artifact: ArtifactRef;
  actor?: string;
}): Promise<WorkflowState> {
  const state = await loadState();
  const operator = input.actor ?? config.defaultOperator;

  ensureStepStatus(state, 'project_init', ['completed']);
  resetStepsFrom(state, 'requirements_normalize');

  const approvalRecord = updateStep(state, 'requirements_upload', 'completed', {
    artifacts: [input.artifact],
    actor: operator,
    action: '上传',
    message: '已上传原始需求文档。',
  });

  if (approvalRecord) {
    await appendApprovalRecord(approvalRecord);
  }

  await persistState(state);
  return state;
}

export async function markRequirementsGenerated(input: {
  artifacts: ArtifactRef[];
  actor?: string;
  llmMode: string;
}): Promise<WorkflowState> {
  const state = await loadState();
  const operator = input.actor ?? config.defaultOperator;

  ensureStepStatus(state, 'requirements_upload', ['completed']);

  const currentStep = state.steps.requirements_normalize;
  if (currentStep.status !== 'draft' && currentStep.status !== 'ai_generated') {
    state.steps.requirements_normalize = createEmptyStep('requirements_normalize');
  }

  const approvalRecord = updateStep(state, 'requirements_normalize', 'ai_generated', {
    artifacts: input.artifacts,
    actor: operator,
    action: '生成',
    message: `已使用${formatLlmModeLabel(input.llmMode)}生成规范化需求。`,
  });

  if (approvalRecord) {
    await appendApprovalRecord(approvalRecord);
  }

  await persistState(state);
  return state;
}

export async function markStepReviewed(input: {
  stepId: StepId;
  actor?: string;
  notes?: string;
}): Promise<WorkflowState> {
  const state = await loadState();
  const operator = input.actor ?? config.defaultOperator;

  ensureStepStatus(state, input.stepId, ['ai_generated', 'human_reviewed']);

  const approvalRecord = updateStep(state, input.stepId, 'human_reviewed', {
    actor: operator,
    action: '审阅',
    message: '已保存人工审阅内容。',
    approvalAction: 'reviewed',
    notes: input.notes,
  });

  if (approvalRecord) {
    await appendApprovalRecord(approvalRecord);
  }

  await persistState(state);
  return state;
}

export async function approveStep(input: {
  stepId: StepId;
  actor?: string;
  notes?: string;
}): Promise<WorkflowState> {
  const state = await loadState();
  const operator = input.actor ?? config.defaultOperator;

  ensureStepStatus(state, input.stepId, ['human_reviewed']);

  const approvalRecord = updateStep(state, input.stepId, 'approved', {
    actor: operator,
    action: '批准',
    message: '当前步骤已批准，可以进入下一环节。',
    approvalAction: 'approved',
    notes: input.notes,
  });

  if (approvalRecord) {
    await appendApprovalRecord(approvalRecord);
  }

  await persistState(state);
  return state;
}

export async function getWorkflowPayload(): Promise<WorkflowStatePayload> {
  const state = await loadState();
  const documents: WorkflowDocuments = {
    rawRequirements: await readText(paths.requirementsInputFile),
    normalizedRequirements: await readText(paths.normalizedRequirementsFile),
    siteExploreSummary: await readText(paths.siteExploreSummaryFile),
    planDocument: await readText(paths.plansFile),
    casesDocument: await readText(paths.casesMarkdownFile),
  };

  return {
    ok: true,
    step: 'workflow',
    status: 'ready',
    artifacts: collectArtifacts(state),
    workflow: state,
    documents,
  };
}

function createInitialState(): WorkflowState {
  const timestamp = new Date().toISOString();

  return {
    project: null,
    steps: stepIds.reduce((accumulator, stepId) => {
      accumulator[stepId] = createEmptyStep(stepId, timestamp);
      return accumulator;
    }, {} as Record<StepId, StepState>),
    logs: [],
    updatedAt: timestamp,
  };
}

function createEmptyStep(stepId: StepId, timestamp = new Date().toISOString()): StepState {
  return {
    id: stepId,
    title: stepTitles[stepId],
    status: 'draft',
    artifacts: [],
    approvals: [],
    updatedAt: timestamp,
  };
}

async function loadState(): Promise<WorkflowState> {
  await ensureWorkflowScaffold();

  const stored = await readJson<WorkflowState | null>(paths.workflowStateFile, null);
  const fallback = createInitialState();

  if (!stored) {
    return fallback;
  }

  return {
    project: stored.project ?? null,
    steps: stepIds.reduce((accumulator, stepId) => {
      const base = createEmptyStep(stepId, stored.updatedAt ?? fallback.updatedAt);
      const existing = stored.steps?.[stepId];
      accumulator[stepId] = {
        ...base,
        ...existing,
        title: stepTitles[stepId],
        artifacts: existing?.artifacts ?? [],
        approvals: existing?.approvals ?? [],
        updatedAt: existing?.updatedAt ?? base.updatedAt,
      };
      return accumulator;
    }, {} as Record<StepId, StepState>),
    logs: stored.logs ?? [],
    updatedAt: stored.updatedAt ?? fallback.updatedAt,
  };
}

async function persistState(state: WorkflowState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  await writeJson(paths.workflowStateFile, state);
}

function updateStep(
  state: WorkflowState,
  stepId: StepId,
  nextStatus: StepStatus,
  input: {
    artifacts?: ArtifactRef[];
    actor: string;
    action: string;
    message: string;
    approvalAction?: ApprovalRecord['action'];
    notes?: string;
  },
): ApprovalRecord | null {
  const current = state.steps[stepId];

  if (!transitionMap[current.status].includes(nextStatus)) {
    throw new ApiError(
      409,
      'invalid_step_transition',
      `步骤 ${stepId} 不能从 ${current.status} 变更为 ${nextStatus}。`,
    );
  }

  current.status = nextStatus;
  current.updatedAt = new Date().toISOString();
  current.artifacts = mergeArtifacts(current.artifacts, input.artifacts ?? []);

  if (input.approvalAction) {
    const approvalRecord: ApprovalRecord = {
      stepId,
      action: input.approvalAction,
      actor: input.actor,
      timestamp: current.updatedAt,
      notes: input.notes,
    };
    current.approvals = [...current.approvals, approvalRecord];
    state.logs = appendLog(state.logs, {
      stepId,
      action: input.action,
      actor: input.actor,
      message: input.message,
    });
    return approvalRecord;
  }

  state.logs = appendLog(state.logs, {
    stepId,
    action: input.action,
    actor: input.actor,
    message: input.message,
  });

  return null;
}

function ensureStepStatus(
  state: WorkflowState,
  stepId: StepId,
  allowedStatuses: StepStatus[],
): StepState {
  const step = state.steps[stepId];

  if (!allowedStatuses.includes(step.status)) {
    throw new ApiError(
      409,
      'step_not_ready',
      `步骤 ${stepId} 当前状态为 ${step.status}，必须先达到 [${allowedStatuses.join(', ')}] 才能继续。`,
    );
  }

  return step;
}

function resetStepsFrom(state: WorkflowState, stepId: StepId): void {
  const startIndex = stepIds.indexOf(stepId);

  for (const downstreamStepId of stepIds.slice(startIndex)) {
    state.steps[downstreamStepId] = createEmptyStep(downstreamStepId, state.updatedAt);
  }
}

function mergeArtifacts(currentArtifacts: ArtifactRef[], nextArtifacts: ArtifactRef[]): ArtifactRef[] {
  const byPath = new Map<string, ArtifactRef>();

  for (const artifact of [...currentArtifacts, ...nextArtifacts]) {
    byPath.set(artifact.path, artifact);
  }

  return [...byPath.values()];
}

function appendLog(
  logs: WorkflowLog[],
  input: Pick<WorkflowLog, 'stepId' | 'action' | 'actor' | 'message'>,
): WorkflowLog[] {
  const nextLog: WorkflowLog = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    ...input,
  };

  return [...logs, nextLog].slice(-100);
}

async function appendApprovalRecord(record: ApprovalRecord): Promise<void> {
  const current = await readJson<ApprovalRecord[]>(paths.approvalLogFile, []);
  current.push(record);
  await writeJson(paths.approvalLogFile, current);
}

async function writeMissingText(targetPath: string, defaultValue: string): Promise<void> {
  const current = await readText(targetPath);
  if (current === null) {
    await writeText(targetPath, defaultValue);
  }
}

async function writeMissingJson(targetPath: string, defaultValue: unknown): Promise<void> {
  const current = await readJson(targetPath, null);
  if (current === null) {
    await writeJson(targetPath, defaultValue);
  }
}

function collectArtifacts(state: WorkflowState): ArtifactRef[] {
  return mergeArtifacts([], Object.values(state.steps).flatMap((step) => step.artifacts));
}

function formatLlmModeLabel(mode: string): string {
  switch (mode) {
    case 'live':
      return '实时 LLM 模式';
    case 'mock':
      return 'Mock 模式';
    case 'template':
      return '模板降级模式';
    default:
      return `${mode} 模式`;
  }
}
