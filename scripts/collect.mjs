import fs from "node:fs";
import path from "node:path";
import { ROOT, OUT_DIR, readJson, spaceVideos, pinnedComment, api, shanghaiDay, shanghaiDayOfUnix, setGap, hasLogin } from "./lib.mjs";

const cfg = readJson(path.join(ROOT, "config.json"));
const ups = readJson(path.join(ROOT, "ups.json"));
setGap(cfg.requestGapMs);

const argv = process.argv.slice(2);
const dIdx = argv.indexOf("--date");
const day = dIdx >= 0 ? argv[dIdx + 1] : shanghaiDay();

const stats = { ups: ups.length, listed: 0, todayVideos: 0, withPin: 0, noPin: 0, errors: [] };
const viaCount = {};
const items = [];

for (const up of ups) {
  let vlist = [];
  try {
    const r = await spaceVideos(up.mid, cfg.scanCount);
    vlist = r.vlist;
    if (!vlist.length) stats.errors.push({ mid: up.mid, stage: "space", code: r.code, message: r.message });
  } catch (e) {
    stats.errors.push({ mid: up.mid, stage: "space", message: String(e.message || e) });
    console.log("[collect] " + up.name + " 列表失败: " + String(e.message || e));
    continue;
  }
  stats.listed += vlist.length;
  const todays = vlist.filter((v) => shanghaiDayOfUnix(v.created) === day);
  stats.todayVideos += todays.length;
  for (const v of todays) {
    let pin = null;
    try {
      const r = await pinnedComment(v.aid, v.bvid, up.mid);
      pin = r.pin;
      if (r.via !== "none") viaCount[r.via] = (viaCount[r.via] || 0) + 1;
      if (!r.ok) stats.errors.push({ mid: up.mid, stage: "reply", bvid: v.bvid, code: r.code });
    } catch (e) {
      stats.errors.push({ mid: up.mid, stage: "reply", bvid: v.bvid, message: String(e.message || e) });
    }
    let desc = "";
    if (!pin) {
      // 没置顶的视频：退回用视频简介（很多 UP 的日报清单其实写在简介里）
      stats.noPin += 1;
      try {
        const d = await api("https://api.bilibili.com/x/web-interface/view?bvid=" + v.bvid, { ref: "https://www.bilibili.com/video/" + v.bvid });
        desc = (d && d.data && (d.data.desc || "")) || "";
      } catch (e) {
        stats.errors.push({ mid: up.mid, stage: "desc", bvid: v.bvid, message: String(e.message || e) });
      }
    } else {
      stats.withPin += 1;
    }
    items.push({
      bvid: v.bvid,
      aid: v.aid,
      mid: up.mid,
      up: up.name,
      title: v.title,
      publishedAt: v.created,
      views: v.play || 0,
      pinLikes: pin ? (pin.like || 0) : 0,
      pinAuthor: (pin && pin.member && pin.member.uname) || "",
      pinCtime: (pin && pin.ctime) || 0,
      text: pin ? ((pin.content && pin.content.message) || "") : "",
      desc,
    });
  }
  console.log("[collect] " + up.name + " 当天视频 " + todays.length + " 条");
}

const dir = path.join(OUT_DIR, day);
fs.mkdirSync(dir, { recursive: true });
const payload = { date: day, generatedAt: new Date().toISOString(), loggedIn: hasLogin(), stats, items };
const rawFile = path.join(dir, "raw.json");
fs.writeFileSync(rawFile, JSON.stringify(payload, null, 2));

console.log("[collect] 当天视频 " + stats.todayVideos + " 条，有置顶 " + stats.withPin + "，无置顶跳过 " + stats.noPin + "，异常 " + stats.errors.length);
console.log("[collect] 登录态: " + (payload.loggedIn ? "已登录" : "匿名"));
console.log("[collect] RAW=" + rawFile);
