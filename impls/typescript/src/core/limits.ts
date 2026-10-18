// WP5 可选工具侧限流：toolCallLimitMiddleware({ max, behavior })，默认不注册（无调用方）。
// 实现说明（主代理裁定）：WP5 文档原方案借 langchain 的 exitBehavior（'summarize' | 'end'）
// Jump 语义，但 WP1 契约里 wrapToolCall 没有 jump 通道（Jump 只存在于 beforeModel/afterModel），
// 故折中：达到 max 时经 state.emit 发 limit{kind:'tool_calls'} 事件并拒绝执行
//（返回 status:'error' 的 ToolOutcome 回灌说明文本）。
// model_calls 轮次上限由 runTurn 内建（TurnDeps.maxRounds + limit 事件），本中间件仅作可选工具限流。
import type { TurnMiddleware } from './middleware.ts';

export function toolCallLimitMiddleware({ max, behavior }: { max: number; behavior: 'summarize' | 'end' }): TurnMiddleware {
  return {
    name: 'toolCallLimit',
    wrapToolCall(_call, state, next) {
      // state.toolCalls 是已执行次数：前 max 次放行，之后的调用拒绝（不执行、不消耗真实工具）
      if (state.toolCalls >= max) {
        state.emit({ type: 'limit', kind: 'tool_calls', limit: max, behavior });
        return Promise.resolve({
          content: `已达工具调用上限（${max}），本次调用未执行。请基于已有结果直接作答或总结收尾。`,
          status: 'error',
          ms: 0,
        });
      }
      return next();
    },
  };
}
