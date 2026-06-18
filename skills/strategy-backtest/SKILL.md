---
name: strategy-backtest
description: 策略回测探索 — 使用内置 3 年 K 线数据在沙箱中验证量化交易策略
version: 1.2.0
tags: [backtest, quant, strategy, kline, duckdb]
---

# 策略回测探索

> **⚠️ 强制规则：当用户请求回测、策略验证、选股筛选、技术指标计算时，你 MUST 调用 `sandbox_exec` 工具执行真实代码。绝对禁止凭空编造回测数据或模拟结果。所有数值必须来自沙箱实际执行的输出。**

你拥有一个**回测专用沙箱**，内置 3 年全市场 K 线数据（A股/港股/美股/指数），可以直接在沙箱中编写并运行量化策略回测代码。

---

## 数据概览

| 属性 | 值 |
|------|------|
| 文件路径 | `/data/kline_3yr.parquet` |
| 格式 | Parquet (ZSTD 压缩, ~77 MB) |
| 行数 | 6,620,730 |
| 交易日 | 819 天 |
| 时间范围 | 2023-06-01 ~ 2026-06-11 |
| 市场 | SZ(深证 3680只), SH(上证 3396只), HK(港股 3136只), US(美股 256只), INDEX(指数 6只) |

### 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| code | VARCHAR | 股票代码（如 600519、00700、AAPL） |
| market | VARCHAR | 市场标识：SH / SZ / HK / US / INDEX |
| date | VARCHAR | 日期 YYYY-MM-DD |
| open | DOUBLE | 开盘价 |
| high | DOUBLE | 最高价 |
| low | DOUBLE | 最低价 |
| close | DOUBLE | 收盘价 |
| volume | DOUBLE | 成交量 |
| turnover | DOUBLE | 成交额（部分市场为 NaN） |

> **注意**：数据中**没有** pe_ratio、pb_ratio、market_cap、turnover_rate、pctChg 等衍生字段。涨跌幅需自行计算：`(close - prev_close) / prev_close`。

---

## 使用方法

调用 `sandbox_exec` 工具时，设置 `require_backtest_template: true`，即可在回测沙箱中执行代码。

### 基本调用模式

```
sandbox_exec({
  code: "<你的回测 Python 代码>",
  require_backtest_template: true,
  timeout: 300
})
```

### 沙箱环境

- **Python 3.12**
- 预装库：**duckdb 1.5**, pandas 2.2, numpy 1.26, scipy 1.13, matplotlib 3.10, requests
- **pyarrow 未安装** — 必须用 DuckDB 读取 Parquet（`duckdb.sql("SELECT ... FROM '/data/kline_3yr.parquet'").df()`）
- `pd.read_parquet()` 不可用，会报错
- 沙箱有外网访问能力
- 磁盘空间约 10GB 可用

---

## 回测代码模板

### 模板 1：单股票策略回测

```python
import duckdb
import pandas as pd
import numpy as np

# ─── 参数 ───
MARKET = 'SH'
CODE = '600519'  # 贵州茅台
START_DATE = '2024-01-01'
END_DATE = '2025-12-31'
INITIAL_CAPITAL = 1_000_000

# ─── 加载数据（必须用 DuckDB） ───
db = duckdb.connect()
df = db.execute(f"""
    SELECT date, open, high, low, close, volume, turnover
    FROM '/data/kline_3yr.parquet'
    WHERE market='{MARKET}' AND code='{CODE}'
      AND date >= '{START_DATE}' AND date <= '{END_DATE}'
    ORDER BY date
""").df()

print(f"数据加载完成: {len(df)} 条记录, {df['date'].iloc[0]} ~ {df['date'].iloc[-1]}")

# ─── 策略逻辑（示例：双均线交叉） ───
df['ma5'] = df['close'].rolling(5).mean()
df['ma20'] = df['close'].rolling(20).mean()
df['signal'] = 0
df.loc[df['ma5'] > df['ma20'], 'signal'] = 1   # 金叉持仓
df.loc[df['ma5'] <= df['ma20'], 'signal'] = -1  # 死叉空仓

# ─── 回测计算 ───
df['returns'] = df['close'].pct_change()
df['strategy_returns'] = df['signal'].shift(1) * df['returns']
df['cumulative'] = (1 + df['strategy_returns']).cumprod() * INITIAL_CAPITAL
df['benchmark'] = (1 + df['returns']).cumprod() * INITIAL_CAPITAL

# ─── 绩效指标 ───
total_return = (df['cumulative'].iloc[-1] / INITIAL_CAPITAL - 1) * 100
benchmark_return = (df['benchmark'].iloc[-1] / INITIAL_CAPITAL - 1) * 100
sharpe = df['strategy_returns'].mean() / df['strategy_returns'].std() * np.sqrt(252) if df['strategy_returns'].std() > 0 else 0
max_drawdown = ((df['cumulative'].cummax() - df['cumulative']) / df['cumulative'].cummax()).max() * 100

print(f"\n═══ 回测结果 ═══")
print(f"策略收益率: {total_return:.2f}%")
print(f"基准收益率: {benchmark_return:.2f}%")
print(f"超额收益:   {total_return - benchmark_return:.2f}%")
print(f"夏普比率:   {sharpe:.2f}")
print(f"最大回撤:   {max_drawdown:.2f}%")
print(f"交易天数:   {len(df)}")
```

### 模板 2：全市场选股回测（DuckDB 向量化，高性能）

```python
import duckdb
import numpy as np

db = duckdb.connect()

# ─── 用 DuckDB 窗口函数做全市场计算（比 pandas 循环快 100x） ───
db.execute("""
CREATE TABLE kline AS 
SELECT * FROM '/data/kline_3yr.parquet'
WHERE market IN ('SH', 'SZ')
ORDER BY code, date
""")

# 计算技术指标
db.execute("""
CREATE TABLE indicators AS
SELECT code, date, open, close, volume,
  ROW_NUMBER() OVER (PARTITION BY code ORDER BY date) as seq,
  MIN(close) OVER (PARTITION BY code ORDER BY date ROWS BETWEEN 59 PRECEDING AND CURRENT ROW) as min60,
  AVG(close) OVER (PARTITION BY code ORDER BY date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) as ma20,
  AVG(close) OVER (PARTITION BY code ORDER BY date ROWS BETWEEN 4 PRECEDING AND CURRENT ROW) as ma5
FROM kline
""")

# 选股信号：60日新低 + MA5 < MA20 + 价格3~15元
db.execute("""
CREATE TABLE signals AS
SELECT code, date, close
FROM indicators
WHERE seq >= 65
  AND close >= 3 AND close <= 15
  AND close <= min60 * 1.001
  AND ma5 < ma20
""")

sig_count = db.execute("SELECT count(*) FROM signals").fetchone()[0]
print(f"信号数: {sig_count}")

# 回测：T+1开盘买入，T+5收盘卖出
db.execute("""
CREATE TABLE kline_seq AS
SELECT code, date, open, close,
  ROW_NUMBER() OVER (PARTITION BY code ORDER BY date) as seq
FROM kline
""")

trades = db.execute("""
SELECT 
  s.date as signal_date,
  k1.date as buy_date,
  k1.open as buy_price,
  k5.close as sell_price,
  (k5.close - k1.open) / k1.open as return
FROM signals s
JOIN kline_seq ks ON s.code = ks.code AND s.date = ks.date
JOIN kline_seq k1 ON s.code = k1.code AND k1.seq = ks.seq + 1
JOIN kline_seq k5 ON s.code = k5.code AND k5.seq = ks.seq + 5
WHERE k1.open > 0
""").df()

print(f"交易数: {len(trades)}")
print(f"胜率: {(trades['return'] > 0).mean()*100:.1f}%")
print(f"平均收益: {trades['return'].mean()*100:.2f}%")
```

### 模板 3：技术指标扫描

```python
import duckdb

db = duckdb.connect()

# ─── 全市场扫描：均线多头排列 + 放量 ───
df = db.execute("""
    WITH ranked AS (
        SELECT code, market, date, close, volume,
               AVG(close) OVER (PARTITION BY code ORDER BY date ROWS 4 PRECEDING) as ma5,
               AVG(close) OVER (PARTITION BY code ORDER BY date ROWS 9 PRECEDING) as ma10,
               AVG(close) OVER (PARTITION BY code ORDER BY date ROWS 19 PRECEDING) as ma20,
               AVG(volume) OVER (PARTITION BY code ORDER BY date ROWS 4 PRECEDING) as vol_ma5,
               LAG(close) OVER (PARTITION BY code ORDER BY date) as prev_close
        FROM '/data/kline_3yr.parquet'
        WHERE market IN ('SH', 'SZ')
          AND date >= '2025-06-01'
    )
    SELECT code, market, date, close, volume,
           ma5, ma10, ma20,
           (close - prev_close) / prev_close * 100 as change_pct
    FROM ranked
    WHERE date = (SELECT MAX(date) FROM ranked)
      AND ma5 > ma10 AND ma10 > ma20
      AND volume > vol_ma5 * 1.5
      AND close > 5
    ORDER BY change_pct DESC
    LIMIT 30
""").df()

print(f"均线多头 + 放量突破 (最新交易日):")
print(df.to_string(index=False))
```

---

## 策略开发指南

### 回测流程

1. **明确策略逻辑**：用户描述策略思路
2. **编写回测代码**：用 DuckDB SQL 加载数据 + 窗口函数计算指标（高性能），用 pandas/numpy 做复杂逻辑
3. **执行回测**：调用 `sandbox_exec` 并设置 `require_backtest_template: true`
4. **分析结果**：解读收益率、夏普比率、最大回撤等指标
5. **优化迭代**：调整参数、改进逻辑、重新回测

### 性能建议

- **优先用 DuckDB SQL + 窗口函数**做全市场计算，比 pandas groupby 循环快 100 倍
- 全市场 7000 只股票的指标计算，DuckDB 通常 5-10 秒完成
- Python 逐股票循环 7000 只会超时（>5分钟），必须避免
- 如需 pandas，先用 DuckDB 过滤/聚合后再 `.df()` 转换

### 常用 DuckDB 查询模式

```sql
-- 获取单只股票数据
SELECT * FROM '/data/kline_3yr.parquet'
WHERE market='SH' AND code='600519' ORDER BY date;

-- 获取某日全市场数据
SELECT * FROM '/data/kline_3yr.parquet'
WHERE date='2025-06-01' AND market IN ('SH','SZ');

-- 计算移动平均（窗口函数）
SELECT *, AVG(close) OVER (PARTITION BY code ORDER BY date ROWS 19 PRECEDING) as ma20
FROM '/data/kline_3yr.parquet' WHERE market='SH' AND code='600519';

-- 计算涨跌幅
SELECT *, (close - LAG(close) OVER (PARTITION BY code ORDER BY date)) 
         / LAG(close) OVER (PARTITION BY code ORDER BY date) as pct_change
FROM '/data/kline_3yr.parquet' WHERE market='SH' AND code='600519';

-- 跨市场统计
SELECT market, count(DISTINCT code) as symbols, count(*) as rows
FROM '/data/kline_3yr.parquet' GROUP BY market;
```

### 注意事项

- `date` 字段是 VARCHAR 格式，比较时直接用字符串即可
- 回测时注意用 `shift(1)` 或 `LAG()` 避免未来函数（look-ahead bias）
- **不要用 `pd.read_parquet()`**，会报错（无 pyarrow）。必须用 `duckdb.sql(...).df()`
- 大规模全市场扫描建议设置 `timeout: 300`
- 沙箱每次执行是独立的，不保留上次运行的状态
- `turnover` 字段在 A 股大部分为 NaN，不可靠；如需换手率请自行用 volume 估算

---

## 适用场景

- 验证用户提出的交易策略想法
- 选股条件筛选和历史回测
- 技术指标有效性验证
- 多因子模型测试（基于价量数据）
- 市场统计分析（行业轮动、市场宽度等）
- 风险指标计算（VaR、最大回撤、波动率等）
