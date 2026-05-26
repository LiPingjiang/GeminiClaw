// src/channels/qqbot/api.ts

export async function getAccessToken(
  appId: string,
  clientSecret: string,
): Promise<string> {
  try {
    const res = await fetch("https://bots.qq.com/app/getAppAccessToken", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId, clientSecret }),
    });
    const data = (await res.json()) as { access_token?: string };
    return data.access_token ?? "";
  } catch {
    return "";
  }
}

// 被动回复（必须在 5 分钟内，带 msg_id）— 失败时 throw
export async function sendC2CReply(
  appId: string,
  clientSecret: string,
  openid: string,
  content: string,
  msgId: string,
): Promise<void> {
  const token = await getAccessToken(appId, clientSecret);
  if (!token) throw new Error("Failed to get access token");
  const res = await fetch(
    `https://api.sgroup.qq.com/v2/users/${openid}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `QQBot ${token}`,
      },
      body: JSON.stringify({
        markdown: { content },
        msg_type: 2,
        msg_id: msgId,
      }),
    },
  );
  if (!res.ok) {
    const err = await res.text().catch(() => res.status.toString());
    throw new Error(`sendC2CReply failed: ${res.status} ${err}`);
  }
}

// 主动消息（不依赖 msg_id，不受 5 分钟限制）
const _msgSeqMap = new Map<string, number>();

export async function sendC2CActive(
  appId: string,
  clientSecret: string,
  openid: string,
  content: string,
): Promise<void> {
  const token = await getAccessToken(appId, clientSecret);
  if (!token) throw new Error("Failed to get access token");
  const seq = (_msgSeqMap.get(openid) ?? 0) + 1;
  _msgSeqMap.set(openid, seq);
  const res = await fetch(
    `https://api.sgroup.qq.com/v2/users/${openid}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `QQBot ${token}`,
      },
      body: JSON.stringify({ content, msg_type: 0, msg_seq: seq }),
    },
  );
  if (!res.ok) {
    const err = await res.text().catch(() => res.status.toString());
    throw new Error(`sendC2CActive failed: ${res.status} ${err}`);
  }
}
