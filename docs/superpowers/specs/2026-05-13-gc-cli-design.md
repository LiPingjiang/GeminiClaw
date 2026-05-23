# GeminiClaw CLI (`gc`) — Design Spec

> 2026-05-13

---

## 目标

为 GeminiClaw 构建一个 agent-first 的 CLI 管理工具 `gc`，让 agent 和人都能通过它：
- 了解自身身份、记忆、skill 体系
- 管理 skill（含溯源机制）
- 查看运行状态和配置
- 一次性从 OpenClaw workspace 导入经验

---

## 架构

### 整体结构

```
src/cli/
├── index.ts          ← CLI 入口，commander 注册所有命令
├── commands/
│   ├── identity.ts   ← gc identity show
│   ├── memory.ts     ← gc memory show/daily/append
│   ├── skill.ts      ← gc skill list/info/install/sources
│   ├── config.ts     ← gc config show
│   ├── status.ts     ← gc status
│   └── sync.ts       ← gc sync from <path>
├── lib/
│   ├── workspace.ts  ← workspace 路径解析（读 config.yaml 中的 workspace 字段）
│   ├── output.ts     ← 统一输出格式（human / --json）
│   └── skill-registry.ts ← skill 溯源注册表（读写 skills/.registry.json）
```

### Skill 目录结构（重构）

当前 GeminiClaw skills 是平铺的 `*_SKILL.md` 文件。重构为 OpenClaw 兼容的子目录格式：

```
skills/
├── .registry.json          ← 溯源注册表（新增）
├── brainstorming/
│   └── SKILL.md
├── self-inspect/
│   └── SKILL.md
└── ...
```

### 溯源注册表 `.registry.json`

```json
{
  "version": 1,
  "skills": {
    "brainstorming": {
      "source": "github:obra/superpowers",
      "installedAt": "2026-05-13T09:00:00Z",
      "version": "v5.1.0",
      "updateUrl": "https://github.com/obra/superpowers/tree/main/skills/brainstorming"
    },
    "self-inspect": {
      "source": "local",
      "installedAt": "2026-05-13T09:00:00Z",
      "version": null,
      "updateUrl": null
    }
  }
}
```

---

## 命令详细设计

### `gc identity show`
输出 agent 身份文件（SOUL.md / USER.md / IDENTITY.md）。
- workspace 路径从 config.yaml 的 `workspace.dir` 读取
- 若文件不存在，提示「尚未配置身份文件，运行 gc sync from <path> 导入」
- `--json`：输出 `{ soul, user, identity }` 三个字段

### `gc memory show`
输出长期记忆（MEMORY.md）。
- `--json`：输出 `{ content, path, mtime }`

### `gc memory daily [date]`
输出每日记忆，date 默认今天（YYYY-MM-DD）。
- 文件路径：`<workspace>/memory/<date>.md`

### `gc memory append <text>`
向 MEMORY.md 追加一条记录（带时间戳）。

### `gc skill list`
列出所有已安装 skill，含来源、版本、是否有 updateUrl。
- `--json`：完整注册表数据

### `gc skill info <name>`
显示 skill 详情：描述、frontmatter、来源、安装时间、SKILL.md 内容预览。

### `gc skill install <path> [--source <url>] [--version <ver>]`
从本地目录安装 skill，写入 `.registry.json`。
- `<path>` 可以是单个 skill 目录（含 SKILL.md）或批量目录
- `--source`：来源 URL，用于后续追踪更新
- `--version`：版本标记

### `gc skill sources`
列出所有 skill 的来源汇总，按 source 分组。

### `gc config show`
显示当前 config.yaml（脱敏：apiKey 替换为 `***`）。
- `--json`：脱敏后的 JSON

### `gc status`
显示运行状态：
- GeminiClaw 是否在运行（检测端口）
- 当前 config 的 provider 列表、默认模型
- skill 数量
- workspace 路径
- memory 策略

### `gc sync from <source-workspace>`
一次性从 OpenClaw workspace 导入经验：
1. 复制 SOUL.md / USER.md / IDENTITY.md / MEMORY.md / AGENTS.md / TOOLS.md
2. 复制 memory/ 目录（每日记忆）
3. 批量安装 skills（从 `~/.openclaw/skills/` 读取），写入 `.registry.json`
4. 用 LLM 决策：哪些内容需要适配（TOOLS.md 中有 OpenClaw 专属配置），生成适配建议报告
5. 输出同步摘要

---

## config.yaml 新增字段

```yaml
workspace:
  dir: ".workspace"          # 身份/记忆文件存放目录，默认 .workspace（相对于 config.yaml）

skills:
  dir: "skills"              # skill 目录，默认 skills/
```

---

## Help 设计原则（agent-first）

每个命令 help 包含四段：
1. **WHAT**：这个命令做什么
2. **WHEN**：agent 什么时候应该调用它
3. **OUTPUT**：输出格式说明（human/json 两种）
4. **EXAMPLE**：具体调用示例

---

## 技术选型

- **CLI 框架**：`commander` v12（GeminiClaw 已有 TypeScript 栈，commander 轻量无额外依赖）
- **输出**：默认 human-readable，`--json` 机器可读
- **bin 注册**：`package.json` 的 `bin.gc` 指向 `dist/cli/index.js`
- **workspace 默认路径**：`<projectRoot>/.workspace/`，可通过 config.yaml 覆盖

---

## Skill 溯源机制（README 记录要点）

这是 GeminiClaw 相对于 OpenClaw/Hermes 的差异化特性：

- 每个 skill 安装时必须记录来源（source URL、版本、安装时间）
- 来源存储在 `skills/.registry.json`，不嵌入 SKILL.md frontmatter
- `gc skill sources` 可随时查看所有 skill 的上游
- 为未来自动更新检查预留接口（`updateUrl` 字段）
- 手动安装的 skill source 标记为 `"local"`，不影响功能
