// src/utils/strip-tool-xml.ts

/**
 * Strip XML-style tags that should never appear in user-facing output.
 * Handles: tool_call, tool_response, tool_thinking, antThinking, thinking, etc.
 */
export function stripToolXml(text: string): string {
  if (!text) return text;
  const tags = [
    "tool_call", "tool_response", "tool_thinking",
    "antThinking", "thinking", "internal_reasoning",
  ];
  let result = text;
  for (const tag of tags) {
    let out = "";
    let i = 0;
    const open = `<${tag}>`;
    const close = `</${tag}>`;
    while (i < result.length) {
      const s = result.indexOf(open, i);
      if (s === -1) {
        out += result.slice(i);
        break;
      }
      out += result.slice(i, s);
      const e = result.indexOf(close, s);
      if (e === -1) {
        // Unclosed tag: intentionally drop everything from the opening tag onward.
        // These are internal-reasoning tags; if the close is missing the content is
        // incomplete internal state, not user-facing text.
        break;
      }
      i = e + close.length;
    }
    result = out;
  }
  // Complementary regex pass: catches the same tag families with attributes
  // (e.g. <thinking type="internal">), which the loop above misses because it
  // only matches the exact bare form <tag>...</tag>.
  result = result.replace(/<(?:antThinking|thinking|internal_reasoning)[^>]*>[\s\S]*?<\/(?:antThinking|thinking|internal_reasoning)>/gi, "");
  // Strip any remaining orphan open/close tags left by attribute variants.
  result = result.replace(/<\/?(?:antThinking|thinking|internal_reasoning)[^>]*>/gi, "");
  return result.trim();
}

/**
 * Detect if the output is stuck in a repetitive loop.
 * Returns the cleaned content (up to first repetition) if loop detected, else null.
 *
 * Carefully avoids false positives on structured content like Markdown tables,
 * code blocks, and lists which naturally contain repeated patterns.
 */
export function detectRepetitionLoop(text: string, minRepeatLen = 50, maxRepeats = 4): string | null {
  if (!text || text.length < minRepeatLen * maxRepeats) return null;

  // ── Markdown structural line patterns (should NOT be treated as repetition) ──
  const isMarkdownStructural = (line: string): boolean => {
    const trimmed = line.trim();
    // Table separator: |---|---|---| or |:---:|:---|---:|
    if (/^\|[\s:|-]+\|$/.test(trimmed)) return true;
    // Table row: | content | content | (starts and ends with |)
    if (/^\|.*\|$/.test(trimmed)) return true;
    // List items: - item, * item, 1. item
    if (/^[-*+]\s/.test(trimmed) || /^\d+\.\s/.test(trimmed)) return true;
    // Heading: ## heading
    if (/^#{1,6}\s/.test(trimmed)) return true;
    // Horizontal rule: --- or ***
    if (/^[-*_]{3,}$/.test(trimmed)) return true;
    return false;
  };

  // Strategy 1: Line-based repetition detection
  const lines = text.split("\n").filter(l => l.trim().length > 0);
  if (lines.length >= maxRepeats * 2) {
    // Check if any line repeats maxRepeats+ times CONSECUTIVELY (not just scattered)
    const lineCounts = new Map<string, { count: number; firstIdx: number }>();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.length < 15) continue; // skip short lines
      if (isMarkdownStructural(line)) continue; // skip Markdown structural lines
      const entry = lineCounts.get(line);
      if (entry) {
        entry.count++;
      } else {
        lineCounts.set(line, { count: 1, firstIdx: i });
      }
    }
    // Require higher threshold: a line must repeat 5+ times (not just 3)
    // to be considered a loop, since structured content often has 3-4 similar lines
    const lineRepeatThreshold = Math.max(maxRepeats, 5);
    for (const [, { count, firstIdx }] of lineCounts) {
      if (count >= lineRepeatThreshold) {
        // Return content before the first occurrence of the repeated line
        const prefix = lines.slice(0, firstIdx).join("\n").trim();
        return prefix || null;
      }
    }
  }

  // Strategy 2: Substring block repetition detection
  const maxBlockLen = Math.min(500, Math.floor(text.length / maxRepeats));
  if (minRepeatLen > maxBlockLen) return null;

  // Pre-compute: which character positions are inside Markdown table or code block regions?
  const inExcludedRegion = new Uint8Array(text.length);
  // Mark table rows
  let pos = 0;
  for (const line of text.split("\n")) {
    if (isMarkdownStructural(line)) {
      for (let j = pos; j < pos + line.length && j < text.length; j++) {
        inExcludedRegion[j] = 1;
      }
    }
    pos += line.length + 1;
  }
  // Mark code block regions (``` ... ``` or ~~~ ... ~~~)
  const codeFenceRe = /^[ \t]*(```|~~~)/m;
  let codeSearchFrom = 0;
  while (codeSearchFrom < text.length) {
    const fenceStart = text.search(new RegExp('(?:^|\\n)[ \\t]*(```|~~~)', 'g'));
    // Simpler: scan for ``` markers
    const f1 = text.indexOf('```', codeSearchFrom);
    const f2 = text.indexOf('~~~', codeSearchFrom);
    const fenceOpen = f1 === -1 ? f2 : f2 === -1 ? f1 : Math.min(f1, f2);
    if (fenceOpen === -1) break;
    const fenceChar = text.slice(fenceOpen, fenceOpen + 3);
    const fenceClose = text.indexOf(fenceChar, fenceOpen + 3);
    if (fenceClose === -1) {
      // Unclosed code fence — mark to end
      for (let j = fenceOpen; j < text.length; j++) inExcludedRegion[j] = 1;
      break;
    }
    const fenceEnd = fenceClose + 3;
    for (let j = fenceOpen; j < fenceEnd && j < text.length; j++) inExcludedRegion[j] = 1;
    codeSearchFrom = fenceEnd;
  }
  void codeFenceRe; // suppress unused warning

  for (let blockLen = minRepeatLen; blockLen <= maxBlockLen; blockLen += 10) {
    for (let i = 0; i + blockLen <= text.length; i += Math.max(1, Math.floor(blockLen / 2))) {
      const block = text.slice(i, i + blockLen);
      let count = 0;
      let searchFrom = i;
      while (searchFrom + blockLen <= text.length) {
        const idx = text.indexOf(block, searchFrom);
        if (idx === -1) break;
        count++;
        searchFrom = idx + 1;
        if (count >= maxRepeats) {
          // Before confirming: check if the repeated block sits inside an excluded region
          let excludedChars = 0;
          for (let j = i; j < i + blockLen; j++) {
            if (inExcludedRegion[j]) excludedChars++;
          }
          if (excludedChars > blockLen * 0.4) {
            break; // Skip — block overlaps significantly with code/table content
          }
          // Found genuine repetition — return content up to first occurrence
          return text.slice(0, i).trim() || null;
        }
      }
    }
  }
  return null;
}
