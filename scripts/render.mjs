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
  const norm = String(s)
    .replace(/Artificial\s+Analysis/gi, " AA ")
    .replace(/人工分析/g, " AA ");
  for (const m of norm.matchAll(/[A-Za-z][A-Za-z0-9.+_-]*|\d+(?:\.\d+)?/g)) {
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

// —— 不做任何内容过滤：有置顶按时间戳拆；没置顶用视频简介；简介也没用就用标题 ——
const pool = [];
let splitPins = 0;

const HEADER_RE = /^(今日内容|今日要闻|本期看点|AI动态|AI ?动态|科技公司|模型排行榜|头条|资讯|前瞻|目录|导语|总结|结尾|开场)\s*[:：]?$/;

function cleanItemLine(s) {
  s = String(s).trim();
  s = s.replace(/^[【\[]\s*\d{1,2}:\d{2}(?::\d{2})?\s*[】\]]\s*/, ""); // 行首【00:05】/[00:05]
  s = s.replace(/^\d{1,2}:\d{2}(?::\d{2})?\s*/, "");                    // 行首 00:08
  s = s.replace(/\s*[【\[]\s*\d{1,2}:\d{2}(?::\d{2})?\s*[】\]]\s*$/, ""); // 行尾【00:03】/[03:10]
  s = s.replace(/^\d{1,2}\s*[.、．:：)）·]\s*(?=\d{1,2}:\d{2})/, "");   // 1. 紧接时间
  s = s.replace(/^\d{1,2}:\d{2}(?::\d{2})?\s*/, "");                    // 再剥一次前导时间
  s = s.replace(/^\d{1,2}\s*[.、．:：)）·]\s*/, "");                    // 1. / 1、 / 1· / 1)
  s = s.replace(/^[\s\-–—•·|]+/, "").trim();
  return s;
}

function isJunk(s) {
  if (!s) return true;
  if (/^https?:\/\//i.test(s)) return true;
  const em = s.replace(/^[\s📌🤖💡🔥⭐️🔔📢•·]+/, "").trim();
  if (HEADER_RE.test(em)) return true;
  if (/^[📌🤖💡🔥⭐️🔔📢]{1,2}\s*$/.test(s)) return true;
  if (em.length <= 2) return true;
  return false;
}

// 统一拆条：兼容各种时间戳/序号格式；带>=2个时间戳的按时间戳行取（滤掉标题/广告/闲聊），
// 否则按「编号行」或整段取。置顶与简介都走这里，再择优。
//   00:08 内容 ｜ 【00:05】 1. 内容 ｜ 1·内容 【00:03】 ｜ 1.00:11 内容 ｜ [03:10] 1·内容
function extractListItems(text) {
  const t = String(text || "");
  const hasTimeline = (t.match(/\d{1,2}:\d{2}(?::\d{2})?/g) || []).length >= 2;
  const lines = t.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  let src;
  if (hasTimeline) {
    src = lines.filter((l) => /\d{1,2}:\d{2}/.test(l));
  } else {
    const numbered = lines.filter((l) => /^\s*\d{1,2}\s*[.、．:：)）·]/.test(l));
    src = numbered.length ? numbered : lines;
  }
  const out = [];
  for (const ln of src) {
    const s = cleanItemLine(ln);
    if (isJunk(s)) continue;
    out.push(s);
  }
  return out;
}

for (const it of raw.items) {
  const text = String(it.text || "");
  const desc = String(it.desc || "").trim();
  // --full 兜底来的、属于别的日期的视频，条目前面标一下日期，避免把昨天新闻当今天
  const tag = it.isFallback && it.videoDate && it.videoDate !== raw.date ? "〔" + it.videoDate.slice(5) + "〕" : "";
  const pinItems = text ? extractListItems(text) : [];
  const descItems = desc.length >= 8 ? extractListItems(desc) : [];
  const sumLen = (a) => a.reduce((n, s) => n + s.length, 0);
  // 置顶 vs 简介，选条目更多/更完整的那份（有的 UP 置顶标题被截断，简介是完整版）
  let chosen = pinItems;
  let src = "pin";
  if (descItems.length && (descItems.length >= pinItems.length || (descItems.length >= Math.ceil(pinItems.length * 0.7) && sumLen(descItems) > sumLen(pinItems)))) {
    chosen = descItems;
    src = "desc";
  }
  if (chosen.length > 1 && src === "pin") splitPins++;
  if (chosen.length) {
    for (const p of chosen) pool.push({ text: tag + p, heat: src === "pin" ? (Number(it.pinLikes) || 0) : 0, bvid: it.bvid, views: it.views, src });
  } else {
    const t2 = cleanTitle(it.title);
    if (t2) pool.push({ text: tag + t2, heat: 0, bvid: it.bvid, views: it.views, src: "title" });
  }
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
  if (shared.length < 2) return false;
  const specific = shared.filter((t) => !genericTokens.has(t));
  const identical = a.tokens.size === b.tokens.size && shared.length === a.tokens.size;
  // 实体集合完全相同（gemini/4/carbon、openai/chatgpt/businesses）→ 同一件事
  if (identical && specific.length >= 1) return true;
  // 忽略泛组织词后，独特实体的 Jaccard 高（如 Gemini 4 Carbon / carbon+4）→ 同一件事
  const specA = new Set([...a.tokens].filter((t) => !genericTokens.has(t)));
  const specB = new Set([...b.tokens].filter((t) => !genericTokens.has(t)));
  if (specA.size && specB.size) {
    let inter = 0;
    for (const t of specA) if (specB.has(t)) inter++;
    const uni = specA.size + specB.size - inter;
    if (inter >= 2 && uni && inter / uni >= 0.5) return true;
  }
  // 一方实体是另一方真子集（只有 Google/DeepMind/AI 泛实体打底）→ 是不同新闻，别并
  if (containment(a.tokens, b.tokens) >= 0.999) return false;
  // 其余情况：至少 2 个非泛词实体且包含度达标才算同一件事
  if (specific.length < 2) return false;
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

// —— 不做跨天去旧闻，所有当日条目全部保留 ——
let finalItems = kept;

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
  const body = (cfg.maxTextLength > 0 && it.text.length > cfg.maxTextLength) ? it.text.slice(0, cfg.maxTextLength).trimEnd() + "…" : it.text;
  return cfg.showSource ? (i + 1) + ". " + body + " · " + it.bvid : (i + 1) + ". " + body;
});

const header = day + " 置顶评论 · 共 " + shown.length + " 条";
const stat = "统计：当天视频 " + raw.stats.todayVideos + " / 有置顶 " + raw.stats.withPin + " / 无置顶跳过 " + raw.stats.noPin
  + " / 时间轴置顶 " + splitPins + " / 合并重复 " + kept.reduce((n, k) => n + k.sources - 1, 0)
  + " / 共 " + shown.length + " 条 / 异常 " + (raw.stats.errors ? raw.stats.errors.length : 0);

const out = [header, ""].concat(lines.length ? lines : ["（今天没有可用的置顶评论）"]).concat(["", stat]).join("\n");

const reportFile = path.join(OUT_DIR, day, "report.md");
fs.writeFileSync(reportFile, out + "\n");
fs.writeFileSync(path.join(OUT_DIR, "latest.md"), out + "\n");
console.log(out);
