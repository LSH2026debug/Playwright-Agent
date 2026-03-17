import net from 'node:net';

import { createApp } from './app.js';
import { config } from './config.js';
import { ensureWorkflowScaffold } from './services/workflowService.js';

async function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        resolve(true);
      } else {
        resolve(false);
      }
    });
    server.once('listening', () => {
      server.close();
      resolve(false);
    });
    server.listen(port);
  });
}

async function findAvailablePort(startPort: number, maxAttempts = 10): Promise<number> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = startPort + i;
    if (!(await isPortInUse(port))) {
      return port;
    }
    console.log(`Port ${port} is in use, trying next...`);
  }
  throw new Error(`Could not find an available port after ${maxAttempts} attempts`);
}

async function main() {
  await ensureWorkflowScaffold();

  const app = createApp();
  
  // 尝试使用配置的端口，如果被占用则自动寻找可用端口
  let port = config.port;
  if (await isPortInUse(port)) {
    console.log(`Port ${port} is already in use.`);
    port = await findAvailablePort(port);
    console.log(`Using available port: ${port}`);
  }
  
  app.listen(port, () => {
    console.log(`AI Playwright POC backend listening on http://localhost:${port}`);
    if (port !== config.port) {
      console.log(`WARNING: Using port ${port} instead of configured port ${config.port}`);
    }
  });
}

void main();