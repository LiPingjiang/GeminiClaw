#!/usr/bin/env python3
"""
构建回测专用 E2B 沙箱模板。

将 3 年 K 线数据（A股/港股/美股，~76.8MB Parquet）烤进自定义模板，
基础模板已有 duckdb + pandas + numpy，无需额外安装。

使用方式：
  1. 先从腾讯云下载 parquet：
     scp root@49.232.173.252:/tmp/kline_3yr.parquet /tmp/kline_3yr.parquet
  2. 运行本脚本：
     python3 scripts/build-backtest-template.py

环境要求：
  - 本地已安装 me2b (mt-e2b SDK v0.0.3+)
  - 本地能访问 api.sandbox.sankuai.com

已知问题：
  - 如果遇到 "syncing took too long" 错误，使用 skip_cache=True 重试（FAQ #13）
"""

import os
import sys
from pathlib import Path

from me2b import Template
from me2b.template.main import TemplateBase
from me2b.template.logger import LogEntry, LogEntryStart, LogEntryEnd

# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------

# E2B 连接配置
E2B_DOMAIN = "sandbox.sankuai.com"
E2B_API_KEY = "e2b_f54df6c095be2d312993f6f2757c47faad67fb07"  # KEY1，唯一能用自定义模板

# 数据文件路径（从腾讯云 scp 下来的）
PARQUET_FILE = "/tmp/kline_3yr.parquet"

# 模板配置
TEMPLATE_ALIAS = "backtest-kline-3yr"
CPU_COUNT = 4
MEMORY_MB = 8192  # 8GB，与现有自定义模板一致

# ---------------------------------------------------------------------------
# 构建日志回调
# ---------------------------------------------------------------------------

def on_build_log(entry):
    """打印构建日志。"""
    if isinstance(entry, LogEntryStart):
        print(f"\n{'='*60}")
        print(f"🚀 {entry.message}")
        print(f"{'='*60}")
    elif isinstance(entry, LogEntryEnd):
        print(f"\n{'='*60}")
        print(f"✅ {entry.message}")
        print(f"{'='*60}")
    elif isinstance(entry, LogEntry):
        level_icon = {"info": "ℹ️", "warn": "⚠️", "error": "❌"}.get(entry.level, "  ")
        print(f"  {level_icon} [{entry.level}] {entry.message}")


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

def main():
    # 1. 检查 parquet 文件是否存在
    if not Path(PARQUET_FILE).exists():
        print(f"❌ 找不到数据文件: {PARQUET_FILE}")
        print(f"   请先从腾讯云下载：")
        print(f"   scp root@49.232.173.252:/tmp/kline_3yr.parquet {PARQUET_FILE}")
        sys.exit(1)

    file_size_mb = Path(PARQUET_FILE).stat().st_size / (1024 * 1024)
    print(f"📦 数据文件: {PARQUET_FILE} ({file_size_mb:.1f} MB)")

    # 2. 设置环境变量（SDK 会读取）
    os.environ["E2B_DOMAIN"] = E2B_DOMAIN
    os.environ["E2B_API_KEY"] = E2B_API_KEY
    os.environ["E2B_API_URL"] = f"https://api.{E2B_DOMAIN}"  # 本地 Mac 无 appenv，需显式指定

    # 3. 定义模板
    # 基于现有 dragon-stock-super 模板（用 alias 引用），已有 Python + duckdb + pandas + numpy
    BASE_TEMPLATE = "dragon-stock-super"  # alias for gaqgjsh2dh4i7dqr8ts7

    print(f"\n📋 构建模板: {TEMPLATE_ALIAS}")
    print(f"   CPU: {CPU_COUNT} cores, Memory: {MEMORY_MB} MB")
    print(f"   基础模板: {BASE_TEMPLATE}")
    print(f"   数据: /data/kline_3yr.parquet ({file_size_mb:.1f} MB)")
    print(f"   策略: skip_cache=True（跳过构建缓存，解决 envd sync 超时）")

    # file_context_path 设为 /tmp，这样 copy 的 arcname 就是 kline_3yr.parquet（不含路径前缀）
    template = (
        TemplateBase(file_context_path="/tmp")
        .from_template(BASE_TEMPLATE)
        .run_cmd("mkdir -p /data")
        .copy("kline_3yr.parquet", "/data/", force_upload=True)
    )

    # 4. 构建并部署模板（skip_cache=True 解决 envd syncing took too long）
    print(f"\n🔨 开始构建（skip_cache=True）...")
    build_info = Template.build(
        template,
        alias=TEMPLATE_ALIAS,
        cpu_count=CPU_COUNT,
        memory_mb=MEMORY_MB,
        skip_cache=True,
        on_build_logs=on_build_log,
        api_key=E2B_API_KEY,
        domain=E2B_DOMAIN,
    )

    # 5. 输出结果
    print(f"\n{'='*60}")
    print(f"🎉 模板构建成功！")
    print(f"{'='*60}")
    print(f"   Template ID:  {build_info.template_id}")
    print(f"   Build ID:     {build_info.build_id}")
    print(f"   Alias:        {build_info.alias}")
    print(f"\n📝 请将以下信息更新到 worker.ts 和初代记忆中：")
    print(f"   const BACKTEST_TEMPLATE_ID = '{build_info.template_id}';")
    print(f"\n   初代使用方式：")
    print(f"   在沙箱任务中指定 template: '{build_info.template_id}'")
    print(f"   数据路径: /data/kline_3yr.parquet")
    print(f"   查询示例:")
    print(f"     import duckdb")
    print(f"     db = duckdb.connect()")
    print(f"     df = db.execute(\"SELECT * FROM '/data/kline_3yr.parquet' WHERE market='SH' AND code='600519'\").df()")


if __name__ == "__main__":
    main()
