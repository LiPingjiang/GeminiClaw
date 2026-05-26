// @ts-nocheck
// src/skills/loader.ts
// Skill 加载器 - 扫描并解析 SKILL.md 文件
import { readFileSync } from "fs";
export class SkillLoader {
    /**
     * 扫描指定目录下的所有 SKILL.md 文件
     */
    static loadSkills(skillsDir) {
        // TODO: 实现文件系统扫描
        // 伪实现，实际应该用 fs.readdirSync + 过滤 *_SKILL.md
        return [];
    }
    /**
     * 解析 SKILL.md 文件，提取 frontmatter 和内容
     */
    static parseSkillFile(filePath) {
        try {
            const content = readFileSync(filePath, "utf-8");
            // 简单的 frontmatter 解析（YAML 格式）
            const frontmatter = {};
            let bodyStart = 0;
            if (content.startsWith("---")) {
                const endMarker = content.indexOf("---", 3);
                if (endMarker !== -1) {
                    const fmText = content.slice(3, endMarker).trim();
                    // TODO: 使用 YAML parser，这里简化处理
                    bodyStart = endMarker + 3;
                }
            }
            return {
                name: this.extractSkillName(filePath),
                description: frontmatter.description || "",
                filePath,
                content: content.slice(bodyStart),
                frontmatter,
            };
        }
        catch (error) {
            console.error(`Failed to parse skill file ${filePath}:`, error);
            return null;
        }
    }
    static extractSkillName(filePath) {
        const filename = filePath.split("/").pop()?.replace("_SKILL.md", "") || "unknown";
        return filename;
    }
    /**
     * 将 Skill 转换为系统提示注入格式
     */
    static toSystemPrompt(skills) {
        if (skills.length === 0)
            return "";
        const lines = ["\n## 可用技能"];
        skills.forEach(skill => {
            lines.push(`\n### ${skill.name}`);
            if (skill.description) {
                lines.push(`**描述：** ${skill.description}`);
            }
            lines.push(`**路径：** ${skill.filePath}`);
            // 添加技能内容的关键部分（避免太长）
            const contentPreview = skill.content.slice(0, 500);
            if (contentPreview) {
                lines.push(`\n${contentPreview}${skill.content.length > 500 ? "..." : ""}\n`);
            }
        });
        return lines.join("\n");
    }
}
