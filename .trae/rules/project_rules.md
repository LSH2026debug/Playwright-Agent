# Playwright-Agent 项目规则

## 1. 开发流程

```
Spec → 用户确认 → 编码实现 → 测试验证 → PR文档
```

**代码提交前检查**:
- [ ] TypeScript编译通过
- [ ] 代码重复检查
- [ ] 日志使用 `%` 格式化
- [ ] 敏感信息未提交

## 2. Playwright 浏览器端代码规范

**必须使用字符串形式传递函数**:
```typescript
// ✅ 正确
const fn = `(function(el) { return el.id })`;
page.evaluate((s) => new Function('return ' + s)(), fn);

// ❌ 错误
page.evaluate((el) => helper(el)); // __name错误
```

## 3. 代码规范

### TypeScript 风格
- 类型注解：`User | None`, `Record<string, unknown>`
- 枚举：`StrEnum`
- 日志：`logger.info("Processing: %s", id)`（禁止 f-string）
- 导入顺序：标准库 → 第三方 → 本地
- 行长度：120字符

### 架构原则
- DRY原则
- 浏览器端代码单独模块（selectorBuilder.ts）
- 错误在正确层级处理

## 4. 项目结构

```
backend/src/
├── services/          # 业务逻辑
├── utils/             # 工具函数
└── types/             # 类型定义
frontend/src/
├── components/        # React组件
└── api.ts             # API客户端
```

## 5. 沟通规范

- 使用 AskUserQuestion 提问
- 中文交流
- 使用 TodoWrite 跟踪进度

## 6. 环境变量

```env
AI_API_KEY=            AI_PROVIDER=
AI_MODEL=              AI_BASE_URL=
LOG_LEVEL=info
```

**最后更新**: 2026-03-17
