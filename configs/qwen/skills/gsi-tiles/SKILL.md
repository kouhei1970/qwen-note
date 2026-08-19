---
name: gsi-tiles
description: 国土地理院（GSI）の地理院タイル（航空写真・標準地図・標高 PNG タイル）を取得・デコードするときに使う。URL 形式・レイヤ名・ズーム上限・標高の計算式・検証用の既知値・公式ドキュメント URL をまとめた確定仕様。地図/地形/標高/航空写真/DEM/3D 地形ビューワの実装で必ず最初に読む。
---

# 地理院タイル 確定仕様（2026-08-17 / 08-19 に curl と実アプリで検証済み）

**この文書の値だけを使う。記憶にある別のホスト名・パス（例: gsi-cer.ad.jp, cyberjapan.ndc.go.jp, /ortho3/v1/getTile, /srtm/v1/tile）はすべて誤りで、存在しない。**

## URL 形式（標準 XYZ タイル、Web メルカトル、原点は左上、256×256 px）

```
https://cyberjapandata.gsi.go.jp/xyz/{layer}/{z}/{x}/{y}.{ext}
```

| 用途 | layer | ext | ズーム | 備考 |
|---|---|---|---|---|
| 航空写真（シームレス空中写真） | `seamlessphoto` | `jpg` | z ≤ 18 | |
| 標準地図 | `std` | `png` | z ≤ 18 | |
| 陰影起伏図 | `relief` | `png` | z ≤ 15 | |
| 標高（DEM1A, 約 1 m） | `dem1a_png` | `png` | z ≤ 17 | 範囲外は 404 |
| 標高（DEM5A, 約 5 m） | `dem5a_png` | `png` | z ≤ 15 | 主に使う。404 なら dem_png へ |
| 標高（DEM10B, 約 10 m） | `dem_png` | `png` | z ≤ 14 | 全国カバー |

例: `https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/15/29041/12870.jpg`（秩父・影森付近）

## 標高 PNG タイルのデコード（公式仕様）

各ピクセルの RGB から `x = R*65536 + G*256 + B`。
- `x == 2^23`（R=128, G=0, B=0）→ 無効値（欠測）。海・未整備域など。0 m で埋めずに欠測として扱う
- `x > 2^23` → `x = x - 2^24`（負の標高）
- 標高[m] = `x * 0.01`

## 緯度経度 → タイル番号

```js
const n = 2 ** z;
const x = Math.floor((lon + 180) / 360 * n);
const y = Math.floor((1 - Math.log(Math.tan(lat*Math.PI/180) + 1/Math.cos(lat*Math.PI/180)) / Math.PI) / 2 * n);
```

## 検証用の既知値（実装の合格条件に使う）

| 地点 | 緯度 / 経度 | 標高（dem5a） |
|---|---|---|
| 秩父市 影森グラウンド中心 | 35.970565 / 139.063364 | **260.2 m**（公式標高 API で確認） |
| 東京駅 | 35.6812 / 139.7671 | 約 4 m |
| 五稜郭公園中心 | 41.7969 / 140.7570 | 約 14 m |
| 金沢工業大学 やつかほリサーチキャンパス | 36.48456 / 136.57116 | 約 40〜60 m |

合成データ・ダミー地形では上の値は絶対に出ないので、「中心標高が既知値 ±2 m」を合格条件にする。

## アクセス作法

- 同時接続は 6 以下。失敗したら間隔を空けて最大 2 回再試行。
- 404 は「データが存在しない」、DNS/タイムアウトは「取得失敗」。混同せずログに出す。
- 利用規約: 出典「国土地理院」の明記が必要（https://maps.gsi.go.jp/development/ichiran.html）。

## 公式ドキュメント

- 地理院タイル一覧: https://maps.gsi.go.jp/development/ichiran.html
- 標高タイル詳細仕様: https://maps.gsi.go.jp/development/demtile.html
- 標高 API（1 点の標高）: https://cyberjapandata2.gsi.go.jp/general/dem/scripts/getelevation.php?lon=139.063364&lat=35.970565&outtype=JSON
