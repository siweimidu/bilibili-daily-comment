import fs from "node:fs";
import path from "node:path";
import QRCode from "qrcode";
import { COOKIE_DIR, COOKIE_FILE, UA, sleep, saveCookies, loadCookies } from "./lib.mjs";

const PENDING = path.join(COOKIE_DIR, "pending.json");
const POLL_LOG = path.join(COOKIE_DIR, "poll.log");
const plog = (m) => { fs.appendFileSync(POLL_LOG, new Date().toISOString() + " " + m + "\n"); console.log(m); };
const QR_PNG = path.join(COOKIE_DIR, "qr.png");
const BASE = "https://passport.bilibili.com/x/passport-login/web/qrcode";
const HDR = { "User-Agent": UA, "Referer": "https://www.bilibili.com/" };

const argv = process.argv.slice(2);
const waitIdx = argv.indexOf("--wait");
const waitSec = waitIdx >= 0 ? Number(argv[waitIdx + 1] || 150) : 0;
const keepIdx = argv.indexOf("--keep");
const keepSec = keepIdx >= 0 ? Number(argv[keepIdx + 1] || 600) : 0;

function extractCookies(setCookies, loginUrl) {
  const out = {};
  for (const raw of setCookies) {
    const kv = raw.split(";")[0];
    const i = kv.indexOf("=");
    if (i > 0) out[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
  if (loginUrl) {
    try {
      const q = new URL(loginUrl).searchParams;
      for (const k of ["SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5", "sid"]) {
        if (q.get(k)) out[k] = q.get(k);
      }
    } catch { /* ignore */ }
  }
  return out;
}

async function generate() {
  const r = await fetch(BASE + "/generate?source=main-fe-header", { headers: HDR });
  const j = await r.json();
  if (j.code !== 0) throw new Error("generate failed: " + j.code + " " + j.message);
  fs.mkdirSync(COOKIE_DIR, { recursive: true });
  await QRCode.toFile(QR_PNG, j.data.url, { width: 600, margin: 3, errorCorrectionLevel: "M" });
  fs.writeFileSync(PENDING, JSON.stringify({ qrcode_key: j.data.qrcode_key, created: Date.now(), url: j.data.url }, null, 2));
  console.log("QR_IMAGE=" + QR_PNG);
  console.log("SCAN_URL=" + j.data.url);
  console.log("NEXT: scan with the Bilibili app, then run: node scripts/login.mjs --wait 150");
}

async function poll(sec) {
  if (!fs.existsSync(PENDING)) throw new Error("no pending QR, run without --wait first");
  const pend = JSON.parse(fs.readFileSync(PENDING, "utf8"));
  const deadline = Date.now() + (sec || waitSec) * 1000;
  let announced = false;
  while (Date.now() < deadline) {
    const r = await fetch(BASE + "/poll?qrcode_key=" + encodeURIComponent(pend.qrcode_key) + "&source=main-fe-header", { headers: HDR });
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    const j = await r.json();
    const code = j && j.data ? j.data.code : -1;
    if (code === 0) {
      const cookies = extractCookies(sc, j.data.url);
      if (!cookies.SESSDATA) throw new Error("login ok but SESSDATA missing");
      const merged = Object.assign({}, loadCookies(), cookies);
      saveCookies(merged);
      plog("LOGIN_OK fields=" + Object.keys(merged).join(","));
      plog("SAVED=" + COOKIE_FILE);
      try { fs.unlinkSync(PENDING); } catch { /* ignore */ }
      return;
    }
    if (code === 86090 && !announced) { announced = true; plog("STATUS=scanned, confirm on phone"); }
    if (code === 86038) { plog("STATUS=expired, rerun login.mjs to get a fresh QR"); return; }
    await sleep(1500);
  }
  plog("STATUS=timeout");
}

async function keepAlive() {
  const deadline = Date.now() + keepSec * 1000;
  while (Date.now() < deadline) {
    await generate();
    try { await poll(150); } catch (e) { console.log("poll error: " + (e.message || e)); }
    if (fs.existsSync(COOKIE_FILE) && loadCookies().SESSDATA) return;
    if (Date.now() >= deadline) return;
    console.log("refreshing QR, " + Math.round((deadline - Date.now()) / 1000) + "s left");
    await sleep(1500);
  }
}

if (keepSec > 0) await keepAlive();
else if (waitSec > 0) await poll(waitSec);
else await generate();
