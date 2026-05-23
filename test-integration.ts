// test-integration.ts - 测试完整的技能+进化集成

import { SkillSystem } from "./src/skills/index.js"
import { join } from "path"

async function testIntegration() {
  console.log("🧪 开始集成测试...")

  try {
    // 1. 测试技能系统
    const skillsDir = join(process.cwd(), "skills")
    const skillSystem = new SkillSystem(skillsDir)
    
    console.log("✅ 技能系统初始化成功")
    
    // 2. 测试系统提示生成
    const systemPrompt = skillSystem.getSystemPrompt()
    console.log("\n📝 技能系统提示:")
    console.log(systemPrompt.slice(0, 300) + "...")
    
    // 3. 测试命令解析
    const { CommandParser } = await import("./src/agent/command-parser.js")
    
    const testCommands = [
      "/进化",
      "/进化 预览 1", 
      "/进化 确认 2",
      "/进化 拒绝 3",
      "/进化 运行",
      "你好，帮我做点事情"
    ]
    
    console.log("\n🔍 命令解析测试:")
    testCommands.forEach(cmd => {
      const isCmd = CommandParser.isCommand(cmd)
      const match = CommandParser.parseCommand(cmd)
      console.log(`\"${cmd}\" -> isCommand: ${isCmd}, parsed: ${match ? JSON.stringify(match) : 'null'}