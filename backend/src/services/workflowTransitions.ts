import { readJson, writeJson } from './storage.js';
import { paths } from '../utils/paths.js';
import { ApiError } from '../utils/apiError.js';
import type {
  ApprovalRecord,
  ArtifactRef,
  StepId,
  StepStatus,
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

export async function loadWorkflowAndTransition(input: {
  stepId: StepId;
  requiredStepId: StepId;
  requiredStatuses: StepStatus[];
  nextStatus: StepStatus;
  actor?: string;
  action: string;
  message: string;
  artifacts: ArtifactRef[];
}): Promise<WorkflowState> {
  const state = await readJson<WorkflowState>(paths.workflowStateFile, createInitialState());
  const requiredStep = state.steps[input.requiredStepId];

  if (!input.requiredStatuses.includes(requiredStep.status)) {
    throw new ApiError(
      409,
      'step_not_ready',
      `步骤 ${input.requiredStepId} 当前状态为 ${requiredStep.status}，必须先达到 [${input.requiredStatuses.join(', ')}] 才能继续。`,
    );
  }

  let current = state.steps[input.stepId] ?? createEmptyStep(input.stepId);

  if (!transitionMap[current.status].includes(input.nextStatus)) {
    // Allow re-run: if the step has already progressed past the target status,
    // reset this step and all downstream steps back to draft, then apply the transition.
    const statusOrder: StepStatus[] = ['draft', 'ai_generated', 'human_reviewed', 'approved', 'completed'];
    const currentIdx = statusOrder.indexOf(current.status);
    const targetIdx = statusOrder.indexOf(input.nextStatus);

    if (currentIdx > targetIdx) {
      // Reset this step and all downstream steps
      const stepIndex = stepIds.indexOf(input.stepId);
      for (const downstreamId of stepIds.slice(stepIndex)) {
        state.steps[downstreamId] = createEmptyStep(downstreamId);
      }
      current = state.steps[input.stepId];
    } else {
      throw new ApiError(409, 'invalid_step_transition', `步骤 ${input.stepId} 不能从 ${current.status} 变更为 ${input.nextStatus}。`);
    }
  }

  current.status = input.nextStatus;
  current.updatedAt = new Date().toISOString();
  current.artifacts = mergeArtifacts(current.artifacts, input.artifacts);
  state.steps[input.stepId] = current;
  state.logs = appendLog(state.logs, {
    stepId: input.stepId,
    action: input.action,
    actor: input.actor ?? 'local-user',
    message: input.message,
  });
  state.updatedAt = new Date().toISOString();

  await writeJson(paths.workflowStateFile, state);
  return state;
}

function createInitialState(): WorkflowState {
  const timestamp = new Date().toISOString();
  return {
    project: null,
    steps: stepIds.reduce((accumulator, stepId) => {
      accumulator[stepId] = createEmptyStep(stepId, timestamp);
      return accumulator;
    }, {} as Record<StepId, WorkflowState['steps'][StepId]>),
    logs: [],
    updatedAt: timestamp,
  };
}

function createEmptyStep(stepId: StepId, timestamp = new Date().toISOString()) {
  return {
    id: stepId,
    title: stepTitles[stepId],
    status: 'draft' as StepStatus,
    artifacts: [] as ArtifactRef[],
    approvals: [] as ApprovalRecord[],
    updatedAt: timestamp,
  };
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
