# GeminiClaw 高级功能开发计划

## 当前状态 (已完成)
- ✅ 技能系统基础架构
- ✅ 进化命令 /进化 基本响应
- ✅ HTTP API 正常工作
- ✅ TypeScript 编译通过

## 待开发高级功能

### P0 - 核心逻辑补全 (TODO 占位符)

#### 1. 进化确认/应用 (`src/commands/evolution.ts`)
- `approveEvolution()` 目前只返回文字，需要真正调用 EvolutionEngine 应用 intent
- 需要：调用 `evolution.applyIntent(intentId)` 或等效方法
- 验收：`/进化 确认 1` 能真正触发代码变更流程

#### 2. 进化拒绝 (`src/commands/evolution.ts`)  
- `rejectEvolution()` 需要真正调用 DB 更新 intent 状态为 rejected
- 需要：`evolution.getDb().updateIntentStatus(intentId, 'rejected')`
- 验收：`/进化 拒绝 1` 后该 intent 不再出现在候选列表

#### 3. 手动触发进化 (`src/commands/evolution.ts`)
- `runEvolution()` 需要真正触发 IntentEngine 的分析流程
- 需要：调用 `evolution.triggerAnalysis()` 或等效方法
- 验收：`/进化 运行` 后能看到新的候选项被生成

### P1 - 用户体验优化

#### 4. /help 命令
- 在 `CommandParser` 和 `EvolutionCommandHandler` 中添加 help 支持
- 返回所有可用命令的说明

#### 5. 进化预览完成检测
- 当前预览生成需要 1-2 分钟，用户体验差
- 需要：轮询或 webhook 机制，生成完成后主动通知

#### 6. 技能热重载
- 修改 skills/ 目录后无需重启即可加载新技能
- 需要：文件监听 + 动态重载

### P2 - 技能管理增强

#### 7. 技能管理命令
- `/技能 列表` - 查看所有已加载技能
- `/技能 详情 <name>` - 查看技能详情
- `/技能 禁用 <name>` / `/技能 启用 <name>`

#### 8. Mutator 技能文件支持
- 确认 Mutator 能修改 .md 文件
- 技能文件变更后自动重载

## 开发顺序

1. **先做 P0**：补全 TODO，让进化仪式真正可用
2. **再做 P1-4**：/help 命令，简单直接
3. **再做 P1-6**：技能热重载
4. **最后 P2**：技能管理命令

## 关键接口确认

开始开发前需要先确认：
- `EvolutionEngine` 暴露了哪些方法？
- `EvolutionDB` 的 `updateIntentStatus` 接口是否存在？
- `Mutator` 是否支持 .md 文件？
