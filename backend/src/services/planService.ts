import { llmAdapter } from '../adapters/llmAdapter.js';
import { ApiError } from '../utils/apiError.js';
import { paths, toRelativePath } from '../utils/paths.js';
import { writeJson, writeText } from './storage.js';
import { getWorkflowPayload, markStepReviewed } from './workflowService.js';
import { loadWorkflowAndTransition } from './workflowTransitions.js';
import type { WorkflowState } from '../types/workflow.js';

export async function generatePlan(input: {
  actor?: string;
}): Promise<{
  state: WorkflowState;
  content: string;
  llm: {
    mode: string;
    provider: string;
    model: string;
    warning?: string;
  };
}> {
  const workflow = await getWorkflowPayload();
  const stepStatus = workflow.workflow.steps.site_explore.status;

  if (stepStatus !== 'approved' && stepStatus !== 'completed') {
    throw new ApiError(409, 'site_explore_not_approved', '请先批准站点探索结果，再生成测试计划。');
  }

  const requirements = workflow.documents.normalizedRequirements;
  const exploreSummary = workflow.documents.siteExploreSummary;

  if (!requirements || !exploreSummary) {
    throw new ApiError(409, 'plan_input_missing', '缺少需求规范或站点探索摘要，无法生成测试计划。');
  }

  const llm = await llmAdapter.requirementsToPlan({
    siteUrl: workflow.workflow.project?.siteUrl ?? '',
    normalizedRequirements: requirements,
    siteExploreSummary: exploreSummary,
    promptPath: paths.requirementsPromptFile,
  });
  const content = llm.content;

  await writeText(paths.plansFile, content);
  await writeJson(paths.plansMetaFile, {
    generatedAt: new Date().toISOString(),
    mode: llm.mode,
    provider: llm.provider,
    model: llm.model,
    warning: llm.warning,
  });

  const state = await loadWorkflowAndTransition({
    stepId: 'plan_generate',
    requiredStepId: 'site_explore',
    requiredStatuses: ['approved', 'completed'],
    nextStatus: 'ai_generated',
    actor: input.actor,
    action: '生成',
    message: '已生成模块级测试计划。',
    artifacts: [
      { label: '模块测试计划', path: toRelativePath(paths.plansFile), kind: 'markdown' },
      { label: '测试计划元数据', path: toRelativePath(paths.plansMetaFile), kind: 'json' },
    ],
  });

  return {
    state,
    content,
    llm: {
      mode: llm.mode,
      provider: llm.provider,
      model: llm.model,
      warning: llm.warning,
    },
  };
}

export async function savePlanReview(input: {
  content: string;
  actor?: string;
  notes?: string;
}): Promise<WorkflowState> {
  if (!input.content.trim()) {
    throw new ApiError(400, 'empty_review_content', '测试计划审阅内容不能为空。');
  }

  await writeText(paths.plansFile, input.content);
  return markStepReviewed({
    stepId: 'plan_generate',
    actor: input.actor,
    notes: input.notes,
  });
}
