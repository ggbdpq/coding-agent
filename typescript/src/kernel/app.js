export const VERSION = '0.4.0';
export function createApp(config, registry, opts) {
    const provider = selectProvider(config, registry);
    const yolo = { value: opts.yolo };
    const app = {
        config,
        registry,
        provider,
        store: opts.store,
        yolo,
        messages: [],
        startSession(extra = {}) {
            opts.store.start({
                version: VERSION,
                model: config.model,
                cwd: process.cwd(),
                yolo: yolo.value,
                ...extra,
            });
        },
        resetMessages() {
            app.messages = opts.freshMessages();
        },
    };
    app.resetMessages();
    app.startSession();
    return app;
}
/** 显式配置的 protocol 按名选；否则按注册顺序取首个 matches 命中的 provider */
function selectProvider(config, registry) {
    if (config.protocol) {
        const explicit = registry.providers().find((p) => p.name === config.protocol);
        if (!explicit) {
            throw new Error(`没有名为 ${config.protocol} 的 provider 插件（可用：${registry
                .providers()
                .map((p) => p.name)
                .join(', ')}）`);
        }
        return explicit.create(config);
    }
    const hit = registry.providers().find((p) => p.matches(config.baseUrl));
    if (!hit)
        throw new Error(`没有 provider 插件能处理 BASE_URL：${config.baseUrl}`);
    return hit.create(config);
}
