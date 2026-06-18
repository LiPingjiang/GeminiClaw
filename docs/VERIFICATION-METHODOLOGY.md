# 初代 Agent 验证方法论 — 可复用检查清单

> 2026-06-15 首次制定。用于检测 GeminiClaw 初代在量化策略回测流程中是否存在数据造假、回测错误、或执行异常。

## 一、审计日志体系（已部署）

审计日志位于 `~/.gemeniclaw/audit/`，三个文件：

| 文件 | 内容 | 关键字段 |
|------|------|----------|
| `sandbox_exec.jsonl` | 沙箱代码执行记录 | ts, event(SUBMIT/SUBMITTED/COMPLETED/FAILED/TIMEOUT), codeHash, taskId, stdout_preview |
| `db_query.jsonl` | DuckDB 写操作记录 | ts, event(WRITE_START/WRITE_OK/WRITE_FAILED), sql(完整SQL), rowsAffected |
| `tool_calls.jsonl` | 所有工具调用记录 | ts, event(TOOL_EXEC_START/TOOL_EXEC_END), toolName, inputPreview, duration |

### 检查流程

1. **数量一致性**：sandbox_exec 的 COMPLETED 数量应与 db_query 的 WRITE_OK 数量匹配（每次回测 = 1次沙箱执行 + 1次DB写入）
2. **时间线合理性**：执行应分散在合理时间段内，而非同一秒内完成多次回测
3. **codeHash 唯一性**：不同策略的代码 hash 应不同；相同策略不同参数允许相同
4. **stdout 真实性**：stdout_preview 应包含回测过程输出（如 DataFrame shape、日期范围），非空非模板化

## 二、回测数据造假识别特征

以下特征是 2026-06-15 首次发现初代造假时的识别信号：

### 2.1 批量 INSERT 时间戳

```sql
-- 造假特征：所有记录的 created_at 完全相同或仅差毫秒
SELECT created_at, COUNT(*) FROM backtest_results GROUP BY created_at;
-- 正常：回测结果应间隔数十秒到数分钟
```

### 2.2 数值统计异常

- **年化收益率 > 50%** 且不是高频策略 → 极可能前视偏差或数据错误
- **夏普比率 > 3.0** 在日频全市场等权组合上 → 几乎不可能
- **不同市场/策略的结果呈规律性分布**（如等差、等比）→ 编造

### 2.3 数据完整性校验

```sql
-- 检查 id 是否连续且无重复
SELECT id, LAG(id) OVER (ORDER BY id) as prev_id,
       id - LAG(id) OVER (ORDER BY id) as gap
FROM backtest_results WHERE gap != 1;

-- 检查是否有 NULL 应有字段
SELECT COUNT(*) FROM backtest_results WHERE annual_return IS NULL OR sharpe IS NULL;
```

## 三、回测方法论质量检查

### 3.1 前视偏差（Look-ahead Bias）检查

```python
# 正确做法：使用 DuckDB LAG() 窗口函数
# 错误做法：pandas shift() 在多股票 DataFrame 上可能跨股票泄露
"""
SELECT *,
  LAG(close, 1) OVER (PARTITION BY code ORDER BY date) as prev_close
FROM kline
"""
```

验证方式：检查策略代码中是否使用了 `LAG()` / `PARTITION BY code`，而非简单 `shift()`。

### 3.2 交易成本合理性

| 市场 | 最低合理单边费率 | 备注 |
|------|-----------------|------|
| A股(SH/SZ) | 0.15% | 含印花税0.05%+佣金0.03%+滑点0.07% |
| 港股(HK) | 0.30% | 含印花税0.13%+佣金0.05%+滑点0.12% |
| 美股(US) | 0.10% | 佣金0.01%+滑点0.09% |

### 3.3 流动性过滤

- A股：日均成交额 > 1000万
- 港股：日均成交额 > 500万（注意：turnover 字段 93% 为 NULL，应使用 `volume * close` 替代）
- 美股：日均成交额 > 500万

### 3.4 过拟合检测

**红旗信号**：3yr 回测漂亮但 15yr 崩塌

```
如果 3yr_annual_return > 15% 且 15yr_max_drawdown > -35%
→ 高概率过拟合，策略不可信
```

### 3.5 样本外验证

- 要求：所有策略必须在 3yr 和 15yr 两个时间窗口同时通过
- 门槛：年化 > 8%，夏普 > 0.8，最大回撤 < -30%

## 四、数据完整性检查

### 4.1 kline_15yr.parquet 覆盖范围确认

```sql
SELECT market, MIN(date), MAX(date), COUNT(DISTINCT code), COUNT(*)
FROM read_parquet('/data/kline_15yr.parquet')
GROUP BY market;
```

预期结果：

| market | min_date | max_date | codes | rows |
|--------|----------|----------|-------|------|
| SH | 2011-01-04 | 2026-06-11 | 3440 | 4.85M |
| SZ | 2011-01-04 | 2026-06-11 | 3731 | 6.21M |
| HK | 2011-01-03 | 2026-06-11 | 3143 | 6.86M |
| US | 2020-01-06 | 2026-06-10 | 256 | 285K |
| INDEX | - | - | 6 | 768 |

**已知问题**：US 只有 6.5 年数据（2020 起），本地无更早美股数据源，需要额外获取。

### 4.2 sandbox_kline_v2.duckdb 数据范围（作为扩展源）

| market | 实际稠密起始 | 备注 |
|--------|-------------|------|
| SH | 1990-12-19 | ✅ 可用于将 A 股延伸至 90 年代 |
| SZ | 1991-01-02 | ✅ 同上 |
| HK | 2020 | ❌ 2007-2019 每年仅 1-7 只，不可用 |
| US | 2023 | ❌ 2020 前几乎为空，不可用 |

## 五、执行流水线端到端验证步骤

1. **发送回测指令给初代** → 通过 `/v1/agent/chat` API
2. **等待执行** → 监控 sandbox_exec.jsonl 出现 SUBMIT → COMPLETED
3. **检查沙箱日志** → stdout_preview 是否包含合理输出
4. **检查 DB 写入** → db_query.jsonl 是否有对应 WRITE_OK
5. **查询回测结果** → `curl localhost:3100/read` 验证数据已入库
6. **交叉验证** → 对比审计日志时间线与数据库 created_at 字段

## 六、策略库管理检查（发现的问题）

### 6.1 当前状态（2026-06-15）

- **不存在 `strategies` 表** — 策略定义无处存储
- `backtest_results` 仅 34 行记录，11 个去重策略
- 无 strategy_type / description / 代码逻辑字段
- 命名不规范：同一策略三种写法（`MA5_MA20` / `MA5/MA20` / `双均线MA5/MA20`）

### 6.2 建议建表

```sql
CREATE TABLE strategies (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  market TEXT,
  strategy_type TEXT,       -- trend / momentum / mean_reversion / multi_factor
  description TEXT,
  code_logic TEXT,          -- 策略代码或规则定义
  parameters JSONB,         -- 参数配置
  version INTEGER DEFAULT 1,
  status TEXT DEFAULT 'active', -- active / archived / testing
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

## 七、快速复用检查命令

```bash
# 1. 查看最近审计日志
tail -20 ~/.gemeniclaw/audit/sandbox_exec.jsonl | jq '.'
tail -20 ~/.gemeniclaw/audit/db_query.jsonl | jq '.'

# 2. 检查回测结果时间分布
curl -s -X POST http://localhost:3100/read \
  -H "Authorization: Bearer gc-sandbox-2026" \
  -H "Content-Type: application/json" \
  -d '{"sql": "SELECT created_at, COUNT(*) as cnt FROM backtest_results GROUP BY created_at ORDER BY created_at"}' | jq '.'

# 3. 检查数据覆盖
curl -s -X POST http://localhost:3100/read \
  -H "Authorization: Bearer gc-sandbox-2026" \
  -H "Content-Type: application/json" \
  -d '{"sql": "SELECT market, MIN(date) as from_d, MAX(date) as to_d, COUNT(DISTINCT code) as stocks, COUNT(*) as rows FROM daily_kline GROUP BY market"}' | jq '.'

# 4. 检查审计日志数量一致性
echo "Sandbox executions: $(grep -c COMPLETED ~/.gemeniclaw/audit/sandbox_exec.jsonl)"
echo "DB writes: $(grep -c WRITE_OK ~/.gemeniclaw/audit/db_query.jsonl)"
```
