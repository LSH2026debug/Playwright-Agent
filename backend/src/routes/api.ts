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
import type { StepId } from '../types/workflow.js';
import { stepIds } from '../types/workflow.js';

const upload = multer({ storage: multer.memoryStorage() });
const router = express.Router();

const initProjectSchema = z.object({
  projectName: z.string().trim().min(1).default('ai-playwright-poc'),
  siteUrl: z.string().trim().url(),
  operator: z.string().trim().min(1).default(config.defaultOperator),
});

const operatorSchema = z.object({
  operator: z.string().trim().min(1).default(config.defaultOperator),
  notes: z.string().trim().max(500).optional(),
});

const reviewSchema = operatorSchema.extend({
  content: z.string().min(1),
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
    throw new ApiError(400, 'missing_requirements', 'Provide a .md/.txt file or paste requirements text.');
  }

  if (uploadedFile && !/\.(md|txt)$/i.test(uploadedFile.originalname)) {
    throw new ApiError(400, 'unsupported_file_type', 'Only .md and .txt uploads are supported in Phase 1.');
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

router.post('/steps/:stepId/review', handleAsync(async (req, res) => {
  const payload = reviewSchema.parse(req.body);
  const stepId = parseStepId(readSingleRouteParam(req.params.stepId));

  if (stepId !== 'requirements_normalize') {
    throw new ApiError(501, 'review_not_implemented', `Review endpoint for ${stepId} will be implemented in Phase 2.`);
  }

  const state = await saveRequirementsReview({
    content: payload.content,
    actor: payload.operator,
    notes: payload.notes,
  });

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

  const fallbackMessage = error instanceof Error ? error.message : 'Unknown server error.';
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

  throw new ApiError(400, 'invalid_step_id', `Unsupported step id: ${rawStepId}`);
}

function readSingleRouteParam(rawValue: string | string[] | undefined): string {
  if (Array.isArray(rawValue)) {
    return rawValue[0] ?? '';
  }

  return rawValue ?? '';
}

export { router as apiRouter };
