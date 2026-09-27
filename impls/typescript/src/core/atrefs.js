// @文件引用（蓝图 V4-3）：把输入里的 @path 注入对应文件内容。
// 纯函数（读文件经参数注入，方便单测）；只读不写，无需权限闸门。
// ponytail: 路径含空格不支持（@token 以空白分隔）；@目录 不展开——需要时升级。
const MAX_FILE_CHARS = 256 * 1024;
const AT_REF_RE = /(^|\s)@([^\s@]+)/g;
export function expandAtRefs(line, readFile) {
    return line.replace(AT_REF_RE, (_all, lead, rawPath) => {
        const content = readFile(rawPath);
        if (content === null)
            return `${lead}@${rawPath}（文件不存在）`;
        const body = content.length > MAX_FILE_CHARS
            ? `${content.slice(0, MAX_FILE_CHARS)}\n…（已截断，原文 ${content.length} 字符）`
            : content;
        return `${lead}[引用文件 ${rawPath}]\n${body}\n[/引用文件]`;
    });
}
