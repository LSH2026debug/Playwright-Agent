# Playwright-Agent 稳定性修复 Spec

## Why
当前Playwright-Agent项目存在多个稳定性问题，影响核心功能可用性：
1. `__name is not defined` 运行时错误导致站点探索功能失败
2. 前端单文件过大（1211行），状态管理混乱
3. 代码重复严重，维护困难
4. 缺少事务性状态更新，可能导致数据不一致

## What Changes
- 彻底修复`__name is not defined`错误（siteExploreService.ts）
- 修复前端状态管理bug（App.tsx重复定义问题）
- 提取selector builder模块，消除代码重复
- 添加基础错误边界和日志记录
- **BREAKING**: 部分函数签名可能调整以支持更好的错误处理

## Impact
- 影响文件：
  - backend/src/services/siteExploreService.ts
  - backend/src/services/selectorBuilder.ts (新增)
  - frontend/src/App.tsx
  - frontend/src/components/ (新增目录)
  - backend/src/utils/logger.ts (新增)
- 新增模块：selectorBuilder、logger、ErrorBoundary

## ADDED Requirements

### Requirement: `__name`错误彻底修复
The system SHALL确保所有在Playwright浏览器端执行的代码不使用TypeScript编译后的函数引用：
- 所有`evaluate`/`evaluateAll`调用的函数必须使用字符串形式
- 使用`new Function()`在浏览器端动态编译执行
- 提供统一的selector builder模块供多处复用

#### Scenario: 站点探索成功执行
- **GIVEN** 用户配置正确的站点URL和登录信息
- **WHEN** 调用站点探索API
- **THEN** 成功收集页面元素信息，无`__name is not defined`错误

### Requirement: 前端状态管理修复
The system SHALL修复App.tsx中的状态管理问题：
- 修复`notice`和`error`状态命名混淆
- 移除重复的状态定义
- 添加清晰的状态更新逻辑

#### Scenario: 错误提示正确显示
- **GIVEN** 用户执行某个操作
- **WHEN** 操作失败
- **THEN** 错误消息正确显示在通知区域

### Requirement: 代码重复消除
The system SHALL提取重复的selector builder逻辑：
- 创建独立的selectorBuilder.ts模块
- 提供TypeScript版本和字符串版本
- 所有使用处统一引用该模块

#### Scenario: 修改选择器逻辑
- **GIVEN** 需要修改元素选择器生成逻辑
- **WHEN** 开发者修改selectorBuilder.ts
- **THEN** 所有使用处自动生效，无需多处修改

### Requirement: 基础错误处理
The system SHALL添加基础错误边界和日志：
- 后端添加结构化日志记录
- 前端添加Error Boundary捕获渲染错误
- API调用添加统一的错误处理

#### Scenario: 运行时错误捕获
- **GIVEN** 应用运行过程中发生错误
- **WHEN** 错误发生时
- **THEN** 错误被记录，用户看到友好的错误提示

## MODIFIED Requirements

### Requirement: siteExploreService重构
**修改原因**：函数过于庞大，职责不单一，代码重复严重
**修改内容**：
- 提取selector builder到独立模块
- 拆分`exploreSite`函数为多个小函数
- 统一使用字符串形式的浏览器端代码

## REMOVED Requirements
- 无
