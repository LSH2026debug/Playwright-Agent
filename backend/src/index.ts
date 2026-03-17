import { createApp } from './app.js';
import { config } from './config.js';
import { ensureWorkflowScaffold } from './services/workflowService.js';

async function main() {
  await ensureWorkflowScaffold();

  const app = createApp();
  app.listen(config.port, () => {
    console.log(`AI Playwright POC backend listening on http://localhost:${config.port}`);
  });
}

void main();