# Word Catcher 🪝

一个 Chrome 扩展（Manifest V3）：读英文文档时，你**划选（高亮）**的英文单词会被记录下来；**同一个单词第二次被划到**（哪怕隔了几个月）就自动进入「生词本」。

- 不翻译、不调用 AI、**不发任何网络请求**，没有后端，没有统计。
- 权限只有 `storage`（内容脚本匹配 `<all_urls>`，用来监听划词）。

## 功能

- 划选单个英文单词（字母，允许中间的 `'` 或 `-`，长度 2–30）即记录；自动转小写、去掉两侧标点。
- 在 `input` / `textarea` / `contenteditable` 里的选择会被忽略。
- 记录所在句子（尽力而为，≤300 字）、页面地址（只保留 origin + path，不含 query/hash）和时间。
- 第 2 次划到 → 状态自动变为「生词本」，页面右下角弹出小提示「✓ 已加入生词本: word」（Shadow DOM，2 秒后淡出，可在弹窗里关闭「页面提示」）。
- 扩展图标上的角标显示生词本数量。
- 弹窗：生词本 / 只划过一次 / 已掌握 三个标签页，搜索、统计、展开查看例句和来源链接；标记已掌握 / 移回生词本 / 删除；导出 Markdown、导出 JSON、导入 JSON、清空（需确认）。

## 构建（Node ≥ 20）

```bash
npm i && npm run build      # 产物在 dist/
npm test                    # 单元测试 (Vitest)
npm run lint
```

不想构建：到 [Releases](../../releases) 下载 `word-catcher-0.1.0.zip` 解压即可。

## 在 Chrome 中加载

1. 打开 `chrome://extensions`
2. 右上角打开「开发者模式」
3. 点「加载已解压的扩展程序」，选择 `dist` 目录（或 release zip 解压后的目录）
4. 建议把扩展固定到工具栏，方便看角标；装好后**已打开的标签页需要刷新**才会生效。

## 计数规则

- 每次划词都计数（`count++`），**永不过期**。
- 防误触：**同一个单词在同一页面（同一 URL）5 分钟内**重复划选只算一次。
- `count ≥ 2` → 状态从 `seen` 变成 `saved`（生词本）。
- `mastered`（已掌握）不会被自动降级；已掌握的词再次被划到，状态保持已掌握，但 count 仍会 +1。
- 每个词最多保留最近 20 条例句。
- 所有写入都由后台 Service Worker 串行处理（内容脚本通过 runtime message 发送），多个标签页同时划词也不会丢数据。

## 数据模型（`chrome.storage.local`）

```ts
words: Record<string, {
  word: string; count: number;
  firstSeen: string; lastSeen: string;          // ISO 时间
  contexts: { sentence: string; url: string; date: string }[]; // 最多 20 条
  status: 'seen' | 'saved' | 'mastered';
}>
recent: Record<`${word}|${url}`, number>   // 防误触用，5 分钟后清理
settings: { toast: boolean }               // 页面提示开关，默认开
```

## 导入合并规则（导入 JSON）

接受导出的 `{ version, words }` 或直接一个 `words` 对象，与现有数据合并：

- 例句：并集，按 `url + date` 去重，按时间排序，保留最新 20 条；
- count：取 `max(本地, 导入, 去重后例句数)` —— 重复导入自己的备份不会翻倍；
- firstSeen 取更早，lastSeen 取更晚；
- 状态取更"高"的一个（seen < saved < mastered），若 count ≥ 2 且为 seen 则升为 saved；
- 非法单词会被跳过。

## 备份

弹窗里点「导出 JSON」即可备份（文件名带日期），换电脑或重装后「导入 JSON」恢复。「导出 Markdown」适合复习或贴到笔记里。数据**只在本机**，卸载扩展会清除数据，卸载前请先导出。

## 隐私

所有数据只保存在本地 `chrome.storage.local`。扩展没有任何网络请求、远程代码、统计或第三方服务。

## 已知限制

- 不做词形还原：`retries` 和 `retry` 是两个词。
- 只在普通网页上生效；`chrome://` 页面、Chrome 网上应用店、其他扩展页面无法注入脚本。
- Chrome 内置 PDF 阅读器中的划词不支持。
- 只捕获顶层页面（不含 iframe 内的内容）。
- 句子提取是尽力而为，复杂排版下可能截取不准。

## 端到端测试（可选）

`e2e/run.mjs` 用 Playwright 自带的 Chromium（`npx playwright-core install chromium`；正式版 Chrome 已不支持 `--load-extension`）加载 `dist`，在本地测试页模拟两次划词并校验存储、角标，以及截图弹窗：

```bash
npm run build && node e2e/run.mjs
```

## 开发

Vite + React 19 + TypeScript（strict）。弹窗由 Vite 构建；`background.js` / `content.js` 由 esbuild 打成单文件（`scripts/build-scripts.mjs`）。图标由 `npm run icons`（sharp）生成。
