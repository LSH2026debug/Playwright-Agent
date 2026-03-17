import path from 'node:path';

import { llmAdapter } from '../adapters/llmAdapter.js';
import { paths, toRelativePath } from '../utils/paths.js';
import { ApiError } from '../utils/apiError.js';
import { readText, writeJson, writeText } from './storage.js';
import {
  getWorkflowPayload,
  markRequirementsGenerated,
  markRequirementsUploaded,
  markStepReviewed,
} from './workflowService.js';
import type { WorkflowState } from '../types/workflow.js';

export async function uploadRequirements(input: {
  originalName?: string;
  sourceText: string;
  actor?: string;
}): Promise<WorkflowState> {
  const extension = path.extname(input.originalName ?? '').toLowerCase();
  const normalizedName = extension === '.txt' ? 'requirements-input.txt' : 'requirements-input.md';

  await writeText(paths.requirementsInputFile, input.sourceText.trim());

  return markRequirementsUploaded({
    actor: input.actor,
    artifact: {
      label: extension === '.txt' ? '原始需求文本' : '原始需求文档',
      path: toRelativePath(paths.requirementsInputFile),
      kind: extension === '.txt' ? 'text' : 'markdown',
    },
  });
}

export async function generateNormalizedRequirements(input: {
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

  if (!workflow.workflow.project) {
    throw new ApiError(409, 'project_not_initialized', '请先完成项目初始化，再执行 AI 生成。');
  }

  const sourceText = await readText(paths.requirementsInputFile);
  if (!sourceText) {
    throw new ApiError(409, 'requirements_missing', '请先上传需求文档，再执行需求规范化。');
  }

  const llmResult = await llmAdapter.normalizeRequirements({
    siteUrl: workflow.workflow.project.siteUrl,
    sourceText,
    promptPath: paths.normalizePromptFile,
  });

  await writeText(paths.normalizedRequirementsFile, llmResult.content);
  await writeJson(paths.normalizedRequirementsMetaFile, {
    generatedAt: new Date().toISOString(),
    mode: llmResult.mode,
    provider: llmResult.provider,
    model: llmResult.model,
    warning: llmResult.warning,
  });

  const state = await markRequirementsGenerated({
    actor: input.actor,
    llmMode: llmResult.mode,
    artifacts: [
      {
        label: '规范化需求文档',
        path: toRelativePath(paths.normalizedRequirementsFile),
        kind: 'markdown',
      },
      {
        label: '规范化需求元数据',
        path: toRelativePath(paths.normalizedRequirementsMetaFile),
        kind: 'json',
      },
    ],
  });

  return {
    state,
    content: llmResult.content,
    llm: {
      mode: llmResult.mode,
      provider: llmResult.provider,
      model: llmResult.model,
      warning: llmResult.warning,
    },
  };
}

export async function saveRequirementsReview(input: {
  content: string;
  actor?: string;
  notes?: string;
}): Promise<WorkflowState> {
  if (!input.content.trim()) {
    throw new ApiError(400, 'empty_review_content', '审阅后的内容不能为空。');
  }

  await writeText(paths.normalizedRequirementsFile, input.content);
  return markStepReviewed({
    stepId: 'requirements_normalize',
    actor: input.actor,
    notes: input.notes,
  });
}
