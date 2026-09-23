# みんなのコート

ふじみ野市の公共スポーツ施設(フットサルコート・サッカー場・体育館アリーナなど)の空き状況を、中高生向けに一画面で見られる**非公式**サイトです。

**公開URL: https://minnanocourtfujimino-ctrl.github.io/minna-no-court/**

- 表示している空き状況は**目安**です。予約前に必ず [ふじみ野市公共施設予約システム](https://yoyacool.e-harp.jp/fujimino)(公式)で確認してください。
- 予約・支払いはこのサイトでは一切できません。すべて市の公式システムで行ってください。

## データの取り方と頻度

- データ取得元: ふじみ野市公共施設予約システム (https://yoyacool.e-harp.jp/fujimino)
- ログイン不要で公開されている「空き状況」のみを取得します。個人に関わる情報は取得・保存しません。
- 取得頻度: **1時間に1回**(GitHub Actions の cron)。
- 1回の取得は対象10室場 × 各1リクエスト。リクエストは逐次で、**間隔は60秒**あけています(サイトの robots.txt `Crawl-delay: 60` に従っています)。
- 取得プログラムの User-Agent には本リポジトリのURLと連絡先を明記しています。

## 止め方(市の担当者さまへ)

自動取得の停止をご希望の場合は、下記の連絡先にご連絡ください。即時停止します。

- リポジトリの設定(Settings → Secrets and variables → Actions → Variables)で `SCRAPE_ENABLED` を `false` にすると、次回以降の取得が止まります。
- 本サイトの運営者は市とは関係のない個人です。

## 連絡先

minnanocourtfujimino@gmail.com

## 構成

```
scraper/          空き状況の取得プログラム (Node.js)
  scrape.mjs      本体。data/availability.json を生成する
  facilities.json 対象施設の定義
  parks.json      ボール遊びOK公園(静的データ)
data/             生成された空き状況データ
site/             公開サイト (GitHub Pages)
```
