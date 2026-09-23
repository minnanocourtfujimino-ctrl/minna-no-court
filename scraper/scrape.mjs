// みんなのコート scraper
// ふじみ野市公共施設予約システムから空き状況を取得して data/availability.json を書く。
//
// 使い方:  node scraper/scrape.mjs
// 環境変数:
//   SCRAPE_MODE=api|browser   既定 api。browser は Playwright 経由(Actions の IP が弾かれた時の予備)
//   SCRAPE_INTERVAL_MS        施設間の待ち時間。既定 60000 (robots.txt の Crawl-delay: 60 に従う)
//   SCRAPE_CONTACT            User-Agent に入れる連絡先

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const OUT_PATH = path.join(ROOT, "data", "availability.json");

const BASE = "https://yoyacool.e-harp.jp/fujimino";
const CONTACT = process.env.SCRAPE_CONTACT || "minnanocourtfujimino@gmail.com";
const USER_AGENT = `MinnaNoCourt/0.1 (+https://github.com/minnanocourtfujimino-ctrl/minna-no-court; contact: ${CONTACT})`;
const INTERVAL_MS = Number(process.env.SCRAPE_INTERVAL_MS || 60_000);
const MODE = process.env.SCRAPE_MODE || "api";

// 市のシステムの statusType → 本サイトの状態コード
//   o=空き, x=埋まり, l=抽選受付中, -=対象外(休館・公開前・受付終了など)
// f(残りわずか)は面ごとの o/x を集計して算出する。
// 対応表は市のシステムのページに埋め込まれた STATUS_TYPES 定義(全16種)に基づく。
const STATUS_MAP = {
  A01: "o", // 利用可能(ネット申込可)
  A02: "o", // 空き状況のみ(空いているがネット申込不可)
  A03: "o", // 電話受付(空いているが電話申込のみ)
  U10: "o", // 窓口受付(空いているが窓口申込のみ)
  L01: "l", // 抽選申込可
  L02: "l", // 抽選申込可
  L03: "l", // 抽選待ち
  R03: "x", // 空きなし
  U01: "-", // 休館日
  U02: "-", // 公開前
  U03: "-", // 受付前
  U04: "-", // 公開終了
  U05: "-", // 受付終了
  U07: "-", // 利用不可
  U08: "-", // 一般開放(予約枠ではない)
  U09: "-", // 設備保守
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 日付(日本時間) ----
function jstDays(n = 3) {
  const jstNow = new Date(Date.now() + 9 * 3600 * 1000);
  return Array.from({ length: n }, (_, i) =>
    new Date(jstNow.getTime() + i * 86_400_000).toISOString().slice(0, 10)
  );
}
function jstNowIso() {
  const jst = new Date(Date.now() + 9 * 3600 * 1000);
  return jst.toISOString().replace(/\.\d+Z$/, "+09:00");
}

// ---- 取得(2方式) ----
function makeApiFetcher() {
  return {
    async getDay(lgc, fc, rc, startDate, endDate) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      try {
        const res = await fetch(`${BASE}/FacilityAvailability/GetDay/${lgc}/${fc}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
          body: JSON.stringify(getDayBody(rc, startDate, endDate)),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const type = res.headers.get("content-type") || "";
        if (!type.includes("application/json")) {
          throw new Error(`unexpected content-type: ${type} (bot対策にブロックされた可能性)`);
        }
        return await res.json();
      } finally {
        clearTimeout(timer);
      }
    },
    async close() {},
  };
}

async function makeBrowserFetcher() {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const context = await browser.newContext({ userAgent: USER_AGENT });
  const page = await context.newPage();
  // 一度トップを開いて bot 対策(Incapsula)の Cookie を得る
  await page.goto(`${BASE}/FacilitySearch/Index`, { waitUntil: "load", timeout: 60_000 });
  await page.waitForTimeout(3000);
  return {
    async getDay(lgc, fc, rc, startDate, endDate) {
      const res = await context.request.post(`${BASE}/FacilityAvailability/GetDay/${lgc}/${fc}`, {
        headers: { "Content-Type": "application/json" },
        data: getDayBody(rc, startDate, endDate),
        timeout: 30_000,
      });
      if (!res.ok()) throw new Error(`HTTP ${res.status()}`);
      return await res.json();
    },
    async close() {
      await browser.close();
    },
  };
}

function getDayBody(rc, startDate, endDate) {
  return {
    startDate,
    endDate,
    roomCode: null,
    courtSize: null,
    utilizationPurpose: null,
    usePeople: null,
    room: { roomCode: rc, roomName: "" },
    toggleTimeType: false,
    usageTimes: null,
    usagePeriodOfTime: null,
    allowInternetRequest: null,
    requestId: null,
  };
}

// ---- 変換 ----
function slotLabel(start, end) {
  const fmt = (t) => {
    const [h, m] = t.split(":");
    return m === "00" ? String(Number(h)) : `${Number(h)}:${m}`;
  };
  return `${fmt(start)}-${fmt(end)}`;
}

// GetDay のレスポンス1件を { slots, availability } に変換する
function parseGetDay(data, rc, days, unknownCodes, facilityId) {
  const room = (data.rooms || []).find((r) => r.roomCode === rc) || (data.rooms || [])[0];
  if (!room) throw new Error("rooms が空");

  // 時間枠の定義 (frameId 順)
  const frames = (data.timeFrames || []).flatMap((set) => set.usageTimeFrames || []);
  if (frames.length === 0) throw new Error("timeFrames が空");
  frames.sort((a, b) => a.usageTimeFrameId - b.usageTimeFrameId);
  const frameIds = frames.map((f) => f.usageTimeFrameId);
  const slots = frames.map((f) => ({
    label: f.usageTimeName || slotLabel(f.usageStartTime.slice(0, 5), f.usageEndTime.slice(0, 5)),
    start: f.usageStartTime.slice(0, 5),
    end: f.usageEndTime.slice(0, 5),
  }));

  // 日付×枠ごとに、全面(コート)の状態を集めて1つに集計
  const availability = {};
  for (const day of days) {
    const perFrame = frameIds.map((frameId) => {
      const courtStatuses = [];
      for (const court of room.courts || []) {
        for (const db of court.dayBooks || []) {
          if (db.usageDate.slice(0, 10) !== day) continue;
          for (const u of db.usageTimes || []) {
            if (u.usageTimeFrameId === frameId) courtStatuses.push(u.statusType);
          }
        }
      }
      return aggregate(courtStatuses, unknownCodes, `${facilityId} ${day}`);
    });
    availability[day] = perFrame;
  }
  return { slots, availability };
}

// 面ごとの statusType の配列 → 1枠の状態
function aggregate(courtStatuses, unknownCodes, context) {
  if (courtStatuses.length === 0) return "-";
  const mapped = courtStatuses.map((s) => {
    if (s in STATUS_MAP) return STATUS_MAP[s];
    if (s != null && !unknownCodes.has(s)) unknownCodes.set(s, context);
    return "-";
  });
  const nOpen = mapped.filter((m) => m === "o").length;
  const nFull = mapped.filter((m) => m === "x").length;
  const nLot = mapped.filter((m) => m === "l").length;
  if (nLot > 0) return "l";
  if (nOpen > 0 && nFull > 0) return "f"; // 一部の面だけ空き
  if (nOpen > 0) return "o";
  if (nFull > 0) return "x";
  return "-";
}

// ---- メイン ----
async function main() {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, "facilities.json"), "utf8"));
  const days = jstDays(3);
  const unknownCodes = new Map(); // code → 最初に観測した施設と日付
  const errors = [];
  const outFacilities = [];

  console.log(`mode=${MODE} interval=${INTERVAL_MS}ms days=${days.join(",")}`);
  const fetcher = MODE === "browser" ? await makeBrowserFetcher() : makeApiFetcher();

  try {
    let first = true;
    for (const fac of config.facilities) {
      if (!first) await sleep(INTERVAL_MS); // robots.txt: Crawl-delay 60
      first = false;

      const t0 = Date.now();
      let slots = [];
      let availability = {};
      try {
        const data = await fetcher.getDay(config.lgc, fac.fc, fac.rc, days[0], days[days.length - 1]);
        ({ slots, availability } = parseGetDay(data, fac.rc, days, unknownCodes, fac.id));
        console.log(`ok   ${fac.id} (${Date.now() - t0}ms)`);
      } catch (e) {
        errors.push({ facilityId: fac.id, reason: String(e.message || e) });
        availability = Object.fromEntries(days.map((d) => [d, []]));
        console.error(`FAIL ${fac.id}: ${e.message || e}`);
      }

      const { fc, rc, ...pub } = fac;
      outFacilities.push({ ...pub, slots, availability });
    }
  } finally {
    await fetcher.close();
  }

  const result = {
    generatedAt: jstNowIso(),
    source: BASE,
    days,
    facilities: outFacilities,
    errors,
    unknownStatusCodes: [...unknownCodes.entries()].map(([code, ctx]) => `${code} (${ctx})`).sort(),
  };

  if (unknownCodes.size > 0) {
    console.warn(`未知の statusType を検出: ${result.unknownStatusCodes.join(", ")} ("-" として扱った)`);
  }

  // 変化がなければ書き換えない(無駄なコミット防止)。ただし6時間に1回は更新時刻を出す。
  let old = null;
  try {
    old = JSON.parse(fs.readFileSync(OUT_PATH, "utf8"));
  } catch {}
  const strip = (j) => JSON.stringify({ ...j, generatedAt: null });
  if (old && strip(old) === strip(result)) {
    const ageMs = Date.now() - Date.parse(old.generatedAt);
    if (ageMs < 6 * 3600 * 1000) {
      console.log("変化なし: data/availability.json は更新しない");
      return;
    }
  }

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(result, null, 1) + "\n");
  console.log(`wrote ${path.relative(ROOT, OUT_PATH)} (facilities=${outFacilities.length}, errors=${errors.length})`);

  if (errors.length === config.facilities.length) {
    console.error("全施設の取得に失敗");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
