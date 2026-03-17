import { promises as fs } from 'node:fs';

import { chromium, type BrowserContext, type Page } from 'playwright';

import { ApiError } from '../utils/apiError.js';
import { paths, toRelativePath } from '../utils/paths.js';
import type { LoginSessionMeta } from '../types/workflow.js';
import { ensureDir, fileExists, readJson, writeJson } from './storage.js';
import { getWorkflowPayload } from './workflowService.js';

interface InteractiveLoginSession {
  context: BrowserContext;
  loginUrl: string;
  openedAt: string;
}

let interactiveSession: InteractiveLoginSession | null = null;

export async function startInteractiveLoginSession(input: {
  loginUrl?: string;
  actor?: string;
}): Promise<LoginSessionMeta> {
  const workflow = await getWorkflowPayload();
  const project = workflow.workflow.project;

  if (!project) {
    throw new ApiError(409, 'project_not_initialized', '请先完成项目初始化，再打开登录浏览器。');
  }

  const loginUrl = input.loginUrl?.trim() || project.auth.loginUrl || project.siteUrl;

  if (interactiveSession) {
    const page = await getInteractivePage(interactiveSession.context);
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
    await page.bringToFront();

    return writeLoginSessionMeta({
      ...(await getLoginSessionStatus()),
      browserOpen: true,
      loginUrl,
      currentUrl: page.url(),
      openedAt: interactiveSession.openedAt,
      updatedAt: new Date().toISOString(),
      note: '登录浏览器已打开，请在该窗口中手动完成登录。',
    });
  }

  await ensureDir(paths.authArtifactsDir, false);
  const context = await chromium.launchPersistentContext(paths.authBrowserProfileDir, {
    headless: false,
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 960 },
  });

  context.on('close', () => {
    if (interactiveSession?.context !== context) {
      return;
    }

    interactiveSession = null;
    void handleInteractiveBrowserClosed();
  });

  const stored = await readStoredLoginSessionMeta();
  const storageStateExists = await fileExists(paths.authStorageStateFile);

  const openedAt = new Date().toISOString();
  interactiveSession = {
    context,
    loginUrl,
    openedAt,
  };

  const page = await getInteractivePage(context);
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });

  return writeLoginSessionMeta({
    ...stored,
    mode: 'manual',
    browserOpen: true,
    profileReady: storageStateExists,
    loginUrl,
    currentUrl: page.url(),
    profilePath: toRelativePath(paths.authBrowserProfileDir),
    storageStatePath: storageStateExists ? toRelativePath(paths.authStorageStateFile) : null,
    openedAt,
    savedAt: stored.savedAt,
    updatedAt: openedAt,
    authenticatedLikely: storageStateExists ? stored.authenticatedLikely : false,
    note: '登录浏览器已打开，请在该窗口中手动完成登录，再回到第 4 步保存登录态。',
  });
}

async function handleInteractiveBrowserClosed(): Promise<void> {
  const stored = await readStoredLoginSessionMeta();
  const storageStateExists = await fileExists(paths.authStorageStateFile);

  await writeLoginSessionMeta({
    ...stored,
    browserOpen: false,
    profileReady: storageStateExists,
    storageStatePath: storageStateExists ? toRelativePath(paths.authStorageStateFile) : null,
    updatedAt: new Date().toISOString(),
    note: storageStateExists
      ? '登录浏览器已关闭，已保存的登录态仍可复用。'
      : '登录浏览器已关闭，如需复用登录态请重新打开并保存。',
  });
}

export async function saveInteractiveLoginSession(input?: {
  closeBrowserAfterSave?: boolean;
}): Promise<LoginSessionMeta> {
  if (!interactiveSession) {
    throw new ApiError(409, 'login_browser_not_open', '登录浏览器尚未打开，请先点击“打开登录浏览器”。');
  }

  const page = await getInteractivePage(interactiveSession.context);
  const currentUrl = page.url();
  const authenticatedLikely = await detectAuthenticatedLikely(page, interactiveSession.loginUrl);
  const savedAt = new Date().toISOString();

  await ensureDir(paths.authArtifactsDir, false);
  await interactiveSession.context.storageState({ path: paths.authStorageStateFile });

  const nextMeta = await writeLoginSessionMeta({
    ...(await readStoredLoginSessionMeta()),
    mode: 'manual',
    browserOpen: true,
    profileReady: true,
    loginUrl: interactiveSession.loginUrl,
    currentUrl,
    profilePath: toRelativePath(paths.authBrowserProfileDir),
    storageStatePath: toRelativePath(paths.authStorageStateFile),
    openedAt: interactiveSession.openedAt,
    savedAt,
    updatedAt: savedAt,
    authenticatedLikely,
    note: authenticatedLikely
      ? '已保存登录态，执行站点探索时可优先复用该登录态。'
      : '已保存当前浏览器状态，但未明显检测到登录成功；如探索仍回到登录页，请重新登录后再保存。',
  });

  if (input?.closeBrowserAfterSave !== false) {
    const context = interactiveSession.context;
    interactiveSession = null;
    await context.close();

    return writeLoginSessionMeta({
      ...nextMeta,
      browserOpen: false,
      updatedAt: new Date().toISOString(),
      note: `${nextMeta.note} 登录浏览器已关闭。`,
    });
  }

  return nextMeta;
}

export async function getLoginSessionStatus(): Promise<LoginSessionMeta> {
  const stored = await readStoredLoginSessionMeta();
  const storageStateExists = await fileExists(paths.authStorageStateFile);

  if (!interactiveSession) {
    return writeLoginSessionMeta({
      ...stored,
      browserOpen: false,
      profilePath: stored.profilePath ?? ((await fileExists(paths.authBrowserProfileDir)) ? toRelativePath(paths.authBrowserProfileDir) : null),
      storageStatePath: storageStateExists ? toRelativePath(paths.authStorageStateFile) : null,
      profileReady: storageStateExists,
      updatedAt: stored.updatedAt ?? new Date().toISOString(),
    });
  }

  const page = await getInteractivePage(interactiveSession.context);
  const currentUrl = page.url();
  const authenticatedLikely = await detectAuthenticatedLikely(page, interactiveSession.loginUrl);

  return writeLoginSessionMeta({
    ...stored,
    mode: 'manual',
    browserOpen: true,
    profilePath: toRelativePath(paths.authBrowserProfileDir),
    storageStatePath: storageStateExists ? toRelativePath(paths.authStorageStateFile) : null,
    loginUrl: interactiveSession.loginUrl,
    currentUrl,
    openedAt: interactiveSession.openedAt,
    authenticatedLikely,
    updatedAt: new Date().toISOString(),
  });
}

export async function clearLoginSession(): Promise<LoginSessionMeta> {
  if (interactiveSession) {
    const context = interactiveSession.context;
    interactiveSession = null;
    await context.close().catch(() => undefined);
  }

  await fs.rm(paths.authBrowserProfileDir, { recursive: true, force: true }).catch(() => undefined);
  await fs.rm(paths.authStorageStateFile, { force: true }).catch(() => undefined);

  return writeLoginSessionMetaFromDefaults({
    note: '已清除保存的登录态。',
  });
}

function createDefaultLoginSessionMeta(): LoginSessionMeta {
  return {
    mode: 'manual',
    browserOpen: false,
    profileReady: false,
    loginUrl: null,
    currentUrl: null,
    profilePath: null,
    storageStatePath: null,
    openedAt: null,
    savedAt: null,
    updatedAt: null,
    authenticatedLikely: false,
  };
}

async function readStoredLoginSessionMeta(): Promise<LoginSessionMeta> {
  return readJson(paths.loginSessionMetaFile, createDefaultLoginSessionMeta());
}

async function writeLoginSessionMeta(meta: LoginSessionMeta): Promise<LoginSessionMeta> {
  await writeJson(paths.loginSessionMetaFile, meta);
  return meta;
}

async function writeLoginSessionMetaFromDefaults(
  overrides: Partial<LoginSessionMeta>,
): Promise<LoginSessionMeta> {
  return writeLoginSessionMeta({
    ...createDefaultLoginSessionMeta(),
    ...overrides,
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
  });
}

async function getInteractivePage(context: BrowserContext): Promise<Page> {
  const currentPages = context.pages().filter((page) => !page.isClosed());
  if (currentPages.length > 0) {
    return currentPages[0];
  }

  return context.newPage();
}

async function detectAuthenticatedLikely(page: Page, loginUrl: string): Promise<boolean> {
  const passwordVisible = await isPasswordFieldVisible(page);
  return stripHash(page.url()) !== stripHash(loginUrl) || !passwordVisible;
}

async function isPasswordFieldVisible(page: Page): Promise<boolean> {
  const passwordField = page.locator('input[type="password"]').first();
  return (await passwordField.count()) > 0 && (await passwordField.isVisible().catch(() => false));
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