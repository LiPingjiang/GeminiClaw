// @ts-nocheck
// src/evolution/mutator/mutator.ts
// Mutator: uses the built-in LLM via ProviderRouter to generate code changes.
// Implements an agentic loop (max 3 rounds) that:
//   1. Reads targetFiles
//   2. Asks LLM to produce a unified diff
//   3. Applies the diff
//   4. Runs `tsc --noEmit` to check for syntax errors
//   5. If errors, feeds them back to the LLM (up to maxRounds)
//   6. On success, `git add` + `git commit`
//
// No external `patch` command dependency — diff is parsed and applied in JS.
import { execSync, spawnSync } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
/**
 * Parse a unified diff string into structured FileDiff objects.
 * Handles standard `--- a/file` / `+++ b/file` headers.
 */
function parseUnifiedDiff(diffText) {
    const files = [];
    const lines = diffText.split("\n");
    let i = 0;
    while (i < lines.length) {
        // Find file header
        if (!lines[i].startsWith("--- ")) {
            i++;
            continue;
        }
        const oldHeader = lines[i];
        const newHeader = lines[i + 1] ?? "";
        if (!newHeader.startsWith("+++ ")) {
            i++;
            continue;
        }
        // Strip "a/" and "b/" prefixes
        let oldPath = oldHeader.slice(4).trim();
        let newPath = newHeader.slice(4).trim();
        if (oldPath.startsWith("a/"))
            oldPath = oldPath.slice(2);
        if (newPath.startsWith("b/"))
            newPath = newPath.slice(2);
        // /dev/null means new file
        if (oldPath === "/dev/null")
            oldPath = newPath;
        if (newPath === "/dev/null")
            newPath = oldPath;
        i += 2;
        const hunks = [];
        // Parse hunks
        while (i < lines.length && !lines[i].startsWith("--- ")) {
            if (!lines[i].startsWith("@@")) {
                i++;
                continue;
            }
            // Parse @@ -L,N +L,N @@ header
            const hunkHeader = lines[i];
            const match = hunkHeader.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
            if (!match) {
                i++;
                continue;
            }
            const oldStart = parseInt(match[1], 10);
            const oldCount = match[2] !== undefined ? parseInt(match[2], 10) : 1;
            const newStart = parseInt(match[3], 10);
            const newCount = match[4] !== undefined ? parseInt(match[4], 10) : 1;
            i++;
            const hunkLines = [];
            while (i < lines.length && !lines[i].startsWith("@@") && !lines[i].startsWith("--- ")) {
                // Include +, -, and context lines; skip "\ No newline at end of file"
                if (!lines[i].startsWith("\\")) {
                    hunkLines.push(lines[i]);
                }
                i++;
            }
            hunks.push({ oldStart, oldCount, newStart, newCount, lines: hunkLines });
        }
        if (hunks.length > 0) {
            files.push({ oldPath, newPath, hunks });
        }
    }
    return files;
}
/**
 * Apply a single FileDiff to file content.
 * Returns the new content, or null if the hunk could not be applied.
 * Skips hunks that don't match (robustness over correctness).
 */
function applyFileDiff(originalContent, fileDiff) {
    const originalLines = originalContent.split("\n");
    const resultLines = [...originalLines];
    let offset = 0; // cumulative line offset from previous hunk applications
    for (const hunk of fileDiff.hunks) {
        const startIdx = hunk.oldStart - 1 + offset; // 0-indexed
        // Build expected context + removed lines for verification
        const expectedOldLines = [];
        for (const line of hunk.lines) {
            if (line.startsWith("-") || line.startsWith(" ")) {
                expectedOldLines.push(line.slice(1));
            }
        }
        // Verify the hunk applies at the expected position (fuzzy: allow ±3 line shift)
        let applyAt = startIdx;
        let found = false;
        for (let shift = 0; shift <= 3; shift++) {
            for (const dir of [0, shift, -shift]) {
                const tryIdx = startIdx + dir;
                if (tryIdx < 0 || tryIdx + expectedOldLines.length > resultLines.length)
                    continue;
                const slice = resultLines.slice(tryIdx, tryIdx + expectedOldLines.length);
                if (slice.every((l, i) => l === expectedOldLines[i])) {
                    applyAt = tryIdx;
                    found = true;
                    break;
                }
            }
            if (found)
                break;
        }
        if (!found) {
            // Skip this hunk — record but continue
            continue;
        }
        // Build replacement lines ('+' and context lines)
        const newLines = [];
        for (const line of hunk.lines) {
            if (line.startsWith("+") || line.startsWith(" ")) {
                newLines.push(line.slice(1));
            }
        }
        // Splice: remove old lines, insert new lines
        const removeCount = expectedOldLines.length;
        resultLines.splice(applyAt, removeCount, ...newLines);
        offset += newLines.length - removeCount;
    }
    return resultLines.join("\n");
}
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
`;
export class Mutator {
    providerRouter;
    repoRoot;
    config;
    logger;
    constructor(params) {
        this.providerRouter = params.providerRouter;
        this.repoRoot = params.repoRoot;
        this.config = params.config;
        this.logger = params.logger;
    }
    async mutate(intent) {
        this.logger.info("Starting mutation for intent %s", intent.id);
        // Read target files
        const fileContents = {};
        for (const relPath of intent.targetFiles) {
            const absPath = join(this.repoRoot, relPath);
            if (existsSync(absPath)) {
                fileContents[relPath] = readFileSync(absPath, "utf-8");
            }
            else {
                this.logger.warn("Target file not found: %s", relPath);
            }
        }
        if (Object.keys(fileContents).length === 0) {
            return {
                success: false,
                changedFiles: [],
                confidence: { score: 0, reason: "No target files found", uncertainties: [] },
                error: `None of the target files exist: ${intent.targetFiles.join(", ")}`,
                rounds: 0,
            };
        }
        // Build initial prompt
        const fileSection = Object.entries(fileContents)
            .map(([path, content]) => `### ${path}\n\`\`\`typescript\n${content}\n\`\`\``)
            .join("\n\n");
        const initialPrompt = `You are a TypeScript code modification assistant. Your task is to modify the following files according to the intent described below.

## Intent
${intent.description}

## Files to Modify
${fileSection}

## Requirements
- Output ONLY the changes as a unified diff (no explanation before the diff)
- Use standard unified diff format with "--- a/filename" and "+++ b/filename" headers
- Include sufficient context lines (3 lines) around each change
- After the diff, provide your confidence assessment as a JSON block
- Do NOT modify files not listed above
- Ensure all changes are syntactically valid TypeScript${CONFIDENCE_PROMPT_SUFFIX}`;
        const messages = [
            { role: "user", content: initialPrompt }
        ];
        let lastError;
        let appliedFiles = [];
        let confidence = { score: 0, reason: "Not attempted", uncertainties: [] };
        let rounds = 0;
        for (let round = 0; round < this.config.maxRounds; round++) {
            rounds = round + 1;
            this.logger.info("Mutator round %d/%d", round + 1, this.config.maxRounds);
            // Call LLM
            let llmResponse;
            try {
                const response = await this.providerRouter.chat(messages);
                llmResponse = response.content;
            }
            catch (err) {
                lastError = `LLM call failed: ${err.message}`;
                this.logger.error("LLM call failed in round %d: %s", round + 1, lastError);
                break;
            }
            // Extract confidence from response
            confidence = this.extractConfidence(llmResponse);
            // Extract unified diff
            const diffText = this.extractDiff(llmResponse);
            if (!diffText) {
                lastError = "LLM did not produce a unified diff";
                this.logger.warn("No diff found in round %d response", round + 1);
                messages.push({ role: "assistant", content: llmResponse });
                messages.push({
                    role: "user",
                    content: "Your response did not contain a unified diff. Please provide the changes in unified diff format (```diff ... ```)."
                });
                continue;
            }
            // Parse and apply diff
            const fileDiffs = parseUnifiedDiff(diffText);
            if (fileDiffs.length === 0) {
                lastError = "Parsed diff had no file changes";
                messages.push({ role: "assistant", content: llmResponse });
                messages.push({
                    role: "user",
                    content: "The diff you provided could not be parsed. Please provide a valid unified diff with --- a/file and +++ b/file headers."
                });
                continue;
            }
            // Apply diffs to files
            const modifiedFiles = [];
            for (const fileDiff of fileDiffs) {
                const relPath = fileDiff.newPath;
                const absPath = join(this.repoRoot, relPath);
                const originalContent = fileContents[relPath] ?? (existsSync(absPath) ? readFileSync(absPath, "utf-8") : "");
                const newContent = applyFileDiff(originalContent, fileDiff);
                if (newContent !== originalContent) {
                    writeFileSync(absPath, newContent, "utf-8");
                    modifiedFiles.push(relPath);
                    this.logger.info("Applied diff to %s", relPath);
                }
            }
            if (modifiedFiles.length === 0) {
                lastError = "Diff was parsed but no files were modified (hunks may not have matched)";
                messages.push({ role: "assistant", content: llmResponse });
                messages.push({
                    role: "user",
                    content: `The diff was parsed but could not be applied to the files. The context lines may not match. Please regenerate the diff ensuring the context lines exactly match the original file content.`
                });
                continue;
            }
            appliedFiles = modifiedFiles;
            // Run TypeScript check
            const tscResult = this.runTypeCheck();
            if (tscResult.success) {
                // Success! Commit
                const commitResult = this.gitCommit(intent, modifiedFiles);
                if (!commitResult.success) {
                    this.logger.warn("Git commit failed: %s", commitResult.error);
                    // Still return success — the files are modified correctly
                }
                const lowConfidence = confidence.score < this.config.confidenceThreshold;
                return {
                    success: true,
                    changedFiles: modifiedFiles,
                    confidence,
                    rounds,
                    ...(lowConfidence ? { lowConfidence: true } : {}),
                };
            }
            else {
                // TypeScript errors — feed back to LLM
                lastError = `TypeScript errors:\n${tscResult.output}`;
                this.logger.warn("TypeScript check failed in round %d:\n%s", round + 1, tscResult.output);
                messages.push({ role: "assistant", content: llmResponse });
                messages.push({
                    role: "user",
                    content: `The changes produced TypeScript compilation errors. Please fix them:\n\n\`\`\`\n${tscResult.output}\n\`\`\`\n\nProvide a new unified diff that fixes these errors.${CONFIDENCE_PROMPT_SUFFIX}`
                });
                // Restore original files before next round
                for (const relPath of modifiedFiles) {
                    if (fileContents[relPath] !== undefined) {
                        writeFileSync(join(this.repoRoot, relPath), fileContents[relPath], "utf-8");
                    }
                }
                appliedFiles = [];
            }
        }
        // All rounds exhausted
        return {
            success: false,
            changedFiles: appliedFiles,
            confidence,
            error: lastError ?? "Max rounds exceeded",
            rounds,
        };
    }
    // ---------------------------------------------------------------------------
    // Private helpers
    // ---------------------------------------------------------------------------
    extractDiff(text) {
        // Try ```diff ... ``` first
        const diffBlockMatch = text.match(/```diff\n([\s\S]*?)```/);
        if (diffBlockMatch)
            return diffBlockMatch[1];
        // Try bare unified diff (starts with ---)
        const bareMatch = text.match(/(---\s+a\/[\s\S]*?)(?:\n```|\n\n(?=[^+\- @\\])|\s*$)/);
        if (bareMatch)
            return bareMatch[1];
        return null;
    }
    extractConfidence(text) {
        // Try to find ```json ... ``` block after the diff
        const jsonBlockMatch = text.match(/```json\n([\s\S]*?)```/);
        if (jsonBlockMatch) {
            try {
                const parsed = JSON.parse(jsonBlockMatch[1]);
                if (typeof parsed.score === "number") {
                    return {
                        score: Math.max(0, Math.min(1, parsed.score)),
                        reason: typeof parsed.reason === "string" ? parsed.reason : "No reason provided",
                        uncertainties: Array.isArray(parsed.uncertainties)
                            ? parsed.uncertainties.filter((u) => typeof u === "string")
                            : [],
                    };
                }
            }
            catch {
                // ignore parse errors
            }
        }
        // Default confidence if not found
        return {
            score: 0.5,
            reason: "Confidence self-assessment not found in LLM response",
            uncertainties: ["Could not parse confidence from response"],
        };
    }
    runTypeCheck() {
        try {
            const result = spawnSync("pnpm", ["exec", "tsc", "--noEmit"], {
                cwd: this.repoRoot,
                timeout: 60_000,
                encoding: "utf-8",
            });
            const output = (result.stdout ?? "") + (result.stderr ?? "");
            if (result.status === 0) {
                return { success: true, output: "" };
            }
            return { success: false, output: output.trim() };
        }
        catch (err) {
            return { success: false, output: `tsc execution failed: ${err.message}` };
        }
    }
    gitCommit(intent, changedFiles) {
        try {
            // Stage changed files
            for (const relPath of changedFiles) {
                execSync(`git add ${JSON.stringify(relPath)}`, {
                    cwd: this.repoRoot,
                    timeout: 10_000,
                });
            }
            // Commit
            const commitMsg = `mutate(${intent.id}): ${intent.description.slice(0, 72)}`;
            execSync(`git commit -m ${JSON.stringify(commitMsg)}`, {
                cwd: this.repoRoot,
                timeout: 10_000,
                env: {
                    ...process.env,
                    GIT_AUTHOR_NAME: "GeminiClaw Evolution",
                    GIT_AUTHOR_EMAIL: "evolution@geminiclaw.local",
                    GIT_COMMITTER_NAME: "GeminiClaw Evolution",
                    GIT_COMMITTER_EMAIL: "evolution@geminiclaw.local",
                },
            });
            return { success: true };
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    }
}
