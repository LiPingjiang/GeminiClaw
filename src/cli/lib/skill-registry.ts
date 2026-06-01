// @ts-nocheck
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
const REGISTRY_FILE = ".registry.json";
export class SkillRegistry {
    skillsDir;
    data;
    constructor(skillsDir) {
        this.skillsDir = skillsDir;
        this.data = this.load();
    }
    registryPath() {
        return join(this.skillsDir, REGISTRY_FILE);
    }
    load() {
        const path = this.registryPath();
        if (!existsSync(path)) {
            return { version: 1, skills: {} };
        }
        try {
            return JSON.parse(readFileSync(path, "utf-8"));
        }
        catch {
            return { version: 1, skills: {} };
        }
    }
    save() {
        mkdirSync(this.skillsDir, { recursive: true });
        writeFileSync(this.registryPath(), JSON.stringify(this.data, null, 2), "utf-8");
    }
    register(name, opts) {
        this.data.skills[name] = {
            source: opts.source,
            installedAt: new Date().toISOString(),
            version: opts.version ?? null,
            updateUrl: opts.updateUrl ?? null,
        };
        this.save();
    }
    get(name) {
        return this.data.skills[name];
    }
    list() {
        return Object.entries(this.data.skills).map(([name, entry]) => ({
            name,
            ...entry,
        }));
    }
    groupBySource() {
        const groups = {};
        for (const item of this.list()) {
            if (!groups[item.source])
                groups[item.source] = [];
            groups[item.source].push(item);
        }
        return groups;
    }
}
