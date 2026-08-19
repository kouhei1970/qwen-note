#!/usr/bin/env node
// README.md を単一ソースとして _site/index.html を生成するビルドスクリプト。
// 使い方: node scripts/build-site.mjs
// テスト用に SOURCE_MD 環境変数でソース Markdown を差し替え可能（既定は README.md）。

import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import hljs from 'highlight.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SITE_DIR = path.join(ROOT, 'site');
const OUT_DIR = path.join(ROOT, '_site');
const SOURCE_MD = path.resolve(ROOT, process.env.SOURCE_MD || 'README.md');

const REPO = 'kouhei1970/qwen-note';
const GITHUB_BLOB_BASE = `https://github.com/${REPO}/blob/main/`;
const DESCRIPTION_MAX_LEN = 110;

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stripTags(html) {
  return html.replace(/<[^>]+>/g, '');
}

// 見出し等の生テキスト（Markdown 記法混じり）を簡易的にプレーンテキスト化する。
// <title> や meta content のように「必ずどの文脈に置いても安全な文字列」が
// 欲しい場面専用（本文レンダリングにはこの関数を使わず marked のレンダラを使う）。
function mdInlineToPlainText(text) {
  return text
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(text, maxLen) {
  if (text.length <= maxLen) return text;
  // 句点で切れるならそこで切る（途中で途切れた文にしない）
  const cut = text.slice(0, maxLen);
  const lastPeriod = cut.lastIndexOf('。');
  if (lastPeriod >= Math.floor(maxLen / 2)) return cut.slice(0, lastPeriod + 1);
  return cut.slice(0, maxLen - 1).trimEnd() + '…';
}

// GitHub 風の見出しスラッグ生成 + 重複回避。
// 文字（Unicode の letter/number/mark、日本語含む）・アンダースコア・ハイフン・
// 半角スペース以外を削除してから、半角スペースを 1 文字ずつハイフンに置換する
// （連続する空白をまとめて 1 個のハイフンにはしない）。GitHub の実際の見出し
// アンカー生成と一致させるための挙動（例:「（」「）」は空白を挟まず単純に消える、
// 「A / B」は "a--b" のように連続ハイフンになる）。
function slugify(text, seen) {
  let slug = text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\p{M}_\- ]+/gu, '')
    .replace(/ /g, '-');
  if (!slug) slug = 'section';
  let unique = slug;
  let i = 1;
  while (seen.has(unique)) {
    unique = `${slug}-${i++}`;
  }
  seen.add(unique);
  return unique;
}

function todayJst() {
  const now = new Date();
  // JST = UTC+9 固定（サマータイムなし）
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(jst.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ---------------------------------------------------------------------------
// Markdown ソース読み込み
// ---------------------------------------------------------------------------

if (!existsSync(SOURCE_MD)) {
  console.error(`[build-site] Markdown source not found: ${SOURCE_MD}`);
  process.exit(1);
}

const markdown = readFileSync(SOURCE_MD, 'utf8');

// ---------------------------------------------------------------------------
// marked 設定: GFM + シンタックスハイライト + 見出し id 付与 + リンク書き換え
// ---------------------------------------------------------------------------

const seenIds = new Set();
const toc = []; // h2 見出しの目次

const customRenderer = {
  heading({ tokens, depth }) {
    const innerHtml = this.parser.parseInline(tokens);
    const plainText = stripTags(innerHtml).trim();
    const id = slugify(plainText, seenIds);
    // README 自身が持つ「## 目次」見出し（本文中の手書き目次）はサイドバーの
    // 自動目次と役割が重複するため、サイドバー目次には含めない。
    if (depth === 2 && plainText !== '目次') {
      toc.push({ id, text: plainText });
    }
    return `<h${depth} id="${id}">${innerHtml}</h${depth}>\n`;
  },
  link({ href, title, tokens }) {
    const text = this.parser.parseInline(tokens);
    let url = href || '';
    // 相対リンク configs/... / bench/... は GitHub 上の実体に書き換える
    if (/^(\.\/)?(configs|bench)\//.test(url)) {
      url = GITHUB_BLOB_BASE + url.replace(/^\.\//, '');
    }
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
    const isExternal = /^https?:\/\//.test(url);
    const externalAttrs = isExternal ? ' target="_blank" rel="noopener noreferrer"' : '';
    return `<a href="${escapeHtml(url)}"${titleAttr}${externalAttrs}>${text}</a>`;
  },
};

marked.use({ gfm: true, renderer: customRenderer });
marked.use(
  markedHighlight({
    langPrefix: 'hljs language-',
    highlight(code, lang) {
      const language = hljs.getLanguage(lang) ? lang : 'plaintext';
      return hljs.highlight(code, { language }).value;
    },
  })
);

// marked.parse() は lex → walkTokens（シンタックスハイライトはここで適用される）
// → render の順に実行する。lexer+parser を分けて呼ぶと walkTokens が走らず
// ハイライトが効かないため、必ず parse() を使う（heading レンダラが toc も収集する）。
// サイト本文からは、ヒーローと重複する要素を取り除く:
//   - 最初の H1（ヒーローにタイトルがある）
//   - Pages 自身の URL だけの段落（サイト上では自己参照になる）
//   - 「## 目次」節（サイドバーに自動目次がある）
const bodyMarkdown = markdown
  .replace(/^# .*\n+/, '')
  .replace(/^Web 版（GitHub Pages）: https:\/\/kouhei1970\.github\.io\/qwen-note\/\s*$\n*/m, '')
  .replace(/^## 目次\s*\n[\s\S]*?(?=^## )/m, '');
const contentHtml = marked.parse(bodyMarkdown);

// タイトル・説明文抽出用に生の見出し/段落テキストが欲しいだけなので、
// ハイライト適用の有無に関係なく再度 lex するだけで十分（副作用なし）。
const tokens = marked.lexer(markdown);

// ---------------------------------------------------------------------------
// タイトル・説明文の抽出
// ---------------------------------------------------------------------------

const h1Token = tokens.find((t) => t.type === 'heading' && t.depth === 1);
const titlePlain = h1Token ? mdInlineToPlainText(h1Token.text) : 'qwen-note';

const firstParagraph = tokens.find((t) => t.type === 'paragraph');
const descriptionPlain = firstParagraph
  ? truncate(mdInlineToPlainText(firstParagraph.text), DESCRIPTION_MAX_LEN)
  : titlePlain;

const TITLE = escapeHtml(titlePlain);
const DESCRIPTION = escapeHtml(descriptionPlain);
const UPDATED = todayJst();

const tocHtml = toc.length
  ? `<ul class="toc-list">\n${toc
      .map((item) => `  <li><a href="#${item.id}">${item.text}</a></li>`)
      .join('\n')}\n</ul>`
  : '';

// ---------------------------------------------------------------------------
// テンプレートに埋め込み
// ---------------------------------------------------------------------------

const templatePath = path.join(SITE_DIR, 'template.html');
if (!existsSync(templatePath)) {
  console.error(`[build-site] Template not found: ${templatePath}`);
  process.exit(1);
}

const template = readFileSync(templatePath, 'utf8');

const html = template
  .replaceAll('{{TITLE}}', TITLE)
  .replaceAll('{{DESCRIPTION}}', DESCRIPTION)
  .replaceAll('{{CONTENT}}', contentHtml)
  .replaceAll('{{TOC}}', tocHtml)
  .replaceAll('{{UPDATED}}', UPDATED);

// ---------------------------------------------------------------------------
// 出力
// ---------------------------------------------------------------------------

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(path.join(OUT_DIR, 'assets'), { recursive: true });

writeFileSync(path.join(OUT_DIR, 'index.html'), html, 'utf8');

const assetsSrc = path.join(SITE_DIR, 'assets');
if (existsSync(assetsSrc)) {
  cpSync(assetsSrc, path.join(OUT_DIR, 'assets'), { recursive: true });
}

writeFileSync(path.join(OUT_DIR, '.nojekyll'), '', 'utf8');

console.log(`[build-site] source: ${path.relative(ROOT, SOURCE_MD)}`);
console.log(`[build-site] title: ${titlePlain}`);
console.log(`[build-site] description: ${descriptionPlain}`);
console.log(`[build-site] h2 headings (toc): ${toc.length}`);
console.log(`[build-site] updated: ${UPDATED}`);
console.log(`[build-site] wrote ${path.relative(ROOT, path.join(OUT_DIR, 'index.html'))}`);
