// 工具参数取值助手：模型给的 arguments 解出来是 map[string]any，
// 取值统一在这里收敛，工具壳各自保持一行调用的可读性。
package tools

import (
	"strconv"
)

// argString 取字符串参数（缺省/类型不符返回空串）。
func argString(args map[string]any, key string) string {
	if v, ok := args[key]; ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

// argNumber 取数值参数；JSON 数值是 float64，字符串数字也顺带解析，缺省返回 def。
func argNumber(args map[string]any, key string, def float64) float64 {
	v, ok := args[key]
	if !ok {
		return def
	}
	switch n := v.(type) {
	case float64:
		return n
	case string:
		if f, err := strconv.ParseFloat(n, 64); err == nil {
			return f
		}
	}
	return def
}

// argBool 取布尔参数（仅显式 true 为真）。
func argBool(args map[string]any, key string) bool {
	v, _ := args[key].(bool)
	return v
}
