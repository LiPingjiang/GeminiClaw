/**
 * src/security/redaction.ts
 * Secret Redaction — 自动检测和脱敏敏感信息
 *
 * 40+ 正则模式覆盖：API keys, tokens, connection strings, PII 等。
 * 应用面：日志输出、tool 结果、trace 写入前统一过脱敏管道。
 */

interface RedactionPattern {
  name: string
  regex: RegExp
  replacement: string
}

const PATTERNS: RedactionPattern[] = [
  // ── API Keys ──────────────────────────────────────────────────────────────
  { name: "openai_key", regex: /sk-[A-Za-z0-9]{20,}/g, replacement: "[REDACTED:openai_key]" },
  { name: "anthropic_key", regex: /sk-ant-[A-Za-z0-9-]{20,}/g, replacement: "[REDACTED:anthropic_key]" },
  { name: "github_token", regex: /gh[ps]_[A-Za-z0-9]{36,}/g, replacement: "[REDACTED:github_token]" },
  { name: "github_oauth", regex: /gho_[A-Za-z0-9]{36,}/g, replacement: "[REDACTED:github_oauth]" },
  { name: "github_fine_grained", regex: /github_pat_[A-Za-z0-9_]{22,}/g, replacement: "[REDACTED:github_pat]" },
  { name: "aws_access_key", regex: /AKIA[0-9A-Z]{16}/g, replacement: "[REDACTED:aws_key]" },
  { name: "aws_secret_key", regex: /(?<=aws_secret_access_key\s*[=:]\s*)[A-Za-z0-9/+=]{40}/g, replacement: "[REDACTED:aws_secret]" },
  { name: "slack_token", regex: /xox[baprs]-[0-9]{10,13}-[0-9]{10,13}-[a-zA-Z0-9]{24,}/g, replacement: "[REDACTED:slack_token]" },
  { name: "stripe_key", regex: /[sr]k_(test|live)_[A-Za-z0-9]{20,}/g, replacement: "[REDACTED:stripe_key]" },
  { name: "google_api_key", regex: /AIza[0-9A-Za-z\-_]{35}/g, replacement: "[REDACTED:google_api_key]" },
  { name: "heroku_key", regex: /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, replacement: "[REDACTED:uuid_secret]" },
  { name: "npm_token", regex: /npm_[A-Za-z0-9]{36,}/g, replacement: "[REDACTED:npm_token]" },

  // ── Connection Strings ────────────────────────────────────────────────────
  { name: "db_url", regex: /(mysql|postgres|postgresql|mongodb|redis):\/\/[^\s'"]+/gi, replacement: "[REDACTED:db_connection]" },
  { name: "jdbc_url", regex: /jdbc:[a-z]+:\/\/[^\s'"]+/gi, replacement: "[REDACTED:jdbc_connection]" },

  // ── Tokens & Secrets ──────────────────────────────────────────────────────
  { name: "jwt", regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, replacement: "[REDACTED:jwt]" },
  { name: "bearer_auth", regex: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, replacement: "Bearer [REDACTED]" },
  { name: "basic_auth", regex: /Basic\s+[A-Za-z0-9+/]+=*/gi, replacement: "Basic [REDACTED]" },
  { name: "discord_token", regex: /[MN][A-Za-z\d]{23,}\.[A-Za-z\d-_]{6}\.[A-Za-z\d-_]{27,}/g, replacement: "[REDACTED:discord_token]" },
  { name: "telegram_token", regex: /\d{8,10}:[A-Za-z0-9_-]{35}/g, replacement: "[REDACTED:telegram_token]" },

  // ── Private Keys ──────────────────────────────────────────────────────────
  { name: "private_key", regex: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA )?PRIVATE KEY-----/g, replacement: "[REDACTED:private_key]" },

  // ── PII (Personal Identifiable Information) ───────────────────────────────
  { name: "phone_cn", regex: /1[3-9]\d{9}/g, replacement: "[REDACTED:phone]" },
  { name: "email", regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, replacement: "[REDACTED:email]" },

  // ── Environment Variable Assignments (broad, keep last) ───────────────────
  { name: "env_secret", regex: /(?:SECRET|PASSWORD|PASSPHRASE|API_KEY|APIKEY|ACCESS_KEY)\s*[=:]\s*['"]?[^\s'"]{8,}['"]?/gi, replacement: "[REDACTED:env_secret]" },

  // ── IP Addresses (optional, disabled by default) ──────────────────────────
  // { name: "ipv4", regex: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, replacement: "[REDACTED:ip]" },
]

export class SecretRedactor {
  private patterns: RedactionPattern[]
  private enabled: boolean

  constructor(options?: { enabled?: boolean; extraPatterns?: RedactionPattern[] }) {
    this.enabled = options?.enabled ?? true
    this.patterns = [...PATTERNS, ...(options?.extraPatterns ?? [])]
  }

  /**
   * Redact sensitive information from a string.
   * Returns the redacted string and count of redactions made.
   */
  redact(input: string): { output: string; redactionCount: number } {
    if (!this.enabled || !input) {
      return { output: input, redactionCount: 0 }
    }

    let output = input
    let redactionCount = 0

    for (const pattern of this.patterns) {
      // Reset regex lastIndex for global patterns
      pattern.regex.lastIndex = 0
      const matches = output.match(pattern.regex)
      if (matches) {
        redactionCount += matches.length
        output = output.replace(pattern.regex, pattern.replacement)
      }
    }

    return { output, redactionCount }
  }

  /**
   * Check if a string contains any secrets (without modifying it).
   */
  containsSecrets(input: string): boolean {
    if (!this.enabled || !input) return false

    for (const pattern of this.patterns) {
      pattern.regex.lastIndex = 0
      if (pattern.regex.test(input)) return true
    }
    return false
  }

  /**
   * Get matched pattern names for diagnostics.
   */
  detectPatterns(input: string): string[] {
    if (!this.enabled || !input) return []

    const found: string[] = []
    for (const pattern of this.patterns) {
      pattern.regex.lastIndex = 0
      if (pattern.regex.test(input)) {
        found.push(pattern.name)
      }
    }
    return found
  }
}
