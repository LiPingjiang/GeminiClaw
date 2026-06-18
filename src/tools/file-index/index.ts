/**
 * FileIndex — 纯 TypeScript 模糊文件搜索索引
 *
 * 借鉴 Claude Code 的 FileIndex 设计：
 * 1. 字符位图预过滤（26 字母位图，O(1) 拒绝不匹配路径）
 * 2. fzf-style 评分（词边界加分、camelCase 加分、连续匹配加分、间隔惩罚）
 * 3. Top-k 优化（维护 limit 个最佳匹配，避免全排序）
 * 4. 异步分块构建（每 4ms 让出事件循环）
 */

export interface SearchResult {
  path: string
  score: number
  positions: number[]
}

const SCORE_MATCH = 16
const BONUS_BOUNDARY = 8
const BONUS_CAMEL = 6
const BONUS_CONSECUTIVE = 4
const PENALTY_GAP_START = 3
const PENALTY_GAP_EXTENSION = 1

function isLower(code: number): boolean {
  return code >= 97 && code <= 122
}
function isUpper(code: number): boolean {
  return code >= 65 && code <= 90
}
function isAlpha(code: number): boolean {
  return isLower(code) || isUpper(code)
}
function toLower(code: number): number {
  return isUpper(code) ? code + 32 : code
}

/** 计算字符的位图掩码（a=1<<0, b=1<<1, ... z=1<<25） */
function charMask(code: number): number {
  const lo = toLower(code)
  if (lo >= 97 && lo <= 122) return 1 << (lo - 97)
  return 0
}

/** 判断某位置是否是词边界（path separator 或 camelCase 边界） */
function isBoundary(path: string, idx: number): boolean {
  if (idx === 0) return true
  const prev = path.charCodeAt(idx - 1)
  const curr = path.charCodeAt(idx)
  // 分隔符边界 / _ - . 
  if (prev === 47 || prev === 95 || prev === 45 || prev === 46) return true
  // camelCase 边界：小写后大写
  if (isLower(prev) && isUpper(curr)) return true
  return false
}

/** fzf-style 评分 */
function scoreMatch(path: string, positions: number[]): number {
  let score = 0
  let prevPos = -2
  for (const pos of positions) {
    score += SCORE_MATCH
    if (isBoundary(path, pos)) score += BONUS_BOUNDARY
    else if (pos > 0 && isUpper(path.charCodeAt(pos)) && isLower(path.charCodeAt(pos - 1))) {
      score += BONUS_CAMEL
    }
    if (pos === prevPos + 1) score += BONUS_CONSECUTIVE
    else if (prevPos >= 0) {
      const gap = pos - prevPos - 1
      score -= PENALTY_GAP_START + gap * PENALTY_GAP_EXTENSION
    }
    prevPos = pos
  }
  return score
}

/** Fuzzy indexOf scan：找到 query 中每个字符在 path 中的匹配位置 */
function fuzzyIndexOf(path: string, query: string): number[] | null {
  const positions: number[] = []
  let pathIdx = 0
  for (let qIdx = 0; qIdx < query.length; qIdx++) {
    const qCode = query.charCodeAt(qIdx)
    let found = false
    while (pathIdx < path.length) {
      if (toLower(path.charCodeAt(pathIdx)) === toLower(qCode)) {
        positions.push(pathIdx)
        pathIdx++
        found = true
        break
      }
      pathIdx++
    }
    if (!found) return null
  }
  return positions
}

export class FileIndex {
  private paths: string[] = []
  private lowerPaths: string[] = []
  private charBits: Int32Array = new Int32Array(0)
  private pathLens: Uint16Array = new Uint16Array(0)
  private topLevelCache: SearchResult[] | null = null
  private readyCount = 0

  /** 从文件列表构建索引 */
  loadFromFileList(fileList: string[]): void {
    const seen = new Set<string>()
    const paths: string[] = []
    for (const line of fileList) {
      if (line.length > 0 && !seen.has(line)) {
        seen.add(line)
        paths.push(line)
      }
    }
    this.buildIndex(paths)
  }

  /** 异步分块构建，避免阻塞事件循环 */
  async loadFromFileListAsync(fileList: string[], chunkSize = 1000): Promise<void> {
    const seen = new Set<string>()
    const paths: string[] = []
    for (const line of fileList) {
      if (line.length > 0 && !seen.has(line)) {
        seen.add(line)
        paths.push(line)
      }
    }
    await this.buildIndexAsync(paths, chunkSize)
  }

  private buildIndex(paths: string[]): void {
    this.paths = paths
    this.lowerPaths = paths.map(p => p.toLowerCase())
    this.pathLens = new Uint16Array(paths.map(p => p.length))
    this.charBits = new Int32Array(paths.length)

    for (let i = 0; i < paths.length; i++) {
      let bits = 0
      const p = paths[i]
      for (let j = 0; j < p.length; j++) {
        bits |= charMask(p.charCodeAt(j))
      }
      this.charBits[i] = bits
    }

    this.readyCount = paths.length
  }

  private async buildIndexAsync(paths: string[], chunkSize: number): Promise<void> {
    this.paths = paths
    this.lowerPaths = paths.map(p => p.toLowerCase())
    this.pathLens = new Uint16Array(paths.map(p => p.length))
    this.charBits = new Int32Array(paths.length)

    for (let i = 0; i < paths.length; i += chunkSize) {
      const end = Math.min(i + chunkSize, paths.length)
      for (let j = i; j < end; j++) {
        let bits = 0
        const p = paths[j]
        for (let k = 0; k < p.length; k++) {
          bits |= charMask(p.charCodeAt(k))
        }
        this.charBits[j] = bits
      }
      // 让出事件循环
      await new Promise(resolve => setTimeout(resolve, 0))
    }

    this.readyCount = paths.length
  }

  /** 搜索：位图预过滤 + fzf 评分 + top-k */
  search(query: string, limit = 20): SearchResult[] {
    if (!query || this.readyCount === 0) return []

    const qLower = query.toLowerCase()
    let needleBitmap = 0
    for (let i = 0; i < qLower.length; i++) {
      needleBitmap |= charMask(qLower.charCodeAt(i))
    }

    // 预过滤：路径必须包含 query 中每个字母的至少一个
    const candidates: SearchResult[] = []

    for (let i = 0; i < this.paths.length; i++) {
      // 位图快速拒绝：如果 path 不包含 query 的任意一个字母，直接跳过
      if ((this.charBits[i] & needleBitmap) !== needleBitmap) continue

      const path = this.paths[i]
      const positions = fuzzyIndexOf(path, qLower)
      if (!positions) continue

      const score = scoreMatch(path, positions)

      // Top-k 维护：保持 candidates 按 score 降序，只保留 limit 个
      if (candidates.length < limit) {
        candidates.push({ path, score, positions })
        // 插入后简单排序（limit 很小，O(limit log limit) 可接受）
        candidates.sort((a, b) => b.score - a.score)
      } else if (score > candidates[candidates.length - 1].score) {
        candidates[candidates.length - 1] = { path, score, positions }
        candidates.sort((a, b) => b.score - a.score)
      }
    }

    return candidates
  }

  get size(): number {
    return this.readyCount
  }

  get isReady(): boolean {
    return this.readyCount > 0
  }
}

/** 全局单例 */
let globalIndex: FileIndex | null = null

export function getFileIndex(): FileIndex {
  if (!globalIndex) {
    globalIndex = new FileIndex()
  }
  return globalIndex
}

export function resetFileIndex(): void {
  globalIndex = null
}
