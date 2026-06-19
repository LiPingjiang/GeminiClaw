#!/usr/bin/env python3
"""
构建 15 年回测专用 E2B 沙箱模板。

策略：基于已有的 backtest-kline-3yr 模板（已包含 duckdb/pandas/numpy），
在构建阶段通过 wget 从 S3Plus 下载 15yr 数据，避免 upload 大文件超时。

数据概况：
  - 总行数: 18,214,580
  - 股票数: 10,569
  - 日期范围: 2011-01-04 ~ 2026-06-11
  - 市场: HK/SZ/SH/US/INDEX
  - 列: code, market, date, open, high, low, close, volume, turnover
  - 文件大小: ~199.3MB (ZSTD)

使用方式：
  python3 scripts/build-backtest-template-15yr.py

环境要求：
  - 本地已安装 me2b (mt-e2b SDK v0.0.3+)
  - 本地能访问 api.sandbox.sankuai.com
  - E2B 沙箱能访问 s3plus-bj02.vip.sankuai.com（美团内网）
"""

import os
import sys

from me2b import Template
from me2b.template.main import TemplateBase
from me2b.template.logger import LogEntry, LogEntryStart, LogEntryEnd

# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------

E2B_DOMAIN = "sandbox.sankuai.com"
E2B_API_KEY = "e2b_f54df6c095be2d312993f6f2757c47faad67fb07"

TEMPLATE_ALIAS = "backtest-kline-15yr"
CPU_COUNT = 4
MEMORY_MB = 8192

# S3Plus 下载地址（美团内网可达）
S3PLUS_URL = "https://s3plus-bj02.vip.sankuai.com/openclaw/kline_15yr.parquet"

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
    # 设置环境变量
    os.environ["E2B_DOMAIN"] = E2B_DOMAIN
    os.environ["E2B_API_KEY"] = E2B_API_KEY
    os.environ["E2B_API_URL"] = f"https://api.{E2B_DOMAIN}"

    # 基于 3yr 模板（它已内含 duckdb/pandas/numpy 和 /data/ 目录结构）
    BASE_TEMPLATE = "backtest-kline-3yr"  # lqp7omxamf1rwy27yrxb

    print(f"📋 构建模板: {TEMPLATE_ALIAS}")
    print(f"   CPU: {CPU_COUNT} cores, Memory: {MEMORY_MB} MB")
    print(f"   基础模板: {BASE_TEMPLATE}")
    print(f"   策略: 构建时 wget 从 S3Plus 下载（不走 upload）")
    print(f"   数据源: {S3PLUS_URL}")

    # 构建模板定义：
    # 1. 基于 3yr 模板（已有 /data/kline_3yr.parquet + Python 环境）
    # 2. wget 下载 15yr 数据到 /data/
    # 3. 保留 3yr 数据作为兼容（或删除节省空间）
    template = (
        TemplateBase()
        .from_template(BASE_TEMPLATE)
        .run_cmd(f"wget -q --no-check-certificate -O /data/kline_15yr.parquet {S3PLUS_URL}")
        .run_cmd("ls -lh /data/")
    )

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

    # 输出结果
    print(f"\n{'='*60}")
    print(f"🎉 模板构建成功！")
    print(f"{'='*60}")
    print(f"   Template ID:  {build_info.template_id}")
    print(f"   Build ID:     {build_info.build_id}")
    print(f"   Alias:        {build_info.alias}")
    print(f"\n📝 更新 worker.ts：")
    print(f"   const BACKTEST_15YR_TEMPLATE_ID = '{build_info.template_id}';")
    print(f"\n   数据路径:")
    print(f"     /data/kline_15yr.parquet  (15年, 199MB, 1821万行)")
    print(f"     /data/kline_3yr.parquet   (3年, 76.8MB, 兼容保留)")
    print(f"\n   查询示例:")
    print(f"     import duckdb")
    print(f"     db = duckdb.connect()")
    print(f"     df = db.execute(\"SELECT * FROM '/data/kline_15yr.parquet' WHERE market='SZ' AND code='000001'\").df()")


if __name__ == "__main__":
    main()
