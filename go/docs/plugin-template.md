# 插件模板：加一个新能力

清单在 `src/plugins/index.ts`——**加插件 = 加一个文件 + 清单一行**，核心零改动。

## 加一个工具

最小骨架（完整活例见 `src/plugins/tools/todo.ts`）：

```ts
// src/plugins/tools/my-tool.ts
import { definePlugin } from '../../kernel/plugin.ts';

export default definePlugin({
  name: 'my-tool',                    // 模型可见的工具名，全注册表唯一
  kind: 'tool',
  description: '一句话说清工具干什么、什么时候用——模型的选用依据，写好它比什么都重要。',
  parameters: {                       // JSON Schema，直传 function calling
    type: 'object',
    properties: { /* ... */ },
    required: [ /* ... */ ],
  },
  needsPermission: false,             // 会写文件/执行命令/碰网络 → true（走权限确认）
  preview: (a) => `my-tool ${String(a.x ?? '')}`,   // 确认界面展示"将要做什么"
  async run(args) {
    // 错误一律 return '错误：...' 文本（让模型自己纠正），不要 throw
    return '结果文本';
  },
});
```

然后在 `src/plugins/index.ts`：

```ts
import myToolPlugin from './tools/my-tool.ts';
// ...
export const builtinPlugins: Plugin[] = [ /* ... */ myToolPlugin, /* ... */ ];
```

规则：

- **一工具一文件**；共享逻辑放同目录非插件文件（参考 `rg.ts`/`pathguard.ts`）。
- 涉及文件路径的，过 `pathguard.ts` 的 `resolvePath`：越出工作目录要在 `preview` 里醒目提示。
- `needsPermission: true` 的工具，确认前用户看的就是 `preview()`——把危险点写在那里。
- 纯逻辑尽量抽成命名导出函数（像 `edit.ts` 的 `applyEdit`），配得上单测。
- 工具内需要会话状态时，存插件闭包（参考 todo）；跨会话持久化找 `app`——但工具
  `run` 拿不到 app，这是有意的：工具保持无状态签名，状态型工具先想清楚再设计。

## 加一条命令

```ts
// src/plugins/commands/my-cmd.ts
import { definePlugin } from '../../kernel/plugin.ts';

export default definePlugin({
  name: 'my-cmd',                     // 用户敲 /my-cmd；不含斜杠，全注册表唯一
  kind: 'command',
  usage: '/my-cmd <参数>',
  summary: '一句话说明（/help 列表展示）',
  async run(app, args) {
    // app 上有 config/registry/provider/store/yolo/messages/startSession/resetMessages
    // 需要退出 REPL 时 return { exit: true }
  },
});
```

`/help` 的列表从注册表自动生成，新命令不用改任何展示代码。

## 加一个协议（provider）

```ts
// src/providers/my-protocol.ts
import { definePlugin } from '../../kernel/plugin.ts';

export default definePlugin({
  name: 'my-protocol',
  kind: 'provider',
  matches: (baseUrl) => baseUrl.includes('/my-protocol'),  // 按 URL 自动识别
  create: (config) => new MyClient(config.baseUrl, config.apiKey, config.model),
});
```

要求：实现 `ChatClient`（`chat(messages, opts) → { message }`，内部消息用
`kernel/types.ts` 的 OpenAI 形状），重试用 `providers/retry.ts` 的 `withRetry`，
SSE 解析复用 `providers/sse.ts`。清单里注意与 `openai`（恒真兜底）的相对顺序。

## 加一个壳（shell）

实现 `start(app): Promise<void>`，`name` 注册进清单后改 `main.ts` 的
`registry.shell('repl')` 一处即可切换。参考 `shell/repl.ts`：壳负责 readline、
SIGINT 三态路由、权限确认 UI 接线、轮前裁剪与会话落盘——这些都是壳的事，别沉到 core。
