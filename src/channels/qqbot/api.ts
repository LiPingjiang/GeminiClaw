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
// msg_seq：以秒级时间戳为基础，防止服务重启后归零被 QQ 判定为重复消息
// 每用户独立递增，同一秒内多条消息也能保证唯一
const _msgSeqBase = Math.floor(Date.now() / 1000) % 1_000_000;
const _msgSeqOffset = new Map<string, number>();

function nextMsgSeq(openid: string): number {
  const offset = (_msgSeqOffset.get(openid) ?? 0) + 1;
  _msgSeqOffset.set(openid, offset);
  return _msgSeqBase + offset;
}

/**
 * 上传图片并发送给单聊用户（被动回复，需要 msg_id）
 * 流程：先 POST /v2/users/{openid}/files 上传图片拿 file_info，
 * 再 POST /v2/users/{openid}/messages 用 msg_type=7 发送
 *
 * @param imagePath 本地图片文件路径（png/jpg）
 * @param imageBase64 图片 base64 字符串（与 imagePath 二选一，优先 base64）
 */
export async function sendC2CImageReply(
  appId: string,
  clientSecret: string,
  openid: string,
  msgId: string,
  imageBase64: string,
): Promise<void> {
  const token = await getAccessToken(appId, clientSecret);
  if (!token) throw new Error("Failed to get access token");

  // Step 1: 上传图片，获取 file_info（srv_send_msg=false，不直接发送）
  const uploadRes = await fetch(
    `https://api.sgroup.qq.com/v2/users/${openid}/files`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `QQBot ${token}`,
      },
      body: JSON.stringify({
        file_type: 1, // 1=图片
        srv_send_msg: false,
        file_data: imageBase64,
      }),
    },
  );
  if (!uploadRes.ok) {
    const err = await uploadRes.text().catch(() => uploadRes.status.toString());
    throw new Error(`uploadC2CFile failed: ${uploadRes.status} ${err}`);
  }
  const uploadData = (await uploadRes.json()) as { file_info?: string };
  const fileInfo = uploadData.file_info;
  if (!fileInfo) throw new Error("uploadC2CFile: no file_info returned");

  // Step 2: 发送图片消息（msg_type=7 富媒体，被动回复带 msg_id）
  const sendRes = await fetch(
    `https://api.sgroup.qq.com/v2/users/${openid}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `QQBot ${token}`,
      },
      body: JSON.stringify({
        msg_type: 7,
        media: { file_info: fileInfo },
        msg_id: msgId,
      }),
    },
  );
  if (!sendRes.ok) {
    const err = await sendRes.text().catch(() => sendRes.status.toString());
    throw new Error(`sendC2CImageReply failed: ${sendRes.status} ${err}`);
  }
}

export async function sendC2CActive(
  appId: string,
  clientSecret: string,
  openid: string,
  content: string,
): Promise<void> {
  const token = await getAccessToken(appId, clientSecret);
  if (!token) throw new Error("Failed to get access token");
  const seq = nextMsgSeq(openid);
  const res = await fetch(
    `https://api.sgroup.qq.com/v2/users/${openid}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `QQBot ${token}`,
      },
      // msg_type: 2 = markdown，与被动回复格式一致
      body: JSON.stringify({ markdown: { content }, msg_type: 2, msg_seq: seq }),
    },
  );
  if (!res.ok) {
    const err = await res.text().catch(() => res.status.toString());
    throw new Error(`sendC2CActive failed: ${res.status} ${err}`);
  }
}
