import path from 'node:path';

const rootDir = path.resolve(process.cwd(), '..');

export const paths = {
  rootDir,
  artifactsDir: path.join(rootDir, 'artifacts'),
  authArtifactsDir: path.join(rootDir, 'artifacts', 'auth'),
  authBrowserProfileDir: path.join(rootDir, 'artifacts', 'auth', 'browser-profile'),
  authStorageStateFile: path.join(rootDir, 'artifacts', 'auth', 'storage-state.json'),
  loginSessionMetaFile: path.join(rootDir, 'artifacts', 'auth', 'login-session.json'),
  logsDir: path.join(rootDir, 'artifacts', 'logs'),
  projectMetaFile: path.join(rootDir, 'artifacts', 'project.json'),
  workflowStateFile: path.join(rootDir, 'artifacts', 'workflow-state.json'),
  approvalLogFile: path.join(rootDir, 'artifacts', 'approval-log.json'),
  requirementsInputFile: path.join(rootDir, 'inputs', 'requirements-input.md'),
  normalizePromptFile: path.join(rootDir, 'prompts', 'normalize-requirements.prompt.md'),
  normalizedRequirementsFile: path.join(rootDir, 'requirements', 'normalized-requirements.md'),
  normalizedRequirementsMetaFile: path.join(rootDir, 'requirements', 'normalized-requirements.meta.json'),
  requirementsPromptFile: path.join(rootDir, 'prompts', 'requirements-to-plan.prompt.md'),
  planPromptFile: path.join(rootDir, 'prompts', 'plan-to-cases.prompt.md'),
  scriptPromptFile: path.join(rootDir, 'prompts', 'case-to-script.prompt.md'),
  sitePagesFile: path.join(rootDir, 'metadata', 'site', 'pages.yaml'),
  siteFlowsFile: path.join(rootDir, 'metadata', 'site', 'flows.yaml'),
  siteExploreSummaryFile: path.join(rootDir, 'metadata', 'site', 'explore-summary.md'),
  siteExploreMetaFile: path.join(rootDir, 'metadata', 'site', 'explore-meta.json'),
  plansFile: path.join(rootDir, 'plans', 'module-test-plan.md'),
  plansMetaFile: path.join(rootDir, 'plans', 'module-test-plan.meta.json'),
  casesFile: path.join(rootDir, 'cases', 'structured-test-cases.json'),
  casesMarkdownFile: path.join(rootDir, 'cases', 'structured-test-cases.md'),
  casesMetaFile: path.join(rootDir, 'cases', 'structured-test-cases.meta.json'),
};

export function toRelativePath(absolutePath: string): string {
  return path.relative(rootDir, absolutePath).replace(/\\/g, '/');
}
