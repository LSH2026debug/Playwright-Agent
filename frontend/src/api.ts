import type {
  CasesResponse,
  LoginSessionResponse,
  NormalizeResponse,
  PlanResponse,
  SiteExploreResponse,
  StepId,
  StepResponse,
  WorkflowPayload,
} from './types';

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3001';

interface ApiErrorShape {
  error?: {
    code?: string;
    message?: string;
  };
}

async function request<T>(pathname: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${pathname}`, init);
  const payload = (await response.json().catch(() => ({}))) as ApiErrorShape & T;

  if (!response.ok) {
    throw new Error(payload.error?.message ?? '请求失败。');
  }

  return payload as T;
}

export function fetchWorkflowState(): Promise<WorkflowPayload> {
  return request<WorkflowPayload>('/api/workflow/state');
}

export function initProject(input: {
  projectName: string;
  siteUrl: string;
  requiresLogin?: boolean;
  loginUrl?: string;
  operator?: string;
}): Promise<StepResponse> {
  return request<StepResponse>('/api/project/init', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  });
}

export function uploadRequirements(input: {
  file: File | null;
  text: string;
  operator?: string;
}): Promise<StepResponse> {
  const formData = new FormData();

  if (input.file) {
    formData.append('file', input.file);
  }

  if (input.text.trim()) {
    formData.append('text', input.text.trim());
  }

  formData.append('operator', input.operator ?? 'local-user');

  return request<StepResponse>('/api/requirements/upload', {
    method: 'POST',
    body: formData,
  });
}

export function generateRequirements(operator = 'local-user'): Promise<NormalizeResponse> {
  return request<NormalizeResponse>('/api/requirements/normalize', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ operator }),
  });
}

export function exploreSite(input: {
  operator?: string;
  maxPages?: number;
  login?: {
    enabled?: boolean;
    loginUrl?: string;
    username?: string;
    password?: string;
    useStoredSession?: boolean;
  };
} = {}): Promise<SiteExploreResponse> {
  return request<SiteExploreResponse>('/api/site/explore', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      operator: input.operator ?? 'local-user',
      maxPages: input.maxPages,
      login: input.login,
    }),
  });
}

export function fetchLoginSessionStatus(): Promise<LoginSessionResponse> {
  return request<LoginSessionResponse>('/api/site/login-session/status');
}

export function startLoginSession(input: {
  operator?: string;
  loginUrl?: string;
}): Promise<LoginSessionResponse> {
  return request<LoginSessionResponse>('/api/site/login-session/start', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      operator: input.operator ?? 'local-user',
      loginUrl: input.loginUrl,
    }),
  });
}

export function saveLoginSession(input: {
  operator?: string;
  closeBrowserAfterSave?: boolean;
} = {}): Promise<LoginSessionResponse> {
  return request<LoginSessionResponse>('/api/site/login-session/save', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      operator: input.operator ?? 'local-user',
      closeBrowserAfterSave: input.closeBrowserAfterSave,
    }),
  });
}

export function clearLoginSession(): Promise<LoginSessionResponse> {
  return request<LoginSessionResponse>('/api/site/login-session/clear', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  });
}

export function generatePlan(operator = 'local-user'): Promise<PlanResponse> {
  return request<PlanResponse>('/api/plan/generate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ operator }),
  });
}

export function generateCases(operator = 'local-user'): Promise<CasesResponse> {
  return request<CasesResponse>('/api/cases/generate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ operator }),
  });
}

export function reviewStep(input: {
  stepId: StepId;
  content: string;
  notes?: string;
  operator?: string;
}): Promise<StepResponse> {
  return request<StepResponse>(`/api/steps/${input.stepId}/review`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      content: input.content,
      notes: input.notes,
      operator: input.operator ?? 'local-user',
    }),
  });
}

export function approveStep(input: {
  stepId: StepId;
  notes?: string;
  operator?: string;
}): Promise<StepResponse> {
  return request<StepResponse>(`/api/steps/${input.stepId}/approve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      notes: input.notes,
      operator: input.operator ?? 'local-user',
    }),
  });
}
