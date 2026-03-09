import { promises as fs } from 'node:fs';

import { config } from '../config.js';

type AdapterMode = 'live' | 'template' | 'mock';

export interface RequirementsToPlanInput {
  siteUrl: string;
  sourceText: string;
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

  async requirementsToPlan(input: RequirementsToPlanInput): Promise<LlmGenerationResult> {
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
        warning: config.ai.apiKey ? undefined : 'AI_API_KEY not set. Template fallback was used.',
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
              content: 'You are a senior QA automation architect. Return Markdown only.',
            },
            {
              role: 'user',
              content: prompt,
            },
          ],
        }),
      });

      if (!response.ok) {
        throw new Error(`Upstream LLM request failed with status ${response.status}.`);
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
        throw new Error('Upstream LLM returned an empty response.');
      }

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
          ? `Live LLM request failed and template fallback was used: ${error.message}`
          : 'Live LLM request failed and template fallback was used.',
      };
    }
  }

  async planToCases(): Promise<LlmGenerationResult> {
    return {
      content: 'Phase 2 placeholder for converting an approved plan into structured cases.',
      mode: 'template',
      provider: config.ai.provider,
      model: config.ai.model,
    };
  }

  async caseToScript(): Promise<LlmGenerationResult> {
    return {
      content: 'Phase 2 placeholder for converting an approved case into a Playwright spec.',
      mode: 'template',
      provider: config.ai.provider,
      model: config.ai.model,
    };
  }

  private async composePrompt(input: PromptedInput): Promise<string> {
    const promptTemplate = await fs.readFile(input.promptPath, 'utf8');
    return `${promptTemplate.trim()}\n\n${input.payload.trim()}\n`;
  }
}

function buildMockRequirementsModule(siteUrl: string): string {
  return [
    '# Normalized Requirements',
    '',
    '## Normalized Scope',
    '- Demo mode output for the AI-assisted Playwright POC.',
    `- Target site: ${siteUrl}`,
    '- Default modules: auth, catalog, cart, checkout.',
    '',
    '## Target Site Summary',
    '- SauceDemo is an e-commerce testing sandbox with stable login, inventory, cart, and checkout flows.',
    '',
    '## Modules In Scope',
    '- auth: valid login, invalid login, session boundary.',
    '- catalog: inventory listing, product detail consistency, sorting intent.',
    '- cart: add to cart, remove from cart, quantity indicator.',
    '- checkout: information form, order overview, completion screen.',
    '',
    '## High Value User Flows',
    '- Standard user logs in and lands on the inventory page.',
    '- User adds one or more products and verifies cart state.',
    '- User finishes checkout and reaches the confirmation page.',
    '',
    '## Test Data And Environment Notes',
    '- Primary account: standard_user / secret_sauce.',
    '- Browser scope for this POC: Chromium only.',
    '',
    '## Risks And Assumptions',
    '- Sorting rules are assumed to follow the standard SauceDemo catalog behavior.',
    '- Network stubbing is out of scope for Phase 1.',
    '',
    '## Approval Checklist',
    '- Confirm module names match the expected business scope.',
    '- Confirm the listed flows are the intended high-priority regressions.',
  ].join('\n');
}

function buildTemplateRequirementsModule(siteUrl: string, sourceText: string): string {
  const summaryLines = sourceText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 6);

  const modules = inferModules(sourceText, siteUrl);
  const flowLines = modules.map((moduleName) => `- ${moduleName}: ${describeFlow(moduleName)}`);
  const acceptanceChecklist = modules.map((moduleName) => `- ${moduleName}: reviewed and approved for downstream test planning.`);

  return [
    '# Normalized Requirements',
    '',
    '## Normalized Scope',
    `- Target site: ${siteUrl}`,
    '- Workflow objective: convert raw product notes into human-reviewable QA modules.',
    '- Delivery constraint: every downstream step is blocked until this artifact is approved.',
    '',
    '## Target Site Summary',
    ...summaryLines.map((line) => `- ${line}`),
    '',
    '## Modules In Scope',
    ...modules.map((moduleName) => `- ${moduleName}`),
    '',
    '## High Value User Flows',
    ...flowLines,
    '',
    '## Test Data And Environment Notes',
    '- Browser scope in this POC: Chromium only.',
    '- Data storage in this POC: local files only.',
    '- Output must remain readable and editable before approval.',
    '',
    '## Risks And Assumptions',
    `- Module inference is template-based${config.ai.apiKey ? ' when live generation is unavailable.' : ' because no API key is configured.'}`,
    '- Fine-grained page metadata and screenshots are deferred to the site exploration step.',
    '- Self-healing and generic crawling are explicitly out of scope.',
    '',
    '## Approval Checklist',
    ...acceptanceChecklist,
  ].join('\n');
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
    detected.add(siteUrl.includes('saucedemo') ? 'auth' : 'core');
  }

  return [...detected];
}

function describeFlow(moduleName: string): string {
  switch (moduleName) {
    case 'auth':
      return 'validate successful login, failed login feedback, and landing page expectations';
    case 'catalog':
      return 'validate inventory visibility, primary product interactions, and critical navigation';
    case 'cart':
      return 'validate add/remove operations and cart state persistence';
    case 'checkout':
      return 'validate checkout information capture, summary review, and completion outcome';
    default:
      return 'validate the module primary happy path and one critical negative path';
  }
}

export const llmAdapter = new LlmAdapter();
