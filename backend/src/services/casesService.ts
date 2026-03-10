import { llmAdapter } from '../adapters/llmAdapter.js';
import { ApiError } from '../utils/apiError.js';
import { paths, toRelativePath } from '../utils/paths.js';
import { writeJson, writeText } from './storage.js';
import { getWorkflowPayload, markStepReviewed } from './workflowService.js';
import { loadWorkflowAndTransition } from './workflowTransitions.js';
import type { WorkflowState } from '../types/workflow.js';

interface StructuredCase {
  id: string;
  module: string;
  title: string;
  priority: 'P0' | 'P1' | 'P2';
  preconditions: string[];
  steps: string[];
  expected: string[];
}

export async function generateCases(input: {
  actor?: string;
}): Promise<{
  state: WorkflowState;
  markdown: string;
  cases: StructuredCase[];
  llm: {
    mode: string;
    provider: string;
    model: string;
    warning?: string;
  };
}> {
  const workflow = await getWorkflowPayload();
  const stepStatus = workflow.workflow.steps.plan_generate.status;

  if (stepStatus !== 'approved' && stepStatus !== 'completed') {
    throw new ApiError(409, 'plan_not_approved', '请先批准测试计划，再生成结构化测试用例。');
  }

  const approvedPlan = workflow.documents.planDocument;

  if (!approvedPlan) {
    throw new ApiError(409, 'plan_missing', '缺少已批准的测试计划内容，无法生成结构化测试用例。');
  }

  const llm = await llmAdapter.planToCases({
    siteUrl: workflow.workflow.project?.siteUrl ?? '',
    approvedPlan,
    promptPath: paths.planPromptFile,
  });
  const cases = buildStructuredCases(approvedPlan);
  const markdown = buildCasesMarkdown(cases, llm.content);

  await writeJson(paths.casesFile, { cases });
  await writeText(paths.casesMarkdownFile, markdown);
  await writeJson(paths.casesMetaFile, {
    generatedAt: new Date().toISOString(),
    count: cases.length,
    mode: llm.mode,
    provider: llm.provider,
    model: llm.model,
    warning: llm.warning,
  });

  const state = await loadWorkflowAndTransition({
    stepId: 'cases_generate',
    requiredStepId: 'plan_generate',
    requiredStatuses: ['approved', 'completed'],
    nextStatus: 'ai_generated',
    actor: input.actor,
    action: '生成',
    message: '已生成结构化测试用例。',
    artifacts: [
      { label: '结构化测试用例 JSON', path: toRelativePath(paths.casesFile), kind: 'json' },
      { label: '结构化测试用例 Markdown', path: toRelativePath(paths.casesMarkdownFile), kind: 'markdown' },
      { label: '测试用例元数据', path: toRelativePath(paths.casesMetaFile), kind: 'json' },
    ],
  });

  return {
    state,
    markdown,
    cases,
    llm: {
      mode: llm.mode,
      provider: llm.provider,
      model: llm.model,
      warning: llm.warning,
    },
  };
}

export async function saveCasesReview(input: {
  markdown: string;
  actor?: string;
  notes?: string;
}): Promise<WorkflowState> {
  if (!input.markdown.trim()) {
    throw new ApiError(400, 'empty_review_content', '结构化测试用例内容不能为空。');
  }

  await writeText(paths.casesMarkdownFile, input.markdown);
  return markStepReviewed({
    stepId: 'cases_generate',
    actor: input.actor,
    notes: input.notes,
  });
}

function buildStructuredCases(approvedPlan: string): StructuredCase[] {
  const modules = inferModulesFromPlan(approvedPlan);
  const cases: StructuredCase[] = [];

  if (modules.includes('auth')) {
    cases.push(
      createCase('AUTH-001', 'auth', '标准用户成功登录', 'P0', ['访问登录页'], ['输入标准账号', '输入正确密码', '点击登录'], ['进入商品列表页']),
      createCase('AUTH-002', 'auth', '错误密码登录失败', 'P0', ['访问登录页'], ['输入标准账号', '输入错误密码', '点击登录'], ['显示错误提示，不跳转列表页']),
    );
  }

  if (modules.includes('catalog')) {
    cases.push(
      createCase('CAT-001', 'catalog', '商品列表页加载成功', 'P0', ['已成功登录'], ['进入 inventory 页面'], ['显示商品列表和标题']),
      createCase('CAT-002', 'catalog', '商品详情信息与列表一致', 'P1', ['已成功登录'], ['记录商品卡片标题', '进入详情页'], ['详情页商品名称与列表一致']),
    );
  }

  if (modules.includes('cart')) {
    cases.push(
      createCase('CART-001', 'cart', '单个商品加入购物车', 'P0', ['已成功登录'], ['在列表页点击加入购物车'], ['购物车数量显示为 1']),
      createCase('CART-002', 'cart', '购物车页移除商品', 'P1', ['购物车中已有商品'], ['进入购物车页', '点击移除'], ['购物车内商品消失']),
    );
  }

  if (modules.includes('checkout')) {
    cases.push(
      createCase('CHK-001', 'checkout', '进入结账信息页', 'P0', ['购物车中已有商品'], ['在购物车点击 checkout'], ['进入结账信息页']),
      createCase('CHK-002', 'checkout', '填写完整结账信息并继续', 'P0', ['已在结账信息页'], ['填写名、姓、邮编', '点击继续'], ['进入订单概览页']),
      createCase('CHK-003', 'checkout', '缺少必填信息时阻止继续', 'P1', ['已在结账信息页'], ['留空任一必填字段', '点击继续'], ['显示错误提示']),
      createCase('CHK-004', 'checkout', '完成订单后进入成功页', 'P0', ['已在订单概览页'], ['点击 Finish'], ['进入完成页并显示成功信息']),
    );
  }

  return cases.length > 0
    ? cases
    : [createCase('CORE-001', 'core', '站点主流程可访问', 'P0', ['访问目标站点'], ['进入首页并执行主操作'], ['主流程可访问且结果符合预期'])];
}

function createCase(
  id: string,
  module: string,
  title: string,
  priority: 'P0' | 'P1' | 'P2',
  preconditions: string[],
  steps: string[],
  expected: string[],
): StructuredCase {
  return { id, module, title, priority, preconditions, steps, expected };
}

function buildCasesMarkdown(cases: StructuredCase[], placeholder: string): string {
  return [
    '# 结构化测试用例',
    '',
    `- 用例总数：${cases.length}`,
    `- AI 备注：${placeholder}`,
    '',
    ...cases.flatMap((item) => [
      `## ${item.id} ${item.title}`,
      `- 模块：${item.module}`,
      `- 优先级：${item.priority}`,
      '- 前置条件：',
      ...item.preconditions.map((entry) => `  - ${entry}`),
      '- 步骤：',
      ...item.steps.map((entry, index) => `  ${index + 1}. ${entry}`),
      '- 预期结果：',
      ...item.expected.map((entry) => `  - ${entry}`),
      '',
    ]),
  ].join('\n');
}

function inferModulesFromPlan(approvedPlan: string): string[] {
  const detected = new Set<string>();
  const lower = approvedPlan.toLowerCase();

  if (lower.includes('auth')) {
    detected.add('auth');
  }

  if (lower.includes('catalog')) {
    detected.add('catalog');
  }

  if (lower.includes('cart')) {
    detected.add('cart');
  }

  if (lower.includes('checkout')) {
    detected.add('checkout');
  }

  return detected.size > 0 ? [...detected] : ['auth', 'catalog', 'cart', 'checkout'];
}
