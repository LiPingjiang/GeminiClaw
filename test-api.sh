#!/bin/bash

# test-api.sh - API 测试脚本

set -e

echo "🧪 GeminiClaw API 测试脚本"
echo "================================"

# 配置
API_URL="http://127.0.0.1:18889/v1/agent/chat"
AUTH_HEADER="Authorization: Bearer gemeniclaw-local-dev-token-2026"
CONTENT_TYPE="Content-Type: application/json"

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 测试函数
test_api() {
    local name="$1"
    local message="$2"
    local session_id="test-$(date +%s)-$RANDOM"
    
    echo -e "\n${YELLOW}测试: $name${NC}"
    echo "消息: $message"
    
    local response=$(curl -s -X POST "$API_URL" \
        -H "$CONTENT_TYPE" \
        -H "$AUTH_HEADER" \
        -d "{\"message\":\"$message\",\"session_id\":\"$session_id\"}" \
        --max-time 10)
    
    if echo "$response" | grep -q "response"; then
        echo -e "${GREEN}✅ 成功${NC}"
        echo "响应: $(echo "$response" | jq -r '.response' | head -2)"
        return 0
    else
        echo -e "${RED}❌ 失败${NC}"
        echo "错误: $response"
        return 1
    fi
}

# 检查服务是否运行
if ! curl -s "$API_URL" > /dev/null; then
    echo -e "${RED}❌ 服务未运行，请先启动 GeminiClaw${NC}"
    exit 1
fi

echo -e "${GREEN}✅ 服务正常响应${NC}"

# 执行测试
test_api "普通聊天" "你好，介绍一下你自己"
test_api "进化命令" "/进化"
test_api "进化预览" "/进化 预览 1"
test_api "帮助命令" "/help"

echo -e "\n${GREEN}🎉 所有测试完成！${NC}"