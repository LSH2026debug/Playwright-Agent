# assumptions / gaps

## Phase 1 assumptions

- 默认演示站点为 SauceDemo。
- 默认操作人写死为 `local-user`。
- 真实 LLM 调用按 OpenAI 兼容的 `chat/completions` 接口处理。
- 无 `AI_API_KEY` 时必须可运行，因此默认允许模板降级。
- Phase 1 重点是审批闸门与需求规范化，不包含浏览器探索与用例生成。

## Phase 1 gaps

- `site_explore`、`plan_generate`、`cases_generate`、`tests_generate`、`tests_run` 尚未实现。
- 前端虽然有 7 步骨架，但第 4 步之后目前仍是占位面板。
- 审阅保存接口目前只为 `requirements_normalize` 提供落盘逻辑。
- 尚未接入 Playwright、HTML 报告、trace、summary.json、summary.md。
- 尚未生成页面元数据、截图、测试计划、结构化用例与 Playwright 脚本。
- 尚未处理多用户并发审批、登录鉴权或细粒度版本比较。

## Risks to address in Phase 2

- 站点探索必须保持受控，不能演变为通用爬虫。
- 页面元数据和截图需要与后续计划、用例、脚本产物建立稳定引用关系。
- 下游步骤应在上游重新生成后自动失效并回退到 `draft`。
- 需要补齐 Playwright 只跑 Chromium、trace on-first-retry、HTML 与 JSON/Markdown 摘要。
