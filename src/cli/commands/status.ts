// @ts-nocheck
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import yaml from "js-yaml";
import { printOutput, printError } from "../lib/output.js";
import { resolveWorkspace, findConfigFile } from "../lib/workspace.js";
import { SkillLoader } from "../../skills/loader-full.js";
import { SkillRegistry } from "../lib/skill-registry.js";

function getVersion() {
    try {
        const pkgPath = join(process.cwd(), "package.json");
        if (existsSync(pkgPath)) {
            return JSON.parse(readFileSync(pkgPath, "utf-8")).version ?? "unknown";
        }
    } catch {}
    return "unknown";
}

function getGitInfo() {
    try {
        const branch = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf-8" }).trim();
        const commit = execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
        const status = execSync("git status --porcelain", { encoding: "utf-8" }).trim();
        return { branch, commit, dirty: status.length > 0 };
    } catch {
        return { branch: null, commit: null, dirty: false };
    }
}

function checkServer(port) {
    try {
        const out = execSync(`lsof -ti tcp:${port} 2>/dev/null || true`, { encoding: "utf-8" }).trim();
        if (out) {
            return { running: true, pid: parseInt(out.split("\n")[0]) };
        }
    } catch {}
    return { running: false, pid: null };
}

export function registerStatusCommand(program) {
    program
        .command("status")
        .description(`System status — check if GeminiClaw is configured and running correctly

WHAT
  Checks config.yaml, workspace files, installed skills, server process, and git state.
  Returns an overall OK/FAIL indicator plus per-component details.

WHEN (agent guidance)
  Call this at session start to verify the environment is healthy.
  Call this when troubleshooting unexpected behavior.
  Call this before running gc sync to confirm the destination is ready.

OUTPUT
  Human: colored status report with ✅/⚠️/❌ indicators
  JSON:  structured status object with ok:boolean`)
        .option("--json", "Output as JSON")
        .action((opts) => {
            const format = opts.json ? "json" : "human";
            try {
                const version = getVersion();
                const configPath = findConfigFile();
                let serverPort = 3000;
                if (configPath) {
                    try {
                        const raw = yaml.load(readFileSync(configPath, "utf-8"));
                        serverPort = raw?.server?.port ?? 3000;
                    } catch {}
                }
                let workspacePath = null;
                let workspaceFiles = {};
                let skillCount = 0;
                let registeredCount = 0;
                try {
                    const ws = resolveWorkspace();
                    workspacePath = ws.root;
                    workspaceFiles = {
                        "SOUL.md": existsSync(ws.soulFile),
                        "USER.md": existsSync(ws.userFile),
                        "IDENTITY.md": existsSync(ws.identityFile),
                        "MEMORY.md": existsSync(ws.memoryFile),
                        "AGENTS.md": existsSync(ws.agentsFile),
                    };
                    const skills = SkillLoader.loadSkills(ws.skillsDir);
                    skillCount = skills.length;
                    const registry = new SkillRegistry(ws.skillsDir);
                    registeredCount = registry.list().length;
                } catch {}
                const serverInfo = checkServer(serverPort);
                const gitInfo = getGitInfo();
                const result = {
                    ok: !!configPath,
                    version,
                    config: { found: !!configPath, path: configPath },
                    workspace: { found: !!workspacePath, path: workspacePath, files: workspaceFiles },
                    skills: { count: skillCount, registered: registeredCount, unregistered: skillCount - registeredCount },
                    server: { running: serverInfo.running, port: serverPort, pid: serverInfo.pid },
                    git: gitInfo,
                };
                const lines = [
                    `GeminiClaw v${version} — ${result.ok ? "✅ OK" : "❌ NEEDS SETUP"}`,
                    "",
                    `Config:    ${result.config.found ? `✅ ${result.config.path}` : "❌ config.yaml not found"}`,
                    `Workspace: ${result.workspace.found ? `✅ ${result.workspace.path}` : "⚠️  not configured"}`,
                ];
                if (Object.keys(workspaceFiles).length > 0) {
                    for (const [file, exists] of Object.entries(workspaceFiles)) {
                        lines.push(`  ${exists ? "✅" : "⚠️ "} ${file}`);
                    }
                }
                lines.push(
                    `Skills:    ${skillCount} installed, ${registeredCount} with provenance${skillCount - registeredCount > 0 ? `, ${skillCount - registeredCount} unregistered` : ""}`,
                    `Server:    ${serverInfo.running ? `✅ running on :${serverPort} (pid ${serverInfo.pid})` : `⚠️  not running on :${serverPort}`}`,
                    `Git:       ${gitInfo.branch ? `${gitInfo.branch} @ ${gitInfo.commit}${gitInfo.dirty ? " (dirty)" : ""}` : "not a git repo"}`
                );
                if (!result.config.found) {
                    lines.push("", "❓ Config not found. Looked in: cwd, project root, ~/.gemeniclaw/config.yaml");
                    lines.push("   Set GC_CONFIG env var or place config.yaml in one of the above locations.");
                }
                if (!result.workspace.found || Object.values(workspaceFiles).some((v) => !v)) {
                    lines.push("", "Run `gc sync from <claw-workspace-path>` to import identity and memory.");
                }
                printOutput(result, lines.join("\n"), format);
            } catch (e) {
                printError(String(e), format);
            }
        });
}
