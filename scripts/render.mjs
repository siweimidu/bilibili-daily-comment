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
const isWindow = Number(raw.windowHours) > 0;

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
  // 只取中文字符做二元组：英文机构名（Google/Antigravity/Grok Bot）会把相似度灌水，导致误判
  const t = String(s).replace(/[^\u4e00-\u9fff]/g, "");
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
    .replace(/人工分析/g, " AA ")
    .replace(/文心/g, " ERNIE ");
  for (const m of norm.matchAll(/[A-Za-z][A-Za-z0-9.+_-]*|\d+(?:\.\d+)?/g)) {
    let w = m[0].toLowerCase().replace(/[.。]+$/, "");
    if (/^[a-z]{4,}s$/.test(w)) w = w.slice(0, -1);   // 简单去复数：decisions→decision / sheets→sheet
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

const HEADER_RE = /^(今日内容|今日要闻|本期看点|本期回顾|AI动态|AI ?动态|科技公司|模型排行榜|AI产品与模型|产品与模型|安全与监管|安全监管|算力与能源|算力能源|算力与公司|公司与算力|公司与模型|产业与算力|评测与公司|芯片与算力|隐私与政策|研究与评测|研究与安全|安全与隐私|数据与安全|数学研究|研究与数学|安全与防护|模型研究与发布|AI安全与隐私|AI内容规则|更新日志|诉讼与市场|本期提到的项目|算力与推理|超级智能风险|AI安全|头条|资讯|前瞻|目录|导语|总结|结尾|开场|片尾致谢)\s*[:：]?$/;

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
  if (/https?:\/\//i.test(s)) return true;
  const em = s.replace(/^[\s📌🤖💡🔥⭐️🔔📢•·]+/, "").trim();
  if (HEADER_RE.test(em)) return true;
  if (/^(开场速览|片尾致谢|今日速览|本期速览)\s*[：:]/.test(em)) return true;
  if (/^(官方示例|输出示例|示例\s*\d|补充一张图|使用范围|API ?价格|今日\s*GitHub|本期回顾)/i.test(em)) return true;
  if (/^\d{1,2}\s*月\s*\d{1,2}\s*日.{0,14}(早报|日报|晚报)/.test(em)) return true;
  if (/其实今天|发晚了|义父们|没有什么内容/.test(em)) return true;
  if (/每晚.{0,8}更新|本期\d+条|重点看.{0,12}动态|盒中之神|乌托邦|贵\s*\d+\s*倍还做错题/.test(em)) return true;
  if (/赞助|广告位|商务合作/.test(em)) return true;
  if (/^[A-Za-z0-9._-]+\s*推荐$/.test(em)) return true;
  if (/推广$/.test(em)) return true;
  if (/^[a-z0-9.-]+\.(com|cn|ai|net|io|org)$/i.test(em)) return true;
  if (/^[a-z0-9.-]+\.[a-z]{2,}\//i.test(em)) return true;
  if (/[：:]$/.test(em)) return true;                                  // 冒号结尾 = 小标题
  if (/^[\u4e00-\u9fff]{2,6}$/.test(em)) return true;                 // 纯短中文标签（模型榜/厂商回应…）
  if (/^[\u4e00-\u9fffA-Za-z0-9 ·]{2,8}$/.test(em)) return true;      // 极短标签（Colab 终端/AI 治理…）
  if (/当期总览|开场导览|本期总结与互动|本期还讲了|官方信源|片头与今日概览|法律与合规|模型榜|空巢老梁|大家一定要注意|网页灰度本轮明细/.test(em)) return true;
  if (/还在.{0,4}更新|打call|持续更新/.test(em)) return true;
  if (/WorkBuddy ?成长|成长计划积分/.test(em)) return true;
  if (/羊毛党|正价渠道的胜利|噩梦！$|悲报|白嫖/.test(em)) return true;
  if (/正规国模授权|官方合作商|npm install|hsk-cli|安装：/.test(em)) return true;
  if (/^(明天见|下期见|再见|本期完)$/.test(em)) return true;
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
    if (!numbered.length) {
      // 散文 / 无编号：整段作为一条（避免把小标题/碎词逐行拆成假条目）
      const whole = cleanItemLine(lines.join(" "));
      return (!whole || isJunk(whole) || whole.length < 6) ? [] : [whole];
    }
    src = numbered;
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
  // 【硬约束】只要当天：视频发布日期不是今天的，一律不要（连 --full 兜底的昨天数据也丢掉）
  if (!isWindow && cfg.todayOnly !== false && it.videoDate && it.videoDate !== raw.date) continue;
  // 滚动窗口模式下不显示日期前缀；兜底/跨日的才标日期
  const tag = isWindow
    ? ""
    : (it.isFallback && it.videoDate && it.videoDate !== raw.date ? "〔" + it.videoDate.slice(5) + "〕" : "");
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
    if (t2 && !isJunk(t2)) pool.push({ text: tag + t2, heat: 0, bvid: it.bvid, views: it.views, src: "title" });
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
    if (inter >= 2 && uni && inter / uni >= 0.5 && jaccard(a.grams, b.grams) >= 0.2) return true;
  }
  // 一方实体是另一方真子集（只有 Google/DeepMind/AI 泛实体打底）→ 是不同新闻，别并
  if (containment(a.tokens, b.tokens) >= 0.999) return false;
  // 其余情况：至少 2 个非泛词实体且包含度达标才算同一件事
  if (specific.length < 2) return false;
  return containment(a.tokens, b.tokens) >= cfg.tokenContainment;
}

// 去「已报道」：保守匹配，宁少删不误删
function matchSeen(a, b) {
  const jc = jaccard(a.grams, b.grams);
  const bothCN = a.grams.size >= 3 && b.grams.size >= 3; // 中文内容够长，中文字面比较才可信
  if (bothCN && jc >= 0.6) return true;                   // 中文表述高度一致
  const shared = [...a.tokens].filter((t) => b.tokens.has(t));
  const spec = shared.filter((t) => !genericTokens.has(t));
  const identical = a.tokens.size === b.tokens.size && shared.length === a.tokens.size;
  if (identical && spec.length >= 1 && (a.tokens.size >= 3 || (bothCN && jc >= 0.5))) return true; // 实体集合相同且足够具体
  if (bothCN && spec.length >= 2 && jc >= 0.45) return true; // ≥2 独特实体相同且中文高度相似
  return false;
}

// —— 跨账号同事件合并：同一件事不同账号不同措辞，并成一条 ——
function jacSets(A, B) { let i = 0; for (const x of A) if (B.has(x)) i++; const u = A.size + B.size - i; return u ? i / u : 0; }
function strongSet(tk) { const s = new Set(); for (const t of tk) { if (genericTokens.has(t)) continue; if (/^\d/.test(t)) continue; s.add(t); } return s; }
function cjkContain(A, B) { const m = Math.min(A.size, B.size); if (!m) return 0; let i = 0; for (const x of A) if (B.has(x)) i++; return i / m; }
const DFILLER = /(服务|产品|能力|功能|模型|系统|版本|团队|平台|工具|技术|相关|进行|推出|发布|正式|开始|继续|测试|宣布|新增|升级|支持|上线|报道|据称|传闻|消息|今日|今天|刚刚|正式版|预览版)/g;
function dgrams(s) {
  let t = String(s || "").replace(/私密/g, "私有").replace(/具身/g, "").replace(/独立/g, "");
  t = t.replace(DFILLER, "").replace(/[^\u4e00-\u9fff]/g, "");
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}
function sameEvent(a, b) {
  if (sameNews(a, b)) return true;
  const da = dgrams(a.text), db = dgrams(b.text);
  const bothCN = da.size >= 2 && db.size >= 2;
  const jc = jaccard(da, db);
  const cc = cjkContain(da, db);
  // 去掉同义/填充词后，中文高度相似或一方是另一方的高包含子集 → 同一事件
  if (bothCN && (jc >= 0.3 || cc >= 0.5)) return true;
  const sa = strongSet(a.tokens), sb = strongSet(b.tokens);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter += 1;
  if (inter >= 1 && jacSets(a.tokens, b.tokens) >= 0.3) return true; // 独特实体重合且词集较像
  if (inter >= 2 && jc >= 0.1) return true;                         // ≥2 独特实体相同
  return false;
}
function mergeSameEventPass(items) {
  const clusters = [];
  for (const it of items) {
    let placed = false;
    for (const c of clusters) {
      if (sameEvent(it, c.rep)) {
        c.items.push(it);
        if (it.text.length > c.rep.text.length) c.rep = it; // 保留信息更全的那条
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push({ rep: it, items: [it] });
  }
  return clusters.map((c) => {
    const rep = Object.assign({}, c.rep);
    rep.sources = c.items.reduce((n, x) => n + (x.sources || 1), 0);
    rep.heat = c.items.reduce((n, x) => n + (x.heat || 0), 0);
    return rep;
  });
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

// —— 去「已报道」：拿指定账号（默认求源索解）发过的时间轴清单做基数，去掉已报过的 ——
let finalItems = kept;
let seenRemoved = 0;
if (cfg.dedupeAgainstSeen) {
  try {
    const seenRaw = JSON.parse(fs.readFileSync(path.join(OUT_DIR, "_seen.json"), "utf8"));
    const seenSig = [];
    for (const s of seenRaw) for (const t of extractListItems(s.text)) seenSig.push({ text: t, grams: bigrams(t), tokens: tokens(t) });
    if (seenSig.length) {
      finalItems = finalItems.filter((k) => {
        const hitSig = seenSig.find((s) => matchSeen(k, s));
        if (hitSig) { seenRemoved += 1; if (process.env.DEBUG_SEEN) console.error("[REMOVED] " + k.text + "   <=   " + hitSig.text); return false; }
        return true;
      });
    }
  } catch (e) { /* 没建过 _seen.json 就跳过 */ }
}

// 跨账号同事件合并（Gemini Decision / Tabletop 等重复并成一条）
const beforeMerge = finalItems.length;
finalItems = mergeSameEventPass(finalItems);
const mergedSameEvent = beforeMerge - finalItems.length;

// 导出用于「热度 TopN」的条目（含 heat/sources）
try {
  fs.writeFileSync(
    path.join(OUT_DIR, "_final_items.json"),
    JSON.stringify(finalItems.map((k) => ({ text: k.text, heat: k.heat || 0, sources: k.sources || 1, views: k.views || 0 })), null, 2)
  );
} catch { /* ignore */ }

// 重要性打分：动作词越多越靠前（组内排序用）
const IMP_WORDS = ["IPO", "收购", "并购", "融资", "罢免", "离职", "起诉", "发布", "开源", "上线", "推出", "正式", "重大", "首次", "免费", "开放", "突破", "登顶", "裁员"];
function impScore(t) { let s = 0; for (const k of IMP_WORDS) if (t.includes(k)) s += 1; return s; }

// —— 按公司归并 + 按重要性排序（用户规范）——
function detectCompany(text) {
  const rules = cfg.companyRules || [];
  let best = null, bestIdx = Infinity;
  for (const r of rules) {
    for (const kw of (r.kws || [])) {
      let idx = -1;
      if (kw.startsWith("^")) {
        const m = new RegExp(kw, "i").exec(text);
        if (m) idx = m.index;
      } else if (/[A-Za-z]/.test(kw)) {
        const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const m = new RegExp("(^|[^A-Za-z])(" + esc + ")(?=[^A-Za-z]|$)", "i").exec(text);
        if (m) idx = m.index + m[1].length;
      } else {
        const p = text.indexOf(kw);
        if (p >= 0) idx = p;
      }
      if (idx >= 0 && idx < bestIdx) { bestIdx = idx; best = r.name; }
    }
  }
  return best;   // 取「在标题里出现最早」的公司，避免提到的竞品抢了主语
}

// 组内/组间默认按热度（≈重要性）
finalItems.sort((a, b) => (b.heat || 0) - (a.heat || 0) || (b.sources || 0) - (a.sources || 0) || (b.views || 0) - (a.views || 0));

const order = cfg.companyOrder || [];
const groups = new Map();
const singles = [];
for (const it of finalItems) {
  let co = detectCompany(it.text);
  if (co && cfg.companyParent && cfg.companyParent[co]) co = cfg.companyParent[co]; // 被收购/子品牌上并到母公司
  if (co) { if (!groups.has(co)) groups.set(co, []); groups.get(co).push(it); }
  else singles.push(it);
}
const groupList = [...groups.entries()].map(([name, items]) => ({ name, items, heatSum: items.reduce((n, x) => n + (x.heat || 0), 0) }));
groupList.sort((a, b) => {
  const ia = order.indexOf(a.name), ib = order.indexOf(b.name);
  return (ia < 0 ? 9999 : ia) - (ib < 0 ? 9999 : ib) || b.heatSum - a.heatSum;
});

const lines = [];
let idx = 0;
for (const g of groupList) {
  const seenTxt = new Set();
  const parts = [];
  const ordered = g.items.slice().sort((a, b) => (b.heat || 0) - (a.heat || 0) || impScore(b.text) - impScore(a.text) || (b.sources || 0) - (a.sources || 0));
  for (const it of ordered) {
    const t = it.text.replace(/[；;。.\s、,，]+$/, "");
    if (!t || seenTxt.has(t)) continue;
    seenTxt.add(t);
    parts.push(t);
  }
  if (!parts.length) continue;
  idx += 1;
  if (parts.length === 1) {
    lines.push(idx + ". " + g.name + "：" + parts[0]);   // 只有一条：公司名 + 内容同行
  } else {
    lines.push(idx + ". " + g.name + "：");               // 多条：公司名一行，下面每条各占一行
    for (const p of parts) lines.push("   " + p);
  }
}
for (const it of singles) {
  const t = it.text.replace(/[；;。.\s、,，]+$/, "");
  if (!t) continue;
  idx += 1;
  lines.push(idx + ". " + t);
}

const stat = "统计：当天视频 " + raw.stats.todayVideos + " / 有置顶 " + raw.stats.withPin + " / 无置顶跳过 " + raw.stats.noPin
  + " / 时间轴置顶 " + splitPins + " / 合并重复 " + kept.reduce((n, k) => n + k.sources - 1, 0)
  + " / 合并同事件 " + mergedSameEvent + " / 去已报道 " + seenRemoved
  + " / 归并前 " + finalItems.length + " 条 → 归并后 " + lines.length + " 条 / 异常 " + (raw.stats.errors ? raw.stats.errors.length : 0);

const listText = (lines.length ? lines : ["（今天没有可用的置顶评论）"]).join("\n");
const reportFile = path.join(OUT_DIR, day, "report.md");
fs.writeFileSync(reportFile, listText + "\n\n" + stat + "\n");
fs.writeFileSync(path.join(OUT_DIR, "latest.md"), listText + "\n");
fs.writeFileSync(path.join(OUT_DIR, "latest_block.txt"), "```text\n" + listText + "\n```\n");
console.log(listText);
