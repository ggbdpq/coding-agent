// 会话持久化：JSONL 追加写，一行一条 JSON（meta 行 + message 行）。
// /resume 的语义 = 读旧文件、换新文件继续写——避免追加到可能损坏的旧文件。
// 目录边界：所有读写都限定在会话目录内，出目录一律拒绝/跳过。
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
export class SessionStore {
    filePath = null;
    /** 归一化后的会话目录绝对路径 */
    root;
    constructor(dir) {
        this.root = path.resolve(dir);
        mkdirSync(this.root, { recursive: true });
    }
    /** 目录边界校验：目标必须是本目录本身或本目录的直接/间接子路径 */
    isInsideDir(target) {
        return target === this.root || target.startsWith(this.root + path.sep);
    }
    /** 开新会话文件并写入元信息行 */
    start(meta = {}) {
        // Windows 文件名禁 :，把 ISO 时间的冒号一并换掉
        const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random()
            .toString(36)
            .slice(2, 6)}.jsonl`;
        const file = path.resolve(this.root, name);
        if (!this.isInsideDir(file))
            throw new Error('会话文件路径越界');
        this.filePath = file;
        appendFileSync(this.filePath, `${JSON.stringify({ type: 'meta', ts: Date.now(), ...meta })}\n`);
    }
    /** 追加一条消息；落盘失败静默（记会话是锦上添花，不该打断对话） */
    append(message) {
        if (!this.filePath)
            return;
        try {
            appendFileSync(this.filePath, `${JSON.stringify({ type: 'message', message })}\n`);
        }
        catch {
            /* 忽略 */
        }
    }
    /** 最近 n 个会话（排除当前文件），按修改时间倒序 */
    listRecent(n) {
        const entries = readdirSync(this.root)
            .filter((f) => f.endsWith('.jsonl'))
            .map((f) => path.resolve(this.root, f))
            .filter((file) => this.isInsideDir(file) && file !== this.filePath)
            .map((file) => ({ file, mtime: statSync(file).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime)
            .slice(0, n);
        return entries.map((e) => ({ ...e, label: this.readLabel(e.file) }));
    }
    /** 读指定会话文件的全部消息行；越出会话目录的路径一律拒绝 */
    load(file) {
        const resolved = path.resolve(file);
        if (!this.isInsideDir(resolved))
            return [];
        const messages = [];
        for (const line of readFileSync(resolved, 'utf8').split('\n')) {
            if (!line.trim())
                continue;
            try {
                const o = JSON.parse(line);
                if (o.type === 'message' && o.message)
                    messages.push(o.message);
            }
            catch {
                /* 跳过坏行 */
            }
        }
        return messages;
    }
    readLabel(file) {
        if (!this.isInsideDir(file))
            return '(无用户消息)';
        for (const line of readFileSync(file, 'utf8').split('\n')) {
            if (!line.trim())
                continue;
            try {
                const o = JSON.parse(line);
                if (o.type === 'message' && o.message?.role === 'user') {
                    const text = (o.message.content ?? '').trim().replace(/\s+/g, ' ');
                    if (text)
                        return text.slice(0, 60) || '(空输入)';
                }
            }
            catch {
                /* 跳过坏行 */
            }
        }
        return '(无用户消息)';
    }
}
