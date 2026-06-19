#!/usr/bin/env python3
"""
构建 15 年回测专用 E2B 沙箱模板（v2 — 全量重导出版）。

与 v1 的区别：
  v1 数据 kline_15yr.parquet  —— 港股仅从 2011 起，1821 万行
  v2 数据 kline_full_15yr.parquet —— 从初代数据库全量重导出并清洗（过滤负价格脏数据）

数据概况（v2，已过滤 71.4 万负价格脏数据）：
  - 总行数: 22,441,883
  - 市场/范围:
      HK    1980-01-03 ~ 2026-06-15  3144 只  8,999,016 行
      SH    1990-12-19 ~ 2026-06-15  3464 只  5,994,554 行
      SZ    1991-01-02 ~ 2026-06-15  3754 只  7,161,770 行
      US    2020-01-06 ~ 2026-06-12   256 只    285,763 行
      INDEX 2025-12-01 ~ 2026-06-15     6 只        780 行
  - 列: code, market, date, open, high, low, close, volume, turnover
  - 文件大小: 251 MB (263,674,873 bytes, ZSTD)

策略：基于已有的 backtest-kline-3yr 模板（已含 duckdb/pandas/numpy），
在构建阶段通过 wget 从 S3Plus 下载数据，避免 upload 大文件超时。

使用方式：
  python3 scripts/build-backtest-template-15yr-v2.py
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

TEMPLATE_ALIAS = "backtest-kline-15yr-v2"
CPU_COUNT = 4
MEMORY_MB = 8192

# S3Plus 下载地址（美团内网可达；E2B 沙箱可访问 sankuai.com 域名）
S3PLUS_URL = "https://s3plus-bj02.vip.sankuai.com/openclaw/kline_full_15yr.parquet"

# 预期文件大小（字节），用于构建时完整性校验
EXPECTED_BYTES = 263674873

# ---------------------------------------------------------------------------
# 构建日志回调
# ---------------------------------------------------------------------------

def on_build_log(entry):
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
    os.environ["E2B_DOMAIN"] = E2B_DOMAIN
    os.environ["E2B_API_KEY"] = E2B_API_KEY
    os.environ["E2B_API_URL"] = f"https://api.{E2B_DOMAIN}"

    BASE_TEMPLATE = "backtest-kline-3yr"  # 已内含 duckdb/pandas/numpy + /data/ 目录

    print(f"📋 构建模板: {TEMPLATE_ALIAS}")
    print(f"   CPU: {CPU_COUNT} cores, Memory: {MEMORY_MB} MB")
    print(f"   基础模板: {BASE_TEMPLATE}")
    print(f"   数据源: {S3PLUS_URL}")
    print(f"   预期大小: {EXPECTED_BYTES:,} bytes")

    # 构建步骤：
    # 1. wget 下载全量数据到 /data/kline_15yr.parquet（沿用现有查询路径）
    # 2. 校验文件大小与 parquet magic
    # 3. ls 确认
    template = (
        TemplateBase()
        .from_template(BASE_TEMPLATE)
        .run_cmd(
            f"wget -q --no-check-certificate -O /data/kline_15yr.parquet '{S3PLUS_URL}'"
        )
        .run_cmd(
            f"ACTUAL=$(wc -c < /data/kline_15yr.parquet); "
            f"if [ \"$ACTUAL\" = \"{EXPECTED_BYTES}\" ]; then echo SIZE_OK; "
            f"else echo \"SIZE_MISMATCH actual=$ACTUAL expected={EXPECTED_BYTES}\"; exit 1; fi"
        )
        .run_cmd(
            "if head -c4 /data/kline_15yr.parquet | grep -q PAR1; "
            "then echo PARQUET_MAGIC_OK; else echo BAD_MAGIC; exit 1; fi"
        )
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

    print(f"\n{'='*60}")
    print(f"🎉 模板构建成功！")
    print(f"{'='*60}")
    print(f"   Template ID:  {build_info.template_id}")
    print(f"   Build ID:     {build_info.build_id}")
    print(f"   Alias:        {build_info.alias}")
    print(f"\n   数据路径: /data/kline_15yr.parquet  (251MB, 2244万行, 已清洗)")
    print(f"\n   查询示例:")
    print(f"     import duckdb")
    print(f"     db = duckdb.connect()")
    print(f"     df = db.execute(\"SELECT * FROM '/data/kline_15yr.parquet' WHERE market='HK' AND code='00700'\").df()")


if __name__ == "__main__":
    main()
