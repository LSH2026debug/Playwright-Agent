import { promises as fs } from 'node:fs';

import { config } from '../config.js';

type AdapterMode = 'live' | 'template' | 'mock';

export interface NormalizeRequirementsInput {
  siteUrl: string;
  sourceText: string;
  promptPath: string;
}

export interface RequirementsToPlanInput {
  siteUrl: string;
  normalizedRequirements: string;
  siteExploreSummary: string;
  promptPath: string;
}

export interface PlanToCasesInput {
  siteUrl: string;
  approvedPlan: string;
  promptPath: string;
}

export interface LlmGenerationResult {
  content: string;
  mode: AdapterMode;
  provider: string;
  model: string;
  warning?: string;
}

interface PromptedInput {
  promptPath: string;
  payload: string;
}

export class LlmAdapter {
  private resolveMode(): AdapterMode {
    if (config.ai.mode === 'mock') {
      return 'mock';
    }

    if (config.ai.mode === 'template') {
      return 'template';
    }

    if (config.ai.mode === 'live' && config.ai.apiKey) {
      return 'live';
    }

    if (config.ai.mode === 'auto' && config.ai.apiKey) {
      return 'live';
    }

    return 'template';
  }

  async normalizeRequirements(input: NormalizeRequirementsInput): Promise<LlmGenerationResult> {
    const mode = this.resolveMode();

    if (mode === 'mock') {
      return {
        content: buildMockRequirementsModule(input.siteUrl),
        mode,
        provider: config.ai.provider,
        model: config.ai.model,
      };
    }

    if (mode === 'template') {
      return {
        content: buildTemplateRequirementsModule(input.siteUrl, input.sourceText),
        mode,
        provider: config.ai.provider,
        model: config.ai.model,
        warning: config.ai.apiKey ? undefined : '未配置 AI_API_KEY，已自动回退到模板生成。',
      };
    }

    try {
      const prompt = await this.composePrompt({
        promptPath: input.promptPath,
        payload: [
          `Site URL: ${input.siteUrl}`,
          '',
          'Source requirements:',
          input.sourceText,
        ].join('\n'),
      });

      const content = await this.requestLiveCompletion(prompt);
      return {
        content,
        mode,
        provider: config.ai.provider,
        model: config.ai.model,
      };
    } catch (error) {
      return {
        content: buildTemplateRequirementsModule(input.siteUrl, input.sourceText),
        mode: 'template',
        provider: config.ai.provider,
        model: config.ai.model,
        warning: error instanceof Error
          ? `实时 LLM 请求失败，已回退到模板生成：${error.message}`
          : '实时 LLM 请求失败，已回退到模板生成。',
      };
    }
  }

  async requirementsToPlan(input: RequirementsToPlanInput): Promise<LlmGenerationResult> {
    const mode = this.resolveMode();

    if (mode === 'mock') {
      return {
        content: buildMockPlan(input.siteUrl),
        mode,
        provider: config.ai.provider,
        model: config.ai.model,
      };
    }

    if (mode === 'template') {
      return {
        content: buildTemplatePlan(input.siteUrl, input.normalizedRequirements, input.siteExploreSummary),
        mode,
        provider: config.ai.provider,
        model: config.ai.model,
        warning: config.ai.apiKey ? undefined : '未配置 AI_API_KEY，已自动回退到模板生成。',
      };
    }

    try {
      const prompt = await this.composePrompt({
        promptPath: input.promptPath,
        payload: [
          `Site URL: ${input.siteUrl}`,
          '',
          'Approved normalized requirements:',
          input.normalizedRequirements,
          '',
          'Approved site exploration summary:',
          input.siteExploreSummary,
        ].join('\n'),
      });

      const content = await this.requestLiveCompletion(prompt);
      return {
        content,
        mode,
        provider: config.ai.provider,
        model: config.ai.model,
      };
    } catch (error) {
      return {
        content: buildTemplatePlan(input.siteUrl, input.normalizedRequirements, input.siteExploreSummary),
        mode: 'template',
        provider: config.ai.provider,
        model: config.ai.model,
        warning: error instanceof Error
          ? `实时 LLM 请求失败，已回退到模板生成：${error.message}`
          : '实时 LLM 请求失败，已回退到模板生成。',
      };
    }
  }

  async planToCases(input: PlanToCasesInput): Promise<LlmGenerationResult> {
    const mode = this.resolveMode();

    if (mode === 'mock') {
      return {
        content: buildMockCasesGuidance(input.siteUrl),
        mode,
        provider: config.ai.provider,
        model: config.ai.model,
      };
    }

    if (mode === 'template') {
      return {
        content: buildTemplateCasesGuidance(input.approvedPlan),
        mode,
        provider: config.ai.provider,
        model: config.ai.model,
        warning: config.ai.apiKey ? undefined : '未配置 AI_API_KEY，已自动回退到模板生成。',
      };
    }

    try {
      const prompt = await this.composePrompt({
        promptPath: input.promptPath,
        payload: [
          `Site URL: ${input.siteUrl}`,
          '',
          'Approved plan:',
          input.approvedPlan,
        ].join('\n'),
      });

      const content = await this.requestLiveCompletion(prompt);
      return {
        content,
        mode,
        provider: config.ai.provider,
        model: config.ai.model,
      };
    } catch (error) {
      return {
        content: buildTemplateCasesGuidance(input.approvedPlan),
        mode: 'template',
        provider: config.ai.provider,
        model: config.ai.model,
        warning: error instanceof Error
          ? `实时 LLM 请求失败，已回退到模板生成：${error.message}`
          : '实时 LLM 请求失败，已回退到模板生成。',
      };
    }
  }

  async caseToScript(): Promise<LlmGenerationResult> {
    return {
      content: '第二阶段占位内容：把已批准的测试用例转换为 Playwright 脚本。',
      mode: 'template',
      provider: config.ai.provider,
      model: config.ai.model,
    };
  }

  private async composePrompt(input: PromptedInput): Promise<string> {
    const promptTemplate = await fs.readFile(input.promptPath, 'utf8');
    return `${promptTemplate.trim()}\n\n${input.payload.trim()}\n`;
  }

  private async requestLiveCompletion(prompt: string): Promise<string> {
    const response = await fetch(`${config.ai.baseURL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.ai.apiKey}`,
      },
      body: JSON.stringify({
        model: config.ai.model,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content: '你是一名资深 QA 自动化架构师。请只返回中文 Markdown。',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorPayload = await response.json().catch(() => null) as {
        error?: {
          message?: string;
          type?: string;
        };
      } | null;
      const upstreamMessage = errorPayload?.error?.message?.trim();
      const upstreamType = errorPayload?.error?.type?.trim();

      if (upstreamType === 'engine_overloaded_error') {
        throw new Error('上游 LLM 服务当前繁忙，请稍后重试。');
      }

      if (upstreamMessage && upstreamType) {
        throw new Error(`上游 LLM 请求失败：${upstreamMessage}（${upstreamType}，状态码 ${response.status}）。`);
      }

      if (upstreamMessage) {
        throw new Error(`上游 LLM 请求失败：${upstreamMessage}（状态码 ${response.status}）。`);
      }

      throw new Error(`上游 LLM 请求失败，状态码为 ${response.status}。`);
    }

    const data = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string;
        };
      }>;
    };

    const content = data.choices?.[0]?.message?.content?.trim();

    if (!content) {
      throw new Error('上游 LLM 返回了空内容。');
    }

    return content;
  }
}

function buildMockRequirementsModule(siteUrl: string): string {
  return [
    '# 规范化需求',
    '',
    '## 规范化范围',
    '- 这是 AI 辅助 Playwright POC 的演示模式产物。',
    `- 目标站点：${siteUrl}`,
    '- 默认模块：auth、catalog、cart、checkout。',
    '',
    '## 目标站点摘要',
    '- SauceDemo 是一个电商测试沙箱，登录、商品列表、购物车和结账流程相对稳定。',
    '',
    '## 范围内模块',
    '- auth：有效登录、无效登录提示、会话边界。',
    '- catalog：商品列表展示、商品详情一致性、排序意图。',
    '- cart：加入购物车、移出购物车、数量标识。',
    '- checkout：信息表单、订单概览、完成页。',
    '',
    '## 高价值用户流程',
    '- standard_user 成功登录并进入商品列表页。',
    '- 用户加入一个或多个商品，并验证购物车状态。',
    '- 用户完成结账并到达确认页。',
    '',
    '## 测试数据与环境说明',
    '- 主测试账号：standard_user / secret_sauce。',
    '- 本 POC 仅覆盖 Chromium。',
    '',
    '## 风险与假设',
    '- 默认假设排序规则遵循 SauceDemo 标准商品列表行为。',
    '- 第一阶段不包含网络桩和接口模拟。',
    '',
    '## 审批检查清单',
    '- 确认模块名称与预期业务范围一致。',
    '- 确认列出的流程属于当前优先级最高的回归范围。',
  ].join('\n');
}

function buildTemplateRequirementsModule(siteUrl: string, sourceText: string): string {
  const summaryLines = sourceText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 6);

  const modules = inferModules(sourceText, siteUrl);
  const flowLines = modules.map((moduleName) => `- ${moduleName}：${describeFlow(moduleName)}`);
  const acceptanceChecklist = modules.map((moduleName) => `- ${moduleName}：已完成审阅，可进入后续测试计划设计。`);

  return [
    '# 规范化需求',
    '',
    '## 规范化范围',
    `- 目标站点：${siteUrl}`,
    '- 工作流目标：把原始产品需求整理为可供人工审阅的测试模块。',
    '- 交付约束：该产物未获批准前，后续步骤全部阻塞。',
    '',
    '## 目标站点摘要',
    ...summaryLines.map((line) => `- ${line}`),
    '',
    '## 范围内模块',
    ...modules.map((moduleName) => `- ${moduleName}`),
    '',
    '## 高价值用户流程',
    ...flowLines,
    '',
    '## 测试数据与环境说明',
    '- 本 POC 仅覆盖 Chromium。',
    '- 本 POC 仅使用本地文件存储数据。',
    '- 所有输出在批准前都必须保持可读、可编辑。',
    '',
    '## 风险与假设',
    `- 当前模块推断采用模板策略${config.ai.apiKey ? '，仅在实时生成不可用时启用。' : '，原因是未配置 API Key。'}`,
    '- 细粒度页面元数据和截图会延后到站点探索步骤处理。',
    '- 本项目明确不包含 self-healing 和通用爬取能力。',
    '',
    '## 审批检查清单',
    ...acceptanceChecklist,
  ].join('\n');
}

function buildMockPlan(siteUrl: string): string {
  return [
    '# 模块级测试计划',
    '',
    `- 目标站点：${siteUrl}`,
    '- 这是 Mock 模式生成的模块级测试计划。',
    '',
    '## 计划模块',
    '- 登录与会话',
    '- 首页与导航',
    '- 核心业务入口',
    '- 关键内容页',
    '',
    '## 测试重点',
    '- 登录成功与失败反馈。',
    '- 首页可达性、入口可见性与导航跳转。',
    '- 关键业务模块的主流程与异常分支。',
    '- 关键页面的内容加载、交互反馈与权限边界。',
  ].join('\n');
}

function buildTemplatePlan(siteUrl: string, normalizedRequirements: string, siteExploreSummary: string): string {
  const modules = inferPlanModules(normalizedRequirements, siteExploreSummary, siteUrl);
  const exploreHighlights = summarizeExploreSummary(siteExploreSummary);

  return [
    '# 模块级测试计划',
    '',
    `- 目标站点：${siteUrl}`,
    `- 当前结果由模板生成，用于第二阶段人工审阅。`,
    `- 模型配置来源：${config.ai.provider} / ${config.ai.model}`,
    '',
    '## 计划来源',
    '- 输入一：已批准的规范化需求。',
    '- 输入二：已批准的站点探索摘要。',
    '- 生成策略：当实时 LLM 不可用或请求失败时，使用模板逻辑根据上述两份输入推断模块和测试重点。',
    '',
    '## 模块范围',
    ...modules.map((moduleName) => `- ${moduleName}`),
    '',
    '## 每模块测试目标',
    ...modules.flatMap((moduleName) => [
      `### 模块：${moduleName}`,
      `- 覆盖 ${moduleName} 的主流程。`,
      `- 覆盖 ${moduleName} 的关键负向场景或异常分支。`,
      `- 覆盖 ${moduleName} 的页面可达性、关键交互与状态反馈。`,
      '',
    ]),
    '## 关键前置条件',
    '- 已有可用测试环境与基础访问权限。',
    '- 站点探索摘要中的关键页面仍然可访问。',
    '- 若目标站点要求登录，需准备可复用登录态或有效账号。',
    '',
    '## 探索摘要参考',
    ...exploreHighlights,
    '',
    '## 风险与限制',
    '- 当前模板计划依赖已批准文档中的模块名称与页面信息，若上游文档过于粗糙，计划粒度也会受限。',
    '- 模板模式不会像实时 LLM 那样做更深的语义归纳，因此更适合作为人工审阅初稿。',
    '- 若站点是强业务定制系统，后续仍建议结合人工补充模块边界与优先级。',
    '',
    '## 审阅检查清单',
    '- 确认模块边界与规范化需求一致。',
    '- 确认模块命名与站点真实菜单、页面或业务域一致。',
    '- 确认计划可以继续拆分为结构化测试用例。',
  ].join('\n');
}

function inferPlanModules(normalizedRequirements: string, siteExploreSummary: string, siteUrl: string): string[] {
  const requirementModules = extractBulletModules(normalizedRequirements);
  const exploredModules = extractExploreModules(siteExploreSummary);
  const merged = [...requirementModules, ...exploredModules]
    .map((item) => normalizeModuleName(item))
    .filter(Boolean);

  const uniqueModules = merged.filter((item, index, array) => array.indexOf(item) === index);
  if (uniqueModules.length > 0) {
    return uniqueModules.slice(0, 8);
  }

  return inferModules(normalizedRequirements, siteUrl).map(normalizeModuleName).filter(Boolean);
}

function extractBulletModules(markdown: string): string[] {
  const lines = markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line));

  return lines
    .map((line) => line.replace(/^[-*]\s+/, '').trim())
    .map((line) => line.split(/[：:]/)[0].trim())
    .filter((line) => line.length >= 2)
    .filter((line) => !/^目标站点|工作流目标|交付约束|本 POC|所有输出|当前模块推断|细粒度页面元数据|风险与假设|审批检查清单$/i.test(line));
}

function extractExploreModules(siteExploreSummary: string): string[] {
  const pageHeaders = [...siteExploreSummary.matchAll(/^###\s+(.+)$/gm)]
    .map((match) => match[1].trim())
    .filter((value) => value && value.toLowerCase() !== '页面概览' && value.toLowerCase() !== '推荐业务流程');

  const headingLines = [...siteExploreSummary.matchAll(/^- 标题层级：(.+)$/gm)]
    .flatMap((match) => match[1].split('；'))
    .map((value) => value.replace(/\/+$/g, '').trim())
    .filter((value) => value.length >= 2);

  return [...pageHeaders, ...headingLines]
    .filter((value) => !/^https?:/i.test(value))
    .filter((value) => !/^home$/i.test(value))
    .filter((value) => !/^首页$/i.test(value));
}

function normalizeModuleName(value: string): string {
  return value
    .replace(/^模块[:：]?\s*/i, '')
    .replace(/^页面[:：]?\s*/i, '')
    .replace(/^检查页面\s*/i, '')
    .replace(/^当前位于/, '')
    .replace(/\s+/g, ' ')
    .replace(/\/+$/g, '')
    .trim();
}

function summarizeExploreSummary(siteExploreSummary: string): string[] {
  const lines = siteExploreSummary
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('#'));

  const overviewLines = lines.filter((line) => line.startsWith('- ')).slice(0, 6);
  const flowLines = lines.filter((line) => /^\d+\.\s/.test(line)).slice(0, 4);

  return [...overviewLines, ...flowLines];
}

function buildMockCasesGuidance(siteUrl: string): string {
  return `基于 ${siteUrl} 的测试计划，优先产出 8 到 12 条覆盖 auth、catalog、cart、checkout 的结构化测试用例。`;
}

function buildTemplateCasesGuidance(approvedPlan: string): string {
  const moduleMatches = [...approvedPlan.matchAll(/^###\s+模块：(.+)$/gm)].map((match) => match[1].trim());
  const modules = moduleMatches.length > 0 ? moduleMatches.join('、') : 'auth、catalog、cart、checkout';
  return `请围绕 ${modules} 生成结构化测试用例，优先覆盖主流程与关键负向路径。`;
}

function inferModules(sourceText: string, siteUrl: string): string[] {
  const lower = `${siteUrl}\n${sourceText}`.toLowerCase();
  const detected = new Set<string>();

  if (lower.includes('saucedemo') || lower.includes('login') || lower.includes('auth')) {
    detected.add('auth');
  }

  if (lower.includes('catalog') || lower.includes('inventory') || lower.includes('product')) {
    detected.add('catalog');
  }

  if (lower.includes('cart') || lower.includes('basket')) {
    detected.add('cart');
  }

  if (lower.includes('checkout') || lower.includes('order')) {
    detected.add('checkout');
  }

  if (detected.size === 0) {
    detected.add(siteUrl.includes('saucedemo') ? 'auth' : '核心流程');
  }

  return [...detected];
}

function describeFlow(moduleName: string): string {
  switch (moduleName) {
    case 'auth':
      return '验证成功登录、失败登录提示以及登录后的落地页是否符合预期';
    case 'catalog':
      return '验证商品列表可见性、主要商品交互和关键导航链路';
    case 'cart':
      return '验证加入购物车、移除商品以及购物车状态保持';
    case 'checkout':
      return '验证结账信息填写、订单概览确认以及完成页结果';
    default:
      return '验证模块主路径以及一个关键负向路径';
  }
}

export const llmAdapter = new LlmAdapter();
