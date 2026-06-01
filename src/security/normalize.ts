/**
 * src/security/normalize.ts
 * Unicode NFKC 归一化 + ANSI escape 序列 strip
 *
 * 防止全角字符 / 零宽字符 / ANSI escape 绕过命令检测。
 */

/**
 * Strip ANSI escape sequences (colors, cursor movement, etc.)
 */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
}

/**
 * Remove zero-width characters that could hide malicious content.
 */
function stripZeroWidth(str: string): string {
  // Zero-width space, zero-width non-joiner, zero-width joiner,
  // left-to-right/right-to-left marks, soft hyphen, word joiner
  return str.replace(/[\u200B-\u200F\u2028-\u202F\u2060\uFEFF\u00AD]/g, "")
}

/**
 * Normalize a command string for security detection.
 * Applies:
 *  1. Unicode NFKC normalization (converts fullwidth to ASCII, etc.)
 *  2. ANSI escape strip
 *  3. Zero-width character removal
 *  4. Whitespace normalization (collapse multiple spaces)
 */
export function normalizeForDetection(input: string): string {
  let result = input

  // 1. Unicode NFKC: fullwidth 'ｒｍ' → 'rm', etc.
  result = result.normalize("NFKC")

  // 2. Strip ANSI escape sequences
  result = stripAnsi(result)

  // 3. Strip zero-width characters
  result = stripZeroWidth(result)

  // 4. Collapse whitespace
  result = result.replace(/\s+/g, " ").trim()

  return result
}
