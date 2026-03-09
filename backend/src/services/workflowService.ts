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
  project_init: 'Project Initialization',
  requirements_upload: 'Requirements Upload',
  requirements_normalize: 'Requirements Normalize',
  site_explore: 'Site Exploration',
  plan_generate: 'Plan Generation',
  cases_generate: 'Case Generation',
  tests_generate: 'Test Generation',
  tests_run: 'Test Execution',
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
        label: 'Project metadata',
        path: toRelativePath(paths.projectMetaFile),
        kind: 'json',
      },
    ],
    actor: operator,
    action: 'init',
    message: `Initialized project for ${input.siteUrl}.`,
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
    action: 'upload',
    message: 'Uploaded source requirements.',
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
    action: 'generate',
    message: `Generated normalized requirements with ${input.llmMode} mode.`,
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
    action: 'review',
    message: 'Saved human review edits.',
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
    action: 'approve',
    message: 'Approved step for downstream execution.',
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
      `Cannot move ${stepId} from ${current.status} to ${nextStatus}.`,
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
      `Step ${stepId} must be in [${allowedStatuses.join(', ')}] but is ${step.status}.`,
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
