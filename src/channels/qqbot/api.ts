// src/channels/qqbot/api.ts
// QQ REST API utilities: getAccessToken, sendC2CReply.

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
    body: JSON.stringify({ content, msg_type: 0, msg_id: msgId }),
  })
}
