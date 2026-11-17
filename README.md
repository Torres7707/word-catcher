# Word Catcher 🪝

一个 Chrome 扩展（Manifest V3）：读英文文档时，你**划选**的英文单词和短语会被记录成词条；**同一个词条第二次被划选**（哪怕隔了几个月）就自动进入「生词本」。

- AI 是可选功能。**未配置 AI 时不发任何网络请求**，只记录单词。配置后可以查看查词结果，也能记录短语。
- 没有后端，没有统计，没有远程代码。
- 必需权限只有 `storage`（内容脚本匹配 `<all_urls>`，用来监听划选）。访问 AI 网关地址的权限是可选权限，在设置页保存时才申请。

## 功能

- 划选单个英文单词（字母，允许中间的 `'` 或 `-`，长度 2–30）即记录；自动转小写、去掉两侧标点。
- 划选 2 到 6 个英文词（最长 60 字符）时是短语候选：配置 AI 后由 AI 判定，置信度不低于 0.8 才作为短语记录；未配置 AI 时不记录。判定结果缓存在本机，同一段文字不会重复判定。
- 在 `input` / `textarea` / `contenteditable` 里的选择会被忽略。
- 记录原句（尽力而为，≤300 字）、页面地址（只保留 origin + path，不含 query/hash）和时间。
- 第 2 次划选 → 状态自动变为「生词本」，页面右下角弹出小提示「✓ 已加入生词本: word」（Shadow DOM，2 秒后淡出，可在弹窗里关闭「页面提示」）。
- 配置 AI 后，划选旁出现查词图标，点开卡片显示原句中的意思、释义、搭配、短语、例句；可「重新生成」。
- 扩展图标上的角标显示生词本数量。
- 弹窗：生词本 / 只划过一次 / 已掌握 三个标签页，搜索、统计、展开查看原句和来源链接，点击词条按需查词（已保存的查词结果直接显示，不再请求）；标记已掌握 / 移回生词本 / 删除；导出 Markdown、导出 JSON、导入 JSON、清空（需确认）。
- 设置页：AI 网关地址、API Key、模型、释义语言，以及「测试连接」。

## 构建（Node ≥ 20）

```bash
npm i && npm run build      # 产物在 dist/
npm test                    # 单元测试 (Vitest)
npm run lint
```

不想构建：到 [Releases](../../releases) 下载 `word-catcher-0.2.0.zip` 解压即可。

## 在 Chrome 中加载

1. 打开 `chrome://extensions`
2. 右上角打开「开发者模式」
3. 点「加载已解压的扩展程序」，选择 `dist` 目录（或 release zip 解压后的目录）
4. 建议把扩展固定到工具栏，方便看角标；装好后**已打开的标签页需要刷新**才会生效。

## 计数规则

- 每次划选都计入划选次数（`count++`），没有上限，**永不过期**。
- 防误触：**同一个词条在同一页面（同一 URL）5 分钟内**重复划选只算一次。
- `count ≥ 2` → 状态从 `seen` 变成 `saved`（生词本）。
- `mastered`（已掌握）不会被自动降级；已掌握的词条再次被划选，状态保持已掌握，但 count 仍会 +1。
- 每个词条最多保留最近 20 条原句。
- 所有写入都由后台 Service Worker 串行处理（内容脚本通过 runtime message 发送），多个标签页同时划选也不会丢数据。

## 数据模型（`chrome.storage.local`）

```ts
words: Record<string, {
  word: string;                                  // 单词或短语（小写）
  kind: 'word' | 'phrase';
  count: number;                                 // 划选次数
  firstSeen: string; lastSeen: string;           // ISO 时间
  contexts: { sentence: string; url: string; date: string }[]; // 原句，最多 20 条
  status: 'seen' | 'saved' | 'mastered';
  lookup?: {                                     // 查词结果
    definitions: string[]; collocations: string[]; phrases: string[];  // 释义、搭配、短语
    examples: { en: string; translation: string }[];                   // 例句
    generatedAt: string;
  };
  meanings?: Record<string, string>;             // 原句 -> 在原句中的意思
}>
recent: Record<`${word}|${url}`, number>   // 防误触用，5 分钟后清理
settings: { toast: boolean }               // 页面提示开关，默认开
aiConfig: { baseUrl: string; apiKey: string; model: string; language: string } // AI 设置，不进入导出文件
phraseChecks: Record<string, { isPhrase: boolean; confidence: number; checkedAt: string }> // 短语判定缓存，最多 2000 条
```

## 导入合并规则（导入 JSON）

导出文件是 `{ version: 2, words }`。导入接受版本 1 和 2，或直接一个 `words` 对象，与现有数据合并：

- 原句：并集，按 `url + date` 去重，按时间排序，保留最新 20 条；
- count：取 `max(本地, 导入, 去重后原句数)` —— 重复导入自己的备份不会翻倍；
- firstSeen 取更早，lastSeen 取更晚；
- 状态取更"高"的一个（seen < saved < mastered），若 count ≥ 2 且为 seen 则升为 saved；
- 查词结果：两边都有时保留生成时间更晚的一份；
- 在原句中的意思：两边都有同一原句时保留本机的，只保留仍在原句列表里的；
- 版本 1 的词条按单词导入；不合规的单词或短语会被跳过；
- 导入和清空都不会改动 AI 设置。

## 备份

弹窗里点「导出 JSON」即可备份（文件名带日期），换电脑或重装后「导入 JSON」恢复。「导出 Markdown」适合复习或贴到笔记里，每个词条下列出释义和例句。数据**只在本机**。

## 卸载

卸载扩展会清除本机上的全部数据和设置：词条、查词结果、短语判定缓存、页面提示开关，以及 AI 设置（含 API Key）。卸载前请先导出 JSON。AI 设置不在导出文件里，重装后需要重新填写。

## 隐私

所有数据只保存在本地 `chrome.storage.local`。

- **未配置 AI**（没有保存模型）时，扩展不发任何网络请求。唯一的例外是你在设置页主动点「测试连接」，它会用表单里填写的地址发一次测试请求。
- **配置 AI 后**，请求只发往你在设置页保存的网关地址（默认是本机 `http://127.0.0.1:3425/v1`），不经过任何其他服务器。每类请求发送的内容：
  - 查词：词条本身、释义语言；需要「在原句中的意思」时再加上那条原句。
  - 短语判定：划选的那段文字（2 到 6 个词），不含原句。
  - 测试连接：固定文字 `Reply with OK.`。
- 请求里**不包含页面地址**，也不包含其他词条、划选次数或你的浏览记录。
- API Key 只放在发往该网关的请求头里。它以明文保存在 `chrome.storage.local`，不会出现在导出文件中。
- 查词结果和短语判定会缓存在本机，再次打开不会重复请求。

## 已知限制

- 不做词形还原：`retries` 和 `retry` 是两个词条。
- 只在普通网页上生效；`chrome://` 页面、Chrome 网上应用店、其他扩展页面无法注入脚本。
- Chrome 内置 PDF 阅读器中的划选不支持。
- 只捕获顶层页面（不含 iframe 内的内容）。
- 原句提取是尽力而为，复杂排版下可能截取不准。

## 端到端测试（可选）

e2e 脚本用 Playwright 自带的 Chromium（`npx playwright-core install chromium`；正式版 Chrome 已不支持 `--load-extension`）加载 `dist`，在本地测试页模拟划选并校验存储、角标和弹窗。查词相关的脚本使用本地假网关，不访问外网：

```bash
npm run build
npm run e2e          # 划选、计数、角标、弹窗
npm run e2e:config   # 设置页
npm run e2e:lookup   # 页面查词卡片、短语
npm run e2e:popup    # 弹窗查词
```

## 开发

Vite + React 19 + TypeScript（strict）。弹窗和设置页由 Vite 构建；`background.js` / `content.js` 由 esbuild 打成单文件（`scripts/build-scripts.mjs`）。AI 请求用 AI SDK 的 OpenAI 兼容 provider。图标由 `npm run icons`（sharp）生成。
