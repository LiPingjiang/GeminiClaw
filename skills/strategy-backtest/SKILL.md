---
name: strategy-backtest
description: 策略回测探索 — 使用内置 3 年 K 线数据在沙箱中验证量化交易策略
version: 1.1.0
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
| 格式 | Parquet (ZSTD 压缩, 76.8 MB) |
| 行数 | 6,620,730 |
| 时间范围 | 2023-01-01 ~ 2026-06-13 |
| 市场 | SH(上证), SZ(深证), HK(港股), US(美股), INDEX(指数) |

### 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| date | VARCHAR | 日期 YYYY-MM-DD |
| code | VARCHAR | 股票代码 |
| market | VARCHAR | 市场标识 (SH/SZ/HK/US/INDEX) |
| open | DOUBLE | 开盘价 |
| high | DOUBLE | 最高价 |
| low | DOUBLE | 最低价 |
| close | DOUBLE | 收盘价 |
| volume | BIGINT | 成交量 |
| amount | DOUBLE | 成交额 |
| turnover_rate | DOUBLE | 换手率 |
| pe_ratio | DOUBLE | 市盈率 |
| pb_ratio | DOUBLE | 市净率 |
| market_cap | DOUBLE | 总市值 |

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

- Python 3.11
- 预装库：duckdb, pandas, numpy, scipy, matplotlib
- DuckDB 可直接读取 Parquet 文件，无需 pyarrow
- 沙箱有外网访问能力

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

# ─── 加载数据 ───
db = duckdb.connect()
df = db.execute(f"""
    SELECT date, open, high, low, close, volume, amount, turnover_rate
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

### 模板 2：多股票选股策略

```python
import duckdb
import pandas as pd
import numpy as np

db = duckdb.connect()

# ─── 选股：低 PE + 高换手 ───
TARGET_DATE = '2025-01-02'
df = db.execute(f"""
    SELECT code, market, close, pe_ratio, pb_ratio, turnover_rate, market_cap
    FROM '/data/kline_3yr.parquet'
    WHERE market IN ('SH', 'SZ')
      AND date = '{TARGET_DATE}'
      AND pe_ratio > 0 AND pe_ratio < 30
      AND turnover_rate > 3
      AND market_cap > 10000000000
    ORDER BY pe_ratio ASC
    LIMIT 20
""").df()

print(f"选股结果 ({TARGET_DATE}):")
print(df.to_string(index=False))

# ─── 回测选出的股票组合未来 N 天表现 ───
codes = df['code'].tolist()
codes_str = ','.join([f"'{c}'" for c in codes])

future = db.execute(f"""
    SELECT code, date, close
    FROM '/data/kline_3yr.parquet'
    WHERE market IN ('SH', 'SZ')
      AND code IN ({codes_str})
      AND date >= '{TARGET_DATE}'
    ORDER BY code, date
""").df()

# 计算每只股票的累计收益
results = []
for code in codes:
    stock_df = future[future['code'] == code].reset_index(drop=True)
    if len(stock_df) > 1:
        ret = (stock_df['close'].iloc[-1] / stock_df['close'].iloc[0] - 1) * 100
        results.append({'code': code, 'return_pct': ret, 'days': len(stock_df)})

result_df = pd.DataFrame(results).sort_values('return_pct', ascending=False)
print(f"\n组合表现 (持有至今):")
print(result_df.to_string(index=False))
print(f"\n等权组合平均收益: {result_df['return_pct'].mean():.2f}%")
```

### 模板 3：技术指标扫描

```python
import duckdb
import pandas as pd

db = duckdb.connect()

# ─── 全市场扫描：MACD 金叉 + 放量 ───
df = db.execute("""
    WITH ranked AS (
        SELECT code, market, date, close, volume, amount,
               AVG(close) OVER (PARTITION BY code ORDER BY date ROWS 11 PRECEDING) as ema12,
               AVG(close) OVER (PARTITION BY code ORDER BY date ROWS 25 PRECEDING) as ema26,
               AVG(volume) OVER (PARTITION BY code ORDER BY date ROWS 4 PRECEDING) as vol_ma5,
               LAG(close) OVER (PARTITION BY code ORDER BY date) as prev_close
        FROM '/data/kline_3yr.parquet'
        WHERE market IN ('SH', 'SZ')
          AND date >= '2025-06-01'
    )
    SELECT code, market, date, close, volume, vol_ma5,
           ema12 - ema26 as dif,
           (close - prev_close) / prev_close * 100 as change_pct
    FROM ranked
    WHERE date = (SELECT MAX(date) FROM ranked)
      AND ema12 > ema26
      AND volume > vol_ma5 * 1.5
    ORDER BY (close - prev_close) / prev_close DESC
    LIMIT 30
""").df()

print(f"MACD 金叉 + 放量突破 (最新交易日):")
print(df.to_string(index=False))
```

---

## 策略开发指南

### 回测流程

1. **明确策略逻辑**：用户描述策略思路（如"均线交叉"、"低PE选股"、"动量突破"）
2. **编写回测代码**：基于上述模板，用 DuckDB SQL 加载数据，用 pandas/numpy 计算信号
3. **执行回测**：调用 `sandbox_exec` 并设置 `require_backtest_template: true`
4. **分析结果**：解读收益率、夏普比率、最大回撤等指标
5. **优化迭代**：调整参数、改进逻辑、重新回测

### 常用 DuckDB 查询模式

```sql
-- 获取单只股票数据
SELECT * FROM '/data/kline_3yr.parquet'
WHERE market='SH' AND code='600519' ORDER BY date;

-- 获取某日全市场数据
SELECT * FROM '/data/kline_3yr.parquet'
WHERE date='2025-06-01' AND market IN ('SH','SZ');

-- 计算移动平均
SELECT *, AVG(close) OVER (PARTITION BY code ORDER BY date ROWS 19 PRECEDING) as ma20
FROM '/data/kline_3yr.parquet' WHERE market='SH' AND code='600519';

-- 跨市场对比
SELECT market, AVG((close-open)/open*100) as avg_change
FROM '/data/kline_3yr.parquet' WHERE date='2025-06-01'
GROUP BY market;
```

### 注意事项

- date 字段是 VARCHAR 格式，比较时直接用字符串即可
- 回测时注意用 `shift(1)` 避免未来函数（look-ahead bias）
- 大规模全市场扫描可能需要 30-60 秒，建议设置 `timeout: 300`
- 沙箱每次执行是独立的，不保留上次运行的状态
- 如需绘图，可用 matplotlib 生成图片并 base64 输出

---

## 适用场景

- 验证用户提出的交易策略想法
- 选股条件筛选和历史回测
- 技术指标有效性验证
- 多因子模型测试
- 市场统计分析（行业轮动、市场宽度等）
- 风险指标计算（VaR、最大回撤、波动率等）
