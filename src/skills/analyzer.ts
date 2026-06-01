// src/skills/analyzer.ts
// Skill 专用分析器 - 检测技能相关问题并生成进化意图
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { SkillLoader } from "./loader.js";

// 示例 Skill 模板（首次初始化时创建）
const EXAMPLE_SKILL_TEMPLATE = `---
name: example
description: 示例技能 - 展示 SKILL.md 的基本格式
version: 1.0.0
tags: [example, template]
---

# 示例技能

这是一个示例技能文件，说明 GeminiClaw 的技能系统如何工作。

## 功能描述

本技能作为模板存在，向进化引擎展示技能文件的标准结构。
进化引擎可以分析此文件并提出改进建议。

## 使用场景

- 学习 SKILL.md 格式
- 作为新技能的创建模板

## 注意事项

- 每个技能应有清晰的描述（description 字段，至少 10 个字符）
- 内容应足够详细（至少 50 个字符）
`;

export class SkillAnalyzer {
  skillsDir: string;
  db: any;

  constructor(skillsDir: string, db: any) {
    this.skillsDir = skillsDir;
    this.db = db;
  }

  /**
   * 分析技能相关问题和改进机会
   * 注意：bootstrap（初始化）任务直接执行，不生成 intent 进入进化队列，
   * 因为 Mutator 只能修改已存在的文件，无法处理目录创建类任务。
   */
  analyze() {
    // 如果 skills 目录为空，直接执行初始化，不走进化队列
    const skills = SkillLoader.loadSkills(this.skillsDir);
    if (skills.length === 0) {
      console.log("[SkillAnalyzer] No skills found, bootstrapping example skill...");
      this.ensureSkillsExist();
      // 初始化完成，本轮不生成 intent，下次运行时再分析新创建的 skill
      return [];
    }

    const intents: any[] = [];

    // 检查每个技能的健康状态
    for (const skill of skills) {
      const skillIntents = this.analyzeSkillHealth(skill);
      intents.push(...skillIntents);
    }

    return intents;
  }

  /**
   * 确保 skills 目录和示例技能存在（首次初始化）
   */
  private ensureSkillsExist() {
    try {
      const exampleDir = join(this.skillsDir, "example");
      mkdirSync(exampleDir, { recursive: true });
      const skillFile = join(exampleDir, "SKILL.md");
      writeFileSync(skillFile, EXAMPLE_SKILL_TEMPLATE, { encoding: "utf-8" });
      console.log(`[SkillAnalyzer] Created example skill at ${skillFile}`);
    } catch (error) {
      console.error("[SkillAnalyzer] Failed to bootstrap skills:", error);
    }
  }

  analyzeSkillHealth(skill: any) {
    const intents: any[] = [];
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
    for (const skill of skills) {
      this.db.addTrackedFile(skill.filePath, "skill");
    }
  }
}
