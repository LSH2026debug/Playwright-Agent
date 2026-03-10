import { useEffect, useState } from 'react';

import {
  approveStep,
  exploreSite,
  fetchWorkflowState,
  generateCases,
  generatePlan,
  generateRequirements,
  initProject,
  reviewStep,
  uploadRequirements,
} from './api';
import type { StepId, StepStatus, WorkflowPayload } from './types';

const defaultOperator = 'local-user';

const stepSequence: Array<{ id: StepId; label: string; description: string }> = [
  {
    id: 'project_init',
    label: '1. 初始化',
    description: '录入项目名称与目标站点 URL。',
  },
  {
    id: 'requirements_upload',
    label: '2. 上传需求',
    description: '上传或粘贴原始需求文档。',
  },
  {
    id: 'requirements_normalize',
    label: '3. 规范化需求',
    description: 'AI 生成规范化模块，人工审阅后批准。',
  },
  {
    id: 'site_explore',
    label: '4. 站点探索',
    description: '第二阶段：Playwright 受控探索与截图。',
  },
  {
    id: 'plan_generate',
    label: '5. 测试计划',
    description: '第二阶段：基于已批准需求生成模块计划。',
  },
  {
    id: 'cases_generate',
    label: '6. 测试用例',
    description: '第二阶段：生成结构化测试用例。',
  },
  {
    id: 'tests_generate',
    label: '7. 生成与执行',
    description: '第二阶段：生成 Playwright 脚本并执行。',
  },
];

export default function App() {
  const [payload, setPayload] = useState<WorkflowPayload | null>(null);
  const [activeStep, setActiveStep] = useState<StepId>('project_init');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [projectName, setProjectName] = useState('ai-playwright-poc');
  const [siteUrl, setSiteUrl] = useState('https://www.saucedemo.com/');
  const [rawRequirements, setRawRequirements] = useState('');
  const [normalizedRequirements, setNormalizedRequirements] = useState('');
  const [siteExploreSummary, setSiteExploreSummary] = useState('');
  const [planDocument, setPlanDocument] = useState('');
  const [casesDocument, setCasesDocument] = useState('');

  useEffect(() => {
    void refreshWorkflow();
  }, []);

  async function refreshWorkflow() {
    setBusy(true);
    setError(null);

    try {
      const nextPayload = await fetchWorkflowState();
      setPayload(nextPayload);
      setProjectName(nextPayload.workflow.project?.name ?? 'ai-playwright-poc');
      setSiteUrl(nextPayload.workflow.project?.siteUrl ?? 'https://www.saucedemo.com/');
      setRawRequirements(nextPayload.documents.rawRequirements ?? '');
      setNormalizedRequirements(nextPayload.documents.normalizedRequirements ?? '');
      setSiteExploreSummary(nextPayload.documents.siteExploreSummary ?? '');
      setPlanDocument(nextPayload.documents.planDocument ?? '');
      setCasesDocument(nextPayload.documents.casesDocument ?? '');

      const suggestedStep = inferActiveStep(nextPayload);
      setActiveStep((currentStep) => (canAccessStep(nextPayload, currentStep) ? currentStep : suggestedStep));
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : '加载工作流状态失败。');
    } finally {
      setBusy(false);
    }
  }

  async function handleProjectInit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runAction(async () => {
      const response = await initProject({
        projectName,
        siteUrl,
        operator: defaultOperator,
      });
      await syncFromWorkflow(response.workflow, '项目已初始化。');
      setActiveStep('requirements_upload');
    });
  }

  async function handleRequirementsUpload(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runAction(async () => {
      const response = await uploadRequirements({
        file: selectedFile,
        text: rawRequirements,
        operator: defaultOperator,
      });
      await syncFromWorkflow(response.workflow, '需求文档已保存。');
      setSelectedFile(null);
      setActiveStep('requirements_normalize');
    });
  }

  async function handleGenerateRequirements() {
    await runAction(async () => {
      const response = await generateRequirements(defaultOperator);
      setNormalizedRequirements(response.content);
      await syncFromWorkflow(response.workflow, `AI 已生成规范化需求，当前模式：${formatLlmMode(response.llm.mode)}`);
    });
  }

  async function handleReviewSave() {
    await runAction(async () => {
      const response = await reviewStep({
        stepId: 'requirements_normalize',
        content: normalizedRequirements,
        operator: defaultOperator,
      });
      await syncFromWorkflow(response.workflow, '人工审阅内容已保存。');
    });
  }

  async function handleApproveRequirements() {
    await runAction(async () => {
      const response = await approveStep({
        stepId: 'requirements_normalize',
        operator: defaultOperator,
      });
      await syncFromWorkflow(response.workflow, '需求规范已批准，可以进入下一步。');
    });
  }

  async function handleExploreSite() {
    await runAction(async () => {
      const response = await exploreSite(defaultOperator);
      setSiteExploreSummary(response.summary);
      await syncFromWorkflow(response.workflow, '站点探索已完成，请人工审阅后再批准。');
    });
  }

  async function handleSaveSiteExploreReview() {
    await runAction(async () => {
      const response = await reviewStep({
        stepId: 'site_explore',
        content: siteExploreSummary,
        operator: defaultOperator,
      });
      await syncFromWorkflow(response.workflow, '站点探索审阅内容已保存。');
    });
  }

  async function handleApproveSiteExplore() {
    await runAction(async () => {
      const response = await approveStep({
        stepId: 'site_explore',
        operator: defaultOperator,
      });
      await syncFromWorkflow(response.workflow, '站点探索结果已批准，可以进入测试计划。');
    });
  }

  async function handleGeneratePlan() {
    await runAction(async () => {
      const response = await generatePlan(defaultOperator);
      setPlanDocument(response.content);
      await syncFromWorkflow(response.workflow, `模块测试计划已生成，当前模式：${formatLlmMode(response.llm.mode)}`);
    });
  }

  async function handleSavePlanReview() {
    await runAction(async () => {
      const response = await reviewStep({
        stepId: 'plan_generate',
        content: planDocument,
        operator: defaultOperator,
      });
      await syncFromWorkflow(response.workflow, '测试计划审阅内容已保存。');
    });
  }

  async function handleApprovePlan() {
    await runAction(async () => {
      const response = await approveStep({
        stepId: 'plan_generate',
        operator: defaultOperator,
      });
      await syncFromWorkflow(response.workflow, '测试计划已批准，可以进入测试用例生成。');
    });
  }

  async function handleGenerateCases() {
    await runAction(async () => {
      const response = await generateCases(defaultOperator);
      setCasesDocument(response.markdown);
      await syncFromWorkflow(response.workflow, `结构化测试用例已生成，当前模式：${formatLlmMode(response.llm.mode)}`);
    });
  }

  async function handleSaveCasesReview() {
    await runAction(async () => {
      const response = await reviewStep({
        stepId: 'cases_generate',
        content: casesDocument,
        operator: defaultOperator,
      });
      await syncFromWorkflow(response.workflow, '结构化测试用例审阅内容已保存。');
    });
  }

  async function handleApproveCases() {
    await runAction(async () => {
      const response = await approveStep({
        stepId: 'cases_generate',
        operator: defaultOperator,
      });
      await syncFromWorkflow(response.workflow, '结构化测试用例已批准，可以进入脚本生成。');
    });
  }

  async function runAction(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      await action();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : '请求失败。');
    } finally {
      setBusy(false);
    }
  }

  async function syncFromWorkflow(workflow: WorkflowPayload['workflow'], message: string) {
    const nextPayload = await fetchWorkflowState();
    setPayload(nextPayload);
    setProjectName(workflow.project?.name ?? 'ai-playwright-poc');
    setSiteUrl(workflow.project?.siteUrl ?? 'https://www.saucedemo.com/');
    setRawRequirements(nextPayload.documents.rawRequirements ?? '');
    setNormalizedRequirements(nextPayload.documents.normalizedRequirements ?? normalizedRequirements);
    setSiteExploreSummary(nextPayload.documents.siteExploreSummary ?? siteExploreSummary);
    setPlanDocument(nextPayload.documents.planDocument ?? planDocument);
    setCasesDocument(nextPayload.documents.casesDocument ?? casesDocument);
    setNotice(message);
  }

  const workflow = payload?.workflow;
  const activeStepState = workflow?.steps[activeStep];
  const artifacts = activeStepState?.artifacts ?? [];
  const recentLogs = workflow?.logs.slice(-8).reverse() ?? [];

  return (
    <div className="app-shell">
      <aside className="step-rail">
        <div className="brand-block">
          <p className="eyebrow">Phase 2</p>
          <h1>AI Playwright POC</h1>
          <p>AI 生成与人工审批强绑定。没有批准，就没有下一步。</p>
        </div>

        <div className="step-list">
          {stepSequence.map((step) => {
            const status = workflow?.steps[step.id]?.status ?? 'draft';
            const disabled = !canAccessStep(payload, step.id);

            return (
              <button
                key={step.id}
                className={`step-card ${activeStep === step.id ? 'is-active' : ''}`}
                disabled={disabled}
                onClick={() => setActiveStep(step.id)}
                type="button"
              >
                <span className={`status-pill status-${status}`}>{formatStatus(status)}</span>
                <strong>{step.label}</strong>
                <span>{step.description}</span>
              </button>
            );
          })}
        </div>
      </aside>

      <main className="content-panel">
        <header className="hero-card">
          <div>
            <p className="eyebrow">当前工作流</p>
            <h2>{stepSequence.find((step) => step.id === activeStep)?.label}</h2>
            <p>{stepSequence.find((step) => step.id === activeStep)?.description}</p>
          </div>
          <div className="hero-meta">
            <div>
              <span>当前步骤状态</span>
              <strong className={`status-pill status-${activeStepState?.status ?? 'draft'}`}>
                {formatStatus(activeStepState?.status ?? 'draft')}
              </strong>
            </div>
            <div>
              <span>操作人</span>
              <strong>{workflow?.project?.operator ?? defaultOperator}</strong>
            </div>
          </div>
        </header>

        {notice ? <div className="feedback success">{notice}</div> : null}
        {error ? <div className="feedback error">{error}</div> : null}

        {activeStep === 'project_init' ? (
          <section className="panel-card">
            <div className="panel-header">
              <div>
                <h3>项目初始化</h3>
                <p>先把项目元数据写入文件，后续步骤都依赖这一步。</p>
              </div>
            </div>

            <form className="form-grid" onSubmit={handleProjectInit}>
              <label>
                <span>项目名称</span>
                <input
                  value={projectName}
                  onChange={(event) => setProjectName(event.target.value)}
                  placeholder="ai-playwright-poc"
                />
              </label>

              <label>
                <span>网站 URL</span>
                <input
                  value={siteUrl}
                  onChange={(event) => setSiteUrl(event.target.value)}
                  placeholder="https://www.saucedemo.com/"
                />
              </label>

              <div className="action-row">
                <button className="primary" disabled={busy} type="submit">
                  {busy ? '处理中...' : '初始化项目'}
                </button>
                <button
                  className="ghost"
                  disabled={!canGoNext(payload, 'project_init')}
                  onClick={() => setActiveStep('requirements_upload')}
                  type="button"
                >
                  下一步
                </button>
              </div>
            </form>
          </section>
        ) : null}

        {activeStep === 'requirements_upload' ? (
          <section className="panel-card">
            <div className="panel-header">
              <div>
                <h3>上传需求文档</h3>
                <p>第一阶段支持 `.md` / `.txt` 文件，也支持直接粘贴文本。</p>
              </div>
            </div>

            <form className="form-grid" onSubmit={handleRequirementsUpload}>
              <label>
                <span>选择文件</span>
                <input
                  accept=".md,.txt"
                  onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)}
                  type="file"
                />
              </label>

              <label className="full-span">
                <span>或直接粘贴需求文本</span>
                <textarea
                  rows={10}
                  value={rawRequirements}
                  onChange={(event) => setRawRequirements(event.target.value)}
                  placeholder="可以直接粘贴需求，或者参考 inputs/sample-saucedemo-requirements.md"
                />
              </label>

              <div className="action-row">
                <button className="primary" disabled={busy} type="submit">
                  {busy ? '处理中...' : '保存需求'}
                </button>
                <button
                  className="ghost"
                  disabled={!canGoNext(payload, 'requirements_upload')}
                  onClick={() => setActiveStep('requirements_normalize')}
                  type="button"
                >
                  下一步
                </button>
              </div>
            </form>
          </section>
        ) : null}

        {activeStep === 'requirements_normalize' ? (
          <section className="panel-card">
            <div className="panel-header">
              <div>
                <h3>AI 规范化需求</h3>
                <p>必须经过人工审阅并批准，后续 `site_explore` 才会开放。</p>
              </div>
            </div>

            <div className="action-row action-row-tight">
              <button className="primary" disabled={busy || !canGenerateRequirements(payload)} onClick={handleGenerateRequirements} type="button">
                {busy ? '处理中...' : 'AI 生成'}
              </button>
              <button
                className="secondary"
                disabled={busy || !canReviewStep(payload, 'requirements_normalize') || !normalizedRequirements.trim()}
                onClick={handleReviewSave}
                type="button"
              >
                保存审阅
              </button>
              <button
                className="accent"
                disabled={busy || !canApproveStepById(payload, 'requirements_normalize')}
                onClick={handleApproveRequirements}
                type="button"
              >
                批准当前步骤
              </button>
              <button
                className="ghost"
                disabled={!canGoNext(payload, 'requirements_normalize')}
                onClick={() => setActiveStep('site_explore')}
                type="button"
              >
                下一步
              </button>
            </div>

            <label className="full-span">
              <span>规范化需求结果</span>
              <textarea
                rows={18}
                value={normalizedRequirements}
                onChange={(event) => setNormalizedRequirements(event.target.value)}
                placeholder="点击 AI 生成后，这里会出现可编辑的规范化需求模块。"
              />
            </label>
          </section>
        ) : null}

        {activeStep === 'site_explore' ? (
          <section className="panel-card">
            <div className="panel-header">
              <div>
                <h3>站点探索</h3>
                <p>使用 Playwright 对目标站点进行受控探索，生成摘要、页面元数据和截图。</p>
              </div>
            </div>

            <div className="action-row action-row-tight">
              <button className="primary" disabled={busy || !canGenerateSiteExplore(payload)} onClick={handleExploreSite} type="button">
                {busy ? '处理中...' : '执行站点探索'}
              </button>
              <button
                className="secondary"
                disabled={busy || !canReviewStep(payload, 'site_explore') || !siteExploreSummary.trim()}
                onClick={handleSaveSiteExploreReview}
                type="button"
              >
                保存审阅
              </button>
              <button
                className="accent"
                disabled={busy || !canApproveStepById(payload, 'site_explore')}
                onClick={handleApproveSiteExplore}
                type="button"
              >
                批准当前步骤
              </button>
              <button
                className="ghost"
                disabled={!canGoNext(payload, 'site_explore')}
                onClick={() => setActiveStep('plan_generate')}
                type="button"
              >
                下一步
              </button>
            </div>

            <label className="full-span">
              <span>站点探索摘要</span>
              <textarea
                rows={16}
                value={siteExploreSummary}
                onChange={(event) => setSiteExploreSummary(event.target.value)}
                placeholder="点击执行站点探索后，这里会出现可编辑的探索摘要。"
              />
            </label>
          </section>
        ) : null}

        {activeStep === 'plan_generate' ? (
          <section className="panel-card">
            <div className="panel-header">
              <div>
                <h3>模块级测试计划</h3>
                <p>基于已批准的规范化需求和站点探索结果生成模块级测试计划。</p>
              </div>
            </div>

            <div className="action-row action-row-tight">
              <button className="primary" disabled={busy || !canGeneratePlanStep(payload)} onClick={handleGeneratePlan} type="button">
                {busy ? '处理中...' : '生成测试计划'}
              </button>
              <button
                className="secondary"
                disabled={busy || !canReviewStep(payload, 'plan_generate') || !planDocument.trim()}
                onClick={handleSavePlanReview}
                type="button"
              >
                保存审阅
              </button>
              <button
                className="accent"
                disabled={busy || !canApproveStepById(payload, 'plan_generate')}
                onClick={handleApprovePlan}
                type="button"
              >
                批准当前步骤
              </button>
              <button
                className="ghost"
                disabled={!canGoNext(payload, 'plan_generate')}
                onClick={() => setActiveStep('cases_generate')}
                type="button"
              >
                下一步
              </button>
            </div>

            <label className="full-span">
              <span>测试计划文档</span>
              <textarea
                rows={18}
                value={planDocument}
                onChange={(event) => setPlanDocument(event.target.value)}
                placeholder="点击生成测试计划后，这里会出现可编辑的模块级测试计划。"
              />
            </label>
          </section>
        ) : null}

        {activeStep === 'cases_generate' ? (
          <section className="panel-card">
            <div className="panel-header">
              <div>
                <h3>结构化测试用例</h3>
                <p>基于已批准的测试计划生成结构化测试用例，并允许人工修订后批准。</p>
              </div>
            </div>

            <div className="action-row action-row-tight">
              <button className="primary" disabled={busy || !canGenerateCasesStep(payload)} onClick={handleGenerateCases} type="button">
                {busy ? '处理中...' : '生成测试用例'}
              </button>
              <button
                className="secondary"
                disabled={busy || !canReviewStep(payload, 'cases_generate') || !casesDocument.trim()}
                onClick={handleSaveCasesReview}
                type="button"
              >
                保存审阅
              </button>
              <button
                className="accent"
                disabled={busy || !canApproveStepById(payload, 'cases_generate')}
                onClick={handleApproveCases}
                type="button"
              >
                批准当前步骤
              </button>
              <button
                className="ghost"
                disabled={!canGoNext(payload, 'cases_generate')}
                onClick={() => setActiveStep('tests_generate')}
                type="button"
              >
                下一步
              </button>
            </div>

            <label className="full-span">
              <span>结构化测试用例</span>
              <textarea
                rows={18}
                value={casesDocument}
                onChange={(event) => setCasesDocument(event.target.value)}
                placeholder="点击生成测试用例后，这里会出现可编辑的结构化测试用例。"
              />
            </label>
          </section>
        ) : null}

        {activeStep === 'tests_generate' ? (
          <section className="panel-card placeholder-card">
            <div className="panel-header">
              <div>
                <h3>{stepSequence.find((step) => step.id === activeStep)?.label}</h3>
                <p>{stepSequence.find((step) => step.id === activeStep)?.description}</p>
              </div>
            </div>

            <p>
              当前已完成到“结构化测试用例 + 人工审批闸门”。测试脚本生成与执行会在下一阶段继续补齐。
            </p>
          </section>
        ) : null}

        <section className="details-grid">
          <article className="panel-card compact-card">
            <div className="panel-header">
              <div>
                <h3>当前工件</h3>
                <p>显示当前步骤关联的文件路径。</p>
              </div>
            </div>

            <ul className="artifact-list">
              {artifacts.length === 0 ? <li>当前步骤暂无工件。</li> : null}
              {artifacts.map((artifact) => (
                <li key={artifact.path}>
                  <strong>{artifact.label}</strong>
                  <span>{artifact.path}</span>
                </li>
              ))}
            </ul>
          </article>

          <article className="panel-card compact-card">
            <div className="panel-header">
              <div>
                <h3>最近操作日志</h3>
                <p>来自后端持久化工作流日志。</p>
              </div>
            </div>

            <ul className="log-list">
              {recentLogs.length === 0 ? <li>还没有操作日志。</li> : null}
              {recentLogs.map((log) => (
                <li key={log.id}>
                  <strong>{log.action}</strong>
                  <span>{log.message}</span>
                  <small>{new Date(log.timestamp).toLocaleString('zh-CN')}</small>
                </li>
              ))}
            </ul>
          </article>
        </section>
      </main>
    </div>
  );
}

function inferActiveStep(payload: WorkflowPayload): StepId {
  const steps = payload.workflow.steps;

  if (steps.project_init.status === 'draft') {
    return 'project_init';
  }

  if (steps.requirements_upload.status === 'draft') {
    return 'requirements_upload';
  }

  if (!isApprovedStatus(steps.requirements_normalize.status)) {
    return 'requirements_normalize';
  }

  if (!isApprovedStatus(steps.site_explore.status)) {
    return 'site_explore';
  }

  if (!isApprovedStatus(steps.plan_generate.status)) {
    return 'plan_generate';
  }

  if (!isApprovedStatus(steps.cases_generate.status)) {
    return 'cases_generate';
  }

  return 'tests_generate';
}

function canAccessStep(payload: WorkflowPayload | null, stepId: StepId): boolean {
  if (!payload) {
    return stepId === 'project_init';
  }

  const steps = payload.workflow.steps;

  switch (stepId) {
    case 'project_init':
      return true;
    case 'requirements_upload':
      return steps.project_init.status === 'completed';
    case 'requirements_normalize':
      return steps.requirements_upload.status === 'completed';
    case 'site_explore':
      return isApprovedStatus(steps.requirements_normalize.status);
    case 'plan_generate':
      return isApprovedStatus(steps.site_explore.status);
    case 'cases_generate':
      return isApprovedStatus(steps.plan_generate.status);
    case 'tests_generate':
      return isApprovedStatus(steps.cases_generate.status);
    case 'tests_run':
      return isApprovedStatus(steps.tests_generate.status);
    default:
      return false;
  }
}

function canGoNext(payload: WorkflowPayload | null, stepId: StepId): boolean {
  if (!payload) {
    return false;
  }

  const status = payload.workflow.steps[stepId].status;

  if (stepId === 'project_init' || stepId === 'requirements_upload') {
    return status === 'completed';
  }

  return isApprovedStatus(status);
}

function canGenerateRequirements(payload: WorkflowPayload | null): boolean {
  if (!payload) {
    return false;
  }

  const stepStatus = payload.workflow.steps.requirements_normalize.status;
  return payload.workflow.steps.requirements_upload.status === 'completed'
    && (stepStatus === 'draft' || stepStatus === 'ai_generated');
}

function canGenerateSiteExplore(payload: WorkflowPayload | null): boolean {
  if (!payload) {
    return false;
  }

  const stepStatus = payload.workflow.steps.site_explore.status;
  return isApprovedStatus(payload.workflow.steps.requirements_normalize.status)
    && (stepStatus === 'draft' || stepStatus === 'ai_generated');
}

function canGeneratePlanStep(payload: WorkflowPayload | null): boolean {
  if (!payload) {
    return false;
  }

  const stepStatus = payload.workflow.steps.plan_generate.status;
  return isApprovedStatus(payload.workflow.steps.site_explore.status)
    && (stepStatus === 'draft' || stepStatus === 'ai_generated');
}

function canGenerateCasesStep(payload: WorkflowPayload | null): boolean {
  if (!payload) {
    return false;
  }

  const stepStatus = payload.workflow.steps.cases_generate.status;
  return isApprovedStatus(payload.workflow.steps.plan_generate.status)
    && (stepStatus === 'draft' || stepStatus === 'ai_generated');
}

function canReviewStep(payload: WorkflowPayload | null, stepId: StepId): boolean {
  if (!payload) {
    return false;
  }

  const status = payload.workflow.steps[stepId].status;
  return status === 'ai_generated' || status === 'human_reviewed';
}

function canApproveStepById(payload: WorkflowPayload | null, stepId: StepId): boolean {
  if (!payload) {
    return false;
  }

  return payload.workflow.steps[stepId].status === 'human_reviewed';
}

function formatStatus(status: StepStatus): string {
  const labels: Record<StepStatus, string> = {
    draft: '草稿',
    ai_generated: 'AI 已生成',
    human_reviewed: '人工已审阅',
    approved: '已批准',
    completed: '已完成',
  };

  return labels[status];
}

function isApprovedStatus(status: StepStatus): boolean {
  return status === 'approved' || status === 'completed';
}

function formatLlmMode(mode: string): string {
  switch (mode) {
    case 'live':
      return '实时 LLM 模式';
    case 'mock':
      return 'Mock 模式';
    case 'template':
      return '模板降级模式';
    default:
      return mode;
  }
}
