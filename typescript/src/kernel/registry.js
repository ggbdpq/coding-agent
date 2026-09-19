export class Registry {
    plugins = [];
    register(p) {
        if (this.plugins.some((q) => q.kind === p.kind && q.name === p.name)) {
            throw new Error(`插件重名：${p.kind}/${p.name}`);
        }
        this.plugins.push(p);
        return this;
    }
    registerAll(plugins) {
        for (const p of plugins)
            this.register(p);
        return this;
    }
    tools() {
        return this.plugins.filter((p) => p.kind === 'tool');
    }
    providers() {
        return this.plugins.filter((p) => p.kind === 'provider');
    }
    commands() {
        return this.plugins.filter((p) => p.kind === 'command');
    }
    shell(name) {
        return this.plugins.find((p) => p.kind === 'shell' && p.name === name);
    }
    /** 工具清单 → function calling 的 tools 参数 */
    toolSchemas() {
        return toSchemas(this.tools());
    }
}
/** 独立导出：core/agentloop 拿到的是裸工具数组，不经注册表实例 */
export function toSchemas(tools) {
    return tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
}
