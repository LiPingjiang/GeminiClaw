// src/skills/loader.ts
// Skill 加载器 - 完整实现（扫描并解析 SKILL.md 文件）
import { readFileSync, readdirSync, statSync } from "fs";
import { join, basename } from "path";

export interface Skill {
  name: string;
  description: string;
  filePath: string;
  content: string;
  frontmatter: Record<string, string>;
}

export class SkillLoader {
    /**
     * 扫描指定目录下的所有 SKILL.md 文件
     * 支持两种格式：
     * 1. 新格式：<skillname>/SKILL.md（子目录）
     * 2. 旧格式：<skillname>_SKILL.md（平铺，向后兼容）
     */
    static loadSkills(skillsDir: string): Skill[] {
        try {
            if (!this.existsAndIsDir(skillsDir)) {
                console.warn(`Skills directory does not exist: ${skillsDir}`);
                return [];
            }
            const skills = [];
            const entries = readdirSync(skillsDir);
            for (const entry of entries) {
                if (entry === ".registry.json" || entry.startsWith("."))
                    continue;
                const entryPath = join(skillsDir, entry);
                const stat = statSync(entryPath);
                if (stat.isDirectory()) {
                    // 子目录格式：<name>/SKILL.md
                    const skillFile = join(entryPath, "SKILL.md");
                    try {
                        statSync(skillFile);
                        const skill = this.parseSkillFile(skillFile);
                        if (skill)
                            skills.push({ ...skill, name: entry });
                    }
                    catch {
                        // 目录下没有 SKILL.md，跳过
                    }
                }
                else if (this.isSkillFile(entry)) {
                    // 旧格式：<name>_SKILL.md
                    const skill = this.parseSkillFile(entryPath);
                    if (skill)
                        skills.push(skill);
                }
            }
            return skills;
        }
        catch (error) {
            console.error(`Failed to load skills from ${skillsDir}:`, error);
            return [];
        }
    }
    /**
     * 检查路径是否存在且为目录
     */
    static existsAndIsDir(path: string): boolean {
        try {
            const stats = statSync(path);
            return stats.isDirectory();
        }
        catch {
            return false;
        }
    }
    /**
     * 检查文件名是否为技能文件
     */
    static isSkillFile(filename: string): boolean {
        return filename.endsWith("_SKILL.md") && !filename.startsWith(".");
    }
    /**
     * 解析 SKILL.md 文件，提取 frontmatter 和内容
     */
    static parseSkillFile(filePath: string): Skill | null {
        try {
            const content = readFileSync(filePath, "utf-8");
            // 解析 frontmatter (YAML 格式)
            const frontmatter: Record<string, string> = {};
            let bodyStart = 0;
            if (content.startsWith("---")) {
                const endMarker = content.indexOf("---", 3);
                if (endMarker !== -1) {
                    const fmText = content.slice(3, endMarker).trim();
                    Object.assign(frontmatter, this.parseYaml(fmText) as Record<string, string>);
                    bodyStart = endMarker + 3;
                }
            }
            return {
                name: this.extractSkillName(filePath),
                description: (frontmatter as any).description || (frontmatter as any).desc || "",
                filePath,
                content: content.slice(bodyStart).trim(),
                frontmatter,
            };
        }
        catch (error) {
            console.error(`Failed to parse skill file ${filePath}:`, error);
            return null;
        }
    }
    /**
     * 简化的 YAML 解析（仅支持基本键值对）
     */
    static parseYaml(yamlText: string): Record<string, string> {
        const result: Record<string, string> = {};
        const lines = yamlText.split("\n");
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#"))
                continue;
            const colonIndex = trimmed.indexOf(":");
            if (colonIndex > 0) {
                const key = trimmed.slice(0, colonIndex).trim();
                const value = trimmed.slice(colonIndex + 1).trim();
                // 移除值周围的引号
                const cleanValue = value.replace(/^['"](.*)['"]$/, "$1");
                result[key] = cleanValue;
            }
        }
        return result;
    }
    static extractSkillName(filePath: string): string {
        const filename = basename(filePath).replace("_SKILL.md", "");
        return filename;
    }
    /**
     * 将 Skill 转换为系统提示注入格式
     */
    static toSystemPrompt(skills: Skill[]): string {
        if (skills.length === 0)
            return "";
        const lines = ["\n## 可用技能"];
        skills.forEach((skill: Skill) => {
            lines.push(`\n### ${skill.name}`);
            if (skill.description) {
                lines.push(`**描述：** ${skill.description}`);
            }
            lines.push(`**路径：** ${skill.filePath}`);
            // 添加技能内容的关键部分（避免太长）
            const contentPreview = skill.content.slice(0, 800);
            if (contentPreview) {
                lines.push(`\n${contentPreview}${skill.content.length > 800 ? "..." : ""}\n`);
            }
        });
        return lines.join("\n");
    }
}
