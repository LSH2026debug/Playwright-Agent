# ai-playwright-poc

一个从零实现的 AI 辅助 Playwright 测试生成与执行 POC。当前仓库已完成第一阶段和第二阶段的主要闭环：

- Node.js + TypeScript 单仓
- 前端使用 React + Vite
- 后端使用 Express + 文件系统持久化
- 实现项目初始化、需求上传、AI 规范化、站点探索、测试计划生成、测试用例生成
- 上述 AI 步骤都支持人工审阅、人工批准
- 严格执行 Human-in-the-loop 闸门，未批准不可进入下一步
- AI 调用通过统一 LLM 适配层封装，支持实时调用、模板降级和 mock

## 当前已完成范围

已实现后端 API：

- `POST /api/project/init`
- `POST /api/requirements/upload`
- `POST /api/requirements/normalize`
- `POST /api/site/explore`
- `POST /api/plan/generate`
- `POST /api/cases/generate`
- `POST /api/steps/:stepId/review`
- `POST /api/steps/:stepId/approve`
- `GET /api/workflow/state`

已实现前端能力：

- 7 步 Wizard 骨架
- 第 1 步项目初始化
- 第 2 步需求上传或粘贴
- 第 3 步 AI 规范化需求、人工编辑、人工批准
- 第 4 步 Playwright 受控站点探索、人工编辑、人工批准
- 第 5 步模块级测试计划生成、人工编辑、人工批准
- 第 6 步结构化测试用例生成、人工编辑、人工批准
- 下一步按钮严格受状态控制
- 当前步骤工件路径展示
- 最近操作日志展示

## 目录结构

```text
ai-playwright-poc/
  backend/
  frontend/
  inputs/
  requirements/
  metadata/site/
  metadata/screenshots/
  plans/
  cases/
  tests/generated/
  tests/helpers/
  prompts/
  scripts/
  reports/
  artifacts/
  assumptions/
```

## 环境准备

建议 Node.js 20+。

复制环境变量模板：

```powershell
Copy-Item .env.example .env
```

如果不配置 `AI_API_KEY`，系统仍然可运行，会自动退化到模板生成。

可选配置：

```env
AI_MODE=auto
AI_PROVIDER=openai-compatible
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL=gpt-4.1-mini
AI_API_KEY=
PORT=3001
DEFAULT_OPERATOR=local-user
VITE_API_BASE_URL=http://localhost:3001
```

模式说明：

- `AI_MODE=auto`: 有 key 走真实 LLM；无 key 自动模板降级
- `AI_MODE=template`: 永远使用模板降级
- `AI_MODE=mock`: 返回固定样例产物，便于演示

## 安装与启动

安装依赖：

```powershell
npm install
```

启动前后端：

```powershell
npm run dev
```

打开前端：

```text
http://127.0.0.1:5173
```

后端地址：

```text
http://localhost:3001
```

## 当前端到端演示步骤

1. 在前端第 1 步填写项目名称和网站 URL。
2. 第 2 步上传 `inputs/sample-saucedemo-requirements.md`，或直接粘贴需求内容。
3. 第 3 步点击“AI 生成”。
4. 在文本框中编辑结果后点击“保存审阅”。
5. 点击“批准当前步骤”。
6. 第 4 步点击“执行站点探索”，审阅并批准探索摘要。
7. 第 5 步点击“生成测试计划”，审阅并批准计划文档。
8. 第 6 步点击“生成测试用例”，审阅并批准结构化测试用例。
9. 每一步批准后“下一步”按钮才会解锁。

## 关键工件

运行后会生成以下关键工件：

- `artifacts/project.json`
- `artifacts/workflow-state.json`
- `artifacts/approval-log.json`
- `inputs/requirements-input.md`
- `requirements/normalized-requirements.md`
- `requirements/normalized-requirements.meta.json`
- `metadata/site/pages.yaml`
- `metadata/site/flows.yaml`
- `metadata/site/explore-summary.md`
- `metadata/site/explore-meta.json`
- `metadata/screenshots/*.png`
- `plans/module-test-plan.md`
- `plans/module-test-plan.meta.json`
- `cases/structured-test-cases.json`
- `cases/structured-test-cases.md`
- `cases/structured-test-cases.meta.json`

状态机规则：

```text
draft -> ai_generated -> human_reviewed -> approved -> completed
```

说明：

- `requirements_normalize` 在第一阶段使用到 `approved`
- `site_explore`、`plan_generate`、`cases_generate` 都会消费上游批准结果
- 若上一步未达到允许状态，后端返回 `409`

## 常用命令

构建：

```powershell
npm run build
```

仅启动后端：

```powershell
npm run dev -w backend
```

仅启动前端：

```powershell
npm run dev -w frontend -- --host 127.0.0.1
```

重置当前运行工件：

```powershell
./scripts/reset-workflow.ps1
```

## 已验证内容

本仓库已完成以下验证：

- `npm install`
- `npx playwright install chromium`
- `npm run build`
- 后端 API 闭环验证：规范化需求、站点探索、测试计划、测试用例的生成、审阅、批准、状态查询

实际验收结果：

```json
{
  "requirements": "approved",
  "siteExplore": "approved",
  "plan": "approved",
  "cases": "approved",
  "testsGenerate": "draft"
}
```

## 下一阶段

下一阶段计划实现：

- `tests_generate` 的 Playwright 脚本生成
- `tests_run` 的 Chromium 执行、报告、trace 与摘要产物
- 将结构化用例稳定映射到脚本文件与执行结果

更多限制与已知缺口见 `assumptions/gaps.md`。
