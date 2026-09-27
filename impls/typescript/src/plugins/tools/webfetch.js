// web_fetch 工具：抓取公网页面文本，供模型查文档/API 说明。
// 安全三道闸（实现即验收条件）：仅 http/https；字面与 DNS 双重拒绝私有/保留地址；
// 重定向不自动跟随——每跳重新过守卫，杜绝"公网 302 跳内网"。
import { definePlugin } from '../../kernel/plugin.ts';
import { assertResolvesPublic, checkUrlLiteral } from './netguard.ts';
const MAX_BYTES = 512 * 1024;
const DEFAULT_MAX_CHARS = 8000;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 20_000;
/** 极简 HTML→文本：去 script/style 与标签。不做实体全解码，够模型读即可 */
function htmlToText(html) {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
export default definePlugin({
    name: 'web_fetch',
    kind: 'tool',
    description: '抓取一个公网 URL 的页面文本（仅 http/https）。用于查阅文档、API 说明、报错线索；内网/私有地址会被拒绝。',
    parameters: {
        type: 'object',
        properties: {
            url: { type: 'string', description: '完整的 http(s) URL' },
            max_chars: { type: 'number', description: `返回正文最大字符数，默认 ${DEFAULT_MAX_CHARS}` },
        },
        required: ['url'],
    },
    needsPermission: true,
    preview: (a) => `GET ${String(a.url ?? '')}（出站网络请求）`,
    async run(args, signal) {
        const raw = String(args.url ?? '');
        const check = checkUrlLiteral(raw);
        if (!check.ok)
            return check.reason ?? '错误：URL 不合规';
        const first = check.url;
        // 用户中止与 20s 超时合并为同一个信号
        const signal2 = signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
        // 手动跟随重定向：每一跳都重新过字面 + DNS 守卫
        let res = null;
        let current = first;
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
            const hopCheck = checkUrlLiteral(current.toString());
            if (!hopCheck.ok)
                return hopCheck.reason ?? '错误：重定向目标不合规';
            try {
                await assertResolvesPublic(current.hostname);
            }
            catch (e) {
                return e.message;
            }
            try {
                res = await fetch(current, {
                    redirect: 'manual',
                    signal: signal2,
                    headers: { 'user-agent': 'tcode-web-fetch/0.1' },
                });
            }
            catch (e) {
                if (signal?.aborted)
                    return '错误：aborted（用户中止）';
                return `错误：请求失败：${e.message}`;
            }
            if (res.status >= 300 && res.status < 400) {
                const loc = res.headers.get('location');
                if (!loc)
                    break;
                current = new URL(loc, current);
                continue;
            }
            break;
        }
        if (!res)
            return '错误：请求未发出';
        if (!res.ok)
            return `错误：HTTP ${res.status} ${res.statusText}`;
        const ctype = res.headers.get('content-type') ?? '';
        const buf = Buffer.from(await res.arrayBuffer());
        const body = buf.subarray(0, MAX_BYTES).toString('utf8');
        const text = ctype.includes('html') ? htmlToText(body) : body;
        const max = Math.max(200, Number(args.max_chars ?? DEFAULT_MAX_CHARS));
        const note = text.length > max ? `\n…（已截断，原文 ${text.length} 字符，可用 max_chars 调大）` : '';
        return `HTTP ${res.status} · ${ctype || '未知类型'} · ${current}\n\n${text.slice(0, max)}${note}`;
    },
});
