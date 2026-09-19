// 注册表：插件按 kind 存取；装配顺序即优先级（provider 的 matches 首个命中生效）。
import type {
  CommandPlugin,
  Plugin,
  ProviderPlugin,
  ShellPlugin,
  ToolPlugin,
} from './plugin.ts';
import type { ToolSchema } from './types.ts';

export class Registry {
  private plugins: Plugin[] = [];

  register(p: Plugin): this {
    if (this.plugins.some((q) => q.kind === p.kind && q.name === p.name)) {
      throw new Error(`插件重名：${p.kind}/${p.name}`);
    }
    this.plugins.push(p);
    return this;
  }

  registerAll(plugins: Plugin[]): this {
    for (const p of plugins) this.register(p);
    return this;
  }

  tools(): ToolPlugin[] {
    return this.plugins.filter((p): p is ToolPlugin => p.kind === 'tool');
  }

  providers(): ProviderPlugin[] {
    return this.plugins.filter((p): p is ProviderPlugin => p.kind === 'provider');
  }

  commands(): CommandPlugin[] {
    return this.plugins.filter((p): p is CommandPlugin => p.kind === 'command');
  }

  shell(name: string): ShellPlugin | undefined {
    return this.plugins.find((p): p is ShellPlugin => p.kind === 'shell' && p.name === name);
  }

  /** 工具清单 → function calling 的 tools 参数 */
  toolSchemas(): ToolSchema[] {
    return toSchemas(this.tools());
  }
}

/** 独立导出：core/agentloop 拿到的是裸工具数组，不经注册表实例 */
export function toSchemas(tools: ToolPlugin[]): ToolSchema[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}
