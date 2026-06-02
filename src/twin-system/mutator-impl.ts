/**
 * MutatorImpl — Fully typed implementation of the Mutator interface.
 *
 * Ports the agentic loop from src/evolution/mutator/mutator.ts:
 *   1. Read target files
 *   2. Prompt LLM for unified diff + confidence
 *   3. Parse & apply diff (positional → linear scan → fuzzy)
 *   4. Run tsc --noEmit
 *   5. On error, feed back to LLM (up to maxRounds)
 *   6. On success, git commit
 *
 * All external side-effects are injected via interfaces for testability.
 */

import type { EvolutionIntent } from "./types.js"
import type { MutationResult, Mutator } from "./evolution-pipeline.js"

// ── Dependency Interfaces ────────────────────────────────────────────────────

export interface FileSystem {
  exists(path: string): boolean
  read(path: string): string
  write(path: string, content: string): void
}

export interface TypeChecker {
  check(cwd: string): TypeCheckResult
}

export interface TypeCheckResult {
  success: boolean
  output: string
}

export interface GitOps {
  add(cwd: string, files: string[]): void
  commit(cwd: string, message: string): GitCommitResult
}

export interface GitCommitResult {
  success: boolean
  error?: string
}

export interface LlmClient {
  chat(messages: LlmMessage[]): Promise<string>
}

export interface LlmMessage {
  role: "user" | "assistant" | "system"
  content: string
}

export interface MutatorConfig {
  maxRounds: number
  confidenceThreshold: number
  repoRoot: string
}

export interface MutatorLogger {
  info(msg: string, ...args: unknown[]): void
  warn(msg: string, ...args: unknown[]): void
  error(msg: string, ...args: unknown[]): void
}

// ── Diff Types ───────────────────────────────────────────────────────────────

export interface FileDiff {
  oldPath: string
  newPath: string
  hunks: Hunk[]
}

export interface Hunk {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: string[]
}

export interface Confidence {
  score: number
  reason: string
  uncertainties: string[]
}

// ── Fuzzy Edit Interface ─────────────────────────────────────────────────────

export interface FuzzyMatcher {
  findAndReplace(
    content: string,
    oldStr: string,
    newStr: string,
  ): { success: boolean; result: string }
}

// ── Prompt Template ──────────────────────────────────────────────────────────

const CONFIDENCE_PROMPT_SUFFIX = `

After the diff, output a JSON block with your confidence self-assessment:
\`\`\`json
{
  "score": 0.85,
  "reason": "The change is straightforward and well-scoped",
  "uncertainties": ["edge case X might need attention"]
}
\`\`\`

The diff should be in standard unified diff format:
\`\`\`diff
--- a/src/example.ts
+++ b/src/example.ts
@@ -1,5 +1,5 @@
 context line
-old line
+new line
 context line
\`\`\`
`

// ── Pure Utility Functions (exported for unit testing) ────────────────────────

/**
 * Parse a unified diff string into structured FileDiff objects.
 * Handles standard `--- a/file` / `+++ b/file` headers.
 */
export function parseUnifiedDiff(diffText: string): FileDiff[] {
  const files: FileDiff[] = []
  const lines = diffText.split("\n")
  let i = 0

  while (i < lines.length) {
    if (!lines[i].startsWith("--- ")) {
      i++
      continue
    }

    const oldHeader = lines[i]
    const newHeader = lines[i + 1] ?? ""
    if (!newHeader.startsWith("+++ ")) {
      i++
      continue
    }

    // Strip "a/" and "b/" prefixes
    let oldPath = oldHeader.slice(4).trim()
    let newPath = newHeader.slice(4).trim()
    if (oldPath.startsWith("a/")) oldPath = oldPath.slice(2)
    if (newPath.startsWith("b/")) newPath = newPath.slice(2)

    // /dev/null means new file
    if (oldPath === "/dev/null") oldPath = newPath
    if (newPath === "/dev/null") newPath = oldPath

    i += 2
    const hunks: Hunk[] = []

    // Parse hunks
    while (i < lines.length && !lines[i].startsWith("--- ")) {
      if (!lines[i].startsWith("@@")) {
        i++
        continue
      }

      const hunkHeader = lines[i]
      const match = hunkHeader.match(
        /@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/,
      )
      if (!match) {
        i++
        continue
      }

      const oldStart = parseInt(match[1], 10)
      const oldCount =
        match[2] !== undefined ? parseInt(match[2], 10) : 1
      const newStart = parseInt(match[3], 10)
      const newCount =
        match[4] !== undefined ? parseInt(match[4], 10) : 1

      i++
      const hunkLines: string[] = []

      while (
        i < lines.length &&
        !lines[i].startsWith("@@") &&
        !lines[i].startsWith("--- ")
      ) {
        // Skip "\ No newline at end of file"
        if (!lines[i].startsWith("\\")) {
          hunkLines.push(lines[i])
        }
        i++
      }

      hunks.push({ oldStart, oldCount, newStart, newCount, lines: hunkLines })
    }

    if (hunks.length > 0) {
      files.push({ oldPath, newPath, hunks })
    }
  }

  return files
}

/**
 * Apply a single FileDiff to file content.
 * Strategy: positional (±10 shift) → linear scan → fuzzy find-and-replace.
 * Best-effort: skips hunks that can't be applied.
 */
export function applyFileDiff(
  originalContent: string,
  fileDiff: FileDiff,
  fuzzyMatcher?: FuzzyMatcher,
): string {
  const resultLines = originalContent.split("\n")
  let offset = 0

  for (const hunk of fileDiff.hunks) {
    const startIdx = hunk.oldStart - 1 + offset

    // Build expected old lines (context + removed)
    const expectedOldLines: string[] = []
    for (const line of hunk.lines) {
      if (line.startsWith("-") || line.startsWith(" ")) {
        expectedOldLines.push(line.slice(1))
      }
    }

    // Build new lines (context + added)
    const newLines: string[] = []
    for (const line of hunk.lines) {
      if (line.startsWith("+") || line.startsWith(" ")) {
        newLines.push(line.slice(1))
      }
    }

    // Strategy 1: Positional match (±10 shift)
    let applyAt = startIdx
    let found = false

    for (let shift = 0; shift <= 10; shift++) {
      for (const dir of [0, shift, -shift]) {
        const tryIdx = startIdx + dir
        if (
          tryIdx < 0 ||
          tryIdx + expectedOldLines.length > resultLines.length
        )
          continue
        const slice = resultLines.slice(
          tryIdx,
          tryIdx + expectedOldLines.length,
        )
        if (slice.every((l, idx) => l === expectedOldLines[idx])) {
          applyAt = tryIdx
          found = true
          break
        }
      }
      if (found) break
    }

    // Strategy 2: Full-file linear scan
    if (!found && expectedOldLines.length > 0) {
      for (
        let tryIdx = 0;
        tryIdx + expectedOldLines.length <= resultLines.length;
        tryIdx++
      ) {
        const slice = resultLines.slice(
          tryIdx,
          tryIdx + expectedOldLines.length,
        )
        if (slice.every((l, idx) => l === expectedOldLines[idx])) {
          applyAt = tryIdx
          found = true
          break
        }
      }
    }

    // Strategy 3: Fuzzy find-and-replace
    if (!found && fuzzyMatcher) {
      const currentContent = resultLines.join("\n")
      const oldStr = expectedOldLines.join("\n")
      const newStr = newLines.join("\n")
      const fuzzyResult = fuzzyMatcher.findAndReplace(
        currentContent,
        oldStr,
        newStr,
      )
      if (fuzzyResult.success) {
        const prevLen = resultLines.length
        const replaced = fuzzyResult.result.split("\n")
        resultLines.splice(0, resultLines.length, ...replaced)
        offset += replaced.length - prevLen
      }
      continue
    }

    if (!found) {
      // Skip this hunk (best-effort)
      continue
    }

    // Apply: remove old lines, insert new lines
    const removeCount = expectedOldLines.length
    resultLines.splice(applyAt, removeCount, ...newLines)
    offset += newLines.length - removeCount
  }

  return resultLines.join("\n")
}

/**
 * Extract unified diff from LLM response text.
 * Tries ```diff ``` block first, then bare unified diff.
 */
export function extractDiff(text: string): string | null {
  // Try fenced diff block first
  const diffBlockMatch = text.match(/```diff\n([\s\S]*?)```/)
  if (diffBlockMatch) return diffBlockMatch[1]

  // Try bare unified diff (starts with ---)
  const bareMatch = text.match(
    /(---\s+a\/[\s\S]*?)(?:\n```|\n\n(?=[^+\- @\\])|\s*$)/,
  )
  if (bareMatch) return bareMatch[1]

  return null
}

/**
 * Extract confidence self-assessment from LLM response.
 * Returns default confidence if parsing fails.
 */
export function extractConfidence(text: string): Confidence {
  const jsonBlockMatch = text.match(/```json\n([\s\S]*?)```/)
  if (jsonBlockMatch) {
    try {
      const parsed = JSON.parse(jsonBlockMatch[1]) as Record<string, unknown>
      if (typeof parsed.score === "number") {
        return {
          score: Math.max(0, Math.min(1, parsed.score)),
          reason:
            typeof parsed.reason === "string"
              ? parsed.reason
              : "No reason provided",
          uncertainties: Array.isArray(parsed.uncertainties)
            ? (parsed.uncertainties as unknown[]).filter(
                (u): u is string => typeof u === "string",
              )
            : [],
        }
      }
    } catch {
      // ignore parse errors
    }
  }

  return {
    score: 0.5,
    reason: "Confidence self-assessment not found in LLM response",
    uncertainties: ["Could not parse confidence from response"],
  }
}

// ── MutatorImpl ──────────────────────────────────────────────────────────────

export interface MutatorImplDeps {
  fs: FileSystem
  typeChecker: TypeChecker
  git: GitOps
  llm: LlmClient
  config: MutatorConfig
  logger: MutatorLogger
  fuzzyMatcher?: FuzzyMatcher
}

export class MutatorImpl implements Mutator {
  private readonly fs: FileSystem
  private readonly typeChecker: TypeChecker
  private readonly git: GitOps
  private readonly llm: LlmClient
  private readonly config: MutatorConfig
  private readonly logger: MutatorLogger
  private readonly fuzzyMatcher?: FuzzyMatcher

  constructor(deps: MutatorImplDeps) {
    this.fs = deps.fs
    this.typeChecker = deps.typeChecker
    this.git = deps.git
    this.llm = deps.llm
    this.config = deps.config
    this.logger = deps.logger
    this.fuzzyMatcher = deps.fuzzyMatcher
  }

  async mutate(intent: EvolutionIntent): Promise<MutationResult> {
    this.logger.info("Starting mutation for intent %s", intent.id)

    // ── Step 1: Read target files ──────────────────────────────────────────
    const fileContents: Record<string, string> = {}
    for (const relPath of intent.targetFiles) {
      const absPath = `${this.config.repoRoot}/${relPath}`
      if (this.fs.exists(absPath)) {
        fileContents[relPath] = this.fs.read(absPath)
      } else {
        this.logger.warn("Target file not found: %s", relPath)
      }
    }

    if (Object.keys(fileContents).length === 0) {
      return {
        success: false,
        changedFiles: [],
        confidence: {
          score: 0,
          reason: "No target files found",
          uncertainties: [],
        },
        rounds: 0,
        error: `None of the target files exist: ${intent.targetFiles.join(", ")}`,
      }
    }

    // ── Step 2: Build initial prompt ───────────────────────────────────────
    const fileSection = Object.entries(fileContents)
      .map(([path, content]) => {
        const numbered = content
          .split("\n")
          .map((line, i) => `${String(i + 1).padStart(4, " ")}  ${line}`)
          .join("\n")
        return `### ${path}\n\`\`\`\n${numbered}\n\`\`\``
      })
      .join("\n\n")

    const initialPrompt = `You are a TypeScript code modification assistant. Your task is to modify the following files according to the intent described below.

## Intent
${intent.description}

## Files to Modify
(Each file is shown with line numbers for reference. Do NOT include line numbers in the diff.)
${fileSection}

## Requirements
- Output ONLY the changes as a unified diff (no explanation before the diff)
- Use standard unified diff format with "--- a/filename" and "+++ b/filename" headers
- CRITICAL: Context lines in the diff must be EXACTLY copied from the file above (character-for-character, including spaces/tabs). Wrong context lines will cause the diff to fail.
- Include 3 context lines around each change
- The line numbers in @@ headers must match the actual line numbers shown above
- After the diff, provide your confidence assessment as a JSON block
- Do NOT modify files not listed above
- Ensure all changes are syntactically valid TypeScript${CONFIDENCE_PROMPT_SUFFIX}`

    const messages: LlmMessage[] = [{ role: "user", content: initialPrompt }]

    // ── Step 3: Agentic loop ───────────────────────────────────────────────
    let lastError: string | undefined
    let appliedFiles: string[] = []
    let confidence: Confidence = {
      score: 0,
      reason: "Not attempted",
      uncertainties: [],
    }
    let rounds = 0

    for (let round = 0; round < this.config.maxRounds; round++) {
      rounds = round + 1
      this.logger.info(
        "Mutator round %d/%d",
        round + 1,
        this.config.maxRounds,
      )

      // Call LLM
      let llmResponse: string
      try {
        llmResponse = await this.llm.chat(messages)
      } catch (err: unknown) {
        const errMsg =
          err instanceof Error ? err.message : String(err)
        lastError = `LLM call failed: ${errMsg}`
        this.logger.error(
          "LLM call failed in round %d: %s",
          round + 1,
          lastError,
        )
        break
      }

      // Extract confidence
      confidence = extractConfidence(llmResponse)

      // Extract unified diff
      const diffText = extractDiff(llmResponse)
      if (!diffText) {
        lastError = "LLM did not produce a unified diff"
        this.logger.warn("No diff found in round %d response", round + 1)
        messages.push({ role: "assistant", content: llmResponse })
        messages.push({
          role: "user",
          content:
            "Your response did not contain a unified diff. Please provide the changes in unified diff format (```diff ... ```).",
        })
        continue
      }

      // Parse diff
      const fileDiffs = parseUnifiedDiff(diffText)
      if (fileDiffs.length === 0) {
        lastError = "Parsed diff had no file changes"
        messages.push({ role: "assistant", content: llmResponse })
        messages.push({
          role: "user",
          content:
            "The diff you provided could not be parsed. Please provide a valid unified diff with --- a/file and +++ b/file headers.",
        })
        continue
      }

      // Apply diffs to files
      const modifiedFiles: string[] = []
      for (const fileDiff of fileDiffs) {
        const relPath = fileDiff.newPath
        const absPath = `${this.config.repoRoot}/${relPath}`
        const originalContent =
          fileContents[relPath] ??
          (this.fs.exists(absPath) ? this.fs.read(absPath) : "")
        const newContent = applyFileDiff(
          originalContent,
          fileDiff,
          this.fuzzyMatcher,
        )
        if (newContent !== originalContent) {
          this.fs.write(absPath, newContent)
          modifiedFiles.push(relPath)
          this.logger.info("Applied diff to %s", relPath)
        }
      }

      if (modifiedFiles.length === 0) {
        lastError =
          "Diff was parsed but no files were modified (hunks may not have matched)"
        messages.push({ role: "assistant", content: llmResponse })
        messages.push({
          role: "user",
          content:
            "The diff was parsed but could not be applied to the files. The context lines may not match. Please regenerate the diff ensuring the context lines exactly match the original file content.",
        })
        continue
      }

      appliedFiles = modifiedFiles

      // Run TypeScript check
      const tscResult = this.typeChecker.check(this.config.repoRoot)
      if (tscResult.success) {
        // Success! Commit
        const commitMsg = `mutate(${intent.id}): ${intent.description.slice(0, 72)}`
        const commitResult = this.git.commit(this.config.repoRoot, commitMsg)
        if (!commitResult.success) {
          this.logger.warn("Git commit failed: %s", commitResult.error)
        } else {
          this.git.add(this.config.repoRoot, modifiedFiles)
        }

        return {
          success: true,
          changedFiles: modifiedFiles,
          confidence,
          rounds,
        }
      }

      // TypeScript errors — feed back to LLM
      lastError = `TypeScript errors:\n${tscResult.output}`
      this.logger.warn(
        "TypeScript check failed in round %d:\n%s",
        round + 1,
        tscResult.output,
      )
      messages.push({ role: "assistant", content: llmResponse })
      messages.push({
        role: "user",
        content: `The changes produced TypeScript compilation errors. Please fix them:\n\n\`\`\`\n${tscResult.output}\n\`\`\`\n\nProvide a new unified diff that fixes these errors.${CONFIDENCE_PROMPT_SUFFIX}`,
      })

      // Restore original files before next round
      for (const relPath of modifiedFiles) {
        if (fileContents[relPath] !== undefined) {
          this.fs.write(
            `${this.config.repoRoot}/${relPath}`,
            fileContents[relPath],
          )
        }
      }
      appliedFiles = []
    }

    // All rounds exhausted
    return {
      success: false,
      changedFiles: appliedFiles,
      confidence,
      rounds,
      error: lastError ?? "Max rounds exceeded",
    }
  }
}
