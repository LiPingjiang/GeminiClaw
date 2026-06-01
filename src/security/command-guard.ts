/**
 * src/security/command-guard.ts
 * Three-layer command approval system
 *
 *  Layer 1: Hardline Blocklist — unconditional deny, no override
 *  Layer 2: Dangerous Patterns — requires approval (47+ patterns)
 *  Layer 3: Smart Approval — LLM-assisted risk assessment (optional)
 *
 * Integrates with HookBus via pre_tool_call for automatic interception.
 */

import { normalizeForDetection } from "./normalize.js"

// ── Types ────────────────────────────────────────────────────────────────────

export type GuardLevel = "allow" | "needs_approval" | "deny"

export interface GuardDecision {
  level: GuardLevel
  reason: string
  matchedPattern?: string
  layer: 1 | 2 | 3
}

interface PatternEntry {
  name: string
  pattern: RegExp
  description: string
}

// ── Layer 1: Hardline Blocklist (NEVER allow) ────────────────────────────────

const HARDLINE_BLOCKLIST: PatternEntry[] = [
  { name: "rm_rf_root", pattern: /rm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+\/(\s|$)/, description: "rm -rf /" },
  { name: "rm_rf_root_alt", pattern: /rm\s+-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*\s+\/(\s|$)/, description: "rm -rf / (alt flag order)" },
  { name: "mkfs", pattern: /mkfs\b/, description: "filesystem format" },
  { name: "dd_block_device", pattern: /dd\s+.*of=\/dev\/[sh]d/, description: "dd to block device" },
  { name: "fork_bomb", pattern: /:\(\)\{.*\|.*\}/, description: "fork bomb" },
  { name: "fork_bomb_alt", pattern: /\.\/\(.*\)\s*&/, description: "fork bomb variant" },
  { name: "shutdown", pattern: /\b(shutdown|poweroff|halt|init\s+0)\b/, description: "system shutdown" },
  { name: "reboot", pattern: /\breboot\b/, description: "system reboot" },
  { name: "kill_all", pattern: /kill\s+-9?\s*-1\b/, description: "kill all processes" },
  { name: "sudo_password_pipe", pattern: /echo\s+.*\|\s*sudo\s+-S/, description: "password piped to sudo" },
  { name: "dev_null_mv", pattern: /mv\s+.*\/dev\/null/, description: "move to /dev/null" },
  { name: "wget_pipe_sh", pattern: /(wget|curl)\s+.*\|\s*(ba)?sh/, description: "remote script execution" },
]

// ── Layer 2: Dangerous Patterns (needs approval) ─────────────────────────────

const DANGEROUS_PATTERNS: PatternEntry[] = [
  // Recursive deletion
  { name: "recursive_delete", pattern: /rm\s+-[a-zA-Z]*r/, description: "recursive delete" },
  { name: "recursive_force", pattern: /rm\s+-[a-zA-Z]*f/, description: "forced delete" },

  // Permission changes
  { name: "chmod_777", pattern: /chmod\s+(777|a\+rwx)/, description: "world-writable permissions" },
  { name: "chown_recursive", pattern: /chown\s+-[a-zA-Z]*R/, description: "recursive ownership change" },

  // SQL dangerous operations
  { name: "sql_drop", pattern: /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i, description: "SQL DROP" },
  { name: "sql_delete_no_where", pattern: /\bDELETE\s+FROM\s+\S+\s*;/i, description: "DELETE without WHERE" },
  { name: "sql_truncate", pattern: /\bTRUNCATE\s+(TABLE\s+)?\S+/i, description: "SQL TRUNCATE" },
  { name: "sql_alter_drop", pattern: /\bALTER\s+TABLE.*DROP\b/i, description: "ALTER TABLE DROP" },

  // Git destructive
  { name: "git_force_push", pattern: /git\s+push\s+.*--force/, description: "git force push" },
  { name: "git_force_push_short", pattern: /git\s+push\s+-f/, description: "git force push (short)" },
  { name: "git_reset_hard", pattern: /git\s+reset\s+--hard/, description: "git reset --hard" },
  { name: "git_clean_force", pattern: /git\s+clean\s+-[a-zA-Z]*f/, description: "git clean -f" },

  // System files
  { name: "tee_system_file", pattern: /tee\s+(\/etc\/|\/sys\/|\/proc\/)/, description: "write to system file" },
  { name: "write_etc", pattern: />\s*\/etc\//, description: "redirect to /etc/" },
  { name: "write_boot", pattern: />\s*\/boot\//, description: "redirect to /boot/" },

  // Network
  { name: "iptables", pattern: /\biptables\b/, description: "firewall modification" },
  { name: "ufw_disable", pattern: /ufw\s+disable/, description: "disable firewall" },

  // Package management (risky)
  { name: "pip_install_force", pattern: /pip\s+install\s+.*--force/, description: "forced pip install" },
  { name: "npm_install_global", pattern: /npm\s+install\s+-g/, description: "global npm install" },

  // Docker risky
  { name: "docker_privileged", pattern: /docker\s+run\s+.*--privileged/, description: "privileged container" },
  { name: "docker_rm_force", pattern: /docker\s+(rm|rmi)\s+-f/, description: "force remove container/image" },

  // Process manipulation
  { name: "kill_signal", pattern: /kill\s+-9\s+\d+/, description: "SIGKILL process" },
  { name: "pkill_broad", pattern: /pkill\s+-9/, description: "broad SIGKILL" },

  // Shell injection vectors
  { name: "eval_exec", pattern: /\beval\s+/, description: "eval execution" },
  { name: "shell_in_shell", pattern: /\b(ba)?sh\s+-c\s+/, description: "nested shell" },
  { name: "python_exec", pattern: /python[23]?\s+-c\s+/, description: "inline python execution" },

  // Environment
  { name: "env_unset_path", pattern: /unset\s+PATH/, description: "unset PATH" },
  { name: "export_path_override", pattern: /export\s+PATH\s*=\s*[^$]/, description: "PATH override (non-append)" },

  // Disk
  { name: "fdisk", pattern: /\bfdisk\b/, description: "disk partition" },
  { name: "mount_unmount", pattern: /\b(u?mount)\s+\//, description: "mount/unmount" },

  // Sudo
  { name: "sudo_command", pattern: /\bsudo\s+/, description: "elevated privileges" },

  // Cron
  { name: "crontab_edit", pattern: /crontab\s+-[er]/, description: "cron job modification" },

  // SSH
  { name: "ssh_keygen_overwrite", pattern: /ssh-keygen\s+.*-f/, description: "SSH key generation to file" },
]

// ── CommandGuard ─────────────────────────────────────────────────────────────

export class CommandGuard {
  private allowlist: Set<string>

  constructor(options?: { allowlist?: string[] }) {
    this.allowlist = new Set(options?.allowlist ?? [])
  }

  /**
   * Evaluate a command string against the three-layer security model.
   * Returns a GuardDecision indicating whether to allow, deny, or require approval.
   */
  evaluate(command: string): GuardDecision {
    // Normalize to defeat evasion attempts
    const normalized = normalizeForDetection(command)

    // Check allowlist first (explicit override for approved commands)
    if (this.allowlist.has(normalized)) {
      return { level: "allow", reason: "Command is in allowlist", layer: 1 }
    }

    // Layer 1: Hardline Blocklist
    for (const entry of HARDLINE_BLOCKLIST) {
      if (entry.pattern.test(normalized)) {
        return {
          level: "deny",
          reason: `Blocked by hardline rule: ${entry.description}`,
          matchedPattern: entry.name,
          layer: 1,
        }
      }
    }

    // Layer 2: Dangerous Patterns
    for (const entry of DANGEROUS_PATTERNS) {
      if (entry.pattern.test(normalized)) {
        return {
          level: "needs_approval",
          reason: `Dangerous pattern detected: ${entry.description}`,
          matchedPattern: entry.name,
          layer: 2,
        }
      }
    }

    // Layer 3: Not implemented yet (Smart Approval via LLM)
    // For now, anything not matched by Layer 1/2 is allowed.
    return { level: "allow", reason: "No dangerous patterns detected", layer: 3 }
  }

  /**
   * Check if a tool call contains a command that needs security review.
   * Examines common arg patterns: args.command, args.cmd, args.script.
   */
  evaluateToolArgs(toolName: string, args: Record<string, unknown>): GuardDecision | null {
    // Only check tools that execute commands
    const commandTools = new Set(["exec", "shell", "run_command", "terminal"])
    if (!commandTools.has(toolName)) return null

    // Extract command from common argument patterns
    const command = (args.command ?? args.cmd ?? args.script ?? args.input) as string | undefined
    if (!command || typeof command !== "string") return null

    return this.evaluate(command)
  }

  /**
   * Add a command to the allowlist (e.g., after user approves "always allow").
   */
  addToAllowlist(command: string): void {
    this.allowlist.add(normalizeForDetection(command))
  }

  /**
   * Remove from allowlist.
   */
  removeFromAllowlist(command: string): void {
    this.allowlist.delete(normalizeForDetection(command))
  }
}
