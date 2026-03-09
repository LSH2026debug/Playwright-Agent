# ai-playwright-poc

一个从零实现的 AI 辅助 Playwright 测试生成与执行 POC。当前仓库已完成 Phase 1：

- Node.js + TypeScript 单仓
- 前端使用 React + Vite
- 后端使用 Express + 文件系统持久化
- 实现项目初始化、需求上传、AI 规范化、人工审阅、人工批准
- 严格执行 Human-in-the-loop 闸门，未批准不可进入下一步
- AI 调用通过统一 LLM Adapter 封装，支持 live / template fallback / mock

## Phase 1 已完成范围

已实现后端 API：

- `POST /api/project/init`
- `POST /api/requirements/upload`
- `POST /api/requirements/normalize`
- `POST /api/steps/:stepId/review`
- `POST /api/steps/:stepId/approve`
- `GET /api/workflow/state`

已实现前端能力：

- 7 步 Wizard 骨架
- 第 1 步项目初始化
- 第 2 步需求上传或粘贴
- 第 3 步 AI 规范化需求、人工编辑、人工批准
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

## Phase 1 端到端演示步骤

1. 在前端第 1 步填写项目名称和网站 URL。
2. 第 2 步上传 `inputs/sample-saucedemo-requirements.md`，或直接粘贴需求内容。
3. 第 3 步点击“AI 生成”。
4. 在文本框中编辑结果后点击“保存审阅”。
5. 点击“批准当前步骤”。
6. 批准后“下一步”按钮才会解锁。

## 关键工件

运行后会生成以下 Phase 1 工件：

- `artifacts/project.json`
- `artifacts/workflow-state.json`
- `artifacts/approval-log.json`
- `inputs/requirements-input.md`
- `requirements/normalized-requirements.md`
- `requirements/normalized-requirements.meta.json`

状态机规则：

```text
draft -> ai_generated -> human_reviewed -> approved -> completed
```

说明：

- `requirements_normalize` 在 Phase 1 使用到 `approved`
- 后续阶段会消费该审批结果，并继续推进到 `completed`
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

重置 Phase 1 运行工件：

```powershell
./scripts/reset-workflow.ps1
```

## 已验证内容

本仓库已完成以下验证：

- `npm install`
- `npm run build`
- 后端 API 闭环验证：初始化、上传、AI 生成、未审阅时批准失败、审阅、批准、状态查询

实际验收结果：

```json
{
  "init": "completed",
  "upload": "completed",
  "normalize": "ai_generated",
  "approveBeforeReview": 409,
  "review": "human_reviewed",
  "approve": "approved",
  "finalRequirementsStatus": "approved"
}
```

## 下一阶段

Phase 2 计划实现：

- `POST /api/site/explore`
- `POST /api/plan/generate`
- `POST /api/cases/generate`
- 受批准状态驱动的下游闸门
- 页面元数据与截图产物

更多限制与已知缺口见 `assumptions/gaps.md`。
