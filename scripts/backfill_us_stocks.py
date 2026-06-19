#!/usr/bin/env python3
"""
美股历史数据补充脚本。

从腾讯财经 API 抓取 2011-2019 年美股日线数据，
通过 DuckDB 网关 (localhost:3100) 写入 daily_kline 表。

运行方式：
  python3 scripts/backfill_us_stocks.py

特点：
  - 每只股票按年段分批请求（2011-2013, 2014-2016, 2017-2019）
  - 使用 INSERT OR IGNORE 避免重复
  - 每次请求间隔 1 秒避免限频
  - 进度保存到 /tmp/us_backfill_progress.json
  - 支持断点续跑
"""

import json
import os
import ssl
import sys
import time
import urllib.request
import urllib.error

# 禁用 SSL 验证（腾讯 API 证书链问题 + macOS 系统 Python 证书缺失）
SSL_CTX = ssl._create_unverified_context()

# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------

DUCKDB_GW_URL = "http://localhost:3100"
DUCKDB_GW_TOKEN = "gc-sandbox-2026"

QQ_API_BASE = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get"

# 年段分批
YEAR_RANGES = [
    ("2011-01-01", "2013-12-31"),
    ("2014-01-01", "2016-12-31"),
    ("2017-01-01", "2019-12-31"),
]

PROGRESS_FILE = "/tmp/us_backfill_progress.json"
SLEEP_BETWEEN_REQUESTS = 1.0  # 秒
BATCH_INSERT_SIZE = 200  # 每次 INSERT 的最大行数

# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------

def db_read(sql: str):
    """通过网关执行只读 SQL"""
    data = json.dumps({"sql": sql}).encode()
    req = urllib.request.Request(
        f"{DUCKDB_GW_URL}/read",
        data=data,
        headers={"Authorization": f"Bearer {DUCKDB_GW_TOKEN}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except Exception as e:
        print(f"  [ERROR] db_read failed: {e}")
        return None


def db_write(sql: str):
    """通过网关执行写入 SQL"""
    data = json.dumps({"sql": sql}).encode()
    req = urllib.request.Request(
        f"{DUCKDB_GW_URL}/write/sql",
        data=data,
        headers={"Authorization": f"Bearer {DUCKDB_GW_TOKEN}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except Exception as e:
        print(f"  [ERROR] db_write failed: {e}")
        return None


def _fetch_with_suffix(code: str, suffix: str, start: str, end: str):
    """尝试用指定后缀从腾讯 API 获取数据"""
    api_code = f"us{code}{suffix}"
    url = f"{QQ_API_BASE}?param={api_code},day,{start},{end},640,qfq"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req, timeout=15, context=SSL_CTX) as resp:
            raw = json.loads(resp.read())
    except Exception as e:
        return None, e

    data = raw.get("data", {})
    if not isinstance(data, dict):
        return [], None

    code_data = data.get(api_code, data.get(f"us{code}", data.get(code, {})))
    if not isinstance(code_data, dict):
        return [], None

    rows = code_data.get("qfqday", code_data.get("day", []))

    result = []
    for row in rows:
        if len(row) < 6:
            continue
        date_str = row[0]
        if date_str < start or date_str > end:
            continue
        try:
            result.append({
                "date": date_str,
                "open": float(row[1]),
                "close": float(row[2]),
                "high": float(row[3]),
                "low": float(row[4]),
                "volume": float(row[5]),
            })
        except (ValueError, IndexError):
            continue

    return result, None


# 缓存每只股票的有效后缀（.OQ=纳斯达克，.N=纽交所）
_SUFFIX_CACHE: dict = {}


def fetch_qq_kline(code: str, start: str, end: str):
    """从腾讯财经API获取前复权日线数据。
    
    自动探测交易所后缀：
      - .OQ = 纳斯达克 (AAPL, MSFT, NVDA, GOOGL...)
      - .N  = 纽交所 (GS, JPM, BA, GM, V, JNJ...)
    首次请求时两个都尝试，后续用缓存。
    """
    # 如果已知此 code 的正确后缀，直接用
    if code in _SUFFIX_CACHE:
        suffix = _SUFFIX_CACHE[code]
        result, err = _fetch_with_suffix(code, suffix, start, end)
        if err:
            print(f"  [WARN] API request failed for {code}{suffix} ({start}~{end}): {err}")
            return []
        return result

    # 首次请求：尝试 .OQ（纳斯达克）优先，再试 .N（纽交所）
    for suffix in [".OQ", ".N"]:
        result, err = _fetch_with_suffix(code, suffix, start, end)
        if err:
            continue
        if result:
            _SUFFIX_CACHE[code] = suffix
            return result

    # 两个都没数据，默认记为 .OQ
    _SUFFIX_CACHE[code] = ".OQ"
    return []


def insert_rows(code: str, rows: list):
    """批量插入数据"""
    if not rows:
        return 0
    
    total_inserted = 0
    for i in range(0, len(rows), BATCH_INSERT_SIZE):
        batch = rows[i:i + BATCH_INSERT_SIZE]
        values = []
        for r in batch:
            # 转义单引号
            values.append(
                f"('{code}', 'US', '{r['date']}', {r['open']}, {r['high']}, {r['low']}, {r['close']}, {r['volume']}, 0)"
            )
        
        sql = f"INSERT OR IGNORE INTO daily_kline (code, market, date, open, high, low, close, volume, turnover) VALUES {', '.join(values)}"
        result = db_write(sql)
        if result and result.get("status") == "ok":
            total_inserted += result.get("rowsAffected", len(batch))
        else:
            print(f"  [WARN] Insert batch failed for {code}, batch {i//BATCH_INSERT_SIZE + 1}")
    
    return total_inserted


def load_progress():
    """加载进度"""
    if os.path.exists(PROGRESS_FILE):
        with open(PROGRESS_FILE) as f:
            return json.load(f)
    return {"completed_codes": [], "failed_codes": []}


def save_progress(progress):
    """保存进度"""
    with open(PROGRESS_FILE, "w") as f:
        json.dump(progress, f, indent=2)


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

def main():
    print("=" * 60)
    print("美股历史数据补充 (2011-2019)")
    print("=" * 60)
    
    # 获取美股代码列表
    print("\n[1/3] 获取美股代码列表...")
    result = db_read("SELECT DISTINCT code FROM daily_kline WHERE market='US' ORDER BY code")
    if not result or result.get("status") != "ok":
        print("ERROR: 无法获取美股代码列表")
        sys.exit(1)
    
    all_codes = [row["code"] for row in result["data"]]
    print(f"  共 {len(all_codes)} 只美股")
    
    # 加载进度
    progress = load_progress()
    completed = set(progress["completed_codes"])
    remaining = [c for c in all_codes if c not in completed]
    print(f"  已完成: {len(completed)}, 剩余: {len(remaining)}")
    
    if not remaining:
        print("\n所有股票已完成！")
        return
    
    # 逐只补充
    print(f"\n[2/3] 开始补充数据...")
    total_new_rows = 0
    
    for idx, code in enumerate(remaining):
        print(f"\n  [{idx+1}/{len(remaining)}] {code}")
        code_rows = []
        
        for start, end in YEAR_RANGES:
            rows = fetch_qq_kline(code, start, end)
            if rows:
                code_rows.extend(rows)
                print(f"    {start[:4]}~{end[:4]}: {len(rows)} 行")
            else:
                print(f"    {start[:4]}~{end[:4]}: 0 行")
            time.sleep(SLEEP_BETWEEN_REQUESTS)
        
        if code_rows:
            inserted = insert_rows(code, code_rows)
            total_new_rows += inserted
            print(f"    写入: {inserted} 行 (总计抓取 {len(code_rows)})")
        else:
            print(f"    无历史数据")
        
        # 记录完成
        progress["completed_codes"].append(code)
        save_progress(progress)
        
        # 每 10 只输出一次进度
        if (idx + 1) % 10 == 0:
            print(f"\n  --- 进度: {len(progress['completed_codes'])}/{len(all_codes)}, 本轮新增 {total_new_rows} 行 ---\n")
    
    # 最终验证
    print(f"\n[3/3] 验证结果...")
    result = db_read("SELECT MIN(date) as min_d, MAX(date) as max_d, COUNT(DISTINCT code) as stocks, COUNT(*) as rows FROM daily_kline WHERE market='US'")
    if result and result.get("status") == "ok":
        row = result["data"][0]
        print(f"  美股覆盖: {row['min_d']} ~ {row['max_d']}, {row['stocks']}只, {row['rows']}行")
    
    print(f"\n{'='*60}")
    print(f"完成！本轮新增 {total_new_rows} 行")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()
