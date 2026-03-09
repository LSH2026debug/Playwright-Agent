import path from 'node:path';

const rootDir = path.resolve(process.cwd(), '..');

export const paths = {
  rootDir,
  artifactsDir: path.join(rootDir, 'artifacts'),
  logsDir: path.join(rootDir, 'artifacts', 'logs'),
  projectMetaFile: path.join(rootDir, 'artifacts', 'project.json'),
  workflowStateFile: path.join(rootDir, 'artifacts', 'workflow-state.json'),
  approvalLogFile: path.join(rootDir, 'artifacts', 'approval-log.json'),
  requirementsInputFile: path.join(rootDir, 'inputs', 'requirements-input.md'),
  normalizedRequirementsFile: path.join(rootDir, 'requirements', 'normalized-requirements.md'),
  normalizedRequirementsMetaFile: path.join(rootDir, 'requirements', 'normalized-requirements.meta.json'),
  requirementsPromptFile: path.join(rootDir, 'prompts', 'requirements-to-plan.prompt.md'),
  planPromptFile: path.join(rootDir, 'prompts', 'plan-to-cases.prompt.md'),
  scriptPromptFile: path.join(rootDir, 'prompts', 'case-to-script.prompt.md'),
  sitePagesFile: path.join(rootDir, 'metadata', 'site', 'pages.yaml'),
  siteFlowsFile: path.join(rootDir, 'metadata', 'site', 'flows.yaml'),
};

export function toRelativePath(absolutePath: string): string {
  return path.relative(rootDir, absolutePath).replace(/\\/g, '/');
}
