// src/evolution/intent-classifier.ts
// Lightweight LLM-based classifier that detects whether a user message
// is triggering the evolution ritual or is a normal chat message.

import type { ProviderRouter } from "../providers/router.js"
import type { ClassifyResult } from "./types.js"

const CLASSIFY_SYSTEM = `You are a message intent classifier for an AI agent's self-improvement system.
Classify the user message into exactly one of these intents. Reply with JSON only, no explanation.

Intents:
- "evolve": user wants to see improvement candidates. Triggers: "进化", "evolve", "show improvements", "有什么可以优化的", "优化一下", "self improve", "进化一下"
- "evolve_show": user wants to see a specific candidate's preview. Triggers: "看第N个", "show me #N", "第N个", "查看第N项", where N is a number
- "evolve_confirm": user confirms applying a change. Triggers: "确认", "apply", "好的就这个", "confirm", "应用", "执行"
- "evolve_reject": user rejects or skips. Triggers: "不要", "skip", "跳过", "cancel", "取消", "算了"
- "chat": everything else

For "evolve_show", also extract the 1-based index number.

Output format:
{"intent": "evolve"} 
or
{"intent": "evolve_show", "index": 2}
or
{"intent": "chat"}`

export class IntentClassifier {
  private providerRouter: ProviderRouter

  constructor(providerRouter: ProviderRouter) {
    this.providerRouter = providerRouter
  }

  /**
   * Classify a user message. Returns "chat" on any error (fail-safe).
   */
  async classify(userMessage: string): Promise<ClassifyResult> {
    // Fast path: skip classification for long messages (clearly not ritual commands)
    if (userMessage.length > 200) {
      return { intent: "chat" }
    }

    try {
      const response = await this.providerRouter.chat([
        { role: "user", content: `${CLASSIFY_SYSTEM}\n\nUser message: ${userMessage}` },
      ])

      const text = response.content.trim()
      // Extract JSON from response (may be wrapped in ```json blocks)
      const jsonMatch = text.match(/\{[\s\S]*\}/)
      if (!jsonMatch) return { intent: "chat" }

      const parsed = JSON.parse(jsonMatch[0]) as { intent?: string; index?: number }
      const intent = parsed.intent as ClassifyResult["intent"]

      const validIntents = ["evolve", "evolve_show", "evolve_confirm", "evolve_reject", "chat"]
      if (!validIntents.includes(intent)) return { intent: "chat" }

      return {
        intent,
        index: typeof parsed.index === "number" ? parsed.index : undefined,
      }
    } catch {
      // Classification errors must never break the chat flow
      return { intent: "chat" }
    }
  }
}
