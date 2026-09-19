// /init：在当前目录生成 AGENTS.md 起手模板（非 LLM 生成，确定性强；
// codex 式"让模型分析仓库生成"留作升级——需要事件流授权一个隐藏 turn）。
// 模板对应 systemprompt 的注入位：项目根 AGENTS.md 每次会话自动注入。
use std::rc::Rc;

use crate::kernel::app::App;
use crate::kernel::plugin::{CommandOutcome, Plugin};

const TEMPLATE: &str = "# AGENTS.md

本文件是 rcode 在此项目工作的行为约束，每次会话自动注入。

## 项目概要
<用两三句话描述这个项目是做什么的>

## 技术栈与命令
- 构建：`<命令>`
- 测试：`<命令>`
- 格式化：`<命令>`

## 工作约定
- <例如：改代码前先跑相关测试>
- <例如：提交信息用中文，遵循 conventional commits>
- <例如：不要改 xxx 目录>";

pub fn init_plugin() -> Plugin {
    Plugin::Command(Rc::new(crate::kernel::plugin::CommandDef {
        name: "init",
        usage: "/init",
        summary: "在当前目录生成 AGENTS.md 起手模板（已存在则不覆盖）",
        run: Rc::new(|_app: &mut App, _args: &[String]| {
            let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
            let file = cwd.join("AGENTS.md");
            if file.exists() {
                println!("AGENTS.md 已存在，未覆盖。可直接编辑它来调整项目约束。");
                return CommandOutcome::default();
            }
            match std::fs::write(&file, TEMPLATE) {
                Ok(()) => println!(
                    "已生成 {}——编辑它补充项目概要、常用命令与工作约定，下次会话自动生效。",
                    file.to_string_lossy()
                ),
                Err(e) => println!("生成失败：{}", e),
            }
            CommandOutcome::default()
        }),
    }))
}
