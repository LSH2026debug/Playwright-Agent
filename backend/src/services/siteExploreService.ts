import path from 'node:path';

import { chromium, type Locator, type Page } from 'playwright';
import yaml from 'js-yaml';

import { config } from '../config.js';
import { paths, toRelativePath } from '../utils/paths.js';
import { ApiError } from '../utils/apiError.js';
import { ensureDir, fileExists, writeJson, writeText } from './storage.js';
import { getWorkflowPayload, markStepReviewed } from './workflowService.js';
import { loadWorkflowAndTransition } from './workflowTransitions.js';
import { getLoginSessionStatus } from './loginSessionService.js';
import type { ArtifactRef, ProjectAuthConfig, WorkflowState } from '../types/workflow.js';

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

  const runtime = await createExploreRuntime(loginConfig.useStoredSession);

  try {
    const page = runtime.page;
    const pages: PageMetadata[] = [];
    const screenshotPaths: string[] = [];
    const visitedUrls = new Set<string>();

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
    const summary = buildExploreSummary(siteUrl, pages, flows, {
      maxPages,
      authMethod,
      loginUsed: loginConfig.enabled,
      authenticated,
      loginUrl: loginConfig.enabled ? loginConfig.loginUrl : null,
    });

    await writeText(paths.sitePagesFile, yaml.dump({ pages }, { lineWidth: 120 }));
    await writeText(paths.siteFlowsFile, yaml.dump({ flows }, { lineWidth: 120 }));
    await writeText(paths.siteExploreSummaryFile, summary);
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
  const headings = await collectVisibleTexts(page, 'h1, h2, h3, .el-breadcrumb__item, .tags-view-item.active, .app-main .el-card__header, .page-title', 8);
  const buttons = await collectVisibleTexts(page, 'button, .el-button, [role="button"]', 10);
  const links = await collectVisibleTexts(page, 'a, .el-menu-item, .el-submenu__title, .submenu-title-noDropdown', 12);

  pages.push({
    id: pageId,
    title,
    url: currentUrl,
    headings: normalizeTextList(headings).slice(0, 8),
    roleHints: normalizeTextList([...buttons, ...links]).slice(0, 10),
    screenshot: screenshotPath,
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

function stripHash(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return url;
  }
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
