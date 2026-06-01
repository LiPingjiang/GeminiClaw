// @ts-nocheck
import { existsSync, readFileSync } from "fs";
import { join, resolve, dirname } from "path";
import os from "os";
import yaml from "js-yaml";

/**
 * 查找 config.yaml，查找顺序：
 *   1. GC_CONFIG 环境变量
 *   2. cwd/config.yaml
 *   3. 向上查找含 package.json(name=geminiclaw) 的目录
 *   4. ~/.gemeniclaw/config.yaml   ← 用户级全局配置
 */
export function findConfigFile(): string | null {
    // 1. 环境变量
    if (process.env.GC_CONFIG) {
        const p = resolve(process.env.GC_CONFIG);
        if (existsSync(p)) return p;
    }
    // 2. cwd
    const cwd = join(process.cwd(), "config.yaml");
    if (existsSync(cwd)) return cwd;
    // 3. 向上找项目根
    let dir = process.cwd();
    for (let i = 0; i < 8; i++) {
        const pkg = join(dir, "package.json");
        if (existsSync(pkg)) {
            try {
                const p = JSON.parse(readFileSync(pkg, "utf-8"));
                if (p.name === "geminiclaw") {
                    const cfg = join(dir, "config.yaml");
                    if (existsSync(cfg)) return cfg;
                }
            } catch {}
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    // 4. 用户级全局配置
    const userCfg = join(os.homedir(), ".gemeniclaw", "config.yaml");
    if (existsSync(userCfg)) return userCfg;

    return null;
}

/**
 * 同 findConfigFile，但找不到时抛异常（兼容旧调用方）
 */
export function requireConfigFile(): string {
    const p = findConfigFile();
    if (!p) throw new Error(
        "config.yaml not found.\n" +
        "Looked in: cwd, project root (package.json), ~/.gemeniclaw/config.yaml\n" +
        "Set GC_CONFIG env var or place config.yaml in one of the above locations."
    );
    return p;
}

export function resolveWorkspace() {
    const configPath = requireConfigFile();
    const projectRoot = dirname(configPath);
    let workspaceDir = ".workspace";
    let skillsDir = "skills";
    try {
        const raw: any = yaml.load(readFileSync(configPath, "utf-8"));
        workspaceDir = raw?.workspace?.dir ?? ".workspace";
        skillsDir = raw?.skills?.dir ?? "skills";
    } catch {
        // use defaults
    }
    const root = resolve(projectRoot, workspaceDir);
    const skillsDirAbs = resolve(projectRoot, skillsDir);
    return {
        root,
        soulFile: join(root, "SOUL.md"),
        userFile: join(root, "USER.md"),
        identityFile: join(root, "IDENTITY.md"),
        memoryFile: join(root, "MEMORY.md"),
        agentsFile: join(root, "AGENTS.md"),
        toolsFile: join(root, "TOOLS.md"),
        memoryDir: join(root, "memory"),
        skillsDir: skillsDirAbs,
    };
}
