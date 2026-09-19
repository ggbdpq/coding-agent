// 配置加载：环境变量 > ~/.tcode/config.json > 报错指路。
// 刻意不写死任何默认端点/模型——本地优先工具，用户自己决定请求发去哪。
// 协议选择不走这里：protocol 只有显式配置时才非空，自动识别由 provider 插件的 matches 做。
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
function readJsonConfig(tcodeDir) {
    const file = path.join(tcodeDir, 'config.json');
    if (!existsSync(file))
        return {};
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    }
    catch (e) {
        throw new Error(`~/.tcode/config.json 解析失败：${e.message}`);
    }
}
export function loadConfig() {
    const tcodeDir = path.join(homedir(), '.tcode');
    const file = readJsonConfig(tcodeDir);
    const apiKey = process.env.TCODE_API_KEY ?? file.apiKey ?? '';
    const baseUrl = (process.env.TCODE_BASE_URL ?? file.baseUrl ?? '').replace(/\/+$/, '');
    const model = process.env.TCODE_MODEL ?? file.model ?? '';
    const contextLimit = Number(process.env.TCODE_CONTEXT_LIMIT) || 100_000;
    const rawProtocol = (process.env.TCODE_PROTOCOL ?? file.protocol ?? '').toLowerCase();
    let protocol;
    if (rawProtocol) {
        if (rawProtocol !== 'openai' && rawProtocol !== 'anthropic') {
            throw new Error(`TCODE_PROTOCOL 只能是 openai 或 anthropic，收到：${rawProtocol}`);
        }
        protocol = rawProtocol;
    }
    // 审批策略：环境变量 --approval > config.json；yolo/never 等价（默认 normal 逐次确认）
    const rawApproval = (process.env.TCODE_APPROVAL ?? file.approval ?? '').toLowerCase();
    let approval;
    if (rawApproval) {
        if (rawApproval !== 'normal' && rawApproval !== 'never') {
            throw new Error(`TCODE_APPROVAL 只能是 normal 或 never，收到：${rawApproval}`);
        }
        approval = rawApproval;
    }
    // 写白名单：config.json allowWriteDirs 或环境变量 TCODE_ALLOW_WRITE（pathsep 分隔）
    const allowWriteDirs = (file.allowWriteDirs ??
        (process.env.TCODE_ALLOW_WRITE ? process.env.TCODE_ALLOW_WRITE.split(path.delimiter) : []))
        .map((d) => path.resolve(d))
        .filter((d) => d.length > 0);
    const missing = [
        ['TCODE_API_KEY', apiKey],
        ['TCODE_BASE_URL', baseUrl],
        ['TCODE_MODEL', model],
    ]
        .filter(([, v]) => !v)
        .map(([k]) => k);
    if (missing.length > 0) {
        throw new Error(`缺少模型配置：${missing.join('、')}。\n` +
            `设置方式（二选一）：\n` +
            `  1. 环境变量：export TCODE_API_KEY=sk-xxx TCODE_BASE_URL=https://xxx/v1 TCODE_MODEL=模型名\n` +
            `  2. 配置文件：~/.tcode/config.json 写 {"apiKey":"...","baseUrl":"...","model":"..."}\n` +
            `任何 OpenAI 兼容端点都可以（本地中转、云 API 均可）。`);
    }
    return { apiKey, baseUrl, model, protocol, approval, allowWriteDirs, contextLimit, tcodeDir };
}
