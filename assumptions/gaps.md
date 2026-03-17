# 假设与缺口

## 当前阶段假设

- 默认演示站点为 SauceDemo。
- 默认操作人写死为 `local-user`。
- 真实 LLM 调用按 OpenAI 兼容的 `chat/completions` 接口处理。
- 无 `AI_API_KEY` 时必须可运行，因此默认允许模板降级。
- 当前阶段重点是把需求规范化、站点探索、测试计划、测试用例串成可审阅闭环。

## 当前缺口

- `tests_generate`、`tests_run` 仍未实现。
- 当前已接入受控站点探索，但尚未把截图、页面元数据和后续脚本生成建立强引用关系。
- 尚未接入 Playwright HTML 报告、trace、summary.json、summary.md。
- 结构化测试用例仍以规则模板为主，尚未根据计划内容做更细粒度拆分。
- 尚未处理多用户并发审批、登录鉴权或细粒度版本比较。

## 下一阶段需要处理的风险

- 站点探索必须保持受控，不能演变为通用爬虫。
- 页面元数据和截图需要与后续计划、用例、脚本产物建立稳定引用关系。
- 下游步骤应在上游重新生成后自动失效并回退到 `draft`。
- 需要补齐 Playwright 只跑 Chromium、trace on-first-retry、HTML 与 JSON/Markdown 摘要。
