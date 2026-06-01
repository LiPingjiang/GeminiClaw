import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  formatDiagnostics,
  clearBaseline,
  type Diagnostic,
  type DiagnosticDiff,
} from "./index.js"

describe("LSP Diagnostics", () => {
  beforeEach(() => {
    clearBaseline()
  })

  describe("formatDiagnostics", () => {
    it("returns empty string when no new errors", () => {
      const diff: DiagnosticDiff = {
        newErrors: [],
        resolvedErrors: [],
        totalCurrentErrors: 0,
      }
      expect(formatDiagnostics(diff)).toBe("")
    })

    it("formats new errors in XML-like block", () => {
      const diff: DiagnosticDiff = {
        newErrors: [
          {
            file: "src/foo.ts",
            line: 10,
            col: 5,
            code: "TS2345",
            message: "Type 'string' is not assignable to type 'number'.",
            severity: "error",
          },
        ],
        resolvedErrors: [],
        totalCurrentErrors: 1,
      }
      const result = formatDiagnostics(diff)
      expect(result).toContain("<diagnostics")
      expect(result).toContain('count="1"')
      expect(result).toContain('new="true"')
      expect(result).toContain("src/foo.ts:10:5 - TS2345:")
      expect(result).toContain("Type 'string' is not assignable")
      expect(result).toContain("</diagnostics>")
    })

    it("caps output at 20 errors", () => {
      const errors: Diagnostic[] = Array.from({ length: 25 }, (_, i) => ({
        file: "src/foo.ts",
        line: i + 1,
        col: 1,
        code: "TS2345",
        message: `Error ${i}`,
        severity: "error" as const,
      }))

      const diff: DiagnosticDiff = {
        newErrors: errors,
        resolvedErrors: [],
        totalCurrentErrors: 25,
      }
      const result = formatDiagnostics(diff)
      expect(result).toContain('count="25"')
      expect(result).toContain("... and 5 more errors")
      // Should only contain 20 individual error lines
      const errorLines = result.split("\n").filter((l) => l.includes("TS2345"))
      expect(errorLines.length).toBe(20)
    })

    it("includes all info in each error line", () => {
      const diff: DiagnosticDiff = {
        newErrors: [
          {
            file: "src/bar.ts",
            line: 42,
            col: 13,
            code: "TS7006",
            message: "Parameter 'x' implicitly has an 'any' type.",
            severity: "error",
          },
        ],
        resolvedErrors: [],
        totalCurrentErrors: 1,
      }
      const result = formatDiagnostics(diff)
      expect(result).toContain("src/bar.ts:42:13 - TS7006: Parameter 'x' implicitly has an 'any' type.")
    })
  })
})
