# py-mcp-full

> PY 爬虫开发全量工具集 — MacCMS 影视站分析 + 智能源码生成 + 选择器调试 + 播放链接调试 + 接口测试 + 代码规范评估 + 全量文件操作

基于 [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) 协议，为 AI 编程助手提供 **18 个专业工具**，覆盖影视爬虫开发全流程。

## ✨ 特性

- 🔍 **网站结构深度分析** — 自动识别 MacCMS v8/v10/采集API/非标架构
- 🤖 **智能源码生成** — 基于分析结果一键生成 T3/T4 爬虫源
- 🎯 **选择器调试** — 实时验证 XPath/CSS 选择器匹配结果
- 🎬 **播放链接调试** — 递归解析 m3u8/mp4 直链，支持 v8/v10 JS 变量提取
- 🧪 **接口测试** — 五大接口（home/category/detail/search/play）自动化测试
- 📋 **规范评估** — 12 项加权检查爬虫源代码规范
- 📁 **全量文件操作** — read/write/delete/mkdir/move/copy/info/cwd

## 🚀 快速开始

### 安装

```bash
git clone https://github.com/sunniu-hjdhnx/py-mcp-full.git
cd py-mcp-full
npm install
```

### 配置 MCP 客户端

在 Claude Desktop / Cursor / Cherry Studio 等 MCP 客户端的配置中添加：

```json
{
  "mcpServers": {
    "py_mcp_full": {
      "command": "node",
      "args": ["/path/to/py-mcp-full/index.js"],
      "env": {
        "ROOT": "/path/to/your/spider/project"
      }
    }
  }
}
```

> `ROOT` 环境变量指定爬虫源项目的根目录，文件操作工具基于此路径。

### 精简部署（可选）

使用 esbuild 打包为单文件，无需 node_modules：

```bash
npm install -g esbuild
esbuild index.js --bundle --platform=node --format=cjs --target=node22 --outfile=dist/index.cjs
```

打包后配置：

```json
{
  "mcpServers": {
    "py_mcp_full": {
      "command": "node",
      "args": ["dist/index.cjs"],
      "env": { "ROOT": "/path/to/your/spider/project" }
    }
  }
}
```

## 🛠 工具列表（18个）

### 爬虫开发工具（10个）

| 工具 | 功能 | 必要参数 |
|------|------|----------|
| `analyze_website` | 深度分析网站结构，识别CMS类型 | `url` |
| `create_spider_source` | 智能生成爬虫源代码 | `url` |
| `debug_selector` | 验证CSS选择器匹配结果 | `url`, `selector` |
| `debug_play_link` | 递归调试播放链接提取 | `url` |
| `test_interface` | 测试五大接口 | `source_code`, `interface` |
| `evaluate_source` | 评估代码规范符合度 | `source_code` |
| `fetch_url` | 抓取页面内容 | `url` |
| `edit_file` | 替换文件内容 | `path`, `search_text`, `replace_text` |
| `find_in_file` | 搜索文件内容 | `path`, `keyword` |
| `list_directory` | 列出目录内容 | `path` |

### 文件操作工具（8个）

| 工具 | 功能 | 必要参数 |
|------|------|----------|
| `read_file` | 读取文件（支持分段） | `path` |
| `write_file` | 写入文件（覆盖/追加） | `path`, `content` |
| `delete_file` | 删除文件或目录 | `path` |
| `create_directory` | 创建目录（支持递归） | `path` |
| `move_file` | 移动/重命名 | `source`, `destination` |
| `copy_file` | 复制文件 | `source`, `destination` |
| `file_info` | 获取文件详细信息 | `path` |
| `get_cwd` | 获取工作目录 | — |

## 📖 使用流程

```
① analyze_website(url="https://example.com")
   → 识别CMS类型，获取HTML结构参数

② debug_selector(url="...", selector="//div[contains(@class,'item')]")
   → 验证选择器是否正确

③ create_spider_source(url="...", mode="T4")
   → 生成完整爬虫源代码

④ test_interface(source_code="...", interface="all")
   → 测试五大接口是否正常

⑤ evaluate_source(source_code="...")
   → 检查规范符合度
```

## 🏗 项目结构

```
py-mcp-full/
├── index.js          # 主程序（1409行）
├── package.json      # 依赖配置
├── manifest.json     # 工具 Schema 定义
└── 使用说明.md        # 中文详细文档
```
## 仓库说明
本 README 仅用于说明项目基本信息与仓库边界，仅供技术学习交流，不包含使用引导、接入引导或资源说明。
## 致谢
[hjdhnx的主页](https://github.com/hjdhnx)
## 📄 License

MIT
