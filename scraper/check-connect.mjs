// GitHub Actions から市のシステムに届くかの疎通確認(1リクエストだけ)。
// bot対策(Incapsula)にブロックされる場合、JSONでないレスポンスが返るのでそれを検出する。
// 使い方: node scraper/check-connect.mjs

const BASE = "https://yoyacool.e-harp.jp/fujimino";
const CONTACT = process.env.SCRAPE_CONTACT || "minnanocourtfujimino@gmail.com";
const USER_AGENT = `MinnaNoCourt/0.1 (+https://github.com/minnanocourt/minna-no-court; contact: ${CONTACT})`;

const jst = new Date(Date.now() + 9 * 3600 * 1000);
const today = jst.toISOString().slice(0, 10);

const res = await fetch(`${BASE}/FacilityAvailability/GetDay/112453/1009`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
  body: JSON.stringify({
    startDate: today,
    endDate: today,
    roomCode: null,
    courtSize: null,
    utilizationPurpose: null,
    usePeople: null,
    room: { roomCode: "121", roomName: "" },
    toggleTimeType: false,
    usageTimes: null,
    usagePeriodOfTime: null,
    allowInternetRequest: null,
    requestId: null,
  }),
});

const type = res.headers.get("content-type") || "";
console.log(`HTTP ${res.status} / content-type: ${type}`);

const body = await res.text();
if (res.ok && type.includes("application/json")) {
  const data = JSON.parse(body);
  const room = data.rooms?.[0];
  const frames = data.timeFrames?.flatMap((s) => s.usageTimeFrames) ?? [];
  console.log(`OK: room=${room?.roomName} courts=${room?.courts?.length} frames=${frames.length}`);
  console.log("判定(A) API直接方式が GitHub Actions から使えます");
} else {
  console.error("NG: JSON が返りませんでした。ブロックされた可能性があります。");
  console.error("--- レスポンス先頭 500 文字 ---");
  console.error(body.slice(0, 500));
  process.exit(1);
}
