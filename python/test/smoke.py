"""端到端冒烟（无网络）：本地假 SSE 服务器按剧本回包，子进程跑真实 REPL。

场景A：--yolo 下 POST 一句话 → 流式正文 → bash 工具调用(echo smoke-ok) → 结果回流 → 最终回答。
场景B：退出重开 /resume 恢复并带上历史（历史随新请求发给模型）。
场景C：Anthropic 协议（BASE_URL 含 /anthropic 自动识别），含分片 input_json_delta 的完整工具轮。
场景D：诱导 web_fetch 抓 http://127.0.0.1:9/private，断言"已拦截"且回流。
场景F：无 --yolo，REPL 喂 y 与 n 各一轮，断言权限往返（n 轮断言"拒绝"回执）。

测试进程用独立临时 HOME（HOME/USERPROFILE 指向 mkdtemp），不污染真实会话；
假服务器只听 127.0.0.1 随机端口，除 bash 的 echo 外零网络。
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

REPO_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_DIR not in sys.path:
    sys.path.insert(0, REPO_DIR)

bodies: list[str] = []


class _FakeHandler(BaseHTTPRequestHandler):
    def log_message(self, *_args: Any) -> None:
        pass

    def do_POST(self) -> None:
        length = int(self.headers.get('content-length', 0))
        raw = self.rfile.read(length).decode('utf-8') if length else ''
        bodies.append(raw)
        self.send_response(200)
        self.send_header('content-type', 'text/event-stream')
        self.end_headers()

        def send(obj: dict[str, Any]) -> None:
            self.wfile.write(f'data: {json.dumps(obj, ensure_ascii=False)}\n\n'.encode('utf-8'))
            self.wfile.flush()

        def done() -> None:
            self.wfile.write(b'data: [DONE]\n\n')
            self.wfile.flush()

        # ---------- Anthropic 协议分支（/v1/messages） ----------
        if self.path.endswith('/v1/messages'):
            if 'tool_result' in raw:
                # 工具结果已回流：给最终回答
                send({'type': 'message_start', 'message': {'role': 'assistant'}})
                send({'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text'}})
                send({
                    'type': 'content_block_delta',
                    'index': 0,
                    'delta': {'type': 'text_delta', 'text': '验证完成：smoke-anthropic'},
                })
                send({'type': 'content_block_stop', 'index': 0})
                send({'type': 'message_delta', 'delta': {'stop_reason': 'end_turn'}})
                send({'type': 'message_stop'})
            else:
                # 第一轮：正文 + 分两片的 tool_use input（考验碎片拼装）
                send({'type': 'message_start', 'message': {'role': 'assistant'}})
                send({'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text'}})
                send({
                    'type': 'content_block_delta',
                    'index': 0,
                    'delta': {'type': 'text_delta', 'text': '我先跑个命令确认环境。'},
                })
                send({'type': 'content_block_stop', 'index': 0})
                send({
                    'type': 'content_block_start',
                    'index': 1,
                    'content_block': {'type': 'tool_use', 'id': 'toolu_smoke', 'name': 'bash'},
                })
                send({
                    'type': 'content_block_delta',
                    'index': 1,
                    'delta': {'type': 'input_json_delta', 'partial_json': '{"command":'},
                })
                send({
                    'type': 'content_block_delta',
                    'index': 1,
                    'delta': {'type': 'input_json_delta', 'partial_json': '"echo smoke-anthropic"}'},
                })
                send({'type': 'content_block_stop', 'index': 1})
                send({'type': 'message_delta', 'delta': {'stop_reason': 'tool_use'}})
                send({'type': 'message_stop'})
            return

        # ---------- OpenAI 协议分支（/v1/chat/completions） ----------
        # 按"最后一条消息的角色 + 最新用户文本"分场：tool=工具结果已回流；user=按输入文本路由场景
        last_role = None
        last_text = ''
        try:
            parsed = json.loads(raw)
            msgs = parsed.get('messages') or []
            if msgs:
                last_role = msgs[-1].get('role')
                last_text = str(msgs[-1].get('content') or '')
        except json.JSONDecodeError:
            pass  # 保底走默认分支

        def text(content: str, finish: str) -> None:
            send({'choices': [{'delta': {'content': content}}]})
            send({
                'choices': [{'delta': {}, 'finish_reason': finish}],
                'usage': {'prompt_tokens': 20, 'completion_tokens': 3},
            })
            done()

        if last_role == 'tool':
            # 工具结果已回流（含被拦截的 web_fetch）：给最终回答
            text('验证完成：smoke-ok', 'stop')
        elif '继续' in last_text:
            # 场景B：恢复历史后的追问
            text('好的，继续。', 'stop')
        elif '试试抓取' in last_text:
            # 场景D：诱导抓取内网地址，验证 SSRF 拦截
            send({'choices': [{'delta': {'role': 'assistant', 'content': '我来抓取这个地址试试。'}}]})
            send({
                'choices': [{
                    'delta': {
                        'tool_calls': [{
                            'index': 0,
                            'id': 'call_fetch',
                            'type': 'function',
                            'function': {'name': 'web_fetch', 'arguments': '{"url":"http://127.0.0.1:9/private"}'},
                        }],
                    },
                }],
            })
            send({
                'choices': [{'delta': {}, 'finish_reason': 'tool_calls'}],
                'usage': {'prompt_tokens': 10, 'completion_tokens': 5},
            })
            done()
        else:
            # 场景A/F 第一轮：流式正文 + 一个 bash 工具调用
            send({'choices': [{'delta': {'role': 'assistant', 'content': '我先跑个命令确认环境。'}}]})
            send({
                'choices': [{
                    'delta': {
                        'tool_calls': [{
                            'index': 0,
                            'id': 'call_smoke',
                            'type': 'function',
                            'function': {'name': 'bash', 'arguments': '{"command":"echo smoke-ok"}'},
                        }],
                    },
                }],
            })
            send({
                'choices': [{'delta': {}, 'finish_reason': 'tool_calls'}],
                'usage': {'prompt_tokens': 10, 'completion_tokens': 5},
            })
            done()


class ReplProcess:
    """跑 python -m pcode 的子进程：stdin 喂行，stdout 后台线程攒进缓冲。"""

    def __init__(self, home: str, base_url: str, extra_args: list[str]) -> None:
        env = dict(os.environ)
        env.update(
            {
                'PCODE_API_KEY': 'test-key',
                'PCODE_BASE_URL': base_url,
                'PCODE_MODEL': 'fake-model',
                'HOME': home,
                'USERPROFILE': home,
                'PYTHONUTF8': '1',
                'PYTHONPATH': REPO_DIR,
            }
        )
        # 隔离掉宿主环境里可能存在的其他 PCODE 配置
        for key in ('PCODE_PROTOCOL', 'PCODE_CONTEXT_LIMIT'):
            env.pop(key, None)

        self.proc = subprocess.Popen(
            [sys.executable, '-m', 'pcode', *extra_args],
            cwd=home,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        self._raw = bytearray()
        self._lock = threading.Lock()
        assert self.proc.stdout is not None
        threading.Thread(target=self._pump, daemon=True).start()

    def _pump(self) -> None:
        stream = self.proc.stdout
        assert stream is not None
        while True:
            # read1：有多少读多少，不等满缓冲（read(n) 会凑齐 n 字节才返回，尾巴会卡住）
            chunk = stream.read1(4096)
            if not chunk:
                break
            with self._lock:
                self._raw.extend(chunk)

    def out(self) -> str:
        with self._lock:
            # 整体解码：多字节字符不会被按字节拆碎
            return self._raw.decode('utf-8', errors='replace')

    def write(self, text: str) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(text.encode('utf-8'))
        self.proc.stdin.flush()

    def close(self) -> None:
        try:
            self.write('/exit\n')
        except (OSError, ValueError):
            pass
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(timeout=5)


def run_repl(g: ReplProcess, steps: list[dict[str, str]], timeout: float = 30.0) -> None:
    """依次执行 steps：每步先等 wait 文本出现（可选）再写入。"""
    deadline = time.monotonic() + timeout
    for step in steps:
        wait = step.get('wait')
        while wait and wait not in g.out():
            if time.monotonic() > deadline:
                raise AssertionError(f'等待超时：{wait}\n=== 当前输出 ===\n{g.out()}')
            if g.proc.poll() is not None:
                raise AssertionError(f'进程已退出，等不到：{wait}\n=== 当前输出 ===\n{g.out()}')
            time.sleep(0.05)
        g.write(step['write'])
    # 给最后一条命令的处理留点收尾时间
    time.sleep(0.5)


def make_home(tag: str) -> str:
    return tempfile.mkdtemp(prefix=f'pcode-smoke-{tag}-')


def drop_home(home: str) -> None:
    shutil.rmtree(home, ignore_errors=True)


def main() -> None:
    # 让本脚本在管道/重定向下也输出 UTF-8，诊断信息可读
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='replace')

    server = ThreadingHTTPServer(('127.0.0.1', 0), _FakeHandler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base_url = f'http://127.0.0.1:{port}/v1'
    base_url_anthropic = f'http://127.0.0.1:{port}/anthropic'

    failures: list[str] = []

    def scenario(name: str, func: Any) -> None:
        try:
            func()
        except AssertionError as e:
            failures.append(name)
            print(f'冒烟{name}失败：{e}')
        except Exception as e:
            failures.append(name)
            print(f'冒烟{name}异常：{type(e).__name__}: {e}')

    # ---------- 场景A：工具闭环 ----------
    home_a = make_home('a')

    def scene_a() -> None:
        g = ReplProcess(home_a, base_url, ['--yolo'])
        run_repl(g, [
            {'write': '跑一下冒烟测试\n'},
            {'write': '', 'wait': '验证完成：smoke-ok'},
        ])
        out = g.out()
        g.close()
        assert '我先跑个命令' in out, f'A: 未见流式正文\n{out}'
        assert '验证完成：smoke-ok' in out, f'A: 未见最终回答\n{out}'
        assert 'smoke-ok' in out, f'A: 未见 bash 工具输出回显\n{out}'
        assert any(
            '"role":"tool"' in b and 'smoke-ok' in b for b in bodies
        ), 'A: 第二轮请求未携带工具结果'
        print('冒烟A通过：流式正文 → 工具调用 → bash 执行 → 结果回流 → 最终回答')

    scenario('A', scene_a)

    # ---------- 场景B：会话 /resume（复用 A 的 HOME，让 /resume 看得到 A 的会话） ----------
    def scene_b() -> None:
        bodies_before = len(bodies)
        g = ReplProcess(home_a, base_url, [])
        run_repl(g, [
            {'write': '/resume\n'},
            {'write': '/resume 1\n', 'wait': '最近的会话'},
            {'write': '继续\n', 'wait': '已恢复'},
            {'write': '', 'wait': '好的，继续。'},
        ])
        out = g.out()
        g.close()
        assert '最近的会话' in out, f'B: /resume 未列出历史会话\n{out}'
        assert '跑一下冒烟测试' in out, f'B: 列表未显示上一会话标签\n{out}'
        assert '已恢复' in out, f'B: 未见恢复确认\n{out}'
        assert '好的，继续。' in out, f'B: 未见恢复后的回答\n{out}'
        new_bodies = bodies[bodies_before:]
        assert any(
            '跑一下冒烟测试' in b and '继续' in b for b in new_bodies
        ), 'B: 恢复的历史未随新请求发给模型'
        print('冒烟B通过：/resume 跨进程恢复会话，历史随请求发送')

    scenario('B', scene_b)
    drop_home(home_a)

    # ---------- 场景C：Anthropic 协议工具闭环（BASE_URL 含 /anthropic 自动识别） ----------
    home_c = make_home('c')

    def scene_c() -> None:
        g = ReplProcess(home_c, base_url_anthropic, ['--yolo'])
        run_repl(g, [
            {'write': '跑一下 Anthropic 冒烟\n'},
            {'write': '', 'wait': '验证完成：smoke-anthropic'},
        ])
        out = g.out()
        g.close()
        assert '我先跑个命令' in out, f'C: 未见流式正文\n{out}'
        assert '验证完成：smoke-anthropic' in out, f'C: 未见最终回答\n{out}'
        assert 'smoke-anthropic' in out, f'C: 未见 bash 工具输出回显\n{out}'
        anthro_bodies = [b for b in bodies if 'smoke-anthropic' in b]
        assert any(
            '"tool_result"' in b and 'smoke-anthropic' in b for b in anthro_bodies
        ), 'C: 第二轮请求未携带 tool_result'
        assert any(
            '"input_schema"' in b and '"max_tokens"' in b and '"system"' in b
            for b in anthro_bodies
        ), 'C: 请求缺 Anthropic 必备字段（input_schema/max_tokens/system）'
        print('冒烟C通过：Anthropic 协议自动识别，工具闭环跑通')

    scenario('C', scene_c)
    drop_home(home_c)

    # ---------- 场景D：web_fetch 的 SSRF 拦截面 ----------
    home_d = make_home('d')

    def scene_d() -> None:
        g = ReplProcess(home_d, base_url, ['--yolo'])
        run_repl(g, [
            {'write': '试试抓取 http://127.0.0.1:9/private\n'},
            {'write': '', 'wait': 'SSRF 防护'},
            {'write': '', 'wait': '验证完成：smoke-ok'},
        ])
        out = g.out()
        g.close()
        assert '已拦截' in out, f'D: SSRF 拦截未生效\n{out}'
        assert '验证完成：smoke-ok' in out, f'D: 拦截后会话未正常收尾\n{out}'
        assert any(
            '"role":"tool"' in b and 'SSRF 防护' in b for b in bodies
        ), 'D: 拦截结果未回流给模型'
        print('冒烟D通过：web_fetch 拦截内网地址，结果回流，会话正常继续')

    scenario('D', scene_d)
    drop_home(home_d)

    # ---------- 场景F：无 --yolo，权限确认 allow 与 deny 两轮 ----------
    home_f = make_home('f')

    def scene_f() -> None:
        g = ReplProcess(home_f, base_url, [])
        run_repl(g, [
            {'write': '跑一下冒烟测试\n'},
            {'write': 'y\n', 'wait': '允许?'},
            {'write': '跑一下冒烟测试\n', 'wait': '验证完成：smoke-ok'},
            {'write': 'n\n', 'wait': '允许?'},
            {'write': '', 'wait': '验证完成：smoke-ok'},
        ])
        out = g.out()
        g.close()
        assert 'echo smoke-ok' in out, f'F: 预览应含将执行的命令\n{out}'
        assert out.count('bash 请求执行') == 2, f'F: 应有两次权限确认\n{out}'
        assert '拒绝' in out, f'F: 未见拒绝回执\n{out}'
        assert any('"role":"tool"' in b and '拒绝' in b for b in bodies), 'F: 拒绝结果未回流给模型'
        print('冒烟F通过：权限确认 allow/deny 两轮往返（y 放行 / n 拒绝且回执回流）')

    scenario('F', scene_f)
    drop_home(home_f)

    server.shutdown()
    if failures:
        print(f'冒烟未全部通过：失败场景 {", ".join(failures)}')
        sys.exit(1)
    print('冒烟全部通过（A/B/C/D/F 五场景）')


if __name__ == '__main__':
    main()
