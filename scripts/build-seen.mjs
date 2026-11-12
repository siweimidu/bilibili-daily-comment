import fs from "node:fs";
import path from "node:path";
import { ROOT, OUT_DIR, readJson, spaceVideos, api, shanghaiDayOfUnix, setGap } from "./lib.mjs";

// —— 构建「已报道库」：指定账号（默认求源索解）发过的视频，取其置顶/热评里的时间轴长评论 ——
// 输出 out/_seen.json：[{ name, mid, date, bvid, text }]
const cfg = readJson(path.join(ROOT, "config.json"));
setGap(cfg.requestGapMs || 1200);

const seenFile = path.join(ROOT, "seen.json");
let seenUps = [];
try { seenUps = readJson(seenFile); } catch { seenUps = []; }

const hasTimeline = (t) => ((String(t).match(/\d{1,2}:\d{2}(?::\d{2})?/g) || []).length >= 2);

async function ownerComments(aid, bvid, mid) {
  const found = new Map(); // rpid -> comment
  const add = (c) => { if (c && Number(c.mid) === Number(mid)) found.set(c.rpid, c); };
  try {
    const j = await api("https://api.bilibili.com/x/v2/reply/main?type=1&oid=" + aid + "&mode=3&ps=20&next=0", { ref: "https://www.bilibili.com/video/" + bvid });
    const d = (j && j.data) || {};
    if (d.upper && d.upper.top) add(d.upper.top);
    (d.top_replies || []).forEach(add);
  } catch { /* ignore */ }
  for (const pn of [1, 2]) {
    try {
      const j = await api("https://api.bilibili.com/x/v2/reply?type=1&oid=" + aid + "&sort=2&pn=" + pn + "&ps=20", { ref: "https://www.bilibili.com/video/" + bvid });
      ((j && j.data && j.data.replies) || []).forEach(add);
    } catch { /* ignore */ }
  }
  return [...found.values()];
}

const out = [];
for (const up of seenUps) {
  let vlist = [];
  try { vlist = (await spaceVideos(up.mid, up.scanVideos || 50)).vlist || []; } catch (e) { console.error("[seen] " + up.name + " 获取视频失败: " + e.message); continue; }
  let got = 0;
  for (const v of vlist) {
    let cs = [];
    try { cs = await ownerComments(v.aid, v.bvid, up.mid); } catch { cs = []; }
    for (const c of cs) {
      const text = (c.content && c.content.message) || "";
      if (!hasTimeline(text)) continue;   // 只要时间轴式清单
      out.push({ name: up.name, mid: up.mid, date: shanghaiDayOfUnix(v.created), bvid: v.bvid, text });
      got += 1;
    }
  }
  console.log("[seen] " + up.name + " 视频 " + vlist.length + " 条，收集到时间轴评论 " + got + " 段");
}

const f = path.join(OUT_DIR, "_seen.json");
fs.writeFileSync(f, JSON.stringify(out, null, 2));
console.log("[seen] 写入 " + f + "，共 " + out.length + " 段");
