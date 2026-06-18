/**
 * LSP Client — 通过 stdio 连接本地语言服务器
 *
 * 支持核心操作：
 * - textDocument/definition    跳转到定义
 * - textDocument/references    查找引用
 * - workspace/symbol           全局符号搜索
 * - textDocument/documentSymbol 文件内符号
 * - textDocument/prepareCallHierarchy + callHierarchy/incomingCalls / outgoingCalls
 *
 * 使用 JSON-RPC 2.0 over stdio。
 */

import { spawn, ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";

// ── JSON-RPC 类型 ──────────────────────────────────────────────────────────

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface LspLocation {
  uri: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

interface LspSymbol {
  name: string;
  kind: number;
  location: LspLocation;
  containerName?: string;
}

interface LspDocumentSymbol {
  name: string;
  kind: number;
  range: LspLocation["range"];
  selectionRange: LspLocation["range"];
  children?: LspDocumentSymbol[];
}

interface LspCallHierarchyItem {
  name: string;
  kind: number;
  uri: string;
  range: LspLocation["range"];
  selectionRange: LspLocation["range"];
}

// ── LSP 客户端 ──────────────────────────────────────────────────────────────

export class LspClient {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<
    number | string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private buffer = "";
  private initialized = false;
  private capabilities: unknown = null;
  private _serverName = "";
  private _isReady = false;

  get isReady(): boolean {
    return this._isReady;
  }
  get serverName(): string {
    return this._serverName;
  }

  async start(
    command: string,
    args: string[] = [],
    rootPath: string = process.cwd(),
  ): Promise<void> {
    if (this.proc) {
      throw new Error("LSP client already started");
    }

    this.proc = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: rootPath,
      env: { ...process.env, NODE_OPTIONS: "" }, // 避免调试器干扰
    });

    this.proc.stdout!.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf-8");
      this.parseMessages();
    });

    this.proc.stderr!.on("data", (chunk: Buffer) => {
      // 忽略 stderr 日志，除非需要调试
    });

    this.proc.on("close", (code) => {
      this._isReady = false;
      // 拒绝所有 pending 请求
      for (const [, req] of this.pending) {
        clearTimeout(req.timer);
        req.reject(new Error(`LSP server exited with code ${code}`));
      }
      this.pending.clear();
    });

    // 发送 initialize
    const initResult = (await this.request("initialize", {
      processId: process.pid,
      rootUri: `file://${rootPath}`,
      capabilities: {
        textDocument: {
          definition: { dynamicRegistration: false, linkSupport: true },
          references: { dynamicRegistration: false },
          documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
          prepareCallHierarchy: { dynamicRegistration: false },
        },
        workspace: {
          symbol: { dynamicRegistration: false },
        },
      },
      workspaceFolders: [
        { uri: `file://${rootPath}`, name: rootPath.split("/").pop() || "" },
      ],
    })) as {
      capabilities: unknown;
      serverInfo?: { name: string; version?: string };
    };

    this.capabilities = initResult.capabilities;
    this._serverName = initResult.serverInfo?.name || command;

    // 发送 initialized 通知
    this.notify("initialized", {});
    this._isReady = true;
  }

  stop(): void {
    if (!this.proc) return;
    this.notify("shutdown", {});
    this.notify("exit", {});
    this.proc.kill("SIGTERM");
    setTimeout(() => {
      if (this.proc && !this.proc.killed) this.proc.kill("SIGKILL");
    }, 2000);
    this.proc = null;
    this._isReady = false;
  }

  // ── 核心 API ────────────────────────────────────────────────────────────

  async gotoDefinition(
    filePath: string,
    line: number,
    character: number,
  ): Promise<LspLocation[] | null> {
    const result = await this.request("textDocument/definition", {
      textDocument: { uri: `file://${filePath}` },
      position: { line, character },
    });
    if (!result) return null;
    if (Array.isArray(result)) return result as LspLocation[];
    return [result as LspLocation];
  }

  async findReferences(
    filePath: string,
    line: number,
    character: number,
  ): Promise<LspLocation[]> {
    const result = (await this.request("textDocument/references", {
      textDocument: { uri: `file://${filePath}` },
      position: { line, character },
      context: { includeDeclaration: true },
    })) as LspLocation[] | null;
    return result || [];
  }

  async workspaceSymbol(query: string): Promise<LspSymbol[]> {
    const result = (await this.request("workspace/symbol", {
      query,
    })) as LspSymbol[] | null;
    return result || [];
  }

  async documentSymbols(filePath: string): Promise<LspDocumentSymbol[]> {
    const result = (await this.request("textDocument/documentSymbol", {
      textDocument: { uri: `file://${filePath}` },
    })) as LspDocumentSymbol[] | null;
    return result || [];
  }

  async prepareCallHierarchy(
    filePath: string,
    line: number,
    character: number,
  ): Promise<LspCallHierarchyItem[]> {
    const result = (await this.request("textDocument/prepareCallHierarchy", {
      textDocument: { uri: `file://${filePath}` },
      position: { line, character },
    })) as LspCallHierarchyItem[] | null;
    return result || [];
  }

  async incomingCalls(item: LspCallHierarchyItem): Promise<LspCallHierarchyItem[]> {
    const result = (await this.request("callHierarchy/incomingCalls", {
      item,
    })) as Array<{ from: LspCallHierarchyItem }> | null;
    return result?.map((r) => r.from) || [];
  }

  async outgoingCalls(item: LspCallHierarchyItem): Promise<LspCallHierarchyItem[]> {
    const result = (await this.request("callHierarchy/outgoingCalls", {
      item,
    })) as Array<{ to: LspCallHierarchyItem }> | null;
    return result?.map((r) => r.to) || [];
  }

  // ── 内部 JSON-RPC ───────────────────────────────────────────────────────

  private request(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.proc || !this.proc.stdin) {
        reject(new Error("LSP server not running"));
        return;
      }
      const id = this.nextId++;
      const msg: JsonRpcMessage = {
        jsonrpc: "2.0",
        id,
        method,
        params,
      };
      const body = JSON.stringify(msg);
      const header = `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request timeout: ${method}`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(header + body);
    });
  }

  private notify(method: string, params: unknown): void {
    if (!this.proc || !this.proc.stdin) return;
    const msg: JsonRpcMessage = {
      jsonrpc: "2.0",
      method,
      params,
    };
    const body = JSON.stringify(msg);
    const header = `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n`;
    this.proc.stdin.write(header + body);
  }

  private parseMessages(): void {
    while (true) {
      // 查找 Content-Length 头
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;
      const header = this.buffer.slice(0, headerEnd);
      const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
      if (!lengthMatch) {
        // 损坏的消息，跳过这行
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const contentLength = parseInt(lengthMatch[1], 10);
      const messageStart = headerEnd + 4;
      if (this.buffer.length < messageStart + contentLength) break;
      const body = this.buffer.slice(messageStart, messageStart + contentLength);
      this.buffer = this.buffer.slice(messageStart + contentLength);
      try {
        const msg = JSON.parse(body) as JsonRpcMessage;
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const req = this.pending.get(msg.id)!;
          clearTimeout(req.timer);
          this.pending.delete(msg.id);
          if (msg.error) {
            req.reject(new Error(msg.error.message));
          } else {
            req.resolve(msg.result);
          }
        }
      } catch {
        // 忽略解析错误
      }
    }
  }
}

// ── 自动检测语言服务器 ──────────────────────────────────────────────────────

export interface DetectedServer {
  command: string;
  args: string[];
  name: string;
}

export function detectLanguageServer(rootPath: string): DetectedServer | null {
  // TypeScript
  if (existsSync(`${rootPath}/tsconfig.json`) || existsSync(`${rootPath}/package.json`)) {
    const tsServer = [
      `${rootPath}/node_modules/.bin/typescript-language-server`,
      `${rootPath}/node_modules/.bin/tsserver`,
    ].find(existsSync);
    if (tsServer) {
      return {
        command: tsServer,
        args: ["--stdio"],
        name: "typescript-language-server",
      };
    }
  }
  // Python
  if (existsSync(`${rootPath}/pyproject.toml`) || existsSync(`${rootPath}/setup.py`)) {
    const pylsp = [
      `${rootPath}/.venv/bin/pylsp`,
      `${rootPath}/venv/bin/pylsp`,
      `${rootPath}/.venv/bin/python-lsp-server`,
    ].find(existsSync);
    if (pylsp) {
      return { command: pylsp, args: [], name: "python-lsp-server" };
    }
  }
  // Go
  if (existsSync(`${rootPath}/go.mod`)) {
    const gopls = "/Users/lipingjiang/go/bin/gopls";
    if (existsSync(gopls)) {
      return { command: gopls, args: ["serve", "-rpc.trace"], name: "gopls" };
    }
  }
  // Rust
  if (existsSync(`${rootPath}/Cargo.toml`)) {
    const rustAnalyzer = "/Users/lipingjiang/.cargo/bin/rust-analyzer";
    if (existsSync(rustAnalyzer)) {
      return { command: rustAnalyzer, args: [], name: "rust-analyzer" };
    }
  }
  return null;
}

// ── 全局单例 ────────────────────────────────────────────────────────────────

let globalClient: LspClient | null = null;

export async function getOrStartLspClient(rootPath: string): Promise<LspClient | null> {
  if (globalClient?.isReady) return globalClient;
  const detected = detectLanguageServer(rootPath);
  if (!detected) return null;
  globalClient = new LspClient();
  try {
    await globalClient.start(detected.command, detected.args, rootPath);
    return globalClient;
  } catch (err) {
    globalClient.stop();
    globalClient = null;
    return null;
  }
}

export function getLspClient(): LspClient | null {
  return globalClient?.isReady ? globalClient : null;
}

export function stopLspClient(): void {
  globalClient?.stop();
  globalClient = null;
}
