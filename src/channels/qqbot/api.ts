// src/channels/qqbot/api.ts
// QQ REST API utilities: getAccessToken, sendC2CReply.

/**
 * Strip markdown formatting for QQ plain-text messages (msg_type: 0).
 * QQ Bot does not render markdown, so symbols like **, ##, ``` appear literally.
 */
function stripMarkdown(text: string): string {
  return text
    // 代码块（多行）：保留内容，去掉 ``` 围栏
    .replace(/```[\w]*\n?([\s\S]*?)```/g, (_, code) => code.trim())
    // 行内代码：去掉反引号
    .replace(/`([^`]+)`/g, "$1")
    // ATX 标题：## 标题 → 标题
    .replace(/^#{1,6}\s+/gm, "")
    // 粗体+斜体：***text*** / **text** / *text* / __text__ / _text_
    .replace(/\*\*\*(.+?)\*\*\*/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/___(.+?)___/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/_(.+?)_/g, "$1")
    // 删除线：~~text~~
    .replace(/~~(.+?)~~/g, "$1")
    // 水平线：--- / *** / ___（整行）
    .replace(/^\s*[-*_]{3,}\s*$/gm, "")
    // Markdown 链接：[text](url) → text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    // 图片：![alt](url) → alt
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    // 引用块：> text → text
    .replace(/^>+\s?/gm, "")
    // Markdown 表格：分隔行（|---|---|）直接删掉
    .replace(/^\|?\s*[-:]+[-|:\s]*$/gm, "")
    // 表格内容行：| 列1 | 列2 | → 列1  列2
    .replace(/^\|(.+)\|\s*$/gm, (_, inner) =>
      inner.split("|").map((s: string) => s.trim()).filter(Boolean).join("  ")
    )
    // 多余空行（连续 3+ 行空行 → 2 行）
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

export async function getAccessToken(appId: string, clientSecret: string): Promise<string> {
  try {
    const res = await fetch("https://bots.qq.com/app/getAppAccessToken", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId, clientSecret }),
    })
    const data = (await res.json()) as { access_token?: string }
    return data.access_token ?? ""
  } catch {
    return ""
  }
}

export async function sendC2CReply(
  appId: string,
  clientSecret: string,
  openid: string,
  content: string,
  msgId: string
): Promise<void> {
  const token = await getAccessToken(appId, clientSecret)
  if (!token) return
  await fetch(`https://api.sgroup.qq.com/v2/users/${openid}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `QQBot ${token}`,
    },
    body: JSON.stringify({ content: stripMarkdown(content), msg_type: 0, msg_id: msgId }),
  })
}
