#!/usr/bin/env node
// @ts-nocheck
import { Command } from "commander";
import { registerIdentityCommand } from "./commands/identity.js";
import { registerMemoryCommand } from "./commands/memory.js";
import { registerSkillCommand } from "./commands/skill.js";
import { registerConfigCommand } from "./commands/config.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerSyncCommand } from "./commands/sync.js";
import { registerChatCommand } from "./commands/chat.js";
import { registerTemplateCommand } from "./commands/template.js";
import { registerServerCommands } from "./commands/server.js";
import { registerTuiCommand } from "./commands/tui.js";

const program = new Command();
program
    .name("geminiclaw")
    .description(`GeminiClaw CLI -- agent-first management tool

OVERVIEW
  geminiclaw (alias: gc) is the primary interface for GeminiClaw agents and operators.
  It exposes identity, memory, skills, config, server lifecycle, and sync operations
  through a consistent CLI surface.

AGENT USAGE
  Agents should call geminiclaw to understand their own context:
    geminiclaw identity show     -- who am I, who do I serve
    geminiclaw memory show       -- what do I remember long-term
    geminiclaw skill list        -- what capabilities do I have
    geminiclaw status            -- am I running correctly

OPERATOR USAGE
  Operators use geminiclaw to manage the server and bootstrap the agent:
    geminiclaw start             -- start server in background
    geminiclaw stop              -- stop server
    geminiclaw restart           -- restart server
    geminiclaw log [-f]          -- tail server log
    geminiclaw status            -- full health check
    geminiclaw sync from <path>  -- import experience from Claw workspace
    geminiclaw skill install     -- add new skills with provenance tracking
    geminiclaw config show       -- inspect current configuration

OUTPUT FORMATS
  All commands support --json for machine-readable output.
  Default output is human-readable with emoji indicators.

ENVIRONMENT
  GC_CONFIG  Path to config.yaml (default: auto-detect from cwd)`)
    .version("0.1.0")
    .addHelpText("after", "\nTip: `gc` is a short alias for `geminiclaw`");

// Commands
registerIdentityCommand(program);
registerMemoryCommand(program);
registerSkillCommand(program);
registerConfigCommand(program);
registerStatusCommand(program);
registerSyncCommand(program);
registerChatCommand(program);
registerTemplateCommand(program);
registerServerCommands(program);
registerTuiCommand(program);

program.parse();
