#!/usr/bin/env node
import { Command } from "commander"
import { registerIdentityCommand } from "./commands/identity.js"
import { registerMemoryCommand } from "./commands/memory.js"
import { registerSkillCommand } from "./commands/skill.js"
import { registerConfigCommand } from "./commands/config.js"
import { registerStatusCommand } from "./commands/status.js"

const program = new Command()

program
  .name("gc")
  .description(
    `GeminiClaw CLI — agent-first management tool

OVERVIEW
  gc is the primary interface for GeminiClaw agents and operators.
  It exposes identity, memory, skills, config, and sync operations
  through a consistent CLI surface.

AGENT USAGE
  Agents should call gc to understand their own context:
    gc identity show     — who am I, who do I serve
    gc memory show       — what do I remember long-term
    gc skill list        — what capabilities do I have
    gc status            — am I running correctly

OPERATOR USAGE
  Operators use gc to bootstrap and maintain the agent:
    gc sync from <path>  — import experience from OpenClaw workspace
    gc skill install     — add new skills with provenance tracking
    gc config show       — inspect current configuration

OUTPUT FORMATS
  All commands support --json for machine-readable output.
  Default output is human-readable with emoji indicators.

ENVIRONMENT
  GC_CONFIG  Path to config.yaml (default: auto-detect from cwd)`
  )
  .version("0.1.0")

// Commands will be registered here by subsequent tasks:
registerIdentityCommand(program)
registerMemoryCommand(program)
registerSkillCommand(program)
registerConfigCommand(program)
registerStatusCommand(program)
// registerSyncCommand(program)

program.parse()
