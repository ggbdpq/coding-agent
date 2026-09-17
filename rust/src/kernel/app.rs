// App：插件的运行环境——命令与壳通过它拿能力，彼此互不 import。
// kernel 不 import core：store 与 freshMessages 由装配方（main）注入，
// 这里只声明最小的结构化接口。
use std::cell::{Cell, RefCell};
use std::rc::Rc;

use serde_json::{Map, Value};

use super::config::Config;
use super::plugin::Registry;
use super::types::{ChatClient, ChatMessage};

/// 当前版本号（横幅、--version、会话 meta 三处共用）。
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// 会话列表条目。
#[derive(Debug, Clone)]
pub struct SessionSummary {
    pub file: String,
    /// 毫秒时间戳
    pub mtime: i64,
    /// 首条用户输入，用作列表标签
    pub label: String,
}

/// core/session.SessionStore 满足此结构（kernel 不直接依赖 core）。
pub trait SessionStoreLike {
    fn start(&mut self, meta: Value);
    fn append(&mut self, message: &ChatMessage);
    fn list_recent(&self, n: usize) -> Vec<SessionSummary>;
    fn load(&self, file: &str) -> Vec<ChatMessage>;
}

/// 装配选项。
pub struct AppOptions {
    pub yolo: bool,
    /// 产出全新消息数组（system 提示词），由装配方注入（依赖 core/systemprompt）
    pub fresh_messages: Box<dyn Fn() -> Vec<ChatMessage>>,
    pub store: Rc<RefCell<dyn SessionStoreLike>>,
}

/// App 插件的运行环境。
pub struct App {
    pub config: Config,
    pub registry: Registry,
    pub provider: Rc<dyn ChatClient>,
    pub store: Rc<RefCell<dyn SessionStoreLike>>,
    /// 会话级免确认开关（--yolo、/yolo、权限确认里的 a 改的都是它）
    pub yolo: Rc<Cell<bool>>,
    /// 当前会话消息；命令/壳直接读写这个数组
    pub messages: Vec<ChatMessage>,
    fresh_messages: Box<dyn Fn() -> Vec<ChatMessage>>,
}

impl App {
    /// 开新会话文件（/new、/resume 都换文件，永不追加旧文件）。
    pub fn start_session(&self, extra: Value) {
        let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
        let mut meta = Map::new();
        meta.insert("version".into(), Value::String(VERSION.to_string()));
        meta.insert("model".into(), Value::String(self.config.model.clone()));
        meta.insert("cwd".into(), Value::String(cwd.to_string_lossy().to_string()));
        meta.insert("yolo".into(), Value::Bool(self.yolo.get()));
        if let Value::Object(extra_map) = extra {
            for (k, v) in extra_map {
                meta.insert(k, v);
            }
        }
        self.store.borrow_mut().start(Value::Object(meta));
    }

    /// messages 换成全新 system 数组。
    pub fn reset_messages(&mut self) {
        self.messages = (self.fresh_messages)();
    }
}

/// 装配 App：选 provider → 初始化消息 → 开会话文件。
pub fn create_app(config: Config, registry: Registry, opts: AppOptions) -> Result<App, String> {
    let provider = select_provider(&config, &registry)?;
    let yolo = Rc::new(Cell::new(opts.yolo));
    let mut app = App {
        config,
        registry,
        provider,
        store: opts.store,
        yolo,
        messages: Vec::new(),
        fresh_messages: opts.fresh_messages,
    };
    app.reset_messages();
    app.start_session(Value::Object(Map::new()));
    Ok(app)
}

/// 显式配置的 protocol 按名选；否则按注册顺序取首个 matches 命中的 provider。
fn select_provider(config: &Config, registry: &Registry) -> Result<Rc<dyn ChatClient>, String> {
    let providers = registry.providers();
    if let Some(proto) = config.protocol {
        if let Some(p) = providers.iter().find(|p| p.name == proto.as_str()) {
            return Ok((p.create)(config));
        }
        let names: Vec<&str> = providers.iter().map(|p| p.name).collect();
        return Err(format!(
            "没有名为 {} 的 provider 插件（可用：{}）",
            proto.as_str(),
            names.join(", ")
        ));
    }
    for p in &providers {
        if (p.matches)(&config.base_url) {
            return Ok((p.create)(config));
        }
    }
    Err(format!("没有 provider 插件能处理 BASE_URL：{}", config.base_url))
}
