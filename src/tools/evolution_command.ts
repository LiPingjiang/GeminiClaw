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
                '`/进化` — 查看待确认的进化候选项',
                '`/进化 运行` — 手动触发一次进化循环',
                '`/状态` — 查看系统状态',
                '`/help` — 显示此帮助信息',
            ].join('\n'),
        };
    }

    // 从全局获取 twin-system 实例（由 index.ts 在启动时注入）
    const globalAny = globalThis;
    const twinSystem = globalAny['__twinSystem'];
    if (!twinSystem) {
        return { type: 'text', text: '⚠️ Twin-System 未启动，无法执行进化命令。' };
    }

    try {
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
