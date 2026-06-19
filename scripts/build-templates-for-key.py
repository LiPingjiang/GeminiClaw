#!/usr/bin/env python3
"""
为指定 E2B API Key 构建回测模板（全量：含 15yr + 3yr 数据）。

用法：
  python3 scripts/build-templates-for-key.py --key KEY2
  python3 scripts/build-templates-for-key.py --key KEY3
  python3 scripts/build-templates-for-key.py --key KEY2 --dry-run

原理：
  从 base 模板出发（所有 key 都能访问），在构建阶段：
  1. pip install duckdb pandas numpy scipy matplotlib requests pyarrow
  2. wget 下载 15yr 数据（~199MB，从能正常访问的 S3Plus URL）
  3. 用 DuckDB 从 15yr 数据中提取最近 3 年子集，生成 3yr parquet
  这样产出的模板和 KEY1 的 15yr 模板完全等价。

数据源：
  - 15yr: https://s3plus-bj02.vip.sankuai.com/openclaw/kline_15yr.parquet (~199MB) ✅ 可用
  - 3yr:  从 15yr 在线生成（规避 S3Plus geminiclaw-data bucket 的 403 问题）
"""

import argparse
import os
import sys

from e2b import Sandbox
from e2b.sandbox.commands.command_handle import CommandExitException

# ---------------------------------------------------------------------------
# API Keys
# ---------------------------------------------------------------------------

KEYS = {
    "KEY1": "e2b_f54df6c095be2d312993f6f2757c47faad67fb07",
    "KEY2": "e2b_c41a5511810565c2e61711c2f4cbfea342d2dfeb",
    "KEY3": "e2b_a92bc4c2475362c2bf6e592c623dcfe2f773ef79",
}

E2B_DOMAIN = "sandbox.sankuai.com"
CPU_COUNT = 4
MEMORY_MB = 8192

# S3Plus 下载地址（仅 15yr 可用）
S3PLUS_15YR = "https://s3plus-bj02.vip.sankuai.com/openclaw/kline_15yr.parquet"

# pip 依赖
PIP_DEPS = "duckdb pandas numpy scipy matplotlib requests pyarrow"

# 用 DuckDB 从 15yr 提取 3yr 子集的脚本
GENERATE_3YR_SCRIPT = r"""
import duckdb
from datetime import datetime, timedelta

# 计算 3 年前的日期
three_years_ago = (datetime.now() - timedelta(days=3*365)).strftime('%Y-%m-%d')
print(f"Filtering 15yr data from {three_years_ago} onwards to generate 3yr subset...")

con = duckdb.connect()

# 先看看 parquet 文件里有哪些列
cols = con.execute("SELECT * FROM '/data/kline_15yr.parquet' LIMIT 0").description
col_names = [c[0] for c in cols]
print(f"Columns ({len(col_names)}): {col_names[:10]}...")

# 尝试找时间列
time_candidates = ['date', 'datetime', 'time', 'timestamp', 'trade_date', 'dt', 'candle_begin_time']
time_col = None
for c in time_candidates:
    if c in col_names:
        time_col = c
        break

if time_col is None:
    # 找不到已知时间列，取第一列（通常是时间列）
    time_col = col_names[0]
    print(f"WARNING: No known time column found, using first column: {time_col}")
else:
    print(f"Using time column: {time_col}")

# 获取总行数和时间范围
total = con.execute("SELECT COUNT(*) FROM '/data/kline_15yr.parquet'").fetchone()[0]
time_range = con.execute(f"SELECT MIN(CAST({time_col} AS VARCHAR)), MAX(CAST({time_col} AS VARCHAR)) FROM '/data/kline_15yr.parquet'").fetchone()
print(f"15yr total rows: {total}, time range: {time_range[0]} ~ {time_range[1]}")

# 过滤并写出
sql = f"COPY (SELECT * FROM '/data/kline_15yr.parquet' WHERE CAST({time_col} AS VARCHAR) >= '{three_years_ago}') TO '/data/kline_3yr.parquet' (FORMAT PARQUET, COMPRESSION ZSTD)"
con.execute(sql)

# 验证
count_3yr = con.execute("SELECT COUNT(*) FROM '/data/kline_3yr.parquet'").fetchone()[0]
print(f"3yr rows: {count_3yr} (filtered from {total})")
print("Done! /data/kline_3yr.parquet generated successfully.")
"""


# ---------------------------------------------------------------------------
# 构建日志回调（兼容不同版本 SDK 的日志格式）
# ---------------------------------------------------------------------------

def on_build_log(entry):
    """通用构建日志回调，兼容多种日志对象格式。"""
    if hasattr(entry, 'message'):
        msg = entry.message
    elif isinstance(entry, dict):
        msg = entry.get('message', str(entry))
    else:
        msg = str(entry)
    
    level = getattr(entry, 'level', None) or (entry.get('level') if isinstance(entry, dict) else None) or 'info'
    level_icon = {"info": "ℹ️", "warn": "⚠️", "error": "❌"}.get(level, "  ")
    print(f"  {level_icon} [{level}] {msg}")


# ---------------------------------------------------------------------------
# 方案一：使用 Template Build API（原方案）
# ---------------------------------------------------------------------------

def build_with_template_api(api_key: str, key_name: str):
    """使用 e2b Template Build API（v2.28+ template_sync）构建模板。"""
    try:
        from e2b.template_sync.main import Template as TemplateBuilder
        from e2b.template_sync import build_api as _build_api
        from e2b.api.client.models import TemplateBuildRequestV3
        from e2b.api.client.types import UNSET
    except ImportError:
        print("❌ e2b Template Build API (template_sync) 不可用，尝试方案二")
        return None

    name = f"backtest-fulldata-{key_name.lower()}"
    print(f"\n{'='*60}")
    print(f"📋 构建全量回测模板: {name} (使用 {key_name})")
    print(f"   方案：Template Build API (e2b v2.28)")
    print(f"{'='*60}")

    # Monkey-patch request_build 以包含 alias 字段（美团私有化后端要求）
    _original_request_build = _build_api.request_build

    def _patched_request_build(client, name, tags, cpu_count, memory_mb):
        """Patched version that sends 'alias' and handles Meituan's response format."""
        from e2b.exceptions import BuildException
        import httpx

        # 直接用 httpx 调 API，绕过 SDK 的响应解析（美团后端返回格式不同）
        url = f"{client._base_url}/v3/templates"
        # 构造认证 header：AuthenticatedClient 用 token/prefix/auth_header_name
        auth_value = f"{client.prefix} {client.token}".strip() if client.prefix else client.token
        auth_header = {client.auth_header_name: auth_value}
        headers = {
            "Content-Type": "application/json",
            **dict(client._headers),
            **auth_header,
        }
        body = {
            "name": name,
            "alias": name,  # 美团后端需要这个字段
            "cpu_count": cpu_count,
            "memory_mb": memory_mb,
        }
        if tags:
            body["tags"] = tags

        resp = httpx.post(url, json=body, headers=headers, timeout=60)
        
        if resp.status_code >= 300:
            raise BuildException(f"{resp.status_code}: {resp.text}")

        data = resp.json()
        print(f"     [debug] API response: {data}")
        
        # 构造一个兼容的 response 对象
        class _Response:
            def __init__(self, d):
                self.template_id = d.get("templateID") or d.get("template_id")
                self.build_id = d.get("buildID") or d.get("build_id")
                self.tags = d.get("tags", [])
                self.names = d.get("names", [name])
        
        return _Response(data)

    # 应用 patch（需要 patch 到 main 模块的命名空间，因为它是 from import 的）
    import e2b.template_sync.main as _template_main
    _build_api.request_build = _patched_request_build
    _template_main.request_build = _patched_request_build

    # 构建脚本：先写入文件再执行（避免 shell 转义问题）
    import base64
    gen_3yr_b64 = base64.b64encode(GENERATE_3YR_SCRIPT.encode()).decode()

    # 构建步骤链
    template = (
        TemplateBuilder()
        .from_template("base")
        .run_cmd(f"pip install --quiet {PIP_DEPS}")
        .run_cmd("sudo mkdir -p /data && sudo chmod 777 /data")
        .run_cmd(f"wget -q --no-check-certificate -O /data/kline_15yr.parquet '{S3PLUS_15YR}'")
        .run_cmd("ls -lh /data/kline_15yr.parquet")
        # 用 base64 解码写入脚本文件，避免 shell 引号转义
        .run_cmd(f"echo '{gen_3yr_b64}' | base64 -d > /tmp/gen_3yr.py")
        .run_cmd("python3 /tmp/gen_3yr.py")
        .run_cmd("ls -lh /data/")
    )

    try:
        print("  → 提交构建请求...")
        build_info = TemplateBuilder.build(
            template,
            name=name,
            cpu_count=CPU_COUNT,
            memory_mb=MEMORY_MB,
            skip_cache=True,
            on_build_logs=on_build_log,
            api_key=api_key,
            domain=E2B_DOMAIN,
        )

        print(f"\n🎉 模板构建成功！")
        print(f"   Template ID: {build_info.template_id}")
        if hasattr(build_info, 'alias'):
            print(f"   Alias:       {build_info.alias}")
        return build_info.template_id
    finally:
        # 恢复原始函数
        _build_api.request_build = _original_request_build
        _template_main.request_build = _original_request_build


# ---------------------------------------------------------------------------
# 方案二：使用 Sandbox + Snapshot（备选方案）
# ---------------------------------------------------------------------------

def build_with_sandbox_snapshot(api_key: str, key_name: str):
    """
    使用 Sandbox.create() + 命令执行 + create_snapshot() 的方式构建模板。
    E2B SDK v2.28+ 推荐方案。
    """
    alias = f"backtest-fulldata-{key_name.lower()}"
    print(f"\n{'='*60}")
    print(f"📋 构建全量回测模板: {alias} (使用 {key_name})")
    print(f"   方案：Sandbox + Snapshot (e2b v2.28)")
    print(f"{'='*60}")

    # 创建沙箱（使用 Sandbox.create() 新 API）
    print("  → 创建 base 沙箱...")
    sbx = Sandbox.create(
        template="base",
        timeout=900,  # 15分钟（下载199MB + 安装 + DuckDB处理）
        api_key=api_key,
        domain=E2B_DOMAIN,
    )
    print(f"  → 沙箱已创建: {sbx.sandbox_id}")

    try:
        # Step 1: 安装依赖
        print("  → 安装 pip 依赖...")
        try:
            sbx.commands.run(f"pip install --quiet {PIP_DEPS}", timeout=180)
            print("  ✅ 依赖安装完成")
        except CommandExitException as e:
            print(f"  ⚠️ pip install 部分失败 (exit={e.exit_code}): {e.stderr[:200]}")
            print("  → 继续...")

        # Step 2: 下载 15yr 数据
        print("  → 下载 15yr 数据（~199MB，可能需要几分钟）...")
        sbx.commands.run("sudo mkdir -p /data && sudo chmod 777 /data", timeout=10)
        result = sbx.commands.run(
            f"wget -q --no-check-certificate -O /data/kline_15yr.parquet '{S3PLUS_15YR}'",
            timeout=300,  # 5分钟下载时间
        )
        if result.exit_code != 0:
            raise RuntimeError(f"下载 15yr 失败 (exit={result.exit_code}): {result.stderr[:500]}")
        
        # 验证下载
        result = sbx.commands.run("ls -lh /data/kline_15yr.parquet", timeout=10)
        print(f"  ✅ 15yr 下载完成: {result.stdout.strip()}")

        # Step 3: 生成 3yr 子集
        print("  → 用 DuckDB 从 15yr 生成 3yr 子集...")
        # 写入脚本文件
        sbx.files.write("/tmp/gen_3yr.py", GENERATE_3YR_SCRIPT)
        try:
            result = sbx.commands.run("python3 /tmp/gen_3yr.py", timeout=120)
            print(f"  ✅ 3yr 生成完成")
            print(f"     {result.stdout.strip()}")
        except CommandExitException as e:
            raise RuntimeError(f"生成 3yr 失败 (exit={e.exit_code}): {e.stderr[:500]}")

        # 验证最终结果
        result = sbx.commands.run("ls -lh /data/", timeout=10)
        print(f"  📁 /data/ 内容:\n     {result.stdout.strip()}")

        # Step 4: 创建快照（模板）
        # 先续命确保沙箱还活着
        try:
            sbx.set_timeout(300)  # 再续 5 分钟
            print("  → 沙箱续命成功")
        except Exception as e:
            print(f"  ⚠️ set_timeout 失败: {e}")
        
        print(f"  → 创建沙箱快照 (name={alias})...")
        snapshot_info = sbx.create_snapshot(name=alias, api_key=api_key, domain=E2B_DOMAIN)
        template_id = snapshot_info.template_id if hasattr(snapshot_info, 'template_id') else str(snapshot_info)
        print(f"  🎉 快照创建成功！")
        print(f"     Template ID: {template_id}")
        if hasattr(snapshot_info, 'name'):
            print(f"     Name:        {snapshot_info.name}")
        return template_id

    except Exception as e:
        print(f"\n  ❌ 构建失败: {e}")
        raise
    finally:
        try:
            sbx.kill()
            print("  → 沙箱已销毁")
        except Exception as e:
            print(f"  ⚠️ 销毁沙箱失败: {e}")


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="为指定 key 构建全量回测模板（含 15yr + 3yr 数据）")
    parser.add_argument("--key", required=True, choices=["KEY1", "KEY2", "KEY3"],
                        help="目标 API Key")
    parser.add_argument("--method", choices=["template", "snapshot", "auto"], default="auto",
                        help="构建方式：template=Template Build API, snapshot=Sandbox快照, auto=自动选择")
    parser.add_argument("--dry-run", action="store_true",
                        help="只打印配置不实际构建")
    args = parser.parse_args()

    key_name = args.key
    api_key = KEYS[key_name]

    os.environ["E2B_DOMAIN"] = E2B_DOMAIN
    os.environ["E2B_API_KEY"] = api_key
    os.environ["E2B_API_URL"] = f"https://api.{E2B_DOMAIN}"

    print(f"🔑 使用 {key_name}: {api_key[:12]}...{api_key[-6:]}")
    print(f"   Domain: {E2B_DOMAIN}")
    print(f"   数据源: {S3PLUS_15YR}")
    print(f"   策略: 下载 15yr + DuckDB 生成 3yr")

    if args.dry_run:
        print("\n[DRY RUN] 以上为配置预览，实际构建跳过。")
        return

    template_id = None

    if args.method in ("template", "auto"):
        template_id = build_with_template_api(api_key, key_name)

    if template_id is None and args.method in ("snapshot", "auto"):
        template_id = build_with_sandbox_snapshot(api_key, key_name)

    if template_id is None:
        print("\n❌ 构建失败，两种方案均未成功。")
        sys.exit(1)

    # 最终汇总
    print(f"\n{'='*60}")
    print(f"📊 {key_name} 模板构建完成")
    print(f"{'='*60}")
    print(f"   Template ID: {template_id}")
    print(f"\n📝 下一步：将此 ID 更新到 worker.ts 的 TEMPLATE_MAP 中：")
    print(f"   '{key_name}': '{template_id}',")


if __name__ == "__main__":
    main()
