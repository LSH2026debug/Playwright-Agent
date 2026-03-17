import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

// 获取当前文件所在目录
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 从项目根目录加载 .env 文件
const envPath = path.resolve(__dirname, '..', '..', '.env');
dotenv.config({ path: envPath });

// 如果上面的路径不对，也尝试从当前工作目录加载
dotenv.config();

type LlmMode = 'auto' | 'mock' | 'template' | 'live';

const rawMode = (process.env.AI_MODE ?? 'auto').trim().toLowerCase();

const aiMode: LlmMode = rawMode === 'mock' || rawMode === 'template' || rawMode === 'live'
  ? rawMode
  : 'auto';

export const config = {
  port: Number(process.env.PORT ?? 3001),
  defaultOperator: process.env.DEFAULT_OPERATOR ?? 'local-user',
  siteExplore: {
    maxPages: Number(process.env.SITE_EXPLORE_MAX_PAGES ?? 12),
    sauceDemoUsername: process.env.SITE_EXPLORE_SAUCEDEMO_USERNAME ?? 'standard_user',
    sauceDemoPassword: process.env.SITE_EXPLORE_SAUCEDEMO_PASSWORD ?? 'secret_sauce',
  },
  ai: {
    mode: aiMode,
    provider: process.env.AI_PROVIDER ?? 'moonshot',
    baseURL: process.env.AI_BASE_URL ?? 'https://api.moonshot.cn/v1',
    model: process.env.AI_MODEL ?? 'moonshot-v1-8k',
    apiKey: process.env.AI_API_KEY ?? '',
  },
};

export type Config = typeof config;
