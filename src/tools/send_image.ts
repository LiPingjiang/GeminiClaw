// src/tools/send_image.ts
// 工具：发送图片到 QQ C2C 单聊
// 流程：读取本地 PNG/JPG → base64 → 上传 QQ files 接口 → 发 msg_type=7 消息
import { readFileSync } from "node:fs";
import { registry } from "./registry.js";
import type { ToolResult, ToolContext } from "./types.js";
import { getAccessToken } from "../channels/qqbot/api.js";

async function sendImageHandler(
  params: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const imagePath = params["image_path"] as string | undefined;
  if (!imagePath) {
    return { type: "error", error: "image_path is required" };
  }

  // 从 ctx.extra 中拿 QQ Bot 配置 + openid + msgId
  const extra = ctx.extra ?? {};
  const appId = extra["appId"] as string | undefined;
  const clientSecret = extra["clientSecret"] as string | undefined;
  const openid = extra["userId"] as string | undefined;
  const msgId = extra["msgId"] as string | undefined;

  if (!appId || !clientSecret || !openid) {
    return {
      type: "error",
      error: "QQ Bot 配置不完整（appId/clientSecret/openid），无法发送图片",
    };
  }

  // 读取图片 → base64
  let imageBase64: string;
  try {
    const buf = readFileSync(imagePath);
    imageBase64 = buf.toString("base64");
  } catch (e) {
    return { type: "error", error: `读取图片失败: ${(e as Error).message}` };
  }

  const token = await getAccessToken(appId, clientSecret);
  if (!token) {
    return { type: "error", error: "获取 QQ Bot access_token 失败" };
  }

  // Step 1: 上传图片获取 file_info
  let fileInfo: string;
  try {
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
      return { type: "error", error: `上传图片失败: ${uploadRes.status} ${err}` };
    }
    const data = (await uploadRes.json()) as { file_info?: string };
    if (!data.file_info) {
      return { type: "error", error: "上传图片未返回 file_info" };
    }
    fileInfo = data.file_info;
  } catch (e) {
    return { type: "error", error: `上传图片异常: ${(e as Error).message}` };
  }

  // Step 2: 发送图片消息 msg_type=7
  const body: Record<string, unknown> = {
    msg_type: 7,
    media: { file_info: fileInfo },
  };
  if (msgId) {
    // 被动回复（5分钟内有效）
    body["msg_id"] = msgId;
  } else {
    // 主动消息（需要 msg_seq）
    const seq = Math.floor(Date.now() / 1000) % 1_000_000;
    body["msg_seq"] = seq;
  }

  try {
    const sendRes = await fetch(
      `https://api.sgroup.qq.com/v2/users/${openid}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `QQBot ${token}`,
        },
        body: JSON.stringify(body),
      },
    );
    if (!sendRes.ok) {
      const err = await sendRes.text().catch(() => sendRes.status.toString());
      return { type: "error", error: `发送图片消息失败: ${sendRes.status} ${err}` };
    }
  } catch (e) {
    return { type: "error", error: `发送图片消息异常: ${(e as Error).message}` };
  }

  return { type: "text", text: `图片已发送到 QQ 用户 ${openid}（路径: ${imagePath}）` };
}

registry.register({
  name: "send_image",
  description:
    "发送本地图片文件到当前 QQ 单聊用户。只能在 QQ Bot 对话中使用。" +
    "image_path 为本地绝对路径，支持 png/jpg 格式。",
  schema: {
    type: "object",
    properties: {
      image_path: {
        type: "string",
        description: "本地图片文件的绝对路径，如 /tmp/kline_dist.png",
      },
    },
    required: ["image_path"],
  },
  handler: sendImageHandler,
  toolset: ["default"],
  requiresApproval: false,
  executionMode: "sequential",
});
