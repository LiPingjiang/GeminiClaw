# MEMORY.md — 跨项目通用长期记忆

> 事件触发写入，跨项目通用知识。项目专属知识放各自 Agent 的知识库。

---

## 架构决策

- [2026-05-25] GeminiClaw 记忆系统改为 layered strategy，DB 路径锁定为绝对路径
- [2026-05-25] QQBot 通道改为先尝试被动消息，失败自动降级主动消息（解决5分钟超时问题）
- [2026-05-26] AGENT.md 完成瘦身（≤40行），bug 记录迁移到 skills/debugging-lessons/，建立 workspace 分层结构

## 工作方法论

- [2026-05-25] 大任务截断后：新建同名 Agent → list_sessions → read_session 还原进度 → 从断点继续
- [2026-05-26] 会话预热：每次会话开始主动读 memory daily（今天+昨天），不等用户触发检索

## 腾讯云

- [2026-05-26] 腾讯云部署方式从 rsync 升级为 git pull，standard deploy: `ssh tencent "cd /opt/dragon-stock && git pull origin feature/cloud-server-v2 && systemctl restart dragon-api dragon-crawler"`
- [2026-05-26] cherry-pick 跨分支同步后 git log 会永远显示大量差距（hash 不同），正确判断方式：比对文件内容而非 commit 数
