import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..");
export const OUT_DIR = path.join(ROOT, "out");
export const COOKIE_DIR = path.join(ROOT, ".cookie");
export const COOKIE_FILE = path.join(COOKIE_DIR, "cookies.json");

export const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const MIXIN = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
const RISK_CODES = [-352, -401, -412, -509, -799];

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let jar = {};
let warmed = false;
let lastAt = 0;
let gapMs = 900;

export function setGap(ms) { gapMs = Number(ms) || 900; }

export function loadCookies() {
  try { return JSON.parse(fs.readFileSync(COOKIE_FILE, "utf8")); } catch { return {}; }
}

export function saveCookies(obj) {
  fs.mkdirSync(COOKIE_DIR, { recursive: true });
  fs.writeFileSync(COOKIE_FILE, JSON.stringify(obj, null, 2));
}

export function hasLogin() {
  const c = loadCookies();
  return Boolean(c.SESSDATA && c.DedeUserID);
}

function absorb(res) {
  const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const raw of list) {
    const kv = raw.split(";")[0];
    const i = kv.indexOf("=");
    if (i > 0) jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
}

function cookieHeader() {
  return Object.entries(jar).map(([k, v]) => k + "=" + v).join("; ");
}

async function warmup() {
  if (warmed) return;
  warmed = true;
  jar = Object.assign({}, loadCookies());
  try {
    const r = await fetch("https://www.bilibili.com/", { headers: { "User-Agent": UA } });
    absorb(r);
  } catch { /* buvid3 is best-effort */ }
}

async function throttle() {
  const wait = lastAt + gapMs + Math.floor(Math.random() * 400) - Date.now();
  if (wait > 0) await sleep(wait);
  lastAt = Date.now();
}

export async function api(url, opts) {
  const o = opts || {};
  const ref = o.ref || "https://www.bilibili.com/";
  const tries = o.tries || 4;
  await warmup();
  let lastErr = new Error("no attempt");
  for (let i = 0; i < tries; i++) {
    await throttle();
    try {
      const r = await fetch(url, {
        headers: {
          "User-Agent": UA,
          "Referer": ref,
          "Origin": "https://www.bilibili.com",
          "Cookie": cookieHeader(),
          "Accept": "application/json, text/plain, */*",
        },
      });
      absorb(r);
      const text = await r.text();
      let j;
      try { j = JSON.parse(text); } catch { throw new Error("non-json response, status " + r.status); }
      if (RISK_CODES.includes(j.code)) {
        lastErr = new Error("risk control " + j.code);
        await sleep(2500 * (i + 1) + Math.floor(Math.random() * 900));
        continue;
      }
      return j;
    } catch (e) {
      lastErr = e;
      await sleep(1200 * (i + 1));
    }
  }
  throw lastErr;
}

let wbiCache = null;

export async function wbiKeys() {
  if (wbiCache) return wbiCache;
  const nav = await api("https://api.bilibili.com/x/web-interface/nav");
  const img = nav && nav.data && nav.data.wbi_img;
  if (!img || !img.img_url) throw new Error("wbi keys unavailable (nav returned " + (nav && nav.code) + ")");
  const raw = img.img_url.split("/").pop().split(".")[0] + img.sub_url.split("/").pop().split(".")[0];
  wbiCache = { mixin: MIXIN.map((i) => raw[i]).join("").slice(0, 32) };
  return wbiCache;
}

async function signedUrl(url, params) {
  const { mixin } = await wbiKeys();
  const clean = {};
  for (const [k, v] of Object.entries(params)) clean[k] = String(v).replace(/[!'()*]/g, "");
  const qs = Object.keys(clean).sort()
    .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(clean[k]))
    .join("&");
  const wts = Math.floor(Date.now() / 1000);
  const w_rid = crypto.createHash("md5").update(qs + "&wts=" + wts + mixin).digest("hex");
  return url + "?" + qs + "&wts=" + wts + "&w_rid=" + w_rid;
}

export async function spaceVideos(mid, ps) {
  const url = await signedUrl("https://api.bilibili.com/x/space/wbi/arc/search", {
    mid,
    ps: ps || 30,
    pn: 1,
    order: "pubdate",
    platform: "web",
    web_location: 1550101,
    dm_img_list: "[]",
    dm_img_str: "V2ViR0wgMS4wIChPcGVuR0wgRVMgMi4wIENocm9taXVtKQ",
    dm_cover_img_str: "QU5HTEUgKE5WSURJQSwgTlZJRElBIEdlRm9yY2UgR1RYIDEwNjAgNkdCIERpcmVjdDNEMTEgdnNfNV8wIHBzXzVfMCwgRDNEMTEpR29vZ2xlIEluYy4gKE5WSURJQS",
    dm_img_inter: '{"ds":[],"wh":[0,0,0],"of":[0,0,0]}',
  });
  const j = await api(url, { ref: "https://space.bilibili.com/" + mid });
  const vlist = (j && j.data && j.data.list && j.data.list.vlist) || [];
  return { code: j && j.code, message: j && j.message, vlist };
}

export async function pinnedComment(aid, bvid, ownerMid) {
  const j = await api(
    "https://api.bilibili.com/x/v2/reply/main?type=1&oid=" + aid + "&mode=3&ps=20&next=0",
    { ref: "https://www.bilibili.com/video/" + bvid }
  );
  if (!j || j.code !== 0) return { ok: false, code: j && j.code, pin: null, via: "none" };
  const d = j.data || {};
  const upperTop = d.upper && d.upper.top;
  if (upperTop) return { ok: true, code: 0, pin: upperTop, via: "upper.top" };
  const owner = Number(ownerMid);
  const mine = (d.top_replies || []).find((c) => Number(c.mid) === owner);
  if (mine) return { ok: true, code: 0, pin: mine, via: "top_replies" };
  return { ok: true, code: 0, pin: null, via: "none" };
}

const SH_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
});

export function shanghaiDay(d) { return SH_FMT.format(d || new Date()); }
export function shanghaiDayOfUnix(sec) { return SH_FMT.format(new Date(sec * 1000)); }

export function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
