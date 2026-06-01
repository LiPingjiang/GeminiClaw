// src/channels/qqbot/api.ts
// QQ Bot Open Platform API — production-grade implementation.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface QQBotApiOptions {
  appId: string;
  clientSecret: string;
}

export interface InlineKeyboardButton {
  id: string;
  render_data: {
    label: string;
    visited_label: string;
    style: 0 | 1; // 0=grey, 1=blue
  };
  action: {
    type: 1 | 2; // 1=callback, 2=link
    data: string;
    permission: { type: 0 | 1 | 2 }; // 0=指定用户, 1=管理者, 2=所有人
    click_limit?: number;
  };
  group_id?: string;
}

export interface InlineKeyboard {
  content: {
    rows: Array<{ buttons: InlineKeyboardButton[] }>;
  };
}

export interface SendMessageOptions {
  /** 消息类型：0=text, 2=markdown, 7=media */
  msgType?: 0 | 2 | 7;
  /** 被动回复的 msg_id（5分钟内有效） */
  msgId?: string;
  /** 主动消息的 msg_seq */
  msgSeq?: number;
  /** Inline keyboard 按钮组件 */
  keyboard?: InlineKeyboard;
  /** 富媒体消息的 media 字段 */
  media?: { file_info: string };
}

// ---------------------------------------------------------------------------
// Token Manager (singleton-per-instance, with caching + auto-refresh)
// ---------------------------------------------------------------------------
class TokenManager {
  private appId: string;
  private clientSecret: string;
  private cachedToken: string | null = null;
  private expiresAt = 0;
  private refreshPromise: Promise<string> | null = null;

  constructor(appId: string, clientSecret: string) {
    this.appId = appId;
    this.clientSecret = clientSecret;
  }

  async getToken(): Promise<string> {
    // Token still valid (with 60s buffer)
    if (this.cachedToken && Date.now() < this.expiresAt - 60_000) {
      return this.cachedToken;
    }
    // Deduplicate concurrent refresh requests
    if (this.refreshPromise) {
      return this.refreshPromise;
    }
    this.refreshPromise = this._refresh();
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  invalidate(): void {
    this.cachedToken = null;
    this.expiresAt = 0;
  }

  private async _refresh(): Promise<string> {
    const res = await fetch("https://bots.qq.com/app/getAppAccessToken", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId: this.appId, clientSecret: this.clientSecret }),
    });
    if (!res.ok) {
      throw new Error(`Token refresh failed: ${res.status}`);
    }
    const data = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!data.access_token) {
      throw new Error("Token refresh: empty access_token");
    }
    this.cachedToken = data.access_token;
    // expires_in is in seconds; convert to ms timestamp
    this.expiresAt = Date.now() + (data.expires_in ?? 7200) * 1000;
    return this.cachedToken;
  }
}

// ---------------------------------------------------------------------------
// QQBotApi — unified API client
// ---------------------------------------------------------------------------
export class QQBotApi {
  private tokenMgr: TokenManager;
  readonly appId: string;
  readonly clientSecret: string;

  // msg_seq management (per openid/group)
  private _msgSeqBase = Math.floor(Date.now() / 1000) % 1_000_000;
  private _msgSeqOffset = new Map<string, number>();

  // Message deduplication (sliding window)
  private _seenMsgIds = new Set<string>();
  private _seenMsgQueue: string[] = [];
  private static readonly DEDUP_MAX = 1000;
  private static readonly DEDUP_TTL_MS = 300_000; // 5 min

  // Typing debounce
  private _lastTypingAt = new Map<string, number>();
  private static readonly TYPING_DEBOUNCE_MS = 50_000;

  constructor(opts: QQBotApiOptions) {
    this.appId = opts.appId;
    this.clientSecret = opts.clientSecret;
    this.tokenMgr = new TokenManager(opts.appId, opts.clientSecret);
  }

  // -------------------------------------------------------------------------
  // Token
  // -------------------------------------------------------------------------
  async getToken(): Promise<string> {
    return this.tokenMgr.getToken();
  }

  invalidateToken(): void {
    this.tokenMgr.invalidate();
  }

  // -------------------------------------------------------------------------
  // Message Deduplication
  // -------------------------------------------------------------------------
  isDuplicate(msgId: string): boolean {
    if (!msgId) return false;
    if (this._seenMsgIds.has(msgId)) return true;
    this._seenMsgIds.add(msgId);
    this._seenMsgQueue.push(msgId);
    if (this._seenMsgQueue.length > QQBotApi.DEDUP_MAX) {
      const removed = this._seenMsgQueue.shift()!;
      this._seenMsgIds.delete(removed);
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // msg_seq generator
  // -------------------------------------------------------------------------
  nextMsgSeq(targetId: string): number {
    const offset = (this._msgSeqOffset.get(targetId) ?? 0) + 1;
    this._msgSeqOffset.set(targetId, offset);
    return this._msgSeqBase + offset;
  }

  // -------------------------------------------------------------------------
  // Core send: C2C (private chat)
  // -------------------------------------------------------------------------
  async sendC2CMessage(
    openid: string,
    content: string,
    opts?: SendMessageOptions,
  ): Promise<void> {
    const token = await this.getToken();
    const msgType = opts?.msgType ?? 2;
    const body: Record<string, unknown> = { msg_type: msgType };

    if (msgType === 2) {
      body.markdown = { content };
    } else if (msgType === 0) {
      body.content = content;
    } else if (msgType === 7 && opts?.media) {
      body.media = opts.media;
    }

    if (opts?.msgId) {
      body.msg_id = opts.msgId;
    } else {
      body.msg_seq = opts?.msgSeq ?? this.nextMsgSeq(openid);
    }

    if (opts?.keyboard) {
      body.keyboard = opts.keyboard;
    }

    await this._post(`/v2/users/${openid}/messages`, body, token);
  }

  // -------------------------------------------------------------------------
  // Core send: Group (群聊)
  // -------------------------------------------------------------------------
  async sendGroupMessage(
    groupOpenid: string,
    content: string,
    opts?: SendMessageOptions,
  ): Promise<void> {
    const token = await this.getToken();
    const msgType = opts?.msgType ?? 2;
    const body: Record<string, unknown> = { msg_type: msgType };

    if (msgType === 2) {
      body.markdown = { content };
    } else if (msgType === 0) {
      body.content = content;
    } else if (msgType === 7 && opts?.media) {
      body.media = opts.media;
    }

    if (opts?.msgId) {
      body.msg_id = opts.msgId;
    } else {
      body.msg_seq = opts?.msgSeq ?? this.nextMsgSeq(groupOpenid);
    }

    if (opts?.keyboard) {
      body.keyboard = opts.keyboard;
    }

    await this._post(`/v2/groups/${groupOpenid}/messages`, body, token);
  }

  // -------------------------------------------------------------------------
  // Convenience: reply (passive) — auto detects window expiry
  // -------------------------------------------------------------------------
  async sendReply(
    target: { type: "c2c"; openid: string } | { type: "group"; groupOpenid: string },
    content: string,
    msgId: string,
    keyboard?: InlineKeyboard,
  ): Promise<void> {
    if (target.type === "c2c") {
      await this.sendC2CMessage(target.openid, content, { msgId, keyboard });
    } else {
      await this.sendGroupMessage(target.groupOpenid, content, { msgId, keyboard });
    }
  }

  // -------------------------------------------------------------------------
  // Convenience: active message (no msg_id needed)
  // -------------------------------------------------------------------------
  async sendActive(
    target: { type: "c2c"; openid: string } | { type: "group"; groupOpenid: string },
    content: string,
    keyboard?: InlineKeyboard,
  ): Promise<void> {
    if (target.type === "c2c") {
      await this.sendC2CMessage(target.openid, content, { keyboard });
    } else {
      await this.sendGroupMessage(target.groupOpenid, content, { keyboard });
    }
  }

  // -------------------------------------------------------------------------
  // Typing indicator (msg_type=6, with debounce)
  // -------------------------------------------------------------------------
  async sendTyping(openid: string): Promise<void> {
    const now = Date.now();
    const last = this._lastTypingAt.get(openid) ?? 0;
    if (now - last < QQBotApi.TYPING_DEBOUNCE_MS) return;
    this._lastTypingAt.set(openid, now);

    const token = await this.getToken();
    // QQ typing indicator uses msg_type=6 (undocumented but used)
    await this._post(`/v2/users/${openid}/messages`, {
      msg_type: 6,
      msg_seq: this.nextMsgSeq(openid),
    }, token).catch(() => { /* typing failure is non-critical */ });
  }

  // -------------------------------------------------------------------------
  // Image upload + send (C2C)
  // -------------------------------------------------------------------------
  async sendC2CImage(
    openid: string,
    imageBase64: string,
    msgId?: string,
  ): Promise<void> {
    const token = await this.getToken();

    // Step 1: Upload
    const uploadRes = await this._postRaw(
      `/v2/users/${openid}/files`,
      { file_type: 1, srv_send_msg: false, file_data: imageBase64 },
      token,
    );
    const uploadData = (await uploadRes.json()) as { file_info?: string };
    if (!uploadData.file_info) throw new Error("Image upload: no file_info");

    // Step 2: Send
    const opts: SendMessageOptions = {
      msgType: 7,
      media: { file_info: uploadData.file_info },
    };
    if (msgId) opts.msgId = msgId;
    await this.sendC2CMessage(openid, "", opts);
  }

  // -------------------------------------------------------------------------
  // Image upload + send (Group)
  // -------------------------------------------------------------------------
  async sendGroupImage(
    groupOpenid: string,
    imageBase64: string,
    msgId?: string,
  ): Promise<void> {
    const token = await this.getToken();

    const uploadRes = await this._postRaw(
      `/v2/groups/${groupOpenid}/files`,
      { file_type: 1, srv_send_msg: false, file_data: imageBase64 },
      token,
    );
    const uploadData = (await uploadRes.json()) as { file_info?: string };
    if (!uploadData.file_info) throw new Error("Group image upload: no file_info");

    await this.sendGroupMessage(groupOpenid, "", {
      msgType: 7,
      media: { file_info: uploadData.file_info },
      ...(msgId ? { msgId } : {}),
    });
  }

  // -------------------------------------------------------------------------
  // INTERACTION_CREATE ACK
  // -------------------------------------------------------------------------
  async acknowledgeInteraction(interactionId: string): Promise<void> {
    const token = await this.getToken();
    const url = `https://api.sgroup.qq.com/interactions/${interactionId}`;
    await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `QQBot ${token}`,
      },
      body: JSON.stringify({ code: 0 }),
    });
  }

  // -------------------------------------------------------------------------
  // Long message chunking
  // -------------------------------------------------------------------------
  static readonly MAX_MESSAGE_LENGTH = 3500;

  splitMessage(content: string): string[] {
    if (content.length <= QQBotApi.MAX_MESSAGE_LENGTH) return [content];
    const chunks: string[] = [];
    let remaining = content;
    while (remaining.length > 0) {
      if (remaining.length <= QQBotApi.MAX_MESSAGE_LENGTH) {
        chunks.push(remaining);
        break;
      }
      // Try to split at newline
      let splitIdx = remaining.lastIndexOf("\n", QQBotApi.MAX_MESSAGE_LENGTH);
      if (splitIdx < QQBotApi.MAX_MESSAGE_LENGTH * 0.5) {
        // No good newline split point, force split
        splitIdx = QQBotApi.MAX_MESSAGE_LENGTH;
      }
      chunks.push(remaining.slice(0, splitIdx));
      remaining = remaining.slice(splitIdx).replace(/^\n/, "");
    }
    return chunks;
  }

  /**
   * Send a potentially long message, auto-splitting into chunks.
   * First chunk uses passive reply (msgId); subsequent chunks use active msg.
   */
  async sendLongMessage(
    target: { type: "c2c"; openid: string } | { type: "group"; groupOpenid: string },
    content: string,
    msgId?: string,
    keyboard?: InlineKeyboard,
  ): Promise<void> {
    const chunks = this.splitMessage(content);
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      const kb = isLast ? keyboard : undefined; // keyboard only on last chunk
      if (i === 0 && msgId) {
        await this.sendReply(target, chunks[i], msgId, kb);
      } else {
        await this.sendActive(target, chunks[i], kb);
      }
      // Small delay between chunks to avoid rate limiting
      if (i < chunks.length - 1) {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------
  private async _post(
    path: string,
    body: Record<string, unknown>,
    token: string,
    retries = 3,
  ): Promise<void> {
    const res = await this._postRaw(path, body, token);
    if (res.ok) return;

    const errText = await res.text().catch(() => "");

    // Retry on 5xx or 429
    if (retries > 0 && (res.status >= 500 || res.status === 429)) {
      const delay = res.status === 429 ? 2000 : 1000;
      await new Promise((r) => setTimeout(r, delay));
      return this._post(path, body, token, retries - 1);
    }

    // Token expired — invalidate and retry once
    if (res.status === 401 && retries > 0) {
      this.invalidateToken();
      const newToken = await this.getToken();
      return this._post(path, body, newToken, 0);
    }

    throw new Error(`QQBot API ${path} failed: ${res.status} ${errText}`);
  }

  private async _postRaw(
    path: string,
    body: Record<string, unknown>,
    token: string,
  ): Promise<Response> {
    return fetch(`https://api.sgroup.qq.com${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `QQBot ${token}`,
      },
      body: JSON.stringify(body),
    });
  }
}

// ---------------------------------------------------------------------------
// Keyboard builder helpers
// ---------------------------------------------------------------------------
export function buildKeyboardButton(
  id: string,
  label: string,
  data: string,
  opts?: {
    visitedLabel?: string;
    style?: 0 | 1;
    clickLimit?: number;
    groupId?: string;
  },
): InlineKeyboardButton {
  return {
    id,
    render_data: {
      label,
      visited_label: opts?.visitedLabel ?? label,
      style: opts?.style ?? 1,
    },
    action: {
      type: 1, // callback
      data,
      permission: { type: 2 }, // everyone
      click_limit: opts?.clickLimit ?? 1,
    },
    group_id: opts?.groupId,
  };
}

export function buildApprovalKeyboard(sessionKey: string): InlineKeyboard {
  return {
    content: {
      rows: [
        {
          buttons: [
            buildKeyboardButton(
              "allow-once",
              "✅ 允许一次",
              `approve:${sessionKey}:allow-once`,
              { visitedLabel: "已允许", style: 1, groupId: "approval" },
            ),
            buildKeyboardButton(
              "allow-always",
              "⭐ 始终允许",
              `approve:${sessionKey}:allow-always`,
              { visitedLabel: "已允许", style: 1, groupId: "approval" },
            ),
            buildKeyboardButton(
              "deny",
              "❌ 拒绝",
              `approve:${sessionKey}:deny`,
              { visitedLabel: "已拒绝", style: 0, groupId: "approval" },
            ),
          ],
        },
      ],
    },
  };
}

export function buildConfirmKeyboard(actionKey: string): InlineKeyboard {
  return {
    content: {
      rows: [
        {
          buttons: [
            buildKeyboardButton(
              "confirm",
              "✓ 确认",
              `confirm:${actionKey}:yes`,
              { visitedLabel: "已确认", style: 1, groupId: "confirm" },
            ),
            buildKeyboardButton(
              "cancel",
              "✗ 取消",
              `confirm:${actionKey}:no`,
              { visitedLabel: "已取消", style: 0, groupId: "confirm" },
            ),
          ],
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Interaction event parser
// ---------------------------------------------------------------------------
export interface InteractionEvent {
  interactionId: string;
  buttonData: string;
  buttonId: string;
  chatType: "c2c" | "group" | "guild";
  userOpenid: string;
  groupOpenid?: string;
  timestamp: string;
}

export function parseInteractionEvent(d: Record<string, unknown>): InteractionEvent | null {
  try {
    const id = d.id as string;
    const data = d.data as { resolved?: { button_data?: string; button_id?: string } };
    const chatType = (d.chat_type as number) === 2 ? "group" : "c2c";
    const userOpenid =
      (d.user_openid as string) ??
      ((d.data as Record<string, unknown>)?.user_openid as string) ??
      "";
    const groupOpenid = (d.group_openid as string) ?? undefined;
    const timestamp = (d.timestamp as string) ?? "";

    return {
      interactionId: id,
      buttonData: data?.resolved?.button_data ?? "",
      buttonId: data?.resolved?.button_id ?? "",
      chatType: chatType as "c2c" | "group" | "guild",
      userOpenid,
      groupOpenid,
      timestamp,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Legacy compatibility exports (used by existing code)
// ---------------------------------------------------------------------------
export async function getAccessToken(
  appId: string,
  clientSecret: string,
): Promise<string> {
  // For backward compat — creates a temporary instance
  // Prefer using QQBotApi instance directly for production
  const api = new QQBotApi({ appId, clientSecret });
  return api.getToken();
}

export async function sendC2CReply(
  appId: string,
  clientSecret: string,
  openid: string,
  content: string,
  msgId: string,
): Promise<void> {
  const api = new QQBotApi({ appId, clientSecret });
  await api.sendC2CMessage(openid, content, { msgId });
}

export async function sendC2CActive(
  appId: string,
  clientSecret: string,
  openid: string,
  content: string,
): Promise<void> {
  const api = new QQBotApi({ appId, clientSecret });
  await api.sendC2CMessage(openid, content);
}

export async function sendC2CImageReply(
  appId: string,
  clientSecret: string,
  openid: string,
  msgId: string,
  imageBase64: string,
): Promise<void> {
  const api = new QQBotApi({ appId, clientSecret });
  await api.sendC2CImage(openid, imageBase64, msgId);
}
