// TEMP diagnostic script — inject real LLM, run collect() on the 5022-msg
// session, observe summariseMiddle branch logs. Deleted after use.
import { loadConfig } from "./src/config/loader.js"
import { AnthropicProvider } from "./src/providers/anthropic.js"
import { McliProvider } from "./src/providers/mcli.js"
import { LlmGwProvider } from "./src/providers/llm-gw.js"
import { FridayProvider } from "./src/providers/friday.js"
import { ProviderRouter } from "./src/providers/router.js"
import { openDb } from "./src/db/client.js"
import { ConversationCandidateSource } from "./src/skill-evolution/conversation-candidate-source.js"
import type { Provider } from "./src/providers/types.js"
import type { ProviderConfig } from "./src/config/schema.js"
import type { Message } from "./src/providers/types.js"
import type { LlmClient, LlmMessage } from "./src/skill-evolution/types.js"
import { writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

function buildProvider(config: ProviderConfig): Provider {
  switch (config.type) {
    case "anthropic": return new AnthropicProvider(config)
    case "mcli": return new McliProvider(config)
    case "llm-gw": return new LlmGwProvider(config)
    case "friday": return new FridayProvider(config)
    default: throw new Error(`Unsupported provider type: ${config.type}`)
  }
}

class RouterLlmClient implements LlmClient {
  constructor(private readonly router: ProviderRouter) {}
  async chat(messages: LlmMessage[]): Promise<string> {
    const mapped: Message[] = messages.map((m) => ({ role: m.role, content: m.content }))
    const res = await this.router.chat(mapped, { temperature: 0.2 })
    return res.content
  }
}

const SESSION = "d0f844b0-67c1-4d70-8f72-e49e48b7e6aa"

async function main() {
  const config = loadConfig()
  const providers = config.providers.map(buildProvider)
  const router = new ProviderRouter(providers, config.routing)
  const llm = new RouterLlmClient(router)

  const dbPath = join(homedir(), ".gemeniclaw", "memory", "geminiclaw.db")
  console.error(`[script] opening db: ${dbPath}`)
  const db = openDb(dbPath)

  const source = new ConversationCandidateSource(
    db,
    { maxCandidates: 1 },
    { sessionIds: [SESSION] },
    llm,
  )

  console.error(`[script] running collect() with REAL LLM on session ${SESSION} ...`)
  const t0 = Date.now()
  const candidates = await source.collect()
  console.error(`[script] collect() done in ${Date.now() - t0}ms, got ${candidates.length} candidate(s)`)

  if (candidates.length === 0) { console.error("[script] no candidate"); process.exit(1) }
  const c = candidates[0]
  writeFileSync("/tmp/prompt_NEW_LLM.txt", c.transcript, "utf8")
  console.error(`[script] transcript=${c.transcript.length} chars -> /tmp/prompt_NEW_LLM.txt`)
  process.exit(0)
}

main().catch((e) => { console.error("[script] FAILED:", e); process.exit(1) })
