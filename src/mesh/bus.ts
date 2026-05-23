import EventEmitter from 'events'
import { RoutedMessage } from './types.js'

class MessageBus extends EventEmitter {
  // 向指定 agent 路由消息
  // 路由前检查 routeChain 是否包含 targetAgentId
  // 包含 → 环路！调用 msg.replyFn 告知用户，不继续路由
  // 不包含 → 把 targetAgentId 加入 routeChain，emit 事件
  route(targetAgentId: string, msg: RoutedMessage): void {
    if (msg.routeChain.includes(targetAgentId)) {
      // 环路处理
      msg.replyFn(
        `消息路由时检测到循环（路径：${msg.routeChain.join(' → ')} → ${targetAgentId}），请直接告诉我你的意图`
      ).catch(console.error)
      return
    }
    msg.routeChain.push(targetAgentId)
    this.emit(`agent:${targetAgentId}`, msg)
  }

  // Agent 注册自己的消息处理器
  onMessage(agentId: string, handler: (msg: RoutedMessage) => Promise<void>): void {
    this.on(`agent:${agentId}`, (msg: RoutedMessage) => {
      handler(msg).catch(console.error)
    })
  }

  // Agent 注销
  offMessage(agentId: string): void {
    this.removeAllListeners(`agent:${agentId}`)
  }
}

// 导出单例
export const messageBus = new MessageBus()
messageBus.setMaxListeners(50)  // 最多 50 个 agent（远超实际上限，避免警告）
