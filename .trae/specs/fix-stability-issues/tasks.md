# Tasks

- [x] Task 1: 修复`__name is not defined`错误
  - [x] SubTask 1.1: 创建selectorBuilder.ts模块，提取所有浏览器端执行的函数
  - [x] SubTask 1.2: 将buildBestSelector和buildPlaywrightLocator转为字符串形式
  - [x] SubTask 1.3: 修改siteExploreService.ts，使用新的selectorBuilder模块
  - [x] SubTask 1.4: 测试站点探索功能，确保无`__name`错误

- [x] Task 2: 修复前端状态管理bug
  - [x] SubTask 2.1: 检查并修复App.tsx中的notice/error状态命名问题
  - [x] SubTask 2.2: 移除重复的状态定义
  - [x] SubTask 2.3: 测试错误提示功能

- [x] Task 3: 添加基础错误处理
  - [x] SubTask 3.1: 创建backend/src/utils/logger.ts，添加结构化日志
  - [x] SubTask 3.2: 在关键服务中添加日志记录
  - [x] SubTask 3.3: 创建前端Error Boundary组件
  - [x] SubTask 3.4: 在App.tsx中添加Error Boundary包裹

# Task Dependencies
- Task 1 必须在 Task 2 之前完成（先确保后端稳定）
- Task 3 可以与其他任务并行
