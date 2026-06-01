// @ts-nocheck
// src/skills/index.ts
// Skill 系统主入口 - 集成到主 Agent 中
import { SkillLoader } from "./loader-full.js";
import { SkillAnalyzer } from "./analyzer.js";
export class SkillSystem {
    skillsDir;
    analyzer;
    constructor(skillsDir) {
        this.skillsDir = skillsDir;
    }
    /**
     * 初始化技能系统
     */
    initialize(db) {
        this.analyzer = new SkillAnalyzer(this.skillsDir, db);
        this.analyzer.registerSkillFiles();
    }
    /**
     * 获取所有技能的元数据
     */
    getSkills() {
        return SkillLoader.loadSkills(this.skillsDir);
    }
    /**
     * 生成技能系统提示
     */
    getSystemPrompt() {
        const skills = this.getSkills();
        return SkillLoader.toSystemPrompt(skills);
    }
    /**
     * 将技能系统提示注入到 Agent 系统提示中
     */
    injectSystemPrompt(basePrompt) {
        const skillPrompt = this.getSystemPrompt();
        if (!skillPrompt) {
            return basePrompt;
        }
        return `${basePrompt}\n${skillPrompt}`;
    }
    /**
     * 获取技能分析器（用于 IntentEngine）
     */
    getAnalyzer() {
        return this.analyzer;
    }
}
export { SkillLoader, SkillAnalyzer };
