import path from 'node:path';

import { chromium, type Page } from 'playwright';
import yaml from 'js-yaml';

import { config } from '../config.js';
import { paths, toRelativePath } from '../utils/paths.js';
import { ApiError } from '../utils/apiError.js';
import { ensureDir, writeJson, writeText } from './storage.js';
import { getWorkflowPayload, markStepReviewed } from './workflowService.js';
import { loadWorkflowAndTransition } from './workflowTransitions.js';
import type { ArtifactRef, WorkflowState } from '../types/workflow.js';

interface PageMetadata {
  id: string;
  title: string;
  url: string;
  headings: string[];
  roleHints: string[];
  screenshot: string;
}

interface FlowMetadata {
  id: string;
  name: string;
  steps: string[];
}

export async function exploreSite(input: {
  actor?: string;
}): Promise<{
  state: WorkflowState;
  summary: string;
  metadata: {
    pages: PageMetadata[];
    flows: FlowMetadata[];
    screenshots: string[];
  };
}> {
  const workflow = await getWorkflowPayload();

  if (!workflow.workflow.project) {
    throw new ApiError(409, 'project_not_initialized', '请先完成项目初始化，再执行站点探索。');
  }

  const requirementsStatus = workflow.workflow.steps.requirements_normalize.status;
  if (requirementsStatus !== 'approved' && requirementsStatus !== 'completed') {
    throw new ApiError(409, 'requirements_not_approved', '请先批准需求规范化结果，再执行站点探索。');
  }

  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    await page.goto(workflow.workflow.project.siteUrl, { waitUntil: 'domcontentloaded' });

    const pages: PageMetadata[] = [];
    const screenshotPaths: string[] = [];

    const pagePlans = buildExplorePlan(workflow.workflow.project.siteUrl, config.siteExplore.maxPages);

    for (const [index, plan] of pagePlans.entries()) {
      await page.goto(plan.url, { waitUntil: 'domcontentloaded' });
      const safeSlug = plan.id;
      const screenshotPath = `metadata/screenshots/${safeSlug}.png`;
      const absoluteScreenshotPath = path.join(paths.rootDir, screenshotPath);

      await ensureDir(absoluteScreenshotPath);
      await page.screenshot({ path: absoluteScreenshotPath, fullPage: true });

      const title = await page.title();
      const headings = await page.locator('h1, h2, h3').allTextContents();
      const buttons = await page.locator('button').allTextContents();
      const links = await page.locator('a').allTextContents();

      pages.push({
        id: plan.id,
        title,
        url: page.url(),
        headings: normalizeTextList(headings).slice(0, 8),
        roleHints: normalizeTextList([...buttons, ...links]).slice(0, 10),
        screenshot: screenshotPath,
      });
      screenshotPaths.push(screenshotPath);

      if (index === 0 && shouldUseSauceDemoLogin(workflow.workflow.project.siteUrl) && pagePlans.length > 1) {
        await loginToSauceDemo(page, workflow.workflow.project.siteUrl);
      }
    }

    const flows = buildFlows(workflow.workflow.project.siteUrl);
    const summary = buildExploreSummary(workflow.workflow.project.siteUrl, pages, flows);

    await writeText(paths.sitePagesFile, yaml.dump({ pages }, { lineWidth: 120 }));
    await writeText(paths.siteFlowsFile, yaml.dump({ flows }, { lineWidth: 120 }));
    await writeText(paths.siteExploreSummaryFile, summary);
    await writeJson(paths.siteExploreMetaFile, {
      exploredAt: new Date().toISOString(),
      siteUrl: workflow.workflow.project.siteUrl,
      screenshotCount: screenshotPaths.length,
      pagesCount: pages.length,
      flowsCount: flows.length,
    });

    const state = await markSiteExplored({
      actor: input.actor,
      artifacts: buildSiteExploreArtifacts(screenshotPaths),
    });

    return {
      state,
      summary,
      metadata: {
        pages,
        flows,
        screenshots: screenshotPaths,
      },
    };
  } finally {
    await browser.close();
  }
}

export async function saveSiteExploreReview(input: {
  content: string;
  actor?: string;
  notes?: string;
}): Promise<WorkflowState> {
  if (!input.content.trim()) {
    throw new ApiError(400, 'empty_review_content', '站点探索审阅内容不能为空。');
  }

  await writeText(paths.siteExploreSummaryFile, input.content);
  return markStepReviewed({
    stepId: 'site_explore',
    actor: input.actor,
    notes: input.notes,
  });
}

async function markSiteExplored(input: {
  actor?: string;
  artifacts: ArtifactRef[];
}): Promise<WorkflowState> {
  return loadWorkflowAndTransition({
    stepId: 'site_explore',
    requiredStepId: 'requirements_normalize',
    requiredStatuses: ['approved', 'completed'],
    nextStatus: 'ai_generated',
    actor: input.actor,
    action: '探索',
    message: '已完成受控站点探索并生成页面元数据。',
    artifacts: input.artifacts,
  });
}

function buildExplorePlan(siteUrl: string, maxPages: number): Array<{ id: string; url: string }> {
  const base = siteUrl.replace(/\/$/, '');
  const plans = [
    { id: 'login', url: base },
    { id: 'inventory', url: `${base}/inventory.html` },
    { id: 'cart', url: `${base}/cart.html` },
    { id: 'checkout-step-one', url: `${base}/checkout-step-one.html` },
  ];

  return plans.slice(0, Math.max(1, maxPages));
}

function shouldUseSauceDemoLogin(siteUrl: string): boolean {
  return siteUrl.toLowerCase().includes('saucedemo.com');
}

async function loginToSauceDemo(page: Page, siteUrl: string): Promise<void> {
  await page.goto(siteUrl, { waitUntil: 'domcontentloaded' });
  await page.locator('#user-name').fill(config.siteExplore.sauceDemoUsername);
  await page.locator('#password').fill(config.siteExplore.sauceDemoPassword);
  await page.locator('#login-button').click();
  await page.waitForURL(/inventory\.html/, { timeout: 10000 });
}

function buildFlows(siteUrl: string): FlowMetadata[] {
  return [
    {
      id: 'auth-login',
      name: '登录主流程',
      steps: [
        `${siteUrl} 登录页`,
        '输入用户名和密码',
        '点击登录按钮',
        '跳转到商品列表页',
      ],
    },
    {
      id: 'catalog-cart',
      name: '商品浏览与加购流程',
      steps: [
        '进入商品列表页',
        '浏览商品卡片',
        '点击加入购物车',
        '进入购物车页',
      ],
    },
    {
      id: 'checkout-complete',
      name: '结账完成流程',
      steps: [
        '购物车页进入结账',
        '填写结账信息',
        '确认订单',
        '进入完成页',
      ],
    },
  ];
}

function buildExploreSummary(siteUrl: string, pages: PageMetadata[], flows: FlowMetadata[]): string {
  return [
    '# 站点探索摘要',
    '',
    `- 目标站点：${siteUrl}`,
    `- 已探索页面数：${pages.length}`,
    `- 已识别流程数：${flows.length}`,
    '',
    '## 页面概览',
    ...pages.flatMap((item) => [
      `### ${item.id}`,
      `- 标题：${item.title || '未获取到标题'}`,
      `- URL：${item.url}`,
      `- 截图：${item.screenshot}`,
      `- 标题层级：${item.headings.join('；') || '无'}`,
      `- 可见操作提示：${item.roleHints.join('；') || '无'}`,
      '',
    ]),
    '## 推荐业务流程',
    ...flows.flatMap((flow) => [
      `### ${flow.name}`,
      ...flow.steps.map((step, index) => `${index + 1}. ${step}`),
      '',
    ]),
    '## 审阅检查清单',
    '- 确认页面列表覆盖后续要生成测试计划的关键入口。',
    '- 确认截图与页面路径匹配。',
    '- 确认推荐业务流程能够支撑后续模块级测试计划。',
  ].join('\n');
}

function normalizeTextList(values: string[]): string[] {
  return values
    .map((value) => value.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter((value, index, array) => array.indexOf(value) === index);
}

function buildSiteExploreArtifacts(screenshotPaths: string[]): ArtifactRef[] {
  return [
    {
      label: '页面元数据',
      path: toRelativePath(paths.sitePagesFile),
      kind: 'yaml',
    },
    {
      label: '流程元数据',
      path: toRelativePath(paths.siteFlowsFile),
      kind: 'yaml',
    },
    {
      label: '站点探索摘要',
      path: toRelativePath(paths.siteExploreSummaryFile),
      kind: 'markdown',
    },
    {
      label: '站点探索元数据',
      path: toRelativePath(paths.siteExploreMetaFile),
      kind: 'json',
    },
    ...screenshotPaths.map((screenshotPath, index) => ({
      label: `站点截图 ${index + 1}`,
      path: screenshotPath,
      kind: 'image' as const,
    })),
  ];
}
