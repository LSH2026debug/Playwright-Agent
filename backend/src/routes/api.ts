import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';

import { config } from '../config.js';
import { ApiError } from '../utils/apiError.js';
import { approveStep, getWorkflowPayload, initializeProject } from '../services/workflowService.js';
import {
  generateNormalizedRequirements,
  saveRequirementsReview,
  uploadRequirements,
} from '../services/requirementsService.js';
import { exploreSite, saveSiteExploreReview } from '../services/siteExploreService.js';
import { generatePlan, savePlanReview } from '../services/planService.js';
import { generateCases, saveCasesReview } from '../services/casesService.js';
import type { StepId, WorkflowState } from '../types/workflow.js';
import { stepIds } from '../types/workflow.js';

const upload = multer({ storage: multer.memoryStorage() });
const router = express.Router();

const initProjectSchema = z.object({
  projectName: z.string().trim().min(1, '项目名称不能为空。').default('ai-playwright-poc'),
  siteUrl: z.string().trim().url('请输入合法的网站 URL。'),
  operator: z.string().trim().min(1, '操作人不能为空。').default(config.defaultOperator),
});

const operatorSchema = z.object({
  operator: z.string().trim().min(1, '操作人不能为空。').default(config.defaultOperator),
  notes: z.string().trim().max(500, '备注不能超过 500 个字符。').optional(),
});

const reviewSchema = operatorSchema.extend({
  content: z.string().min(1, '审阅内容不能为空。'),
});

router.post('/project/init', handleAsync(async (req, res) => {
  const payload = initProjectSchema.parse(req.body);
  const state = await initializeProject(payload);

  res.json(buildStepResponse(state, 'project_init'));
}));

router.post('/requirements/upload', upload.single('file'), handleAsync(async (req, res) => {
  const operator = typeof req.body.operator === 'string' && req.body.operator.trim()
    ? req.body.operator.trim()
    : config.defaultOperator;
  const inlineText = typeof req.body.text === 'string' ? req.body.text.trim() : '';
  const uploadedFile = req.file;

  if (!uploadedFile && !inlineText) {
    throw new ApiError(400, 'missing_requirements', '请上传 .md 或 .txt 文件，或直接粘贴需求文本。');
  }

  if (uploadedFile && !/\.(md|txt)$/i.test(uploadedFile.originalname)) {
    throw new ApiError(400, 'unsupported_file_type', '第一阶段只支持上传 .md 和 .txt 文件。');
  }

  const sourceText = uploadedFile ? uploadedFile.buffer.toString('utf8') : inlineText;
  const state = await uploadRequirements({
    originalName: uploadedFile?.originalname,
    sourceText,
    actor: operator,
  });

  res.json(buildStepResponse(state, 'requirements_upload'));
}));

router.post('/requirements/normalize', handleAsync(async (req, res) => {
  const payload = operatorSchema.parse(req.body ?? {});
  const result = await generateNormalizedRequirements({ actor: payload.operator });

  res.json({
    ...buildStepResponse(result.state, 'requirements_normalize'),
    content: result.content,
    llm: result.llm,
  });
}));

router.post('/site/explore', handleAsync(async (req, res) => {
  const payload = operatorSchema.parse(req.body ?? {});
  const result = await exploreSite({ actor: payload.operator });

  res.json({
    ...buildStepResponse(result.state, 'site_explore'),
    summary: result.summary,
    metadata: result.metadata,
  });
}));

router.post('/plan/generate', handleAsync(async (req, res) => {
  const payload = operatorSchema.parse(req.body ?? {});
  const result = await generatePlan({ actor: payload.operator });

  res.json({
    ...buildStepResponse(result.state, 'plan_generate'),
    content: result.content,
    llm: result.llm,
  });
}));

router.post('/cases/generate', handleAsync(async (req, res) => {
  const payload = operatorSchema.parse(req.body ?? {});
  const result = await generateCases({ actor: payload.operator });

  res.json({
    ...buildStepResponse(result.state, 'cases_generate'),
    markdown: result.markdown,
    cases: result.cases,
    llm: result.llm,
  });
}));

router.post('/steps/:stepId/review', handleAsync(async (req, res) => {
  const payload = reviewSchema.parse(req.body);
  const stepId = parseStepId(readSingleRouteParam(req.params.stepId));

  let state: WorkflowState;

  switch (stepId) {
    case 'requirements_normalize':
      state = await saveRequirementsReview({
        content: payload.content,
        actor: payload.operator,
        notes: payload.notes,
      });
      break;
    case 'site_explore':
      state = await saveSiteExploreReview({
        content: payload.content,
        actor: payload.operator,
        notes: payload.notes,
      });
      break;
    case 'plan_generate':
      state = await savePlanReview({
        content: payload.content,
        actor: payload.operator,
        notes: payload.notes,
      });
      break;
    case 'cases_generate':
      state = await saveCasesReview({
        markdown: payload.content,
        actor: payload.operator,
        notes: payload.notes,
      });
      break;
    default:
      throw new ApiError(501, 'review_not_implemented', `${stepId} 的审阅接口暂未实现。`);
  }

  res.json(buildStepResponse(state, stepId));
}));

router.post('/steps/:stepId/approve', handleAsync(async (req, res) => {
  const payload = operatorSchema.parse(req.body ?? {});
  const stepId = parseStepId(readSingleRouteParam(req.params.stepId));
  const state = await approveStep({
    stepId,
    actor: payload.operator,
    notes: payload.notes,
  });

  res.json(buildStepResponse(state, stepId));
}));

router.get('/workflow/state', handleAsync(async (_req, res) => {
  const payload = await getWorkflowPayload();
  res.json(payload);
}));

router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof z.ZodError) {
    res.status(400).json({
      ok: false,
      error: {
        code: 'validation_error',
        message: error.issues.map((issue) => issue.message).join('; '),
      },
    });
    return;
  }

  if (error instanceof ApiError) {
    res.status(error.statusCode).json({
      ok: false,
      error: {
        code: error.code,
        message: error.message,
      },
    });
    return;
  }

  const fallbackMessage = error instanceof Error ? error.message : '服务端发生未知错误。';
  res.status(500).json({
    ok: false,
    error: {
      code: 'internal_error',
      message: fallbackMessage,
    },
  });
});

function buildStepResponse(state: Awaited<ReturnType<typeof initializeProject>>, stepId: StepId) {
  const step = state.steps[stepId];

  return {
    ok: true,
    step: stepId,
    status: step.status,
    artifacts: step.artifacts,
    workflow: state,
  };
}

function handleAsync(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res, next).catch(next);
  };
}

function parseStepId(rawStepId: string): StepId {
  if ((stepIds as readonly string[]).includes(rawStepId)) {
    return rawStepId as StepId;
  }

  throw new ApiError(400, 'invalid_step_id', `不支持的步骤标识：${rawStepId}`);
}

function readSingleRouteParam(rawValue: string | string[] | undefined): string {
  if (Array.isArray(rawValue)) {
    return rawValue[0] ?? '';
  }

  return rawValue ?? '';
}

export { router as apiRouter };
