// 插件内核：四类插件的类型与注册表。
// 设计对齐 tcode：统一 Plugin 枚举 + kind 判别；内核只有类型与装配、没有任何行为——
// "特权核心"最小化，一切能力皆插件。全项目单线程同步模型，回调统一用 Rc。
use std::rc::Rc;

use serde_json::Value;

use super::app::App;
use super::config::Config;
use super::types::{ChatClient, ToolSchema};

/// 工具插件：一个文件一个工具（core/agentloop 消费）。
pub struct ToolDef {
    pub name: &'static str,
    pub description: &'static str,
    /// JSON Schema，直传 function calling
    pub parameters: Value,
    /// 写类需要逐次确认，读类免确认
    pub needs_permission: bool,
    /// 权限确认时展示给用户看的内容
    pub preview: Rc<dyn Fn(&Value) -> String>,
    /// 执行工具；错误一律返回 "错误：..." 文本让模型自行纠正，不向上抛
    pub run: Rc<dyn Fn(&Value) -> String>,
}

/// 命令返回值：exit=true 时壳收尾退出。
#[derive(Debug, Clone, Copy, Default)]
pub struct CommandOutcome {
    pub exit: bool,
}

/// 斜杠命令插件：name 不含斜杠；输出自己打印。
pub struct CommandDef {
    pub name: &'static str,
    pub usage: &'static str,
    pub summary: &'static str,
    pub run: Rc<dyn Fn(&mut App, &[String]) -> CommandOutcome>,
}

/// 协议插件：matches 按注册顺序首个命中的生效，兜底放清单最后。
pub struct ProviderDef {
    pub name: &'static str,
    pub matches: Rc<dyn Fn(&str) -> bool>,
    pub create: Rc<dyn Fn(&Config) -> Rc<dyn ChatClient>>,
}

/// 交互壳插件：REPL/TUI/单发都是并列的壳，一次只起一个。
pub struct ShellDef {
    pub name: &'static str,
    pub start: Rc<dyn Fn(&mut App) -> Result<(), String>>,
}

/// 四类插件的统一外壳（kind 判别），装配清单里一值一能力，顺序即优先级。
pub enum Plugin {
    Tool(Rc<ToolDef>),
    Command(Rc<CommandDef>),
    Provider(Rc<ProviderDef>),
    Shell(Rc<ShellDef>),
}

impl Plugin {
    pub fn kind(&self) -> &'static str {
        match self {
            Plugin::Tool(_) => "tool",
            Plugin::Command(_) => "command",
            Plugin::Provider(_) => "provider",
            Plugin::Shell(_) => "shell",
        }
    }

    pub fn name(&self) -> &str {
        match self {
            Plugin::Tool(p) => p.name,
            Plugin::Command(p) => p.name,
            Plugin::Provider(p) => p.name,
            Plugin::Shell(p) => p.name,
        }
    }
}

/// 注册表：插件按 kind 存取；装配顺序即优先级（provider 的 matches 首个命中生效）。
pub struct Registry {
    plugins: Vec<Plugin>,
}

impl Registry {
    pub fn new() -> Self {
        Registry { plugins: Vec::new() }
    }

    /// 注册一个插件；同 kind 重名拒绝。
    pub fn register(&mut self, p: Plugin) -> Result<(), String> {
        for q in &self.plugins {
            if q.kind() == p.kind() && q.name() == p.name() {
                return Err(format!("插件重名：{}/{}", p.kind(), p.name()));
            }
        }
        self.plugins.push(p);
        Ok(())
    }

    /// 批量注册（内置清单是静态的，装配错误不应静默）。
    pub fn register_all(&mut self, plugins: Vec<Plugin>) -> Result<(), String> {
        for p in plugins {
            self.register(p)?;
        }
        Ok(())
    }

    /// 按注册顺序返回全部工具插件。
    pub fn tools(&self) -> Vec<Rc<ToolDef>> {
        self.plugins
            .iter()
            .filter_map(|p| match p {
                Plugin::Tool(t) => Some(t.clone()),
                _ => None,
            })
            .collect()
    }

    /// 按注册顺序返回全部协议插件。
    pub fn providers(&self) -> Vec<Rc<ProviderDef>> {
        self.plugins
            .iter()
            .filter_map(|p| match p {
                Plugin::Provider(p) => Some(p.clone()),
                _ => None,
            })
            .collect()
    }

    /// 按注册顺序返回全部命令插件。
    pub fn commands(&self) -> Vec<Rc<CommandDef>> {
        self.plugins
            .iter()
            .filter_map(|p| match p {
                Plugin::Command(c) => Some(c.clone()),
                _ => None,
            })
            .collect()
    }

    /// 按名字找壳插件；找不到返回 None。
    pub fn shell(&self, name: &str) -> Option<Rc<ShellDef>> {
        self.plugins.iter().find_map(|p| match p {
            Plugin::Shell(s) if s.name == name => Some(s.clone()),
            _ => None,
        })
    }

    /// 工具清单 → function calling 的 tools 参数（注册表层便捷入口；agentloop 走 to_schemas）。
    #[allow(dead_code)]
    pub fn tool_schemas(&self) -> Vec<ToolSchema> {
        to_schemas(&self.tools())
    }
}

impl Default for Registry {
    fn default() -> Self {
        Self::new()
    }
}

/// 独立导出：core/agentloop 拿到的是裸工具数组，不经注册表实例。
pub fn to_schemas(tools: &[Rc<ToolDef>]) -> Vec<ToolSchema> {
    tools
        .iter()
        .map(|t| ToolSchema {
            name: t.name.to_string(),
            description: t.description.to_string(),
            parameters: t.parameters.clone(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernel::app::AppOptions;
    use crate::kernel::types::ChatMessage;

    fn fake_tool(name: &'static str) -> Plugin {
        Plugin::Tool(Rc::new(ToolDef {
            name,
            description: "测试工具",
            parameters: serde_json::json!({"type": "object", "properties": {}}),
            needs_permission: false,
            preview: Rc::new(|_| String::new()),
            run: Rc::new(|_| "ok".to_string()),
        }))
    }

    fn fake_provider() -> Plugin {
        Plugin::Provider(Rc::new(ProviderDef {
            name: "fake",
            matches: Rc::new(|_| true),
            create: Rc::new(|_config| {
                Rc::new(FakeClient) as Rc<dyn ChatClient>
            }),
        }))
    }

    struct FakeClient;
    impl ChatClient for FakeClient {
        fn chat(&self, _messages: &[ChatMessage], _opts: &super::super::types::ChatOptions) -> Result<super::super::types::CompletionResult, crate::kernel::types::ChatError> {
            Ok(super::super::types::CompletionResult { message: ChatMessage::assistant(Some(String::new()), vec![]) })
        }
    }

    fn fake_command(name: &'static str) -> Plugin {
        Plugin::Command(Rc::new(CommandDef {
            name,
            usage: "/cmd1",
            summary: "测试命令",
            run: Rc::new(|_app: &mut App, _args: &[String]| CommandOutcome::default()),
        }))
    }

    fn fake_shell() -> Plugin {
        Plugin::Shell(Rc::new(ShellDef { name: "repl", start: Rc::new(|_app: &mut App| Ok(())) }))
    }

    fn unused_app_options() -> AppOptions {
        AppOptions {
            yolo: false,
            fresh_messages: Box::new(|| vec![]),
            store: Rc::new(std::cell::RefCell::new(NoopStore)),
        }
    }

    /// 保持 AppOptions/App 类型被引用（避免脚手架期 dead_code 误报干扰测试输出）。
    struct NoopStore;
    impl crate::kernel::app::SessionStoreLike for NoopStore {
        fn start(&mut self, _meta: Value) {}
        fn append(&mut self, _message: &ChatMessage) {}
        fn list_recent(&self, _n: usize) -> Vec<crate::kernel::app::SessionSummary> {
            vec![]
        }
        fn load(&self, _file: &str) -> Vec<ChatMessage> {
            vec![]
        }
    }

    #[allow(dead_code)]
    fn touch_scaffold() {
        let _ = unused_app_options();
    }

    #[test]
    fn 注册后按类取用() {
        let r = Registry::new().with(vec![fake_tool("t1"), fake_provider(), fake_command("cmd1"), fake_shell()]);
        assert_eq!(r.tools().len(), 1);
        assert_eq!(r.providers().len(), 1);
        assert_eq!(r.commands().len(), 1);
        assert_eq!(r.shell("repl").map(|s| s.name), Some("repl"));
        assert!(r.shell("不存在").is_none());
    }

    #[test]
    fn 同kind重名拒绝_跨kind同名允许() {
        let mut r = Registry::new();
        r.register(fake_tool("t1")).unwrap();
        let err = r.register(fake_tool("t1")).unwrap_err();
        assert!(err.contains("插件重名"), "实际：{}", err);
        r.register(fake_command("t1")).unwrap(); // 不同 kind，允许
    }

    #[test]
    fn toolSchemas输出function_calling形状() {
        let r = Registry::new().with(vec![fake_tool("t1")]);
        let schemas = r.tool_schemas();
        assert_eq!(
            serde_json::to_value(&schemas.iter().map(|s| s.to_value()).collect::<Vec<_>>()).unwrap(),
            serde_json::json!([
                {
                    "type": "function",
                    "function": { "name": "t1", "description": "测试工具", "parameters": { "type": "object", "properties": {} } }
                }
            ])
        );
    }
}

/// 测试辅助：builder 风格批量注册。
#[cfg(test)]
impl Registry {
    fn with(self, plugins: Vec<Plugin>) -> Self {
        let mut r = self;
        r.register_all(plugins).unwrap();
        r
    }
}
