import Database from "better-sqlite3"
import { describe, it, expect, beforeEach } from "vitest"
import { SessionStore } from "./store.js"
import type { Db } from "../db/client.js"

function createStore(): SessionStore {
  const db: Db = new Database(":memory:")
  db.pragma("journal_mode = WAL")
  db.pragma("foreign_keys = ON")
  return new SessionStore(db)
}

describe("SessionStore", () => {
  let store: SessionStore

  beforeEach(() => {
    store = createStore()
  })

  // 1. create — 创建根节点
  it("create — 字段正确，parentSessionId=null，branchType='main'", () => {
    const session = store.create({ source: "http", model: "gpt-4", title: "Test" })

    expect(session.id).toBeTruthy()
    expect(session.parentSessionId).toBeNull()
    expect(session.branchType).toBe("main")
    expect(session.source).toBe("http")
    expect(session.model).toBe("gpt-4")
    expect(session.title).toBe("Test")
    expect(session.startedAt).toBeGreaterThan(0)
    expect(session.endedAt).toBeNull()
    expect(session.endReason).toBeNull()
    expect(session.messageCount).toBe(0)
    expect(session.inputTokens).toBe(0)
    expect(session.outputTokens).toBe(0)
  })

  // 2. branch — 创建子节点
  it("branch — parentSessionId 指向父节点，branchType='evolution'", () => {
    const parent = store.create({ source: "qqbot", model: "claude-3" })
    const child = store.branch(parent.id, { branchType: "evolution" })

    expect(child.id).not.toBe(parent.id)
    expect(child.parentSessionId).toBe(parent.id)
    expect(child.branchType).toBe("evolution")
    expect(child.source).toBe("qqbot")
    expect(child.model).toBe("claude-3")  // 继承父节点 model
  })

  // 3. branch 父节点不存在 — 抛错
  it("branch — 父节点不存在时抛错 'Parent session not found'", () => {
    expect(() => {
      store.branch("non-existent-id", { branchType: "subagent" })
    }).toThrow("Parent session not found")
  })

  // 4. mergeBranch — 写入 summary，end_reason='branch_merged'
  it("mergeBranch — 写入 summary，end_reason='branch_merged'", () => {
    const parent = store.create({ source: "http" })
    const child = store.branch(parent.id, { branchType: "evolution" })

    store.mergeBranch(child.id, "Evolution completed successfully")

    const updated = store.get(child.id)!
    expect(updated.branchSummary).toBe("Evolution completed successfully")
    expect(updated.endReason).toBe("branch_merged")
    expect(updated.endedAt).toBeGreaterThan(0)
  })

  // 5. abortBranch — end_reason='branch_aborted'，summary 含 'aborted:'
  it("abortBranch — end_reason='branch_aborted'，summary 含 'aborted:'", () => {
    const parent = store.create({ source: "http" })
    const child = store.branch(parent.id, { branchType: "subagent" })

    store.abortBranch(child.id, "timeout exceeded")

    const updated = store.get(child.id)!
    expect(updated.endReason).toBe("branch_aborted")
    expect(updated.branchSummary).toContain("aborted:")
    expect(updated.branchSummary).toContain("timeout exceeded")
    expect(updated.endedAt).toBeGreaterThan(0)
  })

  // 6. appendMessage — 消息写入，message_count +1
  it("appendMessage — 消息写入，message_count +1", () => {
    const session = store.create({ source: "cli" })
    expect(session.messageCount).toBe(0)

    const msg = store.appendMessage(session.id, {
      role: "user",
      content: "Hello world",
    })

    expect(msg.id).toBeGreaterThan(0)
    expect(msg.sessionId).toBe(session.id)
    expect(msg.role).toBe("user")
    expect(msg.content).toBe("Hello world")
    expect(msg.createdAt).toBeGreaterThan(0)

    const updated = store.get(session.id)!
    expect(updated.messageCount).toBe(1)
  })

  // 7. appendMessage tool role — role='tool'，toolCalls/toolCallId 正确存储
  it("appendMessage — role='tool'，toolCalls/toolCallId 正确存储", () => {
    const session = store.create({ source: "http" })
    const toolCalls = [{ id: "call_1", type: "function", function: { name: "search", arguments: "{}" } }]

    const msg = store.appendMessage(session.id, {
      role: "tool",
      content: "search result",
      toolCalls,
      toolCallId: "call_1",
    })

    expect(msg.role).toBe("tool")
    expect(msg.toolCalls).toBe(JSON.stringify(toolCalls))
    expect(msg.toolCallId).toBe("call_1")
  })

  // 8. getHistory — 按 id 升序，limit 生效
  it("getHistory — 按 id 升序，limit 生效", () => {
    const session = store.create({ source: "http" })

    for (let i = 0; i < 5; i++) {
      store.appendMessage(session.id, { role: "user", content: `Message ${i}` })
    }

    const history = store.getHistory(session.id, 3)
    expect(history).toHaveLength(3)
    // 按 id 升序
    expect(history[0].content).toBe("Message 0")
    expect(history[1].content).toBe("Message 1")
    expect(history[2].content).toBe("Message 2")
  })

  // 9. addTokens — input_tokens/output_tokens 累加
  it("addTokens — input_tokens/output_tokens 累加", () => {
    const session = store.create({ source: "http" })

    store.addTokens(session.id, 100, 200)
    store.addTokens(session.id, 50, 75)

    const updated = store.get(session.id)!
    expect(updated.inputTokens).toBe(150)
    expect(updated.outputTokens).toBe(275)
  })

  // 10. listRecent — 只返回根节点，按 started_at 倒序，source 过滤生效
  it("listRecent — 只返回根节点，按 started_at 倒序，source 过滤生效", () => {
    const s1 = store.create({ source: "http" })
    const s2 = store.create({ source: "qqbot" })
    const s3 = store.create({ source: "http" })
    // 创建一个子节点（不应出现在 listRecent 结果中）
    store.branch(s1.id, { branchType: "evolution" })

    const all = store.listRecent()
    // 只有根节点（parent_session_id IS NULL）
    expect(all.every(s => s.parentSessionId === null)).toBe(true)
    // 包含所有三个根节点
    const allIds = all.map(s => s.id)
    expect(allIds).toContain(s1.id)
    expect(allIds).toContain(s2.id)
    expect(allIds).toContain(s3.id)
    // 不包含子节点
    expect(allIds).not.toContain(store.branch(s1.id, { branchType: 'subagent' }).id)
    // 按 started_at 倒序（后建的 >= 先建的）
    for (let i = 0; i < all.length - 1; i++) {
      expect(all[i].startedAt).toBeGreaterThanOrEqual(all[i + 1].startedAt)
    }

    // source 过滤
    const httpOnly = store.listRecent({ source: "http" })
    expect(httpOnly.every(s => s.source === "http")).toBe(true)
    expect(httpOnly.map(s => s.id)).not.toContain(s2.id)
  })

  // 11. getTree — 返回树形结构，children 正确嵌套
  it("getTree — 返回树形结构，children 正确嵌套", () => {
    const root = store.create({ source: "http" })
    const child1 = store.branch(root.id, { branchType: "evolution" })
    const child2 = store.branch(root.id, { branchType: "subagent" })
    const grandchild = store.branch(child1.id, { branchType: "compress" })

    const tree = store.getTree(root.id)!
    expect(tree.session.id).toBe(root.id)
    expect(tree.children).toHaveLength(2)

    const child1Tree = tree.children.find(c => c.session.id === child1.id)!
    expect(child1Tree).toBeDefined()
    expect(child1Tree.children).toHaveLength(1)
    expect(child1Tree.children[0].session.id).toBe(grandchild.id)

    const child2Tree = tree.children.find(c => c.session.id === child2.id)!
    expect(child2Tree).toBeDefined()
    expect(child2Tree.children).toHaveLength(0)
  })

  // 12. search — FTS5 搜索，能找到包含关键词的消息
  it("search — FTS5 搜索，能找到包含关键词的消息", () => {
    const session = store.create({ source: "http" })
    store.appendMessage(session.id, { role: "user", content: "hello world from search" })
    store.appendMessage(session.id, { role: "assistant", content: "this is a different message" })

    const results = store.search("hello")
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].content).toContain("hello")
    expect(results[0].sessionId).toBe(session.id)
  })

  // 13. search CJK — 中文搜索，能找到包含中文的消息（trigram 支持）
  // trigram 分词器创建 3-gram，所以搜索关键词需要 >= 3 个字符
  it("search CJK — 中文搜索，能找到包含中文的消息", () => {
    const session = store.create({ source: "http" })
    store.appendMessage(session.id, { role: "user", content: "今天天气很好，适合出门" })
    store.appendMessage(session.id, { role: "assistant", content: "是的，阳光明媚" })

    // trigram 分词器为每 3 字符创建一个 token，所以用 3 字符搜索
    const results = store.search("天天气")
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].content).toContain("天天气")
  })

  // 14. end — end_reason='done'，ended_at 被设置
  it("end — end_reason='done'，ended_at 被设置", () => {
    const session = store.create({ source: "cli" })
    expect(session.endedAt).toBeNull()

    store.end(session.id, "done")

    const updated = store.get(session.id)!
    expect(updated.endReason).toBe("done")
    expect(updated.endedAt).toBeGreaterThan(0)
  })

  // 15. setTitle — title 被更新
  it("setTitle — title 被更新", () => {
    const session = store.create({ source: "http" })
    expect(session.title).toBeNull()

    store.setTitle(session.id, "My New Title")

    const updated = store.get(session.id)!
    expect(updated.title).toBe("My New Title")
  })
})
