import path from 'node:path';

import { chromium, type Locator, type Page } from 'playwright';
import yaml from 'js-yaml';

import { config } from '../config.js';
import { paths, toRelativePath } from '../utils/paths.js';
import { ApiError } from '../utils/apiError.js';
import { logger } from '../utils/logger.js';
import { ensureDir, fileExists, writeJson, writeText } from './storage.js';
import { getWorkflowPayload, markStepReviewed } from './workflowService.js';
import { loadWorkflowAndTransition } from './workflowTransitions.js';
import { getLoginSessionStatus } from './loginSessionService.js';
import type { ArtifactRef, ProjectAuthConfig, WorkflowState } from '../types/workflow.js';
import {
  buildBestSelectorFn,
  buildPlaywrightLocatorFn,
  accessibilityTreeScript,
} from './selectorBuilder.js';

interface InteractiveElement {
  tag: string;
  text: string;
  selector: string;
  playwrightLocator: string;
  role?: string;
  ariaLabel?: string;
  type?: string;
  isUnique: boolean;
}

interface FormField {
  tag: string;
  type: string;
  selector: string;
  playwrightLocator: string;
  label?: string;
  placeholder?: string;
  name?: string;
  required: boolean;
  options?: string[];
  isUnique: boolean;
}

interface TableInfo {
  selector: string;
  columns: string[];
  rowCount: number;
  rowActionButtons: string[];
  hasPagination: boolean;
}

interface AccessibilityNode {
  role: string;
  name: string;
  children?: AccessibilityNode[];
}

interface ApiRequest {
  method: string;
  url: string;
  statusCode?: number;
}

interface DialogInfo {
  triggerSelector: string;
  triggerText: string;
  dialogSelector: string;
  title?: string;
  formFields: FormField[];
  buttons: InteractiveElement[];
}

interface PageMetadata {
  id: string;
  title: string;
  url: string;
  headings: string[];
  roleHints: string[];
  screenshot: string;
  interactiveElements: InteractiveElement[];
  formFields: FormField[];
  dialogs: DialogInfo[];
  tables: TableInfo[];
  accessibilityTree: AccessibilityNode[];
  apiRequests: ApiRequest[];
}

interface FlowMetadata {
  id: string;
  name: string;
  steps: string[];
}

interface ExploreLoginInput {
  enabled?: boolean;
  loginUrl?: string;
  username?: string;
  password?: string;
  useStoredSession?: boolean;
}

interface EffectiveLoginConfig {
  enabled: boolean;
  loginUrl: string;
  username?: string;
  password?: string;
  useStoredSession: boolean;
}

interface ExploreRuntime {
  page: Page;
  close: () => Promise<void>;
}

export async function exploreSite(input: {
  actor?: string;
  maxPages?: number;
  login?: ExploreLoginInput;
}): Promise<{
  state: WorkflowState;
  summary: string;
  metadata: {
    pages: PageMetadata[];
    flows: FlowMetadata[];
    screenshots: string[];
  };
}> {
  logger.info('Starting site exploration', { maxPages: input.maxPages });
  
  const workflow = await getWorkflowPayload();

  if (!workflow.workflow.project) {
    throw new ApiError(409, 'project_not_initialized', '请先完成项目初始化，再执行站点探索。');
  }

  const requirementsStatus = workflow.workflow.steps.requirements_normalize.status;
  if (requirementsStatus !== 'approved' && requirementsStatus !== 'completed') {
    throw new ApiError(409, 'requirements_not_approved', '请先批准需求规范化结果，再执行站点探索。');
  }

  const project = workflow.workflow.project;
  const siteUrl = project.siteUrl;
  const maxPages = resolveMaxPages(input.maxPages);
  const loginConfig = resolveLoginConfig(siteUrl, project.auth, input.login);
  const loginSession = loginConfig.useStoredSession ? await getLoginSessionStatus() : null;

  if (loginConfig.useStoredSession && !loginSession?.profileReady) {
    throw new ApiError(409, 'login_session_not_ready', '当前还没有可复用的登录态，请先打开登录浏览器并保存登录态。');
  }

  if (loginConfig.useStoredSession && loginSession?.browserOpen) {
    throw new ApiError(409, 'login_browser_still_open', '请先在第 4 步保存并关闭登录浏览器，再执行站点探索。');
  }

  const authMethod = loginConfig.useStoredSession
    ? 'manual_session'
    : loginConfig.enabled
      ? 'credentials'
      : 'none';

  logger.info('Creating explore runtime', { authMethod, useStoredSession: loginConfig.useStoredSession });
  const runtime = await createExploreRuntime(loginConfig.useStoredSession);

  try {
    const page = runtime.page;
    const pages: PageMetadata[] = [];
    const screenshotPaths: string[] = [];
    const visitedUrls = new Set<string>();
    const apiRequests = setupApiRequestMonitor(page);

    let authenticated = false;
    if (loginConfig.useStoredSession) {
      await page.goto(siteUrl, { waitUntil: 'domcontentloaded' });
      authenticated = await detectAuthenticatedPage(page);

      if (!authenticated) {
        throw new ApiError(409, 'stored_login_session_invalid', '已保存的登录态未生效，当前仍停留在登录页。请重新打开登录浏览器完成登录后，再保存登录态。');
      }

      await captureCurrentPage(page, pages, screenshotPaths, visitedUrls, 'home');
    } else {
      await page.goto(loginConfig.enabled ? loginConfig.loginUrl : siteUrl, { waitUntil: 'domcontentloaded' });
      await captureCurrentPage(page, pages, screenshotPaths, visitedUrls, loginConfig.enabled ? 'login' : 'home');
    }

    if (loginConfig.enabled && !loginConfig.useStoredSession) {
      authenticated = await loginToSite(page, siteUrl, loginConfig);
      await captureCurrentPage(page, pages, screenshotPaths, visitedUrls, derivePageId(page.url(), 'landing'));
    }

    if (shouldUseSauceDemoPreset(siteUrl)) {
      const pagePlans = buildSauceDemoExplorePlan(siteUrl);

      for (const plan of pagePlans) {
        if (pages.length >= maxPages) {
          break;
        }

        await page.goto(plan.url, { waitUntil: 'domcontentloaded' });
        await captureCurrentPage(page, pages, screenshotPaths, visitedUrls, plan.id);
      }
    } else {
      await exploreMenuDrivenPages(page, maxPages, pages, screenshotPaths, visitedUrls);

      const remainingSlots = Math.max(0, maxPages - pages.length);
      const pagePlans = await discoverExplorePlan(page, siteUrl, remainingSlots, visitedUrls);

      for (const plan of pagePlans) {
        if (pages.length >= maxPages) {
          break;
        }

        await page.goto(plan.url, { waitUntil: 'domcontentloaded' });
        await captureCurrentPage(page, pages, screenshotPaths, visitedUrls, plan.id);
      }
    }

    const flows = buildFlows(siteUrl, pages, authenticated);

    // Distribute collected API requests to pages (associate by timing — assign all to a global list)
    // Deduplicate API requests and assign to each page based on URL match
    const uniqueApis = deduplicateApiRequests(apiRequests);
    if (pages.length > 0) {
      // Assign all unique API requests to page-elements.json at global level
      // and also attempt to match by page URL origin
      for (const p of pages) {
        p.apiRequests = uniqueApis.filter(r => {
          // Simple heuristic: if the API path contains a keyword from the page id, associate it
          return true; // Assign all APIs to every page for now; the consumer can filter
        });
      }
    }

    const summary = buildExploreSummary(siteUrl, pages, flows, {
      maxPages,
      authMethod,
      loginUsed: loginConfig.enabled,
      authenticated,
      loginUrl: loginConfig.enabled ? loginConfig.loginUrl : null,
    });

    await writeText(paths.sitePagesFile, yaml.dump({ pages: pages.map(stripPageElementsForYaml) }, { lineWidth: 120 }));
    await writeText(paths.siteFlowsFile, yaml.dump({ flows }, { lineWidth: 120 }));
    await writeText(paths.siteExploreSummaryFile, summary);
    await writeJson(paths.sitePageElementsFile, buildPageElementsPayload(pages));
    await writeJson(paths.siteExploreMetaFile, {
      exploredAt: new Date().toISOString(),
      siteUrl,
      maxPagesRequested: maxPages,
      screenshotCount: screenshotPaths.length,
      pagesCount: pages.length,
      flowsCount: flows.length,
      requiresLogin: loginConfig.enabled,
      authenticated,
      loginUrlUsed: loginConfig.enabled ? loginConfig.loginUrl : null,
      authMethod,
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
    await runtime.close();
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

function resolveLoginConfig(
  siteUrl: string,
  projectAuth: ProjectAuthConfig,
  runtimeLogin?: ExploreLoginInput,
): EffectiveLoginConfig {
  const hasRuntimeCredentials = Boolean(runtimeLogin?.username?.trim() || runtimeLogin?.password);
  const useStoredSession = runtimeLogin?.useStoredSession ?? false;
  const enabled = typeof runtimeLogin?.enabled === 'boolean'
    ? runtimeLogin.enabled || hasRuntimeCredentials || useStoredSession
    : projectAuth.requiresLogin || hasRuntimeCredentials || shouldUseSauceDemoPreset(siteUrl);

  const loginUrl = runtimeLogin?.loginUrl?.trim() || projectAuth.loginUrl || siteUrl;
  const username = runtimeLogin?.username?.trim() || (shouldUseSauceDemoPreset(siteUrl) ? config.siteExplore.sauceDemoUsername : undefined);
  const password = runtimeLogin?.password || (shouldUseSauceDemoPreset(siteUrl) ? config.siteExplore.sauceDemoPassword : undefined);

  return {
    enabled,
    loginUrl,
    username,
    password,
    useStoredSession,
  };
}

function resolveMaxPages(requestedMaxPages?: number): number {
  if (!requestedMaxPages || !Number.isFinite(requestedMaxPages)) {
    return config.siteExplore.maxPages;
  }

  return Math.max(1, Math.trunc(requestedMaxPages));
}

function shouldUseSauceDemoPreset(siteUrl: string): boolean {
  return siteUrl.toLowerCase().includes('saucedemo.com');
}

async function loginToSite(page: Page, siteUrl: string, loginConfig: EffectiveLoginConfig): Promise<boolean> {
  if (!loginConfig.username || !loginConfig.password) {
    throw new ApiError(400, 'login_credentials_missing', '当前站点已开启登录探索，请在第 4 步填写用户名和密码。');
  }

  if (shouldUseSauceDemoPreset(siteUrl)) {
    await page.goto(loginConfig.loginUrl, { waitUntil: 'domcontentloaded' });
    await page.locator('#user-name').fill(loginConfig.username);
    await page.locator('#password').fill(loginConfig.password);
    await page.locator('#login-button').click();
    await page.waitForURL(/inventory\.html/, { timeout: 10000 });
    return true;
  }

  await page.goto(loginConfig.loginUrl, { waitUntil: 'domcontentloaded' });
  const usernameField = await findFirstVisibleLocator(page, [
    'input[autocomplete="username"]',
    'input[type="email"]',
    'input[name*="email" i]',
    'input[id*="email" i]',
    'input[name*="user" i]',
    'input[id*="user" i]',
    'input[type="text"]',
  ]);
  const passwordField = await findFirstVisibleLocator(page, [
    'input[autocomplete="current-password"]',
    'input[type="password"]',
    'input[name*="pass" i]',
    'input[id*="pass" i]',
  ]);

  if (!usernameField || !passwordField) {
    throw new ApiError(400, 'login_form_not_found', '未能自动识别登录表单，请确认登录页 URL 是否正确，或后续改成自定义选择器版本。');
  }

  await usernameField.fill(loginConfig.username);
  await passwordField.fill(loginConfig.password);

  const startUrl = page.url();
  const submitButton = await findSubmitButton(page);
  if (submitButton) {
    await submitButton.click();
  } else {
    await passwordField.press('Enter');
  }

  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 10000 });
  } catch {
    // Ignore and continue with fallback checks below.
  }

  try {
    await page.waitForFunction(
      ([initialUrl]) => window.location.href !== initialUrl || !document.querySelector('input[type="password"]'),
      [startUrl],
      { timeout: 10000 },
    );
  } catch {
    // Ignore and validate using visibility heuristics below.
  }

  const passwordStillVisible = await isPasswordFieldVisible(page);
  if (passwordStillVisible && stripHash(page.url()) === stripHash(startUrl)) {
    throw new ApiError(400, 'login_failed', '登录未成功，请检查用户名、密码或登录页地址。');
  }

  return true;
}

function buildFlows(siteUrl: string, pages: PageMetadata[], authenticated: boolean): FlowMetadata[] {
  if (shouldUseSauceDemoPreset(siteUrl)) {
    return buildSauceDemoFlows(siteUrl);
  }

  const pageSteps = pages.map((item) => `${item.title || item.id}（${item.url}）`);

  return [
    {
      id: 'entry-navigation',
      name: authenticated ? '登录后关键页面浏览' : '公开站点主导航浏览',
      steps: pageSteps.slice(0, 4),
    },
    {
      id: 'content-sampling',
      name: '关键页面抽样检查',
      steps: pages.slice(0, 4).map((item) => `检查页面 ${item.id} 的标题、标题层级和可见操作提示`),
    },
  ].filter((flow) => flow.steps.length > 0);
}

function buildSauceDemoFlows(siteUrl: string): FlowMetadata[] {
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

function buildExploreSummary(
  siteUrl: string,
  pages: PageMetadata[],
  flows: FlowMetadata[],
  authSummary: {
    maxPages: number;
    authMethod: 'none' | 'credentials' | 'manual_session';
    loginUsed: boolean;
    authenticated: boolean;
    loginUrl: string | null;
  },
): string {
  return [
    '# 站点探索摘要',
    '',
    `- 目标站点：${siteUrl}`,
    `- 本次探索上限：${authSummary.maxPages}`,
    `- 已探索页面数：${pages.length}`,
    `- 已识别流程数：${flows.length}`,
    `- 登录方式：${formatAuthMethod(authSummary.authMethod)}`,
    `- 是否使用登录：${authSummary.loginUsed ? '是' : '否'}`,
    `- 登录结果：${authSummary.loginUsed ? (authSummary.authenticated ? '登录成功' : '登录未成功') : '未启用登录'}`,
    ...(authSummary.loginUrl ? [`- 登录页：${authSummary.loginUrl}`] : []),
    `- 总交互元素数：${pages.reduce((s, p) => s + p.interactiveElements.length, 0)}`,
    `- 总表单字段数：${pages.reduce((s, p) => s + p.formFields.length, 0)}`,
    `- 已探测弹窗数：${pages.reduce((s, p) => s + p.dialogs.length, 0)}`,
    `- 已识别表格数：${pages.reduce((s, p) => s + p.tables.length, 0)}`,
    `- 已捕获API数：${pages.reduce((s, p) => s + p.apiRequests.length, 0)}`,
    '',
    '## 页面概览',
    ...pages.flatMap((item) => [
      `### ${item.id}`,
      `- 标题：${item.title || '未获取到标题'}`,
      `- URL：${item.url}`,
      `- 截图：${item.screenshot}`,
      `- 标题层级：${item.headings.join('；') || '无'}`,
      `- 可见操作提示：${item.roleHints.join('；') || '无'}`,
      `- 交互元素：${item.interactiveElements.length} 个${item.interactiveElements.length > 0 ? '（' + item.interactiveElements.slice(0, 5).map(e => `[${e.text}]`).join('、') + (item.interactiveElements.length > 5 ? '…' : '') + '）' : ''}`,
      `- 表单字段：${item.formFields.length} 个${item.formFields.length > 0 ? '（' + item.formFields.slice(0, 5).map(f => `${f.label || f.placeholder || f.name || f.type}`).join('、') + (item.formFields.length > 5 ? '…' : '') + '）' : ''}`,
      ...(item.dialogs.length > 0 ? [`- 弹窗：${item.dialogs.map(d => `"${d.triggerText}" → ${d.title || '无标题'}（${d.formFields.length} 字段）`).join('；')}`] : []),
      ...(item.tables.length > 0 ? [`- 表格：${item.tables.map(t => `${t.columns.length} 列 × ${t.rowCount} 行${t.rowActionButtons.length > 0 ? '，操作列: ' + t.rowActionButtons.join('/') : ''}${t.hasPagination ? '，有分页' : ''}`).join('；')}`] : []),
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
    '- 确认交互元素和表单字段的选择器能用于后续脚本生成。',
    '- 确认弹窗探测覆盖了关键的创建/编辑操作。',
    '',
    '> 详细交互元素信息见 `metadata/site/page-elements.json`。',
  ].join('\n');
}

function normalizeTextList(values: string[]): string[] {
  return values
    .map((value) => value.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter((value, index, array) => array.indexOf(value) === index);
}

async function createExploreRuntime(useStoredSession: boolean): Promise<ExploreRuntime> {
  if (useStoredSession) {
    if (!(await fileExists(paths.authStorageStateFile))) {
      throw new ApiError(409, 'login_session_not_ready', '未找到可复用的登录态文件，请先打开登录浏览器并保存登录态。');
    }

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 960 },
      storageState: paths.authStorageStateFile,
    });
    const page = await context.newPage();
    return {
      page,
      close: async () => {
        await context.close();
        await browser.close();
      },
    };
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 960 },
  });
  const page = await context.newPage();
  return {
    page,
    close: async () => {
      await context.close();
      await browser.close();
    },
  };
}

async function captureCurrentPage(
  page: Page,
  pages: PageMetadata[],
  screenshotPaths: string[],
  visitedUrls: Set<string>,
  idHint: string,
): Promise<void> {
  await waitForRenderablePage(page);

  const currentUrl = stripHash(page.url());
  if (!currentUrl || visitedUrls.has(currentUrl)) {
    return;
  }

  const pageId = uniquePageId(idHint || derivePageId(currentUrl, `page-${pages.length + 1}`), pages);
  const screenshotPath = `metadata/screenshots/${pageId}.png`;
  const absoluteScreenshotPath = path.join(paths.rootDir, screenshotPath);

  await ensureDir(absoluteScreenshotPath);
  await page.screenshot({ path: absoluteScreenshotPath, fullPage: true });

  const title = await page.title();
  const headings = await collectVisibleTexts(page, 'h1, h2, h3, .el-breadcrumb__item, .tags-view-item.active, .app-main .el-card__header, .page-title', 12);
  const buttons = await collectVisibleTexts(page, 'button, .el-button, [role="button"]', 20);
  const links = await collectVisibleTexts(page, 'a, .el-menu-item, .el-submenu__title, .submenu-title-noDropdown', 20);

  const interactiveElements = await collectInteractiveElements(page, 60);
  const formFields = await collectFormFields(page);
  const tables = await collectTableStructures(page);
  const accessibilityTree = await collectAccessibilityTree(page);
  const dialogs = await probeDialogs(page, pageId);

  pages.push({
    id: pageId,
    title,
    url: currentUrl,
    headings: normalizeTextList(headings).slice(0, 12),
    roleHints: normalizeTextList([...buttons, ...links]).slice(0, 20),
    screenshot: screenshotPath,
    interactiveElements,
    formFields,
    dialogs,
    tables,
    accessibilityTree,
    apiRequests: [],
  });
  screenshotPaths.push(screenshotPath);
  visitedUrls.add(currentUrl);
}

async function exploreMenuDrivenPages(
  page: Page,
  maxPages: number,
  pages: PageMetadata[],
  screenshotPaths: string[],
  visitedUrls: Set<string>,
): Promise<void> {
  if (maxPages <= pages.length) {
    return;
  }

  const triedLabels = new Set<string>();
  const directMenuLabels = await collectVisibleTexts(page, '.el-menu-item.submenu-title-noDropdown.item-block', 12);

  for (const label of directMenuLabels) {
    if (pages.length >= maxPages) {
      return;
    }

    if (!label || /^home$/i.test(label) || triedLabels.has(label)) {
      continue;
    }

    triedLabels.add(label);
    const changed = await clickMenuItemAndWait(page, '.el-menu-item.submenu-title-noDropdown.item-block', label);
    if (changed) {
      await captureCurrentPage(page, pages, screenshotPaths, visitedUrls, sanitizeSlug(label) || 'menu');
    }
  }

  const submenuLabels = await collectVisibleTexts(page, '.el-submenu__title', 12);

  for (const submenuLabel of submenuLabels) {
    if (pages.length >= maxPages) {
      return;
    }

    const submenuTitle = page.locator('.el-submenu__title').filter({ hasText: submenuLabel }).first();
    if (!(await submenuTitle.isVisible().catch(() => false))) {
      continue;
    }

    await submenuTitle.click();
    await page.waitForTimeout(600);

    const childLabels = await collectVisibleTexts(page, '.el-submenu.is-opened .el-menu-item', 12);
    for (const childLabel of childLabels) {
      if (pages.length >= maxPages) {
        return;
      }

      if (!childLabel || triedLabels.has(`${submenuLabel}:${childLabel}`)) {
        continue;
      }

      triedLabels.add(`${submenuLabel}:${childLabel}`);
      const changed = await clickMenuItemAndWait(page, '.el-submenu.is-opened .el-menu-item', childLabel);
      if (changed) {
        await captureCurrentPage(page, pages, screenshotPaths, visitedUrls, sanitizeSlug(childLabel) || 'menu-item');
      }
    }
  }
}

async function discoverExplorePlan(
  page: Page,
  siteUrl: string,
  maxPages: number,
  visitedUrls: Set<string>,
): Promise<Array<{ id: string; url: string }>> {
  if (maxPages <= 0) {
    return [];
  }

  const origin = new URL(siteUrl).origin;
  const hrefs = await page.locator('a[href]').evaluateAll((anchors) =>
    anchors
      .map((anchor) => anchor.getAttribute('href'))
      .filter((value): value is string => Boolean(value)),
  );

  const uniqueUrls = new Set<string>();

  for (const href of hrefs) {
    const normalizedUrl = normalizeCandidateUrl(href, page.url(), origin);
    if (!normalizedUrl || visitedUrls.has(normalizedUrl)) {
      continue;
    }

    uniqueUrls.add(normalizedUrl);
    if (uniqueUrls.size >= maxPages) {
      break;
    }
  }

  return [...uniqueUrls].map((url, index) => ({
    id: derivePageId(url, `page-${index + 1}`),
    url,
  }));
}

function buildSauceDemoExplorePlan(siteUrl: string): Array<{ id: string; url: string }> {
  const base = siteUrl.replace(/\/$/, '');
  return [
    { id: 'inventory', url: `${base}/inventory.html` },
    { id: 'cart', url: `${base}/cart.html` },
    { id: 'checkout-step-one', url: `${base}/checkout-step-one.html` },
  ];
}

function derivePageId(url: string, fallback: string): string {
  try {
    const parsed = new URL(url);
    const pathName = parsed.pathname.replace(/\/$/, '');
    const lastSegment = pathName.split('/').filter(Boolean).pop();
    if (!lastSegment) {
      return fallback;
    }

    return sanitizeSlug(lastSegment.replace(/\.html?$/i, '')) || fallback;
  } catch {
    return fallback;
  }
}

function uniquePageId(idHint: string, pages: PageMetadata[]): string {
  const sanitized = sanitizeSlug(idHint) || `page-${pages.length + 1}`;
  if (!pages.some((item) => item.id === sanitized)) {
    return sanitized;
  }

  let index = 2;
  while (pages.some((item) => item.id === `${sanitized}-${index}`)) {
    index += 1;
  }

  return `${sanitized}-${index}`;
}

function sanitizeSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeCandidateUrl(href: string, currentUrl: string, origin: string): string | null {
  if (!href || href.startsWith('#') || /^mailto:|^tel:|^javascript:/i.test(href)) {
    return null;
  }

  try {
    const url = new URL(href, currentUrl);
    if (url.origin !== origin) {
      return null;
    }

    url.hash = '';
    const normalized = url.toString();
    if (/logout|signout/i.test(normalized)) {
      return null;
    }

    return stripHash(normalized);
  } catch {
    return null;
  }
}

async function findFirstVisibleLocator(page: Page, selectors: string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) > 0 && (await locator.isVisible().catch(() => false))) {
      return locator;
    }
  }

  return null;
}

async function clickMenuItemAndWait(page: Page, selector: string, label: string): Promise<boolean> {
  const target = page.locator(selector).filter({ hasText: label }).first();
  if (!(await target.isVisible().catch(() => false))) {
    return false;
  }

  const before = await getMainContentFingerprint(page);
  await target.click();
  await waitForPageTransition(page, before);
  const after = await getMainContentFingerprint(page);

  return before.url !== after.url || before.text !== after.text;
}

async function findSubmitButton(page: Page): Promise<Locator | null> {
  const selectors = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button[name*="login" i]',
    'button[id*="login" i]',
  ];

  const directMatch = await findFirstVisibleLocator(page, selectors);
  if (directMatch) {
    return directMatch;
  }

  const namedButton = page.getByRole('button', { name: /登录|log in|login|sign in|continue|提交/i }).first();
  if ((await namedButton.count()) > 0 && (await namedButton.isVisible().catch(() => false))) {
    return namedButton;
  }

  return null;
}

async function isPasswordFieldVisible(page: Page): Promise<boolean> {
  const passwordField = page.locator('input[type="password"]').first();
  return (await passwordField.count()) > 0 && (await passwordField.isVisible().catch(() => false));
}

async function detectAuthenticatedPage(page: Page): Promise<boolean> {
  const passwordVisible = await isPasswordFieldVisible(page);
  const normalizedUrl = stripHash(page.url()).toLowerCase();
  return !passwordVisible && !normalizedUrl.includes('/login');
}

async function waitForRenderablePage(page: Page): Promise<void> {
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 10000 });
  } catch {
    // Ignore transient timing issues and continue with DOM-based checks.
  }

  try {
    await page.waitForFunction(() => {
      const appMain = document.querySelector('.app-main');
      const text = (appMain?.textContent || document.body?.textContent || '').replace(/\s+/g, ' ').trim();
      const hasVisibleLayout = Boolean(document.querySelector('.main-container, .app-main, .sidebar-container'));
      return hasVisibleLayout && text.length > 120;
    }, { timeout: 10000 });
  } catch {
    // Fall back to a short delay for SPA pages that render incrementally.
  }

  await page.waitForTimeout(1200);
}

async function waitForPageTransition(
  page: Page,
  before: {
    url: string;
    text: string;
  },
): Promise<void> {
  try {
    await page.waitForFunction(
      (input) => {
        const currentUrl = window.location.href.replace(/#.*$/, '');
        const appMain = document.querySelector('.app-main');
        const currentText = (appMain?.textContent || document.body?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 1200);
        return currentUrl !== input.url || currentText !== input.text;
      },
      before,
      { timeout: 10000 },
    );
  } catch {
    // Ignore and continue with render wait.
  }

  await waitForRenderablePage(page);
}

async function getMainContentFingerprint(page: Page): Promise<{ url: string; text: string }> {
  const fingerprint = await page.evaluate(() => {
    const appMain = document.querySelector('.app-main');
    const text = (appMain?.textContent || document.body?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 1200);
    return {
      url: window.location.href.replace(/#.*$/, ''),
      text,
    };
  });

  return fingerprint;
}

async function collectVisibleTexts(page: Page, selector: string, limit: number): Promise<string[]> {
  const texts = await page.locator(selector).evaluateAll((elements, maxSize) =>
    elements
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const visible = Boolean(rect.width || rect.height || element.getClientRects().length);
        if (!visible) {
          return '';
        }

        return (element.textContent || '').replace(/\s+/g, ' ').trim();
      })
      .filter(Boolean)
      .filter((value, index, array) => array.indexOf(value) === index)
      .slice(0, Number(maxSize)),
    limit,
  );

  return texts.filter(Boolean);
}

async function collectInteractiveElements(page: Page, limit: number): Promise<InteractiveElement[]> {
  const selector = [
    'button:not([disabled])',
    '.el-button:not(.is-disabled)',
    '[role="button"]:not([disabled])',
    'a[href]',
    '.el-menu-item',
    '.el-dropdown-menu__item',
    '.el-tabs__item',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="link"]',
    '[role="switch"]',
    '.el-switch',
    '.el-radio',
    '.el-checkbox',
  ].join(', ');

  const raw = await page.locator(selector).evaluateAll((elements, params) => {
    const { maxSize, buildSelectorSrc, buildLocatorSrc } = params as { 
      maxSize: number; 
      buildSelectorSrc: string; 
      buildLocatorSrc: string 
    };
    // 在浏览器端通过 Function 构造器创建函数
    const buildSel = new Function('return ' + buildSelectorSrc)();
    const buildLoc = new Function('return ' + buildLocatorSrc)();
    
    const seen = new Set<string>();
    return elements
      .map((el) => {
        const rect = el.getBoundingClientRect();
        if (!rect.width && !rect.height) return null;
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        if (!text || seen.has(text)) return null;
        seen.add(text);
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute('role') || undefined;
        const ariaLabel = el.getAttribute('aria-label') || undefined;
        const type = el.getAttribute('type') || undefined;
        const sel = buildSel(el);
        const matchCount = document.querySelectorAll(sel).length;
        return {
          tag,
          text,
          selector: sel,
          playwrightLocator: buildLoc(el),
          role,
          ariaLabel,
          type,
          isUnique: matchCount === 1,
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .slice(0, Number(maxSize));
  }, { 
    maxSize: limit, 
    buildSelectorSrc: buildBestSelectorFn, 
    buildLocatorSrc: buildPlaywrightLocatorFn 
  });

  return raw;
}

async function collectFormFields(page: Page, containerSelector?: string): Promise<FormField[]> {
  const scope = containerSelector || 'body';
  
  const raw = await page.locator(`${scope}`).evaluateAll((containers, params) => {
    const { buildSelectorSrc, buildLocatorSrc } = params as { 
      buildSelectorSrc: string; 
      buildLocatorSrc: string 
    };
    // 在浏览器端通过 Function 构造器创建函数
    const buildSel = new Function('return ' + buildSelectorSrc)();
    const buildLoc = new Function('return ' + buildLocatorSrc)();
    
    const container = containers[0] || document.body;
    const fields = container.querySelectorAll('input, select, textarea, .el-input__inner, .el-textarea__inner, .el-select');
    const seen = new Set<string>();
    return Array.from(fields)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        if (!rect.width && !rect.height) return null;
        const tag = el.tagName.toLowerCase();
        const type = el.getAttribute('type') || (tag === 'select' ? 'select' : tag === 'textarea' ? 'textarea' : 'text');
        if (type === 'hidden') return null;
        const sel = buildSel(el);
        if (seen.has(sel)) return null;
        seen.add(sel);
        const matchCount = document.querySelectorAll(sel).length;
        const name = el.getAttribute('name') || undefined;
        const placeholder = el.getAttribute('placeholder') || undefined;
        const required = el.hasAttribute('required') || el.classList.contains('is-required')
          || Boolean(el.closest('.el-form-item.is-required'));
        let label: string | undefined;
        const formItem = el.closest('.el-form-item');
        if (formItem) {
          const labelEl = formItem.querySelector('.el-form-item__label');
          if (labelEl) label = (labelEl.textContent || '').replace(/\s+/g, ' ').trim();
        }
        if (!label) {
          const id = el.getAttribute('id');
          if (id) {
            const labelFor = container.querySelector(`label[for="${id}"]`);
            if (labelFor) label = (labelFor.textContent || '').replace(/\s+/g, ' ').trim();
          }
        }
        if (!label && el.getAttribute('aria-label')) {
          label = el.getAttribute('aria-label') || undefined;
        }
        let options: string[] | undefined;
        if (tag === 'select') {
          options = Array.from(el.querySelectorAll('option'))
            .map(o => (o.textContent || '').trim())
            .filter(Boolean)
            .slice(0, 20);
        }
        return {
          tag,
          type,
          selector: sel,
          playwrightLocator: buildLoc(el),
          label,
          placeholder,
          name,
          required,
          options,
          isUnique: matchCount === 1,
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .slice(0, 50);
  }, { 
    buildSelectorSrc: buildBestSelectorFn, 
    buildLocatorSrc: buildPlaywrightLocatorFn 
  });

  return raw;
}

async function probeDialogs(page: Page, pageId: string): Promise<DialogInfo[]> {
  const dialogs: DialogInfo[] = [];

  const triggerSelectors = [
    'button.el-button--primary',
    '.el-button--primary',
    'button:has-text("新建")',
    'button:has-text("创建")',
    'button:has-text("添加")',
    'button:has-text("新增")',
    'button:has-text("编辑")',
  ];

  for (const triggerSel of triggerSelectors) {
    if (dialogs.length >= 3) break;

    const triggers = page.locator(triggerSel);
    const count = await triggers.count();

    for (let i = 0; i < Math.min(count, 2); i++) {
      if (dialogs.length >= 3) break;
      const trigger = triggers.nth(i);
      if (!(await trigger.isVisible().catch(() => false))) continue;

      const triggerText = (await trigger.textContent().catch(() => ''))?.replace(/\s+/g, ' ').trim() || '';
      if (!triggerText || triggerText.length > 40) continue;
      if (/登出|logout|signout|删除|delete|remove/i.test(triggerText)) continue;

      const triggerSelector = await trigger.evaluate((el) => {
        if (el.id) return `#${el.id}`;
        const testId = el.getAttribute('data-testid');
        if (testId) return `[data-testid="${testId}"]`;
        return '';
      });

      try {
        await trigger.click();
        await page.waitForTimeout(800);

        const dialogLocator = page.locator('.el-dialog__wrapper:visible, .el-dialog:visible, .el-drawer:visible, [role="dialog"]:visible, .modal:visible').first();
        const dialogVisible = (await dialogLocator.count()) > 0;

        if (dialogVisible) {
          const title = await dialogLocator.locator('.el-dialog__title, .el-drawer__title, .modal-title, [class*="title"]').first().textContent().catch(() => '') || '';
          const dialogSelector = await dialogLocator.evaluate((el) => {
            if (el.classList.contains('el-dialog__wrapper')) return '.el-dialog__wrapper:visible';
            if (el.classList.contains('el-dialog')) return '.el-dialog:visible';
            if (el.classList.contains('el-drawer')) return '.el-drawer:visible';
            if (el.getAttribute('role') === 'dialog') return '[role="dialog"]:visible';
            return '.modal:visible';
          });

          const formFields = await collectFormFields(page, dialogSelector.replace(':visible', ''));
          const buttons = await collectInteractiveElements(page, 10);
          const dialogButtons = buttons.filter(b =>
            b.tag === 'button' || b.role === 'button'
          ).slice(0, 6);

          dialogs.push({
            triggerSelector: triggerSelector || triggerSel,
            triggerText: triggerText.slice(0, 40),
            dialogSelector,
            title: title.replace(/\s+/g, ' ').trim().slice(0, 60) || undefined,
            formFields,
            buttons: dialogButtons,
          });

          const closeBtn = page.locator('.el-dialog__headerbtn, .el-drawer__close-btn, [aria-label="Close"], [aria-label="close"]').first();
          if (await closeBtn.isVisible().catch(() => false)) {
            await closeBtn.click();
            await page.waitForTimeout(500);
          } else {
            await page.keyboard.press('Escape');
            await page.waitForTimeout(500);
          }
        }
      } catch {
        try {
          await page.keyboard.press('Escape');
          await page.waitForTimeout(300);
        } catch { /* ignore */ }
      }
    }
  }

  return dialogs;
}

async function collectTableStructures(page: Page): Promise<TableInfo[]> {
  return page.evaluate(() => {
    const tables: Array<{
      selector: string;
      columns: string[];
      rowCount: number;
      rowActionButtons: string[];
      hasPagination: boolean;
    }> = [];

    // Native HTML tables
    document.querySelectorAll('table').forEach((table, idx) => {
      const headers = Array.from(table.querySelectorAll('thead th, thead td'))
        .map(th => (th.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      const rowCount = table.querySelectorAll('tbody tr').length;
      const actionBtns = Array.from(new Set(
        Array.from(table.querySelectorAll('tbody td:last-child button, tbody td:last-child a, tbody td:last-child .el-button'))
          .map(el => (el.textContent || '').replace(/\s+/g, ' ').trim())
          .filter(Boolean)
      )).slice(0, 10);
      const sel = table.id ? `#${table.id}` : `table:nth-of-type(${idx + 1})`;
      tables.push({
        selector: sel,
        columns: headers.slice(0, 20),
        rowCount,
        rowActionButtons: actionBtns,
        hasPagination: Boolean(document.querySelector('.el-pagination, .pagination, [class*="pager"]')),
      });
    });

    // Element UI tables
    document.querySelectorAll('.el-table').forEach((table, idx) => {
      const headers = Array.from(table.querySelectorAll('.el-table__header-wrapper th .cell'))
        .map(th => (th.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      const rowCount = table.querySelectorAll('.el-table__body-wrapper .el-table__row').length;
      const lastCol = table.querySelectorAll('.el-table__body-wrapper .el-table__row td:last-child');
      const actionBtns = Array.from(new Set(
        Array.from(lastCol).flatMap(cell =>
          Array.from(cell.querySelectorAll('button, a, .el-button'))
            .map(el => (el.textContent || '').replace(/\s+/g, ' ').trim())
        ).filter(Boolean)
      )).slice(0, 10);
      const sel = table.id ? `#${table.id}` : `.el-table:nth-of-type(${idx + 1})`;
      tables.push({
        selector: sel,
        columns: headers.slice(0, 20),
        rowCount,
        rowActionButtons: actionBtns,
        hasPagination: Boolean(document.querySelector('.el-pagination, .pagination, [class*="pager"]')),
      });
    });

    return tables.slice(0, 5);
  });
}

async function collectAccessibilityTree(page: Page): Promise<AccessibilityNode[]> {
  try {
    return page.evaluate((script) => {
      return new Function('return ' + script)();
    }, accessibilityTreeScript);
  } catch {
    return [];
  }
}

function setupApiRequestMonitor(page: Page): ApiRequest[] {
  const requests: ApiRequest[] = [];

  page.on('response', (response) => {
    const url = response.url();
    const method = response.request().method();
    // Only track API-like requests, skip static assets
    if (/\.(js|css|png|jpg|jpeg|gif|svg|woff2?|ttf|ico|map)(\?|$)/i.test(url)) return;
    if (method === 'OPTIONS') return;
    const parsed = (() => { try { return new URL(url); } catch { return null; } })();
    if (!parsed) return;
    // Only track same-origin or API-like paths
    if (/^\/(api|prod-api|dev-api|gpt|dify|v1)\//i.test(parsed.pathname) || /\/(api|graphql|rest)\//i.test(parsed.pathname)) {
      requests.push({
        method,
        url: `${parsed.pathname}${parsed.search}`,
        statusCode: response.status(),
      });
    }
  });

  return requests;
}

function stripHash(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

function deduplicateApiRequests(requests: ApiRequest[]): ApiRequest[] {
  const seen = new Set<string>();
  return requests.filter(r => {
    const key = `${r.method} ${r.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatAuthMethod(method: 'none' | 'credentials' | 'manual_session'): string {
  switch (method) {
    case 'credentials':
      return '直接填写账号密码';
    case 'manual_session':
      return '复用人工登录态';
    default:
      return '未启用登录';
  }
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
      label: '页面交互元素',
      path: toRelativePath(paths.sitePageElementsFile),
      kind: 'json',
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

function stripPageElementsForYaml(page: PageMetadata): Omit<PageMetadata, 'interactiveElements' | 'formFields' | 'dialogs' | 'tables' | 'accessibilityTree' | 'apiRequests'> & { interactiveElementCount: number; formFieldCount: number; dialogCount: number; tableCount: number } {
  return {
    id: page.id,
    title: page.title,
    url: page.url,
    headings: page.headings,
    roleHints: page.roleHints,
    screenshot: page.screenshot,
    interactiveElementCount: page.interactiveElements.length,
    formFieldCount: page.formFields.length,
    dialogCount: page.dialogs.length,
    tableCount: page.tables.length,
  };
}

function buildPageElementsPayload(pages: PageMetadata[]): object {
  return {
    generatedAt: new Date().toISOString(),
    pages: pages.map((p) => ({
      id: p.id,
      url: p.url,
      title: p.title,
      interactiveElements: p.interactiveElements,
      formFields: p.formFields,
      dialogs: p.dialogs,
      tables: p.tables,
      accessibilityTree: p.accessibilityTree,
      apiRequests: p.apiRequests,
    })),
  };
}
