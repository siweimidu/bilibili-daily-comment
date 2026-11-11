import fs from "node:fs";
import path from "node:path";
import { ROOT, OUT_DIR, readJson, shanghaiDay } from "./lib.mjs";

const cfg = readJson(path.join(ROOT, "config.json"));
const argv = process.argv.slice(2);
const dIdx = argv.indexOf("--date");
const day = dIdx >= 0 ? argv[dIdx + 1] : shanghaiDay();

const rawFile = path.join(OUT_DIR, day, "raw.json");
if (!fs.existsSync(rawFile)) {
  console.error("[render] 缺少 " + rawFile + "，先跑 collect.mjs");
  process.exit(1);
}
const raw = readJson(rawFile);

const norm = (s) => String(s).replace(/\r/g, "").replace(/\s+/g, " ").trim();

function trimEdges(s) {
  let t = String(s);
  t = t.replace(/^[\s　]*[】\]\)）]+/, "");
  t = t.replace(/^[\s]*\d{1,2}\s*[.、．:：]\s*/, "");
  t = t.replace(/^[\s\-—–:：|·、,，【\[\(（]+/, "");
  t = t.replace(/^(\[[^\]\n]{1,10}\])+/, "");
  t = t.replace(/(\[[^\]\n]{1,10}\])+$/, "");
  t = t.replace(/[\s]*\d{1,2}\s*[.、．]$/, "");
  t = t.replace(/[\s\-—–:：|·、,，】\])）【\[（(]+$/, "");
  return t.trim();
}

function bigrams(s) {
  const t = s.replace(/[\s\p{P}\p{S}]/gu, "");
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}

function jaccard(a, b) {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const u = a.size + b.size - inter;
  return u ? inter / u : 0;
}

// 拉丁词/数字实体，用来判同一件事（Gemini 4 Carbon / Copilot Fusion 这类）
function tokens(s) {
  const set = new Set();
  for (const m of String(s).matchAll(/[A-Za-z][A-Za-z0-9.+_-]*|\d+(?:\.\d+)?/g)) {
    const w = m[0].toLowerCase().replace(/[.。]+$/, "");
    if (w.length >= 2 || /^\d+$/.test(w)) set.add(w);   // 版本号「4」必须留，"Gemini 4 Carbon" 靠它区分 3 和 4
  }
  return set;
}

function containment(a, b) {
  const small = a.size <= b.size ? a : b;
  if (!small.size) return 0;
  let inter = 0;
  for (const x of small) if (a.has(x) && b.has(x)) inter++;
  return inter / small.size;
}

function splitTimeline(text) {
  const marks = [...text.matchAll(/(\d{1,2}:\d{2}(?::\d{2})?)/g)];
  if (marks.length < 2) return null;
  const out = [];
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].index + marks[i][0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
    const body = trimEdges(text.slice(start, end));
    if (body) out.push(body);
  }
  return out.length >= 2 ? out : null;
}

function cleanTitle(s) {
  let t = norm(s);
  t = t.replace(/^(\s*[【\[][^】\]]{1,12}[】\]])+/, "");
  t = t.replace(/[…\.]{2,}$/, "");
  return t.trim();
}

const chapterRe = new RegExp(cfg.chapterPatterns.join("|"));
const offTopicRe = new RegExp(cfg.offTopicPatterns.join("|"), "i");
// 拉丁关键词必须独立成词，否则 "AI" 会匹配到 Gmail / explain 里面
const latinKw = cfg.aiKeywords.filter((k) => /^[A-Za-z0-9.+_-]+$/.test(k));
const cjkKw = cfg.aiKeywords.filter((k) => !/^[A-Za-z0-9.+_-]+$/.test(k));
const aiRe = new RegExp(
  "(" + latinKw.map((k) => "(?<![A-Za-z0-9])" + k.replace(/[.+]/g, "\\$&") + "(?![A-Za-z0-9])").join("|") + ")"
  + "|(" + cjkKw.join("|") + ")",
  "i"
);
const actionRe = new RegExp(cfg.actionKeywords.join("|"));
const linkRe = /https?:\/\/|b23\.tv|BV[0-9A-Za-z]{10}/;

function keepSegment(t) {
  if (!t || t.length < cfg.minItemLength) return "short";
  if (chapterRe.test(t)) return "chapter";
  if (linkRe.test(t)) return "link";
  if (offTopicRe.test(t)) return "offtopic";
  if (cfg.requireAiKeyword && !aiRe.test(t)) return "offtopic";
  if (!actionRe.test(t)) return "noaction";
  return "";
}

const dropped = { short: 0, chapter: 0, link: 0, offtopic: 0, noaction: 0, pinlownews: 0, history: 0, titleFallback: 0 };
const pool = [];
let splitPins = 0;

for (const it of raw.items) {
  const text = norm(it.text);
  if (!text) continue;
  const parts = cfg.splitTimeline ? splitTimeline(text) : null;
  if (parts) splitPins++;
  const pieces = parts || [trimEdges(text)];

  // 一条置顶只有在「大部分分段确实是资讯」时才被当成日报清单；
  // 否则它只是视频章节目录或闲聊感想，整条丢掉（价格 & 开放时间 / 输出示例 1 这种就是章节）
  const good = [];
  for (const p of pieces) {
    const why = keepSegment(p);
    if (why) { dropped[why] += 1; continue; }
    good.push(p);
  }
  const ratio = pieces.length ? good.length / pieces.length : 0;
  if (cfg.debugPins) console.log("[pin] " + it.bvid + " " + good.length + "/" + pieces.length + " = " + ratio.toFixed(2) + (parts ? "" : " (no-timeline)"));

  // 置顶要么是纯章节目录（比例极低），要么整条没什么能用的：那就把视频标题当资讯
  const useTitle = good.length === 0 || (parts && ratio < cfg.titleFallbackRatio);
  if (useTitle) {
    const t = cleanTitle(it.title);
    const why = keepSegment(t);
    if (why) { dropped.titleFallback += 1; continue; }
    pool.push({ text: t, heat: Number(it.pinLikes) || 0, bvid: it.bvid, views: it.views, fromTitle: true });
    continue;
  }
  if (parts && ratio < cfg.pinNewsRatio) {
    dropped.pinlownews += 1;
    continue;
  }
  for (const p of good) pool.push({ text: p, heat: Number(it.pinLikes) || 0, bvid: it.bvid, views: it.views });
}

function sharedTokens(a, b) {
  const out = [];
  for (const x of a) if (b.has(x)) out.push(x);
  return out;
}

const genericTokens = new Set((cfg.genericTokens || []).map((t) => t.toLowerCase()));

function sameNews(a, b) {
  if (jaccard(a.grams, b.grams) >= cfg.dedupeThreshold) return true;
  if (a.tokens.size < 2 || b.tokens.size < 2) return false;
  const shared = sharedTokens(a.tokens, b.tokens);
  // 只共享 OpenAI / ChatGPT / Gemini 这种泛词不算同一件事，否则互不相关的新闻会被并成一条
  const specific = shared.filter((t) => !genericTokens.has(t));
  if (shared.length < 2 || specific.length === 0) return false;
  return containment(a.tokens, b.tokens) >= cfg.tokenContainment;
}

const kept = [];
for (const cand of pool) {
  const rec = { text: cand.text, heat: cand.heat, bvid: cand.bvid, views: cand.views, sources: 1, grams: bigrams(cand.text), tokens: tokens(cand.text) };
  const dup = kept.find((k) => sameNews(k, rec));
  if (dup) {
    dup.heat += rec.heat;
    dup.sources += 1;
    const nearHeadline = (x) => Math.abs(x.length - cfg.headlineTargetLength);
    if (nearHeadline(rec.text) < nearHeadline(dup.text)) { dup.text = rec.text; dup.grams = rec.grams; dup.tokens = rec.tokens; dup.bvid = rec.bvid; }
    continue;
  }
  kept.push(rec);
}

// 跨天去旧闻：前几日已经报过的，今天不再重复
const historyFile = path.join(OUT_DIR, "_history.json");
let history = {};
try { history = JSON.parse(fs.readFileSync(historyFile, "utf8")); } catch { history = {}; }
let finalItems = kept;
if (cfg.dropSeenHistory) {
  const past = [];
  for (const [d, list] of Object.entries(history)) {
    if (d === day) continue;
    for (const t of list) past.push({ grams: bigrams(t), tokens: tokens(t) });
  }
  finalItems = kept.filter((k) => {
    const hit = past.some((p) => sameNews(p, k));
    if (hit) dropped.history += 1;
    return !hit;
  });
}
history[day] = finalItems.map((k) => k.text);
fs.writeFileSync(historyFile, JSON.stringify(history, null, 2));

if (cfg.sortMode === "heat") finalItems.sort((a, b) => b.heat - a.heat || b.sources - a.sources || b.views - a.views);
else finalItems.sort((a, b) => b.sources - a.sources || b.heat - a.heat || b.views - a.views);

// 同一视频的条目不相邻：整体顺序不变，只把撞车的往后挪
if (cfg.decluster) {
  const rest = finalItems.slice();
  const mixed = [];
  while (rest.length) {
    const last = mixed.length ? mixed[mixed.length - 1].bvid : null;
    let pick = rest.findIndex((x) => x.bvid !== last);
    if (pick === -1) pick = 0;
    mixed.push(rest.splice(pick, 1)[0]);
  }
  finalItems = mixed;
}
const shown = cfg.maxLines > 0 ? finalItems.slice(0, cfg.maxLines) : finalItems;

const lines = shown.map((it, i) => {
  const body = it.text.length > cfg.maxTextLength ? it.text.slice(0, cfg.maxTextLength).trimEnd() + "…" : it.text;
  return cfg.showSource ? (i + 1) + ". " + body + " · " + it.bvid : (i + 1) + ". " + body;
});

const header = day + " 置顶评论 · 共 " + shown.length + " 条";
const stat = "统计：当天视频 " + raw.stats.todayVideos + " / 有置顶 " + raw.stats.withPin + " / 无置顶跳过 " + raw.stats.noPin
  + " / 时间轴置顶 " + splitPins + " / 合并 " + kept.reduce((n, k) => n + k.sources - 1, 0)
  + " / 丢[太短 " + dropped.short + " 章节 " + dropped.chapter + " 链接 " + dropped.link + " 非AI " + dropped.offtopic
  + " 无动作 " + dropped.noaction + " 整条非资讯 " + dropped.pinlownews + " 旧闻 " + dropped.history + "] / 异常 " + (raw.stats.errors ? raw.stats.errors.length : 0);

const out = [header, ""].concat(lines.length ? lines : ["（今天没有可用的置顶评论）"]).concat(["", stat]).join("\n");

const reportFile = path.join(OUT_DIR, day, "report.md");
fs.writeFileSync(reportFile, out + "\n");
fs.writeFileSync(path.join(OUT_DIR, "latest.md"), out + "\n");
console.log(out);
