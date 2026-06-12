// @ts-nocheck
// src/tools/evolution_command.ts
// 进化命令工具 — 将 /进化 /help /状态 等斜杠命令路由到 twin-system
import { registry } from './registry.js';

async function evolutionCommandHandler(params, _ctx) {
    const command = params['command'];
    const args = params['args'] ?? [];
    if (!command) {
        return { type: 'error', error: '未指定命令' };
    }
    if (command === 'help') {
        return {
            type: 'text',
            text: [
                '**GeminiClaw 可用命令：**',
                '',
                '`/进化` — 查看待确认的代码进化候选项',
                '`/进化 运行` — 手动触发一次代码进化循环',
                '`/技能` — 查看已结晶的技能库',
                '`/技能 运行` — 立即触发一次技能反思进化（不必等到凌晨 3 点）',
                '`/状态` — 查看系统状态',
                '`/help` — 显示此帮助信息',
            ].join('\n'),
        };
    }

    // 从全局获取实例（由 index.ts 在启动时注入）
    const globalAny = globalThis;
    const twinSystem = globalAny['__twinSystem'];
    const evolutionSystem = globalAny['__evolutionSystem'];

    try {
        // ── 技能引擎命令（用户主动发起技能进化）────────────────────────
        // 别名：/技能 /skill；子命令：运行/run/进化/evolve = 立即扫描进化
        if (command === '技能' || command === 'skill') {
            const skill = evolutionSystem && evolutionSystem.skill;
            if (!skill) {
                return { type: 'text', text: '⚠️ 技能进化引擎未启动，无法执行技能命令。' };
            }

            const sub = args[0];
            const runAliases = ['运行', 'run', '进化', 'evolve'];
            if (sub && runAliases.includes(sub)) {
                // 立即触发一次技能反思进化（复用引擎自带的候选源 / lookback / minScore）
                const result = await skill.runOnce('manual');
                if (result.success) {
                    const action = result.details && (result.details.action || result.details.skillName)
                        ? `\n动作: ${result.details.action ?? ''} ${result.details.skillName ?? ''}`.trim()
                        : '';
                    return {
                        type: 'text',
                        text: `✅ **技能进化完成**\n\n${result.summary}${action}\n耗时: ${result.durationMs}ms`,
                    };
                }
                return {
                    type: 'text',
                    text: `🟡 **本次未产出新技能**\n\n${result.summary}${result.reason ? `\n原因: ${result.reason}` : ''}\n耗时: ${result.durationMs}ms`,
                };
            }

            // 默认：列出已结晶的技能库
            const store = skill.getStore();
            const skills = store.listAll().map((s) => s.meta);
            if (skills.length === 0) {
                return {
                    type: 'text',
                    text: '📚 **技能库为空**\n\n还没有结晶出技能。输入 `/技能 运行` 立即从对话历史中提炼一次。',
                };
            }
            const lines = [`📚 **技能库（${skills.length} 个）**`, ''];
            skills.forEach((m, i) => {
                lines.push(`${i + 1}. **${m.name}**${m.version ? ` v${m.version}` : ''}`);
                if (m.description) lines.push(`   ${m.description}`);
            });
            lines.push('', '输入 `/技能 运行` 立即触发一次技能反思进化。');
            return { type: 'text', text: lines.join('\n') };
        }

        // ── 代码进化引擎命令（twin-system）──────────────────────────────
        if (!twinSystem) {
            return { type: 'text', text: '⚠️ Twin-System 未启动，无法执行进化命令。' };
        }
        switch (command) {
            case '进化': {
                if (args[0] === '运行') {
                    const intent = twinSystem.aggregator.next();
                    if (!intent) {
                        return { type: 'text', text: '🧬 **进化分析完成**\n\n当前队列中无待处理意图。' };
                    }
                    const result = await twinSystem.pipeline.run(intent);
                    if (result.success) {
                        return { type: 'text', text: `✅ **进化成功**\n\n${intent.description}\n变更文件: ${result.mutationResult?.changedFiles?.join(', ') ?? 'N/A'}` };
                    }
                    return { type: 'text', text: `❌ **进化失败**\n\n${intent.description}\n原因: ${result.failureReason ?? '未知'}` };
                }
                // Default: list candidates
                const candidates = twinSystem.aggregator.peek(5);
                if (candidates.length === 0) {
                    return { type: 'text', text: '📋 **当前无进化候选项**\n\n系统将持续监控，发现优化机会时自动入队。' };
                }
                const lines = ['📋 **进化候选项**\n'];
                candidates.forEach((c, i) => {
                    lines.push(`${i + 1}. [${c.riskLevel}] ${c.description}`);
                    lines.push(`   文件: ${c.targetFiles.join(', ')}`);
                });
                return { type: 'text', text: lines.join('\n') };
            }
            case '状态': {
                const stats = twinSystem.aggregator.getStats();
                const lines = [
                    '📊 **GeminiClaw Twin-System 状态**\n',
                    `🔄 **队列大小**: ${stats.queueSize} 个意图`,
                    `📈 **累计收集**: ${stats.totalCollected} 个`,
                    `📊 **最近运行**: ${stats.lastRunAt ? new Date(stats.lastRunAt).toLocaleString('zh-CN') : '从未'}`,
                ];
                return { type: 'text', text: lines.join('\n') };
            }
            default:
                return { type: 'text', text: `❌ 未知命令: /${command}\n输入 /help 查看所有可用命令。` };
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { type: 'error', error: `命令执行失败: ${message}` };
    }
}

registry.register({
    name: 'evolution_command',
    description: '执行斜杠命令，如 /进化、/状态、/help',
    schema: {
        type: 'object',
        properties: {
            command: { type: 'string', description: '命令名称（不含斜杠）' },
            args: { type: 'array', items: { type: 'string' }, description: '命令参数列表' },
        },
        required: ['command'],
    },
    handler: evolutionCommandHandler,
});
