// test_fuzzy_diff.mjs
// 测试模糊匹配的核心功能

import { createRequire } from "module";
const require = createRequire(import.meta.url);

import { readdirSync } from "fs";

function findFile(dir, name) {
  try {
    const items = readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      if (item.isFile() && item.name === name) return `${dir}/${item.name}`;
      if (item.isDirectory()) {
        const found = findFile(`${dir}/${item.name}`, name);
        if (found) return found;
      }
    }
  } catch {}
  return null;
}

const fuzzyPath = findFile("./dist", "fuzzy_edit.js");
console.log("fuzzy_edit.js:", fuzzyPath);

if (!fuzzyPath) {
  console.error("❌ 找不到 fuzzy_edit.js，请先 npm run build");
  process.exit(1);
}

const { fuzzyFindAndReplace } = require(`./${fuzzyPath}`);

let passed = 0;
let failed = 0;

function check(name, got, want) {
  if (got === want) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.log(`  ❌ ${name}`);
    console.log(`     期望: ${JSON.stringify(want)}`);
    console.log(`     实际: ${JSON.stringify(got)}`);
    failed++;
  }
}

// ================================================================
// 测试 1：完全精确匹配
// ================================================================
console.log("\n=== 测试 1：完全精确匹配 ===");
{
  const content = `function hello() {\n  console.log("hello world");\n  return 42;\n}`;
  const oldStr = `  console.log("hello world");`;
  const newStr = `  console.log("hi there");`;
  const r = fuzzyFindAndReplace(content, oldStr, newStr);
  check("success=true", r.success, true);
  check("strategy=exact", r.strategy, "exact");
  check("替换结果正确", r.result.includes('console.log("hi there")'), true);
}

// ================================================================
// 测试 2：缩进不一致（diff 里 2 空格，文件里 4 空格）
// ================================================================
console.log("\n=== 测试 2：缩进不一致（触发 indentation_flexible）===");
{
  // 文件里是 4 空格缩进
  const content = `function hello() {\n    console.log("hello world");\n    return 42;\n}`;
  // oldStr 是 2 空格缩进（LLM 生成的 diff 常见问题）
  const oldStr = `  console.log("hello world");`;
  const newStr = `  console.log("hi there");`;
  const r = fuzzyFindAndReplace(content, oldStr, newStr);
  console.log(`  strategy: ${r.strategy}, success: ${r.success}`);
  check("success=true", r.success, true);
  check("替换结果正确", r.result?.includes('console.log("hi there")'), true);
}

// ================================================================
// 测试 3：行尾有多余空格（触发 line_trimmed）
// ================================================================
console.log("\n=== 测试 3：行尾多余空格（触发 line_trimmed）===");
{
  // 文件里行尾有空格
  const content = `function hello() {  \n  console.log("hello world");  \n  return 42;\n}`;
  const oldStr = `  console.log("hello world");`;
  const newStr = `  console.log("hi there");`;
  const r = fuzzyFindAndReplace(content, oldStr, newStr);
  console.log(`  strategy: ${r.strategy}, success: ${r.success}`);
  check("success=true", r.success, true);
  check("替换结果正确", r.result?.includes('console.log("hi there")'), true);
}

// ================================================================
// 测试 4：完全无法匹配（应该 success=false）
// ================================================================
console.log("\n=== 测试 4：完全不存在的内容（应返回 success=false）===");
{
  const content = `function hello() {\n  return 42;\n}`;
  const oldStr = `  console.log("this does not exist in file at all xyz123");`;
  const newStr = `  console.log("hi there");`;
  const r = fuzzyFindAndReplace(content, oldStr, newStr);
  console.log(`  strategy: ${r.strategy}, success: ${r.success}`);
  check("success=false", r.success, false);
}

// ================================================================
// 测试 5：多行 oldStr（模拟真实 diff hunk）
// ================================================================
console.log("\n=== 测试 5：多行替换 ===");
{
  const content = `function hello() {\n  const x = 1;\n  console.log("hello world");\n  return x;\n}`;
  const oldStr = `  console.log("hello world");\n  return x;`;
  const newStr = `  console.log("hi there");\n  return x + 1;`;
  const r = fuzzyFindAndReplace(content, oldStr, newStr);
  console.log(`  strategy: ${r.strategy}, success: ${r.success}`);
  check("success=true", r.success, true);
  check("替换结果正确", r.result?.includes('console.log("hi there")') && r.result?.includes('return x + 1'), true);
}

// ================================================================
// 汇总
// ================================================================
console.log(`\n=== 汇总：${passed} 通过 / ${failed} 失败 ===`);
if (failed > 0) process.exit(1);
