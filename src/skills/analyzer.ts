// @ts-nocheck
// src/skills/analyzer.ts
// Skill 专用分析器 - 检测技能相关问题并生成进化意图
import { SkillLoader } from "./loader.js";
export class SkillAnalyzer {
    skillsDir;
    db;
    constructor(skillsDir, db) {
        this.skillsDir = skillsDir;
        this.db = db;
    }
    /**
     * 分析技能相关问题和改进机会
     */
    analyze() {
        const skills = SkillLoader.loadSkills(this.skillsDir);
        const intents = [];
        // 1. 检查技能文件是否存在
        if (skills.length === 0) {
            intents.push(this.createSkillBootstrapIntent());
        }
        // 2. 检查每个技能的健康状态
        for (const skill of skills) {
            const skillIntents = this.analyzeSkillHealth(skill);
            intents.push(...skillIntents);
        }
        return intents;
    }
    createSkillBootstrapIntent() {
        const now = Date.now();
        return {
            id: `skill-bootstrap-${now}`,
            type: "bootstrap",
            description: "初始化 Skill 系统 - 创建基础技能目录和示例技能",
            targetFiles: [this.skillsDir],
            evidence: ["No skills found in directory"],
            riskLevel: "low",
            status: "pending",
            createdAt: now,
            updatedAt: now,
        };
    }
    analyzeSkillHealth(skill) {
        const intents = [];
        const now = Date.now();
        // 检查技能描述是否完整
        if (!skill.description || skill.description.length < 10) {
            intents.push({
                id: `skill-desc-${skill.name}-${now}`,
                type: "behavior_fix",
                description: `完善技能 "${skill.name}" 的描述信息`,
                targetFiles: [skill.filePath],
                evidence: ["Skill description is missing or too short"],
                riskLevel: "low",
                status: "pending",
                createdAt: now,
                updatedAt: now,
            });
        }
        // 检查技能内容是否完整
        if (skill.content.length < 50) {
            intents.push({
                id: `skill-content-${skill.name}-${now}`,
                type: "behavior_fix",
                description: `扩展技能 "${skill.name}" 的实现内容`,
                targetFiles: [skill.filePath],
                evidence: ["Skill content is too short or incomplete"],
                riskLevel: "medium",
                status: "pending",
                createdAt: now,
                updatedAt: now,
            });
        }
        return intents;
    }
    /**
     * 注册技能文件到追踪系统，使进化仪式可以修改它们
     */
    registerSkillFiles() {
        const skills = SkillLoader.loadSkills(this.skillsDir);
        // 将技能文件添加到追踪列表，让 TraceAnalyzer 等可以监控
        for (const skill of skills) {
            this.db.addTrackedFile(skill.filePath, "skill");
        }
    }
}
