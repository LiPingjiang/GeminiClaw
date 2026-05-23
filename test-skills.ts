// test-skills.ts - 测试技能系统

import { SkillLoader } from "./src/skills/loader-full.js"
import { SkillSystem } from "./src/skills/index.js"
import { join } from "path"
import { mkdirSync } from "fs"

async function testSkills() {
  console.log("🧪 开始测试技能系统...")

  try {
    // 1. 测试技能目录创建
    const skillsDir = join(process.cwd(), "skills")
    mkdirSync(skillsDir, { recursive: true })
    console.log(`✅ 技能目录已创建: ${skillsDir}`)

    // 2. 测试技能加载
    const skills = SkillLoader.loadSkills(skillsDir)
    console.log(`✅ 加载到 ${skills.length} 个技能:`)
    skills.forEach(skill => {
      console.log(`  - ${skill.name}: ${skill.description}`)
    })

    // 3. 测试系统提示生成
    const systemPrompt = SkillLoader.toSystemPrompt(skills)
    console.log("\n📝 生成的系统提示:")
    console.log(systemPrompt.slice(0, 500) + (systemPrompt.length > 500 ? "..." : ""))

    // 4. 测试技能系统
    const skillSystem = new SkillSystem(skillsDir)
    console.log("\n✅ 技能系统初始化成功")
    
    const injectedPrompt = skillSystem.injectSystemPrompt("你是一个AI助手。")
    console.log("\n📝 注入后的系统提示:")
    console.log(injectedPrompt.slice(0, 500) + (injectedPrompt.length > 500 ? "..." : ""))

    console.log("\n🎉 技能系统测试完成！")

  } catch (error) {
    console.error("❌ 测试失败:", error)
    process.exit(1)
  }
}

// 运行测试
testSkills()