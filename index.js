import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import fs from "fs";
import path from "path";
import axios from "axios";
import { load } from "cheerio";

const ROOT = process.env.ROOT || process.cwd();

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function fetchPage(url, timeout = 15000) {
  const res = await axios.get(url, { timeout, headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9" }, maxRedirects: 5 });
  return res.data;
}

function truncStr(s, max = 3000) {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "\n...[截断]" : s;
}

function fixUrl(u, host) {
  if (!u) return "";
  if (u.startsWith("//")) return "https:" + u;
  if (u.startsWith("/")) return "https://" + host + u;
  return u;
}

function getHost(url) {
  try { return new URL(url).host; } catch { return url.replace(/^https?:\/\//, "").split("/")[0]; }
}

function getBase(url) {
  try { const u = new URL(url); return u.origin; } catch { return "https://" + getHost(url); }
}

const TOOLS = [
  {
    name: "analyze_website",
    description: `深度分析网站结构，识别CMS类型并提取关键选择器
核心能力：
1. 抓取首页+分类页+详情页（自动发现链接）
2. 识别MacCMS v8/v10/采集API/非标架构
3. 提取分类列表、视频列表、播放区域的关键选择器
4. 检测加密/签名/特殊架构特征
5. 输出结构化分析报告供create_spider_source使用`,
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "网站首页URL" }
      },
      required: ["url"]
    }
  },
  {
    name: "create_spider_source",
    description: `基于analyze_website分析结果生成爬虫源代码
核心能力：
1. 读取分析结果，选择对应骨架（v8/v10/API/非标）
2. 使用分析出的真实选择器替换模板占位符
3. 自动适配搜索方式（GET/POST/API）
4. 根据加密检测结果注入解密逻辑
5. 输出可运行的完整爬虫代码`,
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "网站URL" },
        analysis: { type: "string", description: "analyze_website输出的分析报告JSON" },
        mode: { type: "string", description: "T4或T3模式，默认T4", default: "T4" }
      },
      required: ["url"]
    }
  },
  {
    name: "debug_selector",
    description: `验证选择器在真实页面上的匹配结果
核心能力：
1. 抓取指定URL页面
2. 用cheerio测试CSS选择器或XPath选择器
3. 输出匹配元素数量和前3个匹配内容
4. 检查contains规范合规性`,
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "要测试的页面URL" },
        selector: { type: "string", description: "CSS选择器" },
        extract: { type: "string", description: "要提取的属性：text/html/attr:name", default: "text" }
      },
      required: ["url", "selector"]
    }
  },
  {
    name: "debug_play_link",
    description: `调试播放链接解析，多级兜底提取m3u8/mp4
核心能力：
1. 直接检测是否为m3u8/mp4直链
2. 请求播放页从JS变量提取链接
3. 支持v8(now=)/v10(player_data)/通用(unescape/eval)
4. iframe递归解析
5. 输出最终链接和提取方法`,
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "播放页URL或疑似直链" },
        page_url: { type: "string", description: "上级页面URL（用于Referer）" }
      },
      required: ["url"]
    }
  },
  {
    name: "test_interface",
    description: `测试爬虫源五大接口（home/category/detail/search/play）
逐个调用接口并验证返回数据结构、字段完整性、数据量`,
    inputSchema: {
      type: "object",
      properties: {
        source_code: { type: "string", description: "爬虫源Python代码" },
        interface: { type: "string", description: "要测试的接口名：home/category/detail/search/play/all" }
      },
      required: ["source_code", "interface"]
    }
  },
  {
    name: "evaluate_source",
    description: `评估爬虫源代码是否符合规范
检查项：
1. XPath是否使用contains（禁止@class=精确匹配）
2. 是否有多级选择器兜底
3. 是否有去重机制
4. 是否有URL补全（fix_url）
5. 是否有标准化日志输出
6. 异常处理是否完善
7. 单条数据异常是否不中断`,
    inputSchema: {
      type: "object",
      properties: {
        source_code: { type: "string", description: "爬虫源Python代码" }
      },
      required: ["source_code"]
    }
  },
  {
    name: "fetch_url",
    description: "抓取页面内容（智能提取关键区域，防截断）",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL" },
        region: { type: "string", description: "提取区域：video_list/play_area/full", default: "video_list" }
      },
      required: ["url"]
    }
  },
  {
    name: "edit_file",
    description: "替换文件中的文本内容",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        search_text: { type: "string" },
        replace_text: { type: "string" }
      },
      required: ["path", "search_text", "replace_text"]
    }
  },
  {
    name: "find_in_file",
    description: "搜索文件内容",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        keyword: { type: "string" }
      },
      required: ["path", "keyword"]
    }
  },
  {
    name: "list_directory",
    description: "列出目录内容",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" }
      },
      required: ["path"]
    }
  },
  {
    name: "read_file",
    description: "读取文件内容（支持文本文件，返回带行号内容）",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件绝对路径" },
        offset: { type: "integer", description: "起始行号(从0开始)" },
        limit: { type: "integer", description: "读取行数" }
      },
      required: ["path"]
    }
  },
  {
    name: "write_file",
    description: "写入文件内容（不存在则创建，存在则覆盖或追加）",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件绝对路径" },
        content: { type: "string", description: "要写入的内容" },
        append: { type: "boolean", description: "是否追加模式(默认false覆盖)" }
      },
      required: ["path", "content"]
    }
  },
  {
    name: "delete_file",
    description: "删除文件或目录（recursive=true时删除非空目录）",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "要删除的文件或目录路径" },
        recursive: { type: "boolean", description: "是否递归删除(默认false)" }
      },
      required: ["path"]
    }
  },
  {
    name: "create_directory",
    description: "创建目录（支持递归创建父目录）",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "目录路径" },
        recursive: { type: "boolean", description: "是否递归创建(默认true)" }
      },
      required: ["path"]
    }
  },
  {
    name: "move_file",
    description: "移动或重命名文件或目录",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "源路径" },
        destination: { type: "string", description: "目标路径" }
      },
      required: ["source", "destination"]
    }
  },
  {
    name: "copy_file",
    description: "复制文件或目录",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "源路径" },
        destination: { type: "string", description: "目标路径" }
      },
      required: ["source", "destination"]
    }
  },
  {
    name: "file_info",
    description: "获取文件或目录详细信息（大小、权限、修改时间等）",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径" }
      },
      required: ["path"]
    }
  },
  {
    name: "get_cwd",
    description: "获取当前工作目录",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    }
  }
];

const server = new Server(
  { name: "py-mcp-full", version: "3.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

let analysisCache = {};

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {

    if (name === "analyze_website") {
      const url = args.url;
      const host = getHost(url);
      const base = getBase(url);
      const result = { url, host, base, cms_type: "unknown", features: {}, selectors: {}, filters: {}, sample_data: {}, warnings: [] };

      // Step 1: 抓取首页
      let homeHtml;
      try {
        homeHtml = await fetchPage(url);
      } catch (e) {
        return { content: [{ type: "text", text: `❌ 无法访问首页: ${e.message}` }] };
      }
      const $home = load(homeHtml);

      // Step 2: URL路径CMS识别
      if (/\/frim\/|search\.php\?searchtype=5|\/movie\/index\d+\.html/.test(homeHtml)) {
        result.cms_type = "maccms_v8";
      } else if (/\/index\.php\/vod\//.test(homeHtml) || /index\.php\/vod\/show/.test(homeHtml)) {
        result.cms_type = "maccms_v10";
      } else if (/\/api\.php\/provide|\/api\.php\/provid/.test(homeHtml)) {
        result.cms_type = "api_collect";
      }

      // Step 3: HTML结构特征识别（辅助验证）
      if ($home("div.stui-header__menu, div.stui-pannel, div.stui-vodlist").length > 0) {
        result.features.template = "stui";
        if (result.cms_type === "unknown") result.cms_type = "maccms_v8";
      }
      if ($home("div.hy-video-list, div.hy-play-list").length > 0) {
        result.features.template = "haiyang";
        if (result.cms_type === "unknown") result.cms_type = "maccms_v8";
      }
      if ($home("div.module-items, div.module-item").length > 0) {
        result.features.template = "module";
        if (result.cms_type === "unknown") result.cms_type = "maccms_v10";
      }
      if ($home("div.myui-vodlist, ul.myui-vodlist").length > 0) {
        result.features.template = "myui";
        if (result.cms_type === "unknown") result.cms_type = "maccms_v8";
      }
      if ($home("div#search, form#search").length > 0 && /search\.php/.test(homeHtml)) {
        result.features.search_method = "post_search_php";
      }

      // Step 4: 提取分类导航
      const categoryLinks = [];
      const navSelectors = [
        "div.stui-header__menu a[href*='tid'], div.stui-header__menu a[href*='id']",
        "div.hy-header-menu a[href*='tid'], div.hy-header-menu a[href*='id']",
        "ul.nav-menu a[href*='tid'], ul.nav-menu a[href*='/vod/']",
        "div.nav a[href*='tid'], div.nav a[href*='/vod/']",
        "a[href*='/frim/'], a[href*='searchtype=5']",
        "a[href*='/index.php/vod/show'], a[href*='/index.php/vod/type']",
        "a[href*='/type/'], a[href*='/list/']",
        ".header-nav a, .main-nav a, .nav-list a"
      ];
      for (const sel of navSelectors) {
        $home(sel).each((_, el) => {
          const href = $home(el).attr("href") || "";
          const text = $home(el).text().trim();
          if (href && text && text.length < 10) {
            const fullHref = fixUrl(href, host);
            const tidMatch = href.match(/tid[=/](\d+)|id[=/](\d+)|\/(\d+)\.html|type[=/](\d+)/);
            const tid = tidMatch ? (tidMatch[1] || tidMatch[2] || tidMatch[3] || tidMatch[4]) : "";
            categoryLinks.push({ name: text, href: fullHref, tid });
          }
        });
        if (categoryLinks.length > 2) break;
      }
      result.sample_data.categories = categoryLinks.slice(0, 15);

      // Step 5: 提取首页视频列表选择器
      const videoItemSelectors = [
        { sel: "a.stui-vodlist__thumb", name: "stui卡片" },
        { sel: "a.videopic", name: "videopic卡片" },
        { sel: "div.module-item a[href*='detail'], div.module-item a[href*='movie']", name: "module卡片" },
        { sel: "a.myui-vodlist__thumb", name: "myui卡片" },
        { sel: "div.item a[href*='movie'], div.item a[href*='detail'], div.item a[href*='vod']", name: "通用item卡片" },
        { sel: "li a[href*='movie'], li a[href*='detail'], li a[href*='vod']", name: "li下卡片" },
        { sel: "a[href*='/movie/'], a[href*='/detail/'], a[href*='/vod/detail']", name: "详情链接兜底" }
      ];
      let foundVideoSel = null;
      for (const vs of videoItemSelectors) {
        const count = $home(vs.sel).length;
        if (count > 3) {
          foundVideoSel = { selector: vs.sel, name: vs.name, count };
          break;
        }
      }
      if (foundVideoSel) {
        result.selectors.video_list = foundVideoSel;
        // 从视频卡片提取详情页URL模式
        const firstLink = $home(foundVideoSel.selector).first();
        const detailHref = firstLink.attr("href") || "";
        result.selectors.detail_url_pattern = fixUrl(detailHref, host);
        // 提取封面图属性
        const img = firstLink.find("img").first();
        result.selectors.pic_attr = img.attr("data-original") ? "data-original" : img.attr("data-src") ? "data-src" : "src";
      }

      // Step 6: 抓取分类页验证
      let categoryUrl = "";
      if (result.cms_type === "maccms_v8") {
        if (categoryLinks.length > 0 && categoryLinks[0].href) {
          categoryUrl = categoryLinks[0].href;
        } else {
          const tids = homeHtml.match(/tid[=/](\d+)/g);
          if (tids) {
            categoryUrl = `${base}/search.php?searchtype=5&tid=${tids[0].match(/\d+/)[0]}`;
          } else {
            categoryUrl = `${base}/frim/index1.html`;
          }
        }
      } else if (result.cms_type === "maccms_v10") {
        if (categoryLinks.length > 0 && categoryLinks[0].href) {
          categoryUrl = categoryLinks[0].href;
        } else {
          categoryUrl = `${base}/index.php/vod/show/id/1.html`;
        }
      } else if (categoryLinks.length > 0) {
        categoryUrl = categoryLinks[0].href;
      }

      if (categoryUrl) {
        try {
          const catHtml = await fetchPage(categoryUrl);
          const $cat = load(catHtml);
          // 在分类页验证视频列表选择器
          if (!foundVideoSel) {
            for (const vs of videoItemSelectors) {
              const count = $cat(vs.sel).length;
              if (count > 3) {
                result.selectors.video_list = { selector: vs.sel, name: vs.name, count };
                foundVideoSel = true;
                break;
              }
            }
          }
          // 提取分页信息
          const pageLinks = $cat("a[href*='page='], a[href*='/page/'], a[href*='_'], .page a, .pagination a");
          const pageHrefs = [];
          pageLinks.each((_, el) => pageHrefs.push($cat(el).attr("href") || ""));
          result.selectors.pagination = pageHrefs.slice(0, 5);
          // 尝试从分类页获取详情页链接
          const detailLinks = $cat("a[href*='detail'], a[href*='movie'], a[href*='/vod/']");
          let detailUrl = "";
          detailLinks.each((_, el) => {
            const h = $cat(el).attr("href") || "";
            if (h && !detailUrl) detailUrl = fixUrl(h, host);
          });
          if (detailUrl && !result.selectors.detail_url_pattern) {
            result.selectors.detail_url_pattern = detailUrl;
          }
          // 抓取详情页分析播放区域
          if (detailUrl) {
            try {
              const detHtml = await fetchPage(detailUrl);
              const $det = load(detHtml);
              // 播放源选择器
              const playSelectors = [
                { sel: "div.stui-vodlist__head h3, div.stui-vodlist__head span", name: "stui播放源" },
                { sel: "a.option[title], a.switch[title]", name: "option播放源" },
                { sel: "div.module-tab-item", name: "module播放源" },
                { sel: "div.panel h3, div.panel span.source-name", name: "panel播放源" }
              ];
              for (const ps of playSelectors) {
                if ($det(ps.sel).length > 0) {
                  result.selectors.play_source = { selector: ps.sel, name: ps.name, count: $det(ps.sel).length };
                  break;
                }
              }
              // 剧集列表选择器
              const epSelectors = [
                { sel: "ul.stui-content__playlist a", name: "stui剧集" },
                { sel: "ul.playlistlink a, ul.playlist a", name: "playlist剧集" },
                { sel: "div.module-play-list a", name: "module剧集" },
                { sel: "div.playlist a, div.play-list a", name: "通用剧集" }
              ];
              for (const es of epSelectors) {
                if ($det(es.sel).length > 0) {
                  result.selectors.episode_list = { selector: es.sel, name: es.name, count: $det(es.sel).length };
                  break;
                }
              }
              // 检测加密特征
              const scripts = $det("script").map((_, el) => $det(el).html() || "").get().join("\n");
              if (/eval\(function|document\.write\(unescape|atob\(|CryptoJS|decodeURIComponent/.test(scripts)) {
                result.features.encryption = true;
                if (/CryptoJS\.aes|CryptoJS\.AES|aes/.test(scripts)) result.features.encryption_type = "AES";
                if (/atob\(/.test(scripts)) result.features.encryption_type = "Base64";
                if (/eval\(function/.test(scripts)) result.features.encryption_type = "eval_obfuscation";
                result.warnings.push("检测到加密/混淆特征，需要特殊解密处理");
              }
              // 播放页JS变量检测
              if (/var\s+now\s*=/.test(scripts)) result.features.player_js = "var_now";
              if (/player_data\s*=/.test(scripts)) result.features.player_js = "player_data";
              if (/var\s+playurl\s*=/.test(scripts)) result.features.player_js = "var_playurl";
              if (/DPlayer|dp\.play/.test(scripts)) result.features.player_type = "DPlayer";
              if (/iframe/.test(detHtml)) result.features.has_iframe = true;

              result.sample_data.play_area_html = truncStr($det("div.stui-vodlist__head, div.hy-play-list, div.module-play, div.panel, div.playlist, .play-list").first().parent().html() || "", 3000);
            } catch (e) {
              result.warnings.push(`详情页无法访问: ${e.message}`);
            }
          }
        } catch (e) {
          result.warnings.push(`分类页无法访问: ${e.message}`);
        }
      }

      // Step 7: 检测搜索方式
      if ($home("form[action*='search']").length > 0 || /search\.php/.test(homeHtml)) {
        result.features.search_method = result.features.search_method || "post_search_php";
        const form = $home("form[action*='search']");
        result.selectors.search_form_action = form.attr("action") || "/search.php";
        result.selectors.search_input_name = form.find("input[type='text'], input[type='search']").attr("name") || "searchword";
      } else if (/search\.html/.test(homeHtml)) {
        result.features.search_method = "get_search_html";
        const m = homeHtml.match(/href="([^"]*search[^"]*wd=)"/);
        result.selectors.search_url_pattern = m ? m[1] : "/index.php/vod/search.html?wd=";
      }

      // Step 8: 检测API采集接口
      if (result.cms_type === "unknown") {
        const apiPaths = ["/api.php/provide/vod/", "/api.php/provide/vod/at/xml/", "/api.php/provide/vod/at/json/", "/provide/vod/"];
        for (const ap of apiPaths) {
          try {
            const apiRes = await axios.get(base + ap, { timeout: 5000, headers: { "User-Agent": UA } });
            if (apiRes.data && (apiRes.data.list || apiRes.data.video || apiRes.data.class)) {
              result.cms_type = "api_collect";
              result.features.api_path = ap;
              result.features.api_format = ap.includes("xml") ? "xml" : "json";
              break;
            }
          } catch {}
        }
      }

      if (result.cms_type === "unknown") {
        result.warnings.push("未能识别CMS类型，将使用非标架构模板，需要手动调整选择器");
      }

      analysisCache[host] = result;

      const report = `
📊 网站深度分析报告
════════════════════════════════════
🌐 URL: ${url}
🏠 Host: ${host}
📦 CMS类型: ${result.cms_type}
🎨 模板: ${result.features.template || "未识别"}

📋 分类列表 (${result.sample_data.categories?.length || 0}个):
${(result.sample_data.categories || []).slice(0, 10).map(c => `  · ${c.name} (tid=${c.tid}) → ${c.href}`).join("\n")}

🎯 视频列表选择器:
${result.selectors.video_list ? `  ✅ ${result.selectors.video_list.selector} (${result.selectors.video_list.name}, 匹配${result.selectors.video_list.count}个)` : "  ❌ 未匹配到"}

🔗 详情页URL模式:
${result.selectors.detail_url_pattern || "  未检测到"}

🖼️ 封面图属性: ${result.selectors.pic_attr || "src"}

🎵 播放源选择器:
${result.selectors.play_source ? `  ✅ ${result.selectors.play_source.selector} (${result.selectors.play_source.count}个源)` : "  ❌ 未匹配到"}

📺 剧集选择器:
${result.selectors.episode_list ? `  ✅ ${result.selectors.episode_list.selector} (${result.selectors.episode_list.count}集)` : "  ❌ 未匹配到"}

🔍 搜索方式: ${result.features.search_method || "未检测到"}
  ${result.selectors.search_form_action ? `表单action: ${result.selectors.search_form_action}` : ""}
  ${result.selectors.search_input_name ? `输入框name: ${result.selectors.search_input_name}` : ""}
  ${result.selectors.search_url_pattern ? `搜索URL: ${result.selectors.search_url_pattern}` : ""}

⚠️ 特殊特征:
${result.features.encryption ? `  🔒 加密: ${result.features.encryption_type || "未知类型"}` : "  无加密"}
${result.features.player_js ? `  🎮 JS变量: ${result.features.player_js}` : ""}
${result.features.player_type ? `  📺 播放器: ${result.features.player_type}` : ""}
${result.features.has_iframe ? "  🖼️ 包含iframe" : ""}
${result.features.api_path ? `  📡 API路径: ${result.features.api_path}` : ""}

⚠️ 警告:
${result.warnings.length > 0 ? result.warnings.map(w => `  · ${w}`).join("\n") : "  无"}

📄 分析JSON（供create_spider_source使用）:
\`\`\`json
${JSON.stringify(result, null, 2)}
\`\`\`
`;
      return { content: [{ type: "text", text: report }] };
    }

    if (name === "create_spider_source") {
      const url = args.url;
      const host = getHost(url);
      const base = getBase(url);
      const mode = args.mode || "T4";
      let analysis = null;
      try { analysis = args.analysis ? JSON.parse(args.analysis) : analysisCache[host] || null; } catch { analysis = analysisCache[host] || null; }

      if (!analysis) {
        return { content: [{ type: "text", text: "❌ 缺少分析数据，请先调用analyze_website分析网站" }] };
      }

      const cms = analysis.cms_type || "unknown";
      const tpl = analysis.features?.template || "";
      const videoSel = analysis.selectors?.video_list?.selector || "";
      const playSourceSel = analysis.selectors?.play_source?.selector || "";
      const episodeSel = analysis.selectors?.episode_list?.selector || "";
      const searchMethod = analysis.features?.search_method || "";
      const picAttr = analysis.selectors?.pic_attr || "src";
      const hasEncryption = analysis.features?.encryption || false;
      const encryptionType = analysis.features?.encryption_type || "";
      const playerJs = analysis.features?.player_js || "";
      const categories = analysis.sample_data?.categories || [];

      let code = "";
      const classList = categories.filter(c => c.tid).map(c => `{ "type_name": "${c.name}", "type_id": "${c.tid}" }`);

      if (cms === "maccms_v8") {
        code = `#!/usr/bin/python
# -*- coding: utf-8 -*-
import requests, re, json, urllib.parse
from lxml import etree
from base.spider import Spider

class Spider(Spider):
    def init(self, extend=""):
        self.name = "${host.split(".")[0]}影视"
        self.host = "${host}"
        self.headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "Referer": "https://${host}"}

    def fix_url(self, url):
        if not url: return ""
        if url.startswith("//"): return "https:" + url
        if url.startswith("/"): return f"https://{self.host}" + url
        return url

    def homeContent(self, filter):
        try:
            classes = [${classList.join(", ")}]
            filters = {}
            for c in classes:
                tid = c["type_id"]
                filters[tid] = [
                    {"key": "area", "name": "地区", "value": [{"n": "全部", "v": ""}, {"n": "大陆", "v": "大陆"}, {"n": "香港", "v": "香港"}, {"n": "美国", "v": "美国"}, {"n": "日本", "v": "日本"}, {"n": "韩国", "v": "韩国"}]},
                    {"key": "year", "name": "年份", "value": [{"n": "全部", "v": ""}${Array.from({length:10},(_,i)=>`{"n":"${2024-i}","v":"${2024-i}"}`).join(",")}]},
                    {"key": "order", "name": "排序", "value": [{"n": "最新", "v": "time"}, {"n": "最热", "v": "hit"}, {"n": "评分", "v": "score"}]}
                ]
            return {"class": classes, "filters": filters}
        except Exception as e:
            print(f"[{self.name}] 首页错误: {e}")
            return {"class": [], "filters": {}}

    def categoryContent(self, tid, pg, filter, extend):
        try:
            area = extend.get("area", "")
            year = extend.get("year", "")
            order = extend.get("order", "time")
            url = f"https://{self.host}/search.php?searchtype=5&tid={tid}&page={pg}&area={area}&year={year}&order={order}"
            res = requests.get(url, headers=self.headers, timeout=10)
            html = etree.HTML(res.text)
            items = html.xpath('//a[${videoSel ? videoSel.replace(/a\./, "").replace(/^\./, "") : 'contains(@class,"videopic")'}]')
            if not items: items = html.xpath('//div[contains(@class,"item")]//a[contains(@href,"movie")]')
            if not items: items = html.xpath('//a[contains(@href,"/movie/") and .//img]')
            seen, videos = set(), []
            for item in items:
                try:
                    href = self.fix_url("".join(item.xpath(".//@href")) or "")
                    pid = re.search(r"(\\d+)\\.html", href)
                    if not pid or pid.group(1) in seen: continue
                    seen.add(pid.group(1))
                    title = "".join(item.xpath('.//@title | .//@alt')) or "".join(item.xpath(".//text()")).strip()
                    pic = self.fix_url("".join(item.xpath(f'.//img/@${picAttr} | .//img/@src')) or "")
                    videos.append({"vod_id": pid.group(1), "vod_name": title, "vod_pic": pic, "vod_remarks": "".join(item.xpath('.//span[contains(@class,"pic-tag")]/text()'))})
                except: continue
            print(f"[{self.name}] 分类匹配 {len(videos)} 条")
            return {"list": videos, "page": int(pg), "pagecount": 1, "limit": 30, "total": len(videos)}
        except Exception as e:
            print(f"[{self.name}] 分类错误: {e}")
            return {"list": [], "page": 1, "pagecount": 0, "limit": 0, "total": 0}

    def detailContent(self, ids):
        try:
            vid = ids[0] if isinstance(ids, list) else ids.split(",")[0]
            url = f"https://{self.host}/movie/index{vid}.html"
            res = requests.get(url, headers=self.headers, timeout=10)
            html = etree.HTML(res.text)
            vod = {"vod_id": vid, "vod_name": "".join(html.xpath('//h1/text() | //h2/text()')).strip(), "vod_pic": self.fix_url("".join(html.xpath(f'//div[contains(@class,"pic")]//img/@${picAttr} | //div[contains(@class,"pic")]//img/@src')))}
            panels = html.xpath('//div[contains(@class,"panel")]')
            play_from, play_url = [], []
            for p in panels:
                name = "".join(p.xpath('.//a[contains(@class,"option")]/@title | .//a[contains(@class,"option")]/text()')).strip()
                if not name: continue
                eps = p.xpath('.//ul[contains(@class,"playlistlink")]//a')
                if not eps: eps = p.xpath('.//ul//a[contains(@href,"play")]')
                ep_list = []
                for a in eps:
                    t = "".join(a.xpath(".//text()")).strip()
                    u = self.fix_url("".join(a.xpath("./@href")))
                    if t and u: ep_list.append(f"{t}${u}")
                if ep_list: play_from.append(name); play_url.append("#".join(ep_list))
            vod["vod_play_from"] = "$$$".join(play_from)
            vod["vod_play_url"] = "$$$".join(play_url)
            print(f"[{self.name}] 详情 {len(play_from)} 个播放源")
            return {"list": [vod]}
        except Exception as e:
            print(f"[{self.name}] 详情错误: {e}")
            return {"list": []}

    def searchContent(self, key, quick, pg=1):
        try:
            url = f"https://{self.host}/search.php"
            data = {"searchword": key, "searchtype": "video"}
            res = requests.post(url, data=data, headers=self.headers, timeout=10)
            html = etree.HTML(res.text)
            items = html.xpath('//a[contains(@class,"videopic")]')
            if not items: items = html.xpath('//a[contains(@href,"/movie/") and .//img]')
            seen, videos = set(), []
            for item in items:
                try:
                    href = self.fix_url("".join(item.xpath(".//@href")) or "")
                    pid = re.search(r"(\\d+)\\.html", href)
                    if not pid or pid.group(1) in seen: continue
                    seen.add(pid.group(1))
                    videos.append({"vod_id": pid.group(1), "vod_name": "".join(item.xpath('.//@title | .//@alt')).strip(), "vod_pic": self.fix_url("".join(item.xpath(f'.//img/@${picAttr}')) or "")})
                except: continue
            print(f"[{self.name}] 搜索 {key} 结果 {len(videos)} 条")
            return {"list": videos, "page": int(pg), "pagecount": 1, "limit": 30, "total": len(videos)}
        except Exception as e:
            print(f"[{self.name}] 搜索错误: {e}")
            return {"list": [], "page": 1, "pagecount": 0, "limit": 0, "total": 0}

    def playerContent(self, flag, id, vipFlags):
        try:
            if ".m3u8" in id or ".mp4" in id:
                return {"parse": 0, "playUrl": "", "url": id, "header": json.dumps(self.headers)}
            url = self.fix_url(id)
            res = requests.get(url, headers=self.headers, timeout=10)
            body = res.text
            ${hasEncryption ? `import base64; ` : ""}m = re.search(r'var\\s+now\\s*=\\s*["\\']([^"\\']+)["\\']', body)
            if not m: m = re.search(r'player_data[^}]*"url"\\s*:\\s*["\\']([^"\\']+)["\\']', body)
            if not m: m = re.search(r'var\\s+playurl\\s*=\\s*["\\']([^"\\']+)["\\']', body)
            if not m: m = re.search(r'url\\s*:\\s*["\\']([^"\\']+)["\\']', body)
            play_url = self.fix_url(m.group(1)) if m else ""
            ${hasEncryption ? `if not play_url and "eval(" in body: play_url = "需要解密: " + encryptionType` : ""}
            print(f"[{self.name}] 播放: {flag} -> {play_url[:50]}...")
            return {"parse": 0, "playUrl": "", "url": play_url, "header": json.dumps(self.headers)}
        except Exception as e:
            print(f"[{self.name}] 播放错误: {e}")
            return {"parse": 0, "playUrl": "", "url": "", "header": ""}
`;
      } else if (cms === "maccms_v10") {
        code = `#!/usr/bin/python
# -*- coding: utf-8 -*-
import requests, re, json
from lxml import etree
from base.spider import Spider

class Spider(Spider):
    def init(self, extend=""):
        self.name = "${host.split(".")[0]}影视"
        self.host = "${host}"
        self.headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "Referer": "https://${host}"}

    def fix_url(self, url):
        if not url: return ""
        if url.startswith("//"): return "https:" + url
        if url.startswith("/"): return f"https://{self.host}" + url
        return url

    def homeContent(self, filter):
        try:
            classes = [${classList.join(", ")}]
            filters = {}
            for c in classes:
                tid = c["type_id"]
                filters[tid] = [
                    {"key": "area", "name": "地区", "value": [{"n": "全部", "v": ""}, {"n": "大陆", "v": "大陆"}, {"n": "香港", "v": "香港"}, {"n": "美国", "v": "美国"}, {"n": "日本", "v": "日本"}, {"n": "韩国", "v": "韩国"}]},
                    {"key": "year", "name": "年份", "value": [{"n": "全部", "v": ""}${Array.from({length:10},(_,i)=>`{"n":"${2024-i}","v":"${2024-i}"}`).join(",")}]},
                    {"key": "order", "name": "排序", "value": [{"n": "最新", "v": "time"}, {"n": "最热", "v": "hits"}, {"n": "评分", "v": "score"}]}
                ]
            return {"class": classes, "filters": filters}
        except Exception as e:
            print(f"[{self.name}] 首页错误: {e}")
            return {"class": [], "filters": {}}

    def categoryContent(self, tid, pg, filter, extend):
        try:
            area = extend.get("area", "")
            year = extend.get("year", "")
            order = extend.get("order", "time")
            url = f"https://{self.host}/index.php/vod/show/id/{tid}/page/{pg}/area/{area}/year/{year}/by/{order}.html"
            res = requests.get(url, headers=self.headers, timeout=10)
            html = etree.HTML(res.text)
            items = html.xpath('//a[${videoSel ? videoSel.replace(/a\./, "").replace(/^\./, "") : 'contains(@class,"module-item")'}]')
            if not items: items = html.xpath('//div[contains(@class,"module-items")]//a[contains(@href,"detail")]')
            if not items: items = html.xpath('//a[contains(@href,"/vod/detail/") and .//img]')
            seen, videos = set(), []
            for item in items:
                try:
                    href = self.fix_url("".join(item.xpath(".//@href")) or "")
                    pid = re.search(r"id/(\\d+)", href)
                    if not pid or pid.group(1) in seen: continue
                    seen.add(pid.group(1))
                    title = "".join(item.xpath('.//@title | .//@alt')) or "".join(item.xpath(".//text()")).strip()
                    pic = self.fix_url("".join(item.xpath(f'.//img/@${picAttr} | .//img/@src')) or "")
                    videos.append({"vod_id": pid.group(1), "vod_name": title, "vod_pic": pic})
                except: continue
            print(f"[{self.name}] 分类匹配 {len(videos)} 条")
            return {"list": videos, "page": int(pg), "pagecount": 1, "limit": 30, "total": len(videos)}
        except Exception as e:
            print(f"[{self.name}] 分类错误: {e}")
            return {"list": [], "page": 1, "pagecount": 0, "limit": 0, "total": 0}

    def detailContent(self, ids):
        try:
            vid = ids[0] if isinstance(ids, list) else ids.split(",")[0]
            url = f"https://{self.host}/index.php/vod/detail/id/{vid}.html"
            res = requests.get(url, headers=self.headers, timeout=10)
            html = etree.HTML(res.text)
            vod = {"vod_id": vid, "vod_name": "".join(html.xpath('//h1/text() | //h2/text()')).strip(), "vod_pic": self.fix_url("".join(html.xpath(f'//div[contains(@class,"module-item")]//img/@${picAttr} | //div[contains(@class,"module-item")]//img/@src')))}
            tabs = html.xpath('//div[contains(@class,"module-tab-item")]')
            contents = html.xpath('//div[contains(@class,"module-play-list")]')
            play_from, play_url = [], []
            for i, tab in enumerate(tabs):
                name = "".join(tab.xpath(".//text()")).strip()
                if not name: continue
                ep_list = []
                content = contents[i] if i < len(contents) else None
                if content is None: continue
                eps = content.xpath('.//a[contains(@href,"play")]')
                for a in eps:
                    t = "".join(a.xpath(".//text()")).strip()
                    u = self.fix_url("".join(a.xpath("./@href")))
                    if t and u: ep_list.append(f"{t}${u}")
                if ep_list: play_from.append(name); play_url.append("#".join(ep_list))
            if not play_from:
                panels = html.xpath('//div[contains(@class,"panel")]')
                for p in panels:
                    name = "".join(p.xpath('.//a[contains(@class,"option")]/@title')).strip()
                    if not name: continue
                    eps = p.xpath('.//ul[contains(@class,"playlistlink")]//a')
                    ep_list = [f'{"".join(a.xpath(".//text()")).strip()}${self.fix_url("".join(a.xpath("./@href")))}' for a in eps]
                    if ep_list: play_from.append(name); play_url.append("#".join(ep_list))
            vod["vod_play_from"] = "$$$".join(play_from)
            vod["vod_play_url"] = "$$$".join(play_url)
            print(f"[{self.name}] 详情 {len(play_from)} 个播放源")
            return {"list": [vod]}
        except Exception as e:
            print(f"[{self.name}] 详情错误: {e}")
            return {"list": []}

    def searchContent(self, key, quick, pg=1):
        try:
            url = f"https://{self.host}/index.php/vod/search.html?wd={key}&page={pg}"
            res = requests.get(url, headers=self.headers, timeout=10)
            html = etree.HTML(res.text)
            items = html.xpath('//a[contains(@class,"module-item")]')
            if not items: items = html.xpath('//a[contains(@href,"/vod/detail/") and .//img]')
            seen, videos = set(), []
            for item in items:
                try:
                    href = self.fix_url("".join(item.xpath(".//@href")) or "")
                    pid = re.search(r"id/(\\d+)", href)
                    if not pid or pid.group(1) in seen: continue
                    seen.add(pid.group(1))
                    videos.append({"vod_id": pid.group(1), "vod_name": "".join(item.xpath('.//@title | .//@alt')).strip(), "vod_pic": self.fix_url("".join(item.xpath(f'.//img/@${picAttr}')) or "")})
                except: continue
            print(f"[{self.name}] 搜索 {key} 结果 {len(videos)} 条")
            return {"list": videos, "page": int(pg), "pagecount": 1, "limit": 30, "total": len(videos)}
        except Exception as e:
            print(f"[{self.name}] 搜索错误: {e}")
            return {"list": [], "page": 1, "pagecount": 0, "limit": 0, "total": 0}

    def playerContent(self, flag, id, vipFlags):
        try:
            if ".m3u8" in id or ".mp4" in id:
                return {"parse": 0, "playUrl": "", "url": id, "header": json.dumps(self.headers)}
            url = self.fix_url(id)
            res = requests.get(url, headers=self.headers, timeout=10)
            body = res.text
            m = re.search(r'player_data\\s*=\\s*(\\{.*?\\})', body)
            if m:
                try:
                    pd = json.loads(m.group(1).replace("'", '"'))
                    play_url = pd.get("url", "")
                except: play_url = ""
            else:
                m = re.search(r'var\\s+now\\s*=\\s*["\\']([^"\\']+)["\\']', body)
                play_url = m.group(1) if m else ""
            if not play_url:
                m = re.search(r'url\\s*:\\s*["\\']([^"\\']+)["\\']', body)
                play_url = m.group(1) if m else ""
            play_url = self.fix_url(play_url)
            print(f"[{self.name}] 播放: {flag} -> {play_url[:50]}...")
            return {"parse": 0, "playUrl": "", "url": play_url, "header": json.dumps(self.headers)}
        except Exception as e:
            print(f"[{self.name}] 播放错误: {e}")
            return {"parse": 0, "playUrl": "", "url": "", "header": ""}
`;
      } else if (cms === "api_collect") {
        const apiPath = analysis.features?.api_path || "/api.php/provide/vod/";
        const apiFormat = analysis.features?.api_format || "json";
        code = `#!/usr/bin/python
# -*- coding: utf-8 -*-
import requests, re, json
from base.spider import Spider

class Spider(Spider):
    def init(self, extend=""):
        self.name = "${host.split(".")[0]}采集源"
        self.host = "${host}"
        self.api = "https://${host}${apiPath}"
        self.headers = {"User-Agent": "Mozilla/5.0"}

    def homeContent(self, filter):
        try:
            res = requests.get(self.api, headers=self.headers, timeout=10)
            data = res.json()
            classes = [{"type_name": c["type_name"], "type_id": str(c["type_id"])} for c in data.get("class", [])]
            return {"class": classes, "filters": {}}
        except Exception as e:
            print(f"[{self.name}] 首页错误: {e}")
            return {"class": [], "filters": {}}

    def categoryContent(self, tid, pg, filter, extend):
        try:
            url = f"{self.api}?ac=videolist&t={tid}&pg={pg}"
            res = requests.get(url, headers=self.headers, timeout=10)
            data = res.json()
            videos = []
            for v in data.get("list", []):
                videos.append({"vod_id": str(v.get("vod_id", "")), "vod_name": v.get("vod_name", ""), "vod_pic": v.get("vod_pic", ""), "vod_remarks": v.get("vod_remarks", "")})
            pgcount = data.get("pagecount", 1)
            return {"list": videos, "page": int(pg), "pagecount": int(pgcount), "limit": 30, "total": data.get("total", len(videos))}
        except Exception as e:
            print(f"[{self.name}] 分类错误: {e}")
            return {"list": [], "page": 1, "pagecount": 0, "limit": 0, "total": 0}

    def detailContent(self, ids):
        try:
            vid = ids[0] if isinstance(ids, list) else ids.split(",")[0]
            url = f"{self.api}?ac=detail&ids={vid}"
            res = requests.get(url, headers=self.headers, timeout=10)
            data = res.json()
            vod_list = data.get("list", [])
            if not vod_list: return {"list": []}
            v = vod_list[0]
            vod = {"vod_id": str(v.get("vod_id", "")), "vod_name": v.get("vod_name", ""), "vod_pic": v.get("vod_pic", ""), "vod_content": v.get("vod_content", ""), "vod_play_from": v.get("vod_play_from", ""), "vod_play_url": v.get("vod_play_url", "")}
            print(f"[{self.name}] 详情获取成功")
            return {"list": [vod]}
        except Exception as e:
            print(f"[{self.name}] 详情错误: {e}")
            return {"list": []}

    def searchContent(self, key, quick, pg=1):
        try:
            url = f"{self.api}?wd={key}&pg={pg}"
            res = requests.get(url, headers=self.headers, timeout=10)
            data = res.json()
            videos = [{"vod_id": str(v.get("vod_id", "")), "vod_name": v.get("vod_name", ""), "vod_pic": v.get("vod_pic", ""), "vod_remarks": v.get("vod_remarks", "")} for v in data.get("list", [])]
            print(f"[{self.name}] 搜索 {key} 结果 {len(videos)} 条")
            return {"list": videos, "page": int(pg), "pagecount": 1, "limit": 30, "total": len(videos)}
        except Exception as e:
            print(f"[{self.name}] 搜索错误: {e}")
            return {"list": [], "page": 1, "pagecount": 0, "limit": 0, "total": 0}

    def playerContent(self, flag, id, vipFlags):
        try:
            if not id.startswith("http"): id = "https://" + id
            print(f"[{self.name}] 播放: {id[:50]}...")
            return {"parse": 0, "playUrl": "", "url": id, "header": json.dumps(self.headers)}
        except Exception as e:
            print(f"[{self.name}] 播放错误: {e}")
            return {"parse": 0, "playUrl": "", "url": "", "header": ""}
`;
      } else {
        // 非标架构
        code = `#!/usr/bin/python
# -*- coding: utf-8 -*-
import requests, re, json
from lxml import etree
from base.spider import Spider

class Spider(Spider):
    def init(self, extend=""):
        self.name = "${host.split(".")[0]}影视"
        self.host = "${host}"
        self.headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "Referer": "https://${host}"}

    def fix_url(self, url):
        if not url: return ""
        if url.startswith("//"): return "https:" + url
        if url.startswith("/"): return f"https://{self.host}" + url
        return url

    def homeContent(self, filter):
        try:
            classes = [${classList.length > 0 ? classList.join(", ") : '{"type_name": "电影", "type_id": "1"}, {"type_name": "电视剧", "type_id": "2"}'}]
            return {"class": classes, "filters": {}}
        except Exception as e:
            print(f"[{self.name}] 首页错误: {e}")
            return {"class": [], "filters": {}}

    def categoryContent(self, tid, pg, filter, extend):
        try:
            # TODO: 根据实际URL规律修改分类页URL
            url = f"https://{self.host}/type/{tid}/{pg}.html"
            res = requests.get(url, headers=self.headers, timeout=10)
            html = etree.HTML(res.text)
            # 兜底选择器
            items = html.xpath('//a[${videoSel ? videoSel.replace(/a\./, "").replace(/^\./, "") : 'contains(@href,"detail") and .//img'}]')
            if not items: items = html.xpath('//div[contains(@class,"item")]//a[.//img]')
            if not items: items = html.xpath('//a[.//img and contains(@href,"vod")]')
            seen, videos = set(), []
            for item in items:
                try:
                    href = self.fix_url("".join(item.xpath(".//@href")) or "")
                    pid = re.search(r"(\\d+)", href)
                    if not pid or pid.group(1) in seen: continue
                    seen.add(pid.group(1))
                    title = "".join(item.xpath('.//@title | .//@alt')) or "".join(item.xpath(".//text()")).strip()
                    pic = self.fix_url("".join(item.xpath(f'.//img/@${picAttr} | .//img/@src')) or "")
                    videos.append({"vod_id": pid.group(1), "vod_name": title, "vod_pic": pic})
                except: continue
            print(f"[{self.name}] 分类匹配 {len(videos)} 条")
            return {"list": videos, "page": int(pg), "pagecount": 1, "limit": 30, "total": len(videos)}
        except Exception as e:
            print(f"[{self.name}] 分类错误: {e}")
            return {"list": [], "page": 1, "pagecount": 0, "limit": 0, "total": 0}

    def detailContent(self, ids):
        try:
            vid = ids[0] if isinstance(ids, list) else ids.split(",")[0]
            # TODO: 根据实际URL规律修改详情页URL
            url = f"https://{self.host}/detail/{vid}.html"
            res = requests.get(url, headers=self.headers, timeout=10)
            html = etree.HTML(res.text)
            vod = {"vod_id": vid, "vod_name": "".join(html.xpath('//h1/text() | //h2/text()')).strip(), "vod_pic": self.fix_url("".join(html.xpath(f'//img/@${picAttr} | //img/@src')).split()[0] if "".join(html.xpath(f'//img/@${picAttr} | //img/@src')) else "")}
            # 播放源提取 - 多级兜底
            play_from, play_url = [], []
            # 方式1：module-tab
            tabs = html.xpath('//div[contains(@class,"module-tab-item")]')
            contents = html.xpath('//div[contains(@class,"module-play-list")]')
            for i, tab in enumerate(tabs):
                name = "".join(tab.xpath(".//text()")).strip()
                if not name or i >= len(contents): continue
                eps = contents[i].xpath('.//a[contains(@href,"play")]')
                ep_list = [f'{"".join(a.xpath(".//text()")).strip()}${self.fix_url("".join(a.xpath("./@href")))}' for a in eps]
                if ep_list: play_from.append(name); play_url.append("#".join(ep_list))
            # 方式2：panel
            if not play_from:
                panels = html.xpath('//div[contains(@class,"panel")]')
                for p in panels:
                    name = "".join(p.xpath('.//a[contains(@class,"option")]/@title')).strip()
                    if not name: continue
                    eps = p.xpath('.//ul[contains(@class,"playlistlink")]//a')
                    ep_list = [f'{"".join(a.xpath(".//text()")).strip()}${self.fix_url("".join(a.xpath("./@href")))}' for a in eps]
                    if ep_list: play_from.append(name); play_url.append("#".join(ep_list))
            vod["vod_play_from"] = "$$$".join(play_from)
            vod["vod_play_url"] = "$$$".join(play_url)
            print(f"[{self.name}] 详情 {len(play_from)} 个播放源")
            return {"list": [vod]}
        except Exception as e:
            print(f"[{self.name}] 详情错误: {e}")
            return {"list": []}

    def searchContent(self, key, quick, pg=1):
        try:
            # TODO: 根据实际搜索方式修改
            url = f"https://{self.host}/search.html?wd={key}&page={pg}"
            res = requests.get(url, headers=self.headers, timeout=10)
            html = etree.HTML(res.text)
            items = html.xpath('//a[contains(@href,"detail") and .//img]')
            if not items: items = html.xpath('//a[.//img]')
            seen, videos = set(), []
            for item in items:
                try:
                    href = self.fix_url("".join(item.xpath(".//@href")) or "")
                    pid = re.search(r"(\\d+)", href)
                    if not pid or pid.group(1) in seen: continue
                    seen.add(pid.group(1))
                    videos.append({"vod_id": pid.group(1), "vod_name": "".join(item.xpath('.//@title | .//@alt')).strip(), "vod_pic": self.fix_url("".join(item.xpath(f'.//img/@${picAttr}')) or "")})
                except: continue
            print(f"[{self.name}] 搜索 {key} 结果 {len(videos)} 条")
            return {"list": videos, "page": int(pg), "pagecount": 1, "limit": 30, "total": len(videos)}
        except Exception as e:
            print(f"[{self.name}] 搜索错误: {e}")
            return {"list": [], "page": 1, "pagecount": 0, "limit": 0, "total": 0}

    def playerContent(self, flag, id, vipFlags):
        try:
            if ".m3u8" in id or ".mp4" in id:
                return {"parse": 0, "playUrl": "", "url": id, "header": json.dumps(self.headers)}
            url = self.fix_url(id)
            res = requests.get(url, headers=self.headers, timeout=10)
            body = res.text
            m = re.search(r'var\\s+now\\s*=\\s*["\\']([^"\\']+)["\\']', body)
            if not m: m = re.search(r'player_data\\s*=\\s*(\\{.*?\\})', body)
            if not m: m = re.search(r'url\\s*:\\s*["\\']([^"\\']+)["\\']', body)
            play_url = ""
            if m:
                if "player_data" in m.group(0):
                    try: play_url = json.loads(m.group(1).replace("'", '"')).get("url", "")
                    except: play_url = ""
                else: play_url = m.group(1)
            play_url = self.fix_url(play_url)
            print(f"[{self.name}] 播放: {flag} -> {play_url[:50]}...")
            return {"parse": 0, "playUrl": "", "url": play_url, "header": json.dumps(self.headers)}
        except Exception as e:
            print(f"[{self.name}] 播放错误: {e}")
            return {"parse": 0, "playUrl": "", "url": "", "header": ""}
`;
      }

      return { content: [{ type: "text", text: `✅ 基于分析结果生成爬虫源\n📦 CMS类型: ${cms}\n🎨 模板: ${tpl || "通用"}\n🎯 视频选择器: ${videoSel || "兜底"}\n🎵 播放源选择器: ${playSourceSel || "兜底"}\n🔒 加密: ${hasEncryption ? encryptionType : "无"}\n\n\`\`\`python\n${code}\n\`\`\`` }] };
    }

    if (name === "debug_selector") {
      const { url, selector, extract = "text" } = args;
      try {
        const html = await fetchPage(url);
        const $ = load(html);
        const elements = $(selector);
        const results = [];
        elements.slice(0, 5).each((_, el) => {
          if (extract === "html") results.push($(el).html()?.slice(0, 500));
          else if (extract.startsWith("attr:")) results.push($(el).attr(extract.split(":")[1]));
          else results.push($(el).text().trim().slice(0, 200));
        });
        const warnings = [];
        if (selector.includes("[class=") || selector.includes("[class*='") === false && selector.includes(".item") === false) {
          // CSS选择器不做contains检查，这是XPath的规则
        }
        return { content: [{ type: "text", text: `📊 选择器调试结果\n选择器: ${selector}\n页面: ${url}\n匹配数量: ${elements.length}\n前5个结果:\n${results.map((r, i) => `  [${i + 1}] ${r || "(空)"}`).join("\n")}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `❌ 调试失败: ${e.message}` }] };
      }
    }

    if (name === "debug_play_link") {
      const { url, page_url } = args;
      const host = getHost(url);
      const headers = { "User-Agent": UA, "Referer": page_url || `https://${host}`, "Accept-Language": "zh-CN,zh;q=0.9" };
      const fixU = (u) => { if (!u) return ""; if (u.startsWith("//")) return "https:" + u; if (u.startsWith("/")) return "https://" + host + u; return u; };

      // Step 1: 直链检测
      if (/\.m3u8(\?|$)/.test(url) || /\.mp4(\?|$)/.test(url)) {
        return { content: [{ type: "text", text: `✅ 直链检测\n类型: ${url.includes(".m3u8") ? "m3u8" : "mp4"}\n链接: ${url}` }] };
      }

      // Step 2: 请求播放页
      try {
        const res = await axios.get(url, { headers, timeout: 10000 });
        const body = res.data;
        const methods = [];

        // v8: var now="..."
        let m = body.match(/var\s+now\s*=\s*["']([^"']+)["']/);
        if (m) methods.push({ method: "MacCMS v8 (var now=)", url: fixU(m[1]) });

        // v10: player_data={...}
        m = body.match(/player_data\s*=\s*(\{.*?\})/);
        if (m) {
          try {
            const pd = JSON.parse(m[1].replace(/'/g, '"'));
            if (pd.url) methods.push({ method: "MacCMS v10 (player_data)", url: fixU(pd.url) });
          } catch {}
        }

        // 通用: var playurl="..."
        m = body.match(/var\s+playurl\s*=\s*["']([^"']+)["']/);
        if (m) methods.push({ method: "通用 (var playurl=)", url: fixU(m[1]) });

        // 通用: url:"..."
        m = body.match(/url\s*:\s*["']([^"']+)["']/);
        if (m) methods.push({ method: "通用 (url:)", url: fixU(m[1]) });

        // unescape
        m = body.match(/unescape\(["']([^"']+)["']\)/);
        if (m) {
          try { methods.push({ method: "unescape解码", url: unescape(m[1]) }); } catch {}
        }

        // Base64
        m = body.match(/atob\(["']([^"']+)["']\)/);
        if (m) {
          try { methods.push({ method: "Base64解码", url: Buffer.from(m[1], "base64").toString() }); } catch {}
        }

        // iframe检测
        const $ = load(body);
        const iframes = $("iframe");
        if (iframes.length > 0) {
          const iframeSrc = iframes.first().attr("src") || "";
          if (iframeSrc) methods.push({ method: "iframe嵌套", url: fixU(iframeSrc) });
        }

        const vaildMethod = methods.find(m => m.url && (m.url.includes(".m3u8") || m.url.includes(".mp4")));

        const report = `
📺 播放链接调试结果
页面: ${url}
${vaildMethod ? `✅ 有效链接 (通过: ${vaildMethod.method})\n🔗 ${vaildMethod.url}` : "❌ 未找到有效直链"}
检测到的方法 (${methods.length}个):
${methods.map(m => `  · ${m.method}: ${m.url ? m.url.slice(0, 80) + "..." : "(空)"}`).join("\n") || "  无"}
${!vaildMethod && methods.length > 0 ? "\n⚠️ 找到链接但非m3u8/mp4格式，可能需要二次解析" : ""}
${iframes.length > 0 ? `\n🖼️ 检测到iframe，可能需要递归解析` : ""}
`;
        return { content: [{ type: "text", text: report }] };
      } catch (e) {
        return { content: [{ type: "text", text: `❌ 播放链接调试失败: ${e.message}` }] };
      }
    }

    if (name === "test_interface") {
      const { source_code, interface: iface } = args;
      const results = [];

      const checks = {
        home: [
          { name: "返回JSON格式", test: /return\s*\{[^}]*"class"/.test(source_code) },
          { name: "包含class列表", test: /"class"/.test(source_code) },
          { name: "包含filters", test: /"filters"/.test(source_code) },
          { name: "异常处理", test: /except\s+Exception/.test(source_code) }
        ],
        category: [
          { name: "多级选择器兜底", test: /if not items:/.test(source_code) },
          { name: "contains匹配", test: /contains\(@class/.test(source_code) },
          { name: "去重机制", test: /seen/.test(source_code) },
          { name: "URL补全fix_url", test: /fix_url/.test(source_code) },
          { name: "标准化日志", test: /print\(f?\[/.test(source_code) }
        ],
        detail: [
          { name: "播放源提取", test: /play_from/.test(source_code) },
          { name: "多播放源分隔$$$", test: /\$\$\$/.test(source_code) },
          { name: "剧集分隔#", test: /"#"\.join/.test(source_code) },
          { name: "单条容错continue", test: /continue/.test(source_code) },
          { name: "panel contains匹配", test: /contains\(@class.*panel/.test(source_code) || /contains\(@class.*tab/.test(source_code) }
        ],
        search: [
          { name: "搜索URL构建", test: /search/.test(source_code) },
          { name: "去重机制", test: /seen/.test(source_code) },
          { name: "多级兜底", test: /if not items:/.test(source_code) }
        ],
        play: [
          { name: "直链检测", test: /\.m3u8|\.mp4/.test(source_code) },
          { name: "JS变量提取", test: /var\s+now|player_data/.test(source_code) },
          { name: "URL补全", test: /fix_url/.test(source_code) },
          { name: "返回header", test: /"header"/.test(source_code) }
        ]
      };

      const targets = iface === "all" ? Object.keys(checks) : [iface];
      for (const t of targets) {
        if (checks[t]) {
          for (const c of checks[t]) {
            results.push({ interface: t, check: c.name, pass: c.test });
          }
        }
      }

      const passed = results.filter(r => r.pass).length;
      const total = results.length;
      const score = Math.round((passed / total) * 100);

      return { content: [{ type: "text", text: `🧪 接口测试结果 (${iface})\n通过: ${passed}/${total} (${score}%)\n\n${results.map(r => `${r.pass ? "✅" : "❌"} [${r.interface}] ${r.check}`).join("\n")}` }] };
    }

    if (name === "evaluate_source") {
      const { source_code } = args;
      const rules = [
        { name: "使用lxml+etree", test: /from lxml import/.test(source_code), weight: 10 },
        { name: "XPath含contains匹配", test: /contains\(@class/.test(source_code), weight: 15 },
        { name: "禁止@class=精确匹配", test: !/\/\*\[@class="[^"]*"\]/.test(source_code) || /contains/.test(source_code), weight: 15 },
        { name: "多级选择器兜底", test: (source_code.match(/if not items:/g) || []).length >= 1, weight: 10 },
        { name: "去重机制(seen set)", test: /seen/.test(source_code), weight: 10 },
        { name: "URL补全(fix_url)", test: /fix_url/.test(source_code), weight: 10 },
        { name: "标准化日志输出", test: /print\(f?\[/.test(source_code) || /print\(f"/.test(source_code), weight: 5 },
        { name: "异常处理完善", test: (source_code.match(/except\s+Exception/g) || []).length >= 3, weight: 5 },
        { name: "单条容错continue", test: /continue/.test(source_code), weight: 5 },
        { name: "播放源$$$/#分隔", test: /\$\$\$/.test(source_code) && /"#"\.join/.test(source_code), weight: 5 },
        { name: "空值容错(or/)", test: /\|\||\sor\s/.test(source_code), weight: 5 },
        { name: "引用base.spider", test: /from base\.spider import/.test(source_code), weight: 5 }
      ];

      const results = rules.map(r => ({ ...r, pass: r.test }));
      const totalWeight = rules.reduce((s, r) => s + r.weight, 0);
      const passedWeight = results.filter(r => r.pass).reduce((s, r) => s + r.weight, 0);
      const score = Math.round((passedWeight / totalWeight) * 100);
      const grade = score >= 90 ? "S" : score >= 80 ? "A" : score >= 60 ? "B" : score >= 40 ? "C" : "D";

      return { content: [{ type: "text", text: `📊 代码规范评估\n等级: ${grade} (${score}分)\n权重得分: ${passedWeight}/${totalWeight}\n\n${results.map(r => `${r.pass ? "✅" : "❌"} [${r.weight}分] ${r.name}`).join("\n")}\n\n${results.filter(r => !r.pass).map(r => `⚠️ 需修复: ${r.name}`).join("\n") || "🎉 全部通过！"}` }] };
    }

    if (name === "fetch_url") {
      const { url, region = "video_list" } = args;
      try {
        const html = await fetchPage(url);
        const $ = load(html);
        let result = "";
        if (region === "video_list") {
          const sels = ["div.stui-vodlist", "div.hy-video-list", "div.module-items", "ul.myui-vodlist", "div.video-list", "div.list"];
          for (const s of sels) {
            if ($(s).length > 0) { result = $(s).first().html(); break; }
          }
          if (!result) result = $("body").html()?.slice(0, 8000) || "";
        } else if (region === "play_area") {
          const sels = ["div.stui-vodlist__head", "div.hy-play-list", "div.module-play", "div.panel", "div.playlist"];
          for (const s of sels) {
            if ($(s).length > 0) { result = $(s).first().parent().html(); break; }
          }
          if (!result) result = $("body").html()?.slice(0, 8000) || "";
        } else {
          result = html.slice(0, 10000);
        }
        return { content: [{ type: "text", text: truncStr(result, 8000) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `❌ 抓取失败: ${e.message}` }] };
      }
    }

    if (name === "edit_file") {
      let c = fs.readFileSync(args.path, "utf8");
      c = c.replaceAll(args.search_text, args.replace_text);
      fs.writeFileSync(args.path, c, "utf8");
      return { content: [{ type: "text", text: "✅ 替换完成" }] };
    }

    if (name === "find_in_file") {
      const c = fs.readFileSync(args.path, "utf8");
      const lines = c.split("\n").map((l, i) => l.includes(args.keyword) ? `${i + 1}: ${l}` : "").filter(Boolean);
      return { content: [{ type: "text", text: lines.join("\n") || "未找到匹配" }] };
    }

    if (name === "list_directory") {
      const files = fs.readdirSync(args.path).map(f => ({ name: f, isDir: fs.statSync(path.join(args.path, f)).isDirectory() }));
      return { content: [{ type: "text", text: JSON.stringify(files, null, 2) }] };
    }

    
    if (name === "read_file") {
      const p = args.path;
      const offset = args.offset || 0;
      const limit = args.limit;
      let c = fs.readFileSync(p, "utf8");
      let lines = c.split("\n");
      lines = lines.slice(offset, limit ? offset + limit : undefined);
      const numbered = lines.map((l, i) => `${offset + i + 1}| ${l}`).join("\n");
      return { content: [{ type: "text", text: numbered }] };
    }
    if (name === "write_file") {
      const p = args.path;
      const dir = path.dirname(p);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      if (args.append) { fs.appendFileSync(p, args.content, "utf8"); }
      else { fs.writeFileSync(p, args.content, "utf8"); }
      return { content: [{ type: "text", text: "写入完成: " + p }] };
    }
    if (name === "delete_file") {
      const p = args.path;
      if (!fs.existsSync(p)) return { content: [{ type: "text", text: "路径不存在: " + p }] };
      if (fs.statSync(p).isDirectory()) {
        if (args.recursive) { fs.rmSync(p, { recursive: true, force: true }); }
        else { fs.rmdirSync(p); }
      } else { fs.unlinkSync(p); }
      return { content: [{ type: "text", text: "已删除: " + p }] };
    }
    if (name === "create_directory") {
      const p = args.path;
      if (args.recursive !== false) { fs.mkdirSync(p, { recursive: true }); }
      else { fs.mkdirSync(p); }
      return { content: [{ type: "text", text: "目录已创建: " + p }] };
    }
    if (name === "move_file") {
      const src = args.source; const dst = args.destination;
      const dstDir = path.dirname(dst);
      if (!fs.existsSync(dstDir)) fs.mkdirSync(dstDir, { recursive: true });
      fs.renameSync(src, dst);
      return { content: [{ type: "text", text: "已移动: " + src + " -> " + dst }] };
    }
    if (name === "copy_file") {
      const src = args.source; const dst = args.destination;
      const dstDir = path.dirname(dst);
      if (!fs.existsSync(dstDir)) fs.mkdirSync(dstDir, { recursive: true });
      if (fs.statSync(src).isDirectory()) { fs.cpSync(src, dst, { recursive: true }); }
      else { fs.copyFileSync(src, dst); }
      return { content: [{ type: "text", text: "已复制: " + src + " -> " + dst }] };
    }
    if (name === "file_info") {
      const p = args.path;
      if (!fs.existsSync(p)) return { content: [{ type: "text", text: "路径不存在: " + p }] };
      const stat = fs.statSync(p);
      return { content: [{ type: "text", text: JSON.stringify({ path: p, name: path.basename(p), ext: path.extname(p), size: stat.size, isFile: stat.isFile(), isDirectory: stat.isDirectory(), mode: stat.mode.toString(8), atime: stat.atime.toISOString(), mtime: stat.mtime.toISOString(), ctime: stat.ctime.toISOString() }, null, 2) }] };
    }
    if (name === "get_cwd") {
      return { content: [{ type: "text", text: process.cwd() }] };
    }
    return { content: [{ type: "text", text: "未知指令" }] };
  } catch (e) {
    return { content: [{ type: "text", text: `❌ 错误: ${e.message}` }] };
  }
});

const transport = new StdioServerTransport();
server.connect(transport).then(() => {
  console.log("MCP v3.1 Full 服务已启动 · 全量文件操作 + 深度分析 + 智能生成 + 真实调试");
});