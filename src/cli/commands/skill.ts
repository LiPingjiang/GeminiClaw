// @ts-nocheck
import { existsSync, cpSync, mkdirSync, statSync } from "fs";
import { join, basename } from "path";
import { resolveWorkspace } from "../lib/workspace.js";
import { printOutput, printError } from "../lib/output.js";
import { SkillRegistry } from "../lib/skill-registry.js";
import { SkillLoader } from "../../skills/loader-full.js";
export function registerSkillCommand(program) {
    const skill = program
        .command("skill")
        .description(`Skill management — list, inspect, install skills with provenance tracking

WHAT
  Manages skills in the skills/ directory. Each skill has a source record
  in skills/.registry.json that tracks where it came from and when.

WHEN (agent guidance)
  Call \`gc skill list\` to discover available capabilities.
  Call \`gc skill info <name>\` before invoking an unfamiliar skill.
  Call \`gc skill sources\` to understand the provenance of all skills.

PROVENANCE
  Every skill has a source field:
    github:obra/superpowers   — from superpowers open-source project
    mt-skillhub:<name>        — from Meituan internal SkillHub
    local                     — manually created or imported
  This enables future update checks via the updateUrl field.

OUTPUT
  Human: formatted skill list with source badges
  JSON:  full registry data`);
    skill
        .command("list")
        .description("List all installed skills with source and version")
        .option("--json", "Output as JSON")
        .action((opts) => {
        const format = opts.json ? "json" : "human";
        try {
            const ws = resolveWorkspace();
            const loaded = SkillLoader.loadSkills(ws.skillsDir);
            const registry = new SkillRegistry(ws.skillsDir);
            const items = loaded.map((s) => {
                const reg = registry.get(s.name);
                return {
                    name: s.name,
                    description: s.description,
                    source: reg?.source ?? "unknown",
                    version: reg?.version ?? null,
                    installedAt: reg?.installedAt ?? null,
                    updateUrl: reg?.updateUrl ?? null,
                };
            });
            const humanText = [
                `📦 Installed skills — ${items.length} total\n`,
                ...items.map((item) => {
                    const badge = item.source === "unknown" ? "⚪" :
                        item.source === "local" ? "🏠" :
                            item.source.startsWith("github:") ? "🐙" : "🏢";
                    const ver = item.version ? ` @${item.version}` : "";
                    return `  ${badge} ${item.name}${ver}\n     ${item.description || "(no description)"}\n     source: ${item.source}`;
                }),
                `\nRun \`gc skill info <name>\` for details.`,
                `Run \`gc skill sources\` to see provenance summary.`,
            ].join("\n");
            printOutput(items, humanText, format);
        }
        catch (e) {
            printError(String(e), format);
        }
    });
    skill
        .command("info <name>")
        .description("Show skill details including provenance and SKILL.md content")
        .option("--json", "Output as JSON")
        .action((name, opts) => {
        const format = opts.json ? "json" : "human";
        try {
            const ws = resolveWorkspace();
            const skills = SkillLoader.loadSkills(ws.skillsDir);
            const s = skills.find((x) => x.name === name);
            if (!s) {
                printError(`Skill not found: ${name}`, format);
                return;
            }
            const reg = new SkillRegistry(ws.skillsDir).get(name);
            const data = { ...s, registry: reg ?? null };
            const preview = s.content.slice(0, 1000);
            const humanText = [
                `📄 Skill: ${s.name}`,
                `Description: ${s.description || "(none)"}`,
                `File: ${s.filePath}`,
                reg
                    ? [`Source: ${reg.source}`, `Version: ${reg.version ?? "unknown"}`,
                        `Installed: ${reg.installedAt}`,
                        reg.updateUrl ? `Update URL: ${reg.updateUrl}` : null]
                        .filter(Boolean).join("\n")
                    : "Source: ⚠️  not registered (no provenance data)",
                `\n--- SKILL.md preview ---\n${preview}${s.content.length > 1000 ? "\n..." : ""}`,
            ].join("\n");
            printOutput(data, humanText, format);
        }
        catch (e) {
            printError(String(e), format);
        }
    });
    skill
        .command("install <path>")
        .description("Install a skill from a local directory")
        .option("--source <source>", "Provenance source (e.g. github:obra/superpowers)", "local")
        .option("--version <version>", "Version label")
        .option("--update-url <url>", "URL for future update checks")
        .option("--name <name>", "Override skill name (default: directory name)")
        .action((skillPath, opts) => {
        try {
            const ws = resolveWorkspace();
            const registry = new SkillRegistry(ws.skillsDir);
            const absPath = skillPath.startsWith("/") ? skillPath : join(process.cwd(), skillPath);
            if (!existsSync(absPath)) {
                console.error(`❌ Path not found: ${absPath}`);
                process.exit(1);
            }
            if (!statSync(absPath).isDirectory()) {
                console.error(`❌ Path must be a directory containing SKILL.md`);
                process.exit(1);
            }
            if (!existsSync(join(absPath, "SKILL.md"))) {
                console.error(`❌ No SKILL.md found in ${absPath}`);
                process.exit(1);
            }
            const name = opts.name ?? basename(absPath);
            const destDir = join(ws.skillsDir, name);
            mkdirSync(destDir, { recursive: true });
            cpSync(absPath, destDir, { recursive: true });
            registry.register(name, {
                source: opts.source,
                version: opts.version,
                updateUrl: opts.updateUrl,
            });
            console.log(`✅ Installed skill: ${name}\n   Source: ${opts.source}`);
            if (opts.version)
                console.log(`   Version: ${opts.version}`);
        }
        catch (e) {
            console.error(`❌ ${e}`);
            process.exit(1);
        }
    });
    skill
        .command("sources")
        .description("Show skill provenance summary grouped by source")
        .option("--json", "Output as JSON")
        .action((opts) => {
        const format = opts.json ? "json" : "human";
        try {
            const ws = resolveWorkspace();
            const registry = new SkillRegistry(ws.skillsDir);
            const groups = registry.groupBySource();
            const humanLines = [`🔍 Skill provenance summary\n`];
            for (const [source, skills] of Object.entries(groups)) {
                humanLines.push(`  ${source} (${skills.length})`);
                for (const s of skills) {
                    const ver = s.version ? ` @${s.version}` : "";
                    humanLines.push(`    • ${s.name}${ver}`);
                }
            }
            if (Object.keys(groups).length === 0) {
                humanLines.push("  No skills registered. Run `gc sync from <path>` to import.");
            }
            printOutput(groups, humanLines.join("\n"), format);
        }
        catch (e) {
            printError(String(e), format);
        }
    });
}
