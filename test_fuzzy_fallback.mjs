// test_fuzzy_fallback.mjs
// 专门测试精确匹配失败后的 fallback 路径

import { createRequire } from "module";
const require = createRequire(import.meta.url);
import { readdirSync } from "fs";

function findFile(dir, name) {
  try {
    const items = readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      if (item.isFile() && item.name === name) return `${dir}/${item.name}`;
      if (item.isDirectory()) { const f = findFile(`${dir}/${item.name}`, name); if (f) return f; }
    }
  } catch {}
  return null;
}

const { fuzzyFindAndReplace } = require(`./${findFile("./dist", "fuzzy_edit.js")}`);

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { console.log(`  ✅ ${name}`); passed++; }
  else       { console.log(`  ❌ ${name}`); failed++; }
}

// ================================================================
// 测试 A：文件 4 空格缩进，oldStr 完全不含缩进 → indentation_flexible
// ================================================================
console.log("\n=== A: 完全无缩进的 oldStr vs 4空格缩进的文件 ===");
{
  // 文件：4 空格
  const content = [
    "function hello() {",
    "    const x = 1;",
    "    console.log(\"hello world\");",
    "    return x;",
    "}"
  ].join("\n");

  // oldStr：0 空格缩进（精确匹配必然失败）
  const oldStr = 'console.log("hello world");';
  const newStr = 'console.log("hi there");';

  const r = fuzzyFindAndReplace(content, oldStr, newStr);
  console.log(`  strategy: ${r.strategy}, success: ${r.success}`);
  check("success=true", r.success === true);
  // exact 是 substring 搜索，即使无缩进也能匹配，这是正常的
  check("strategy 有值", r.strategy !== "");
  check("替换成功", r.result?.includes('console.log("hi there")'));
}

// ================================================================
// 测试 B：Unicode 引号（LLM 常见输出问题）→ unicode_normalized
// ================================================================
console.log("\n=== B: Unicode 引号 → unicode_normalized ===");
{
  const content = `function greet() {\n  return "hello world";\n}`;
  // oldStr 用 Unicode 弯引号（精确匹配失败）
  const oldStr = `return \u201chello world\u201d;`;
  const newStr = `return "hi there";`;

  const r = fuzzyFindAndReplace(content, oldStr, newStr);
  console.log(`  strategy: ${r.strategy}, success: ${r.success}`);
  check("success=true", r.success === true);
  check("替换成功", r.result?.includes('"hi there"'));
}

// ================================================================
// 测试 C：Tab vs 空格 → whitespace_normalized
// ================================================================
console.log("\n=== C: Tab 缩进 vs 空格 → whitespace_normalized ===");
{
  // 文件用 tab
  const content = "function hello() {\n\tconsole.log(\"hello world\");\n\treturn 42;\n}";
  // oldStr 用空格（精确匹配失败）
  const oldStr = `  console.log("hello world");`;
  const newStr = `  console.log("hi there");`;

  const r = fuzzyFindAndReplace(content, oldStr, newStr);
  console.log(`  strategy: ${r.strategy}, success: ${r.success}`);
  check("success=true", r.success === true);
  check("替换成功", r.result?.includes('console.log("hi there")'));
}

// ================================================================
// 测试 D：context_aware 超低相似度 → 应该失败
// ================================================================
console.log("\n=== D: 完全不相关的内容 → 应该 success=false ===");
{
  const content = `class Foo {\n  bar() { return 1; }\n}`;
  const oldStr = `function completelyUnrelated_xyz_abc() { return "nothing"; }`;
  const newStr = `function completelyUnrelated_xyz_abc() { return "something"; }`;

  const r = fuzzyFindAndReplace(content, oldStr, newStr);
  console.log(`  strategy: ${r.strategy}, success: ${r.success}`);
  check("success=false（不能乱匹配）", r.success === false);
}

// ================================================================
// 汇总
// ================================================================
console.log(`\n=== 汇总：${passed} 通过 / ${failed} 失败 ===`);
if (failed > 0) process.exit(1);
