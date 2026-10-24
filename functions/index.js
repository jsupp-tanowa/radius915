/**
 * shopsコレクション管理画面用 API (Cloud Functions)
 *
 * エンドポイント（すべて /api/admin/ 配下。Hosting rewriteで振り分ける想定）:
 *   GET  /session            ログイン状態の確認
 *   POST /login               ログイン（固定の管理者情報と照合しセッショントークンを発行）
 *   POST /logout               ログアウト（クライアント側でトークンを破棄するだけ）
 *   GET  /shops                shops一覧取得（要ログイン）
 *   POST /shops                shops新規作成（要ログイン）
 *   PUT  /shops/:id             shops更新（要ログイン）
 *   DELETE /shops/:id           shops削除（要ログイン）
 *   POST /resolve-maps-url      GoogleマップURL → 店名/緯度経度/placeidの解決（要ログイン）
 *
 * 認証方式:
 *   管理者情報はFirestoreに保存せず、Secret Managerで管理する固定値
 *   （ADMIN_USERNAME / ADMIN_PASSWORD_HASH）と照合する。
 *   ログイン成功時はHMAC署名付きの自己完結セッショントークンを発行する
 *   （サーバー側にセッションを保存しないステートレス方式）。
 *   ④ Firebase Hostingのrewrite経由ではCookieがCloud Functionsまで
 *     転送されないケースがあるため、Cookieではなく
 *     "Authorization: Bearer <token>" ヘッダーでトークンをやり取りする。
 */

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

admin.initializeApp();
const db = getFirestore();

// ── Secret Manager経由で注入する値 ──
// デプロイ前に `firebase functions:secrets:set <NAME>` で設定する
const ADMIN_USERNAME      = defineSecret("ADMIN_USERNAME");
const ADMIN_PASSWORD_HASH = defineSecret("ADMIN_PASSWORD_HASH");
const SESSION_SECRET      = defineSecret("SESSION_SECRET");
const MAPS_SERVER_KEY     = defineSecret("MAPS_SERVER_KEY");

const SESSION_TTL_MS  = 1000 * 60 * 60 * 24 * 7; // 7日間

/* ── セッショントークンの署名／検証 ── */
function signSession(payload, secret) {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig  = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${sig}`;
}

function verifySession(token, secret) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [data, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  const a = Buffer.from(sig || "");
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, "base64url").toString());
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// ④ "Authorization: Bearer <token>" ヘッダーからトークンを取り出す
function extractToken(req) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function requireAuth(req, res, next) {
  const session = verifySession(extractToken(req), SESSION_SECRET.value());
  if (!session) {
    res.status(401).json({ error: "認証が必要です" });
    return;
  }
  req.adminUsername = session.username;
  next();
}

/* ── shopsデータのバリデーション／整形 ──
   app.js（サポたのわ本体）が実際に参照しているフィールドに合わせている。
   ※ placeid は本体アプリの経路検索・Googleマップ遷移で必須のため必須項目とする。 */
function validateShopPayload(body) {
  const errors = [];
  if (!body || typeof body !== "object") return ["不正なリクエストです"];
  if (!body.name || !String(body.name).trim()) errors.push("店名は必須です");
  if (!body.placeid || !String(body.placeid).trim()) errors.push("Place IDは必須です");
  if (body.lat === undefined || body.lat === "" || Number.isNaN(Number(body.lat))) errors.push("緯度が不正です");
  if (body.lng === undefined || body.lng === "" || Number.isNaN(Number(body.lng))) errors.push("経度が不正です");
  return errors;
}

function buildShopData(body) {
  return {
    name:         String(body.name).trim(),
    lat:          Number(body.lat),
    lng:          Number(body.lng),
    placeid:      String(body.placeid).trim(),
    category:     String(body.category || "").trim(),
    prefecture:   String(body.prefecture || "").trim(),
    team:         String(body.team || "").trim(),
    note:         String(body.note || "").trim(),
    // ③ 実データはimages(配列)ではなくimage(カンマ区切り文字列)が正。
    //   app.js側もimage優先で読み込む実装のため、そちらに合わせる。
    image:        String(body.image || "").trim(),
    supportLevel: Math.min(Math.max(Number(body.supportLevel) || 0, 0), 5),
    visited:      !!body.visited,
    screen:       !!body.screen,
    // verifiedは未指定時はtrue扱い（app.js側は verified === false のときのみ非サポーター扱いにするため）
    verified:     body.verified !== false,
    published:    !!body.published,
    updatedAt:    FieldValue.serverTimestamp()
  };
}

/* ── GoogleマップURLの解決 ── */
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "ja,en;q=0.8"
};
const GOOGLE_HOST_RE    = /(^|\.)(google\.[a-z.]+|goo\.gl|g\.co)$/i;
const SHORTENER_HOST_RE = /^(maps\.app\.goo\.gl|goo\.gl|g\.co)$/i;

// 短縮URL(maps.app.goo.gl等)を、展開済みのGoogleマップURLに変換する。
// ⑥ 展開済みのURL(店名・座標・IDが全て入っている)に到達したら、それ以上はたどらない。
//   （さらにアクセスすると、同意画面などへ飛ばされて情報を失うことがあるため）
async function resolveRedirect(url) {
  let current = url;
  for (let i = 0; i < 8; i++) {
    let host;
    try { host = new URL(current).hostname; } catch { return current; }
    if (!SHORTENER_HOST_RE.test(host)) return current;

    let r;
    try {
      r = await fetch(current, { method: "GET", redirect: "manual", headers: BROWSER_HEADERS });
    } catch {
      return current;
    }
    try { if (r.body) await r.body.cancel(); } catch { /* 無視 */ }

    const loc = r.headers.get("location");
    if (!loc || r.status < 300 || r.status >= 400) return current;

    let next = new URL(loc, current).toString();
    // 同意画面(consent.google.*)に飛ばされた場合は、continue= に元のURLが入っているので取り出す
    const nu = new URL(next);
    if (/(^|\.)consent\.google\./i.test(nu.hostname)) {
      const cont = nu.searchParams.get("continue");
      if (!cont) return current;
      next = cont;
    }
    current = next;
  }
  return current;
}

function safeDecode(s) {
  const t = s.replace(/\+/g, " ");
  try { return decodeURIComponent(t); } catch { return t; }
}

// 展開済みGoogleマップURLから、店名・座標・place_id・店舗固有ID(cid)を取り出す
function parseMapsUrl(url) {
  let name = null, lat = null, lng = null, placeId = null, cid = null;

  const placeMatch = url.match(/\/maps\/place\/([^/@?]+)/);
  if (placeMatch) name = safeDecode(placeMatch[1]);

  if (!name) {
    const qm = url.match(/[?&](?:q|query)=([^&#]+)/);
    if (qm) {
      const q = safeDecode(qm[1]);
      if (!/^place_id:/i.test(q)) name = q;
    }
  }

  // ⑤ "@lat,lng,zoom" は共有時の地図の表示位置であり店舗の座標とは限らない。
  //   data=内の "!3d<lat>!4d<lng>" が実際のピン座標なので、あればそちらを優先する。
  const pinMatch = url.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (pinMatch) {
    lat = pinMatch[1];
    lng = pinMatch[2];
  } else {
    const atMatch = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (atMatch) { lat = atMatch[1]; lng = atMatch[2]; }
  }

  // URLにplace_idそのものが含まれている場合
  const pid = url.match(/!19s(ChIJ[\w-]+)/) ||
              url.match(/[?&]query_place_id=([\w-]+)/) ||
              url.match(/place_id:([\w-]+)/);
  if (pid) placeId = pid[1];

  // ⑥ "!1s0x<hex>:0x<hex>" の後半が店舗固有ID(cid)。10進数に変換して使う。
  const cidMatch = url.match(/!1s0x[0-9a-f]+:0x([0-9a-f]+)/i);
  if (cidMatch) {
    try { cid = BigInt("0x" + cidMatch[1]).toString(); } catch { cid = null; }
  }

  return { name, lat, lng, placeId, cid };
}

/* ── Places API(Legacy)呼び出し ── */
async function placesGet(endpoint, params) {
  const qs = new URLSearchParams({ language: "ja", key: MAPS_SERVER_KEY.value(), ...params });
  const r = await fetch(`https://maps.googleapis.com/maps/api/place/${endpoint}/json?${qs.toString()}`);
  return r.json();
}

// 失敗原因の切り分け用に、各API呼び出しの結果ステータスを記録する
function note(diag, label, d) {
  diag.push(`${label}:${d.status}${d.error_message ? `(${d.error_message})` : ""}`);
}

async function findCandidates(info, diag) {
  const list = [];
  const seen = new Set();
  const add = c => {
    if (c && c.place_id && !seen.has(c.place_id)) { seen.add(c.place_id); list.push(c); }
  };
  const hasPin = !!(info.lat && info.lng);

  if (info.name) {
    const p1 = { input: info.name, inputtype: "textquery", fields: "place_id,name,geometry" };
    if (hasPin) p1.locationbias = `circle:500@${info.lat},${info.lng}`;
    const d1 = await placesGet("findplacefromtext", p1);
    note(diag, "findplace", d1);
    (d1.candidates || []).forEach(add);

    const p2 = { query: info.name };
    if (hasPin) { p2.location = `${info.lat},${info.lng}`; p2.radius = "500"; }
    const d2 = await placesGet("textsearch", p2);
    note(diag, "textsearch", d2);
    (d2.results || []).slice(0, 10).forEach(add);
  }

  // 店名で見つからない/店名が取れない場合は、ピン座標のごく近くを探す
  if (!list.length && hasPin) {
    const d3 = await placesGet("nearbysearch", { location: `${info.lat},${info.lng}`, radius: "50" });
    note(diag, "nearby", d3);
    (d3.results || []).slice(0, 10).forEach(add);
  }
  return list;
}

async function getPlaceDetails(placeId, diag) {
  const d = await placesGet("details", { place_id: placeId, fields: "place_id,name,geometry,url" });
  note(diag, "details", d);
  return d.status === "OK" ? d.result : null;
}

function cidOf(detail) {
  const m = detail && detail.url && detail.url.match(/[?&]cid=(\d+)/);
  return m ? m[1] : null;
}

function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000, toRad = x => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/* ── Expressアプリ本体 ── */
const app = express();
app.use(express.json());

// ③ Firebase Hostingの function rewrite は、パスを書き換えずに
//   (例: /api/admin/login のまま) そのままCloud Functionsへ転送する。
//   そのため、ルートは "/api/admin" を含めてルーター側にマウントする。
const router = express.Router();

router.get("/session", (req, res) => {
  const session = verifySession(extractToken(req), SESSION_SECRET.value());
  res.json(session ? { authenticated: true, username: session.username } : { authenticated: false });
});

router.post("/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    res.status(400).json({ error: "ユーザー名とパスワードを入力してください" });
    return;
  }
  if (username !== ADMIN_USERNAME.value()) {
    res.status(401).json({ error: "ユーザー名またはパスワードが違います" });
    return;
  }
  const ok = await bcrypt.compare(password, ADMIN_PASSWORD_HASH.value());
  if (!ok) {
    res.status(401).json({ error: "ユーザー名またはパスワードが違います" });
    return;
  }
  const token = signSession({ username, exp: Date.now() + SESSION_TTL_MS }, SESSION_SECRET.value());
  // ④ Cookieではなく、レスポンスボディでトークンを返す。
  //   クライアント側(admin.js)がこれを保存し、以降はAuthorizationヘッダーで送る。
  res.json({ username, token });
});

router.post("/logout", (req, res) => {
  // ④ ステートレストークンのため、サーバー側で無効化する状態は持たない。
  //   クライアント側(admin.js)が保存しているトークンを破棄すれば十分。
  res.json({ ok: true });
});

// これ以降のエンドポイントはログイン必須
router.use(requireAuth);

router.get("/shops", async (req, res) => {
  const snapshot = await db.collection("shops").get();
  // shopId = ドキュメントID（実データではplaceidと同一）
  const shops = snapshot.docs.map(doc => ({ shopId: doc.id, ...doc.data() }));
  res.json(shops);
});

router.post("/shops", async (req, res) => {
  const errors = validateShopPayload(req.body);
  if (errors.length) {
    res.status(400).json({ error: errors.join(" / ") });
    return;
  }
  const placeid = String(req.body.placeid).trim();
  const ref = db.collection("shops").doc(placeid); // ③ ドキュメントID = placeid
  const existing = await ref.get();
  if (existing.exists) {
    res.status(409).json({ error: "このPlace IDの店舗は既に登録されています。編集画面から更新してください。" });
    return;
  }
  const data = buildShopData(req.body);
  data.createdAt = FieldValue.serverTimestamp();
  await ref.set(data);
  res.status(201).json({ shopId: ref.id });
});

router.put("/shops/:id", async (req, res) => {
  const errors = validateShopPayload(req.body);
  if (errors.length) {
    res.status(400).json({ error: errors.join(" / ") });
    return;
  }
  const ref = db.collection("shops").doc(req.params.id);
  const snap = await ref.get();
  if (!snap.exists) {
    res.status(404).json({ error: "店舗が見つかりません" });
    return;
  }
  const data = buildShopData(req.body);
  // ③ placeid(=ドキュメントID)はURLのidを正とし、フォーム側の値があっても上書きしない
  //   （IDを変更したい場合は削除して新規登録し直す運用とする）
  data.placeid = req.params.id;
  // ③ genre/matchScore等、このフォームが扱わない既存フィールドを消さないよう merge:true で更新する
  await ref.set(data, { merge: true });
  res.json({ shopId: ref.id });
});

router.delete("/shops/:id", async (req, res) => {
  const ref = db.collection("shops").doc(req.params.id);
  const snap = await ref.get();
  if (!snap.exists) {
    res.status(404).json({ error: "店舗が見つかりません" });
    return;
  }
  await ref.delete();
  res.status(204).send();
});

router.post("/resolve-maps-url", async (req, res) => {
  const url = (req.body && req.body.url || "").trim();
  if (!url) {
    res.status(400).json({ error: "URLを入力してください" });
    return;
  }
  let inputHost;
  try { inputHost = new URL(url).hostname; } catch {
    res.status(400).json({ error: "URLの形式が正しくありません" });
    return;
  }
  if (!GOOGLE_HOST_RE.test(inputHost)) {
    res.status(400).json({ error: "GoogleマップのURLを入力してください" });
    return;
  }

  const diag = [];
  try {
    const resolvedUrl = await resolveRedirect(url);
    const info = parseMapsUrl(resolvedUrl);
    console.log("[resolve-maps-url]", JSON.stringify({ input: url, resolved: resolvedUrl, info }));

    const hasPin = !!(info.lat && info.lng);
    let chosen = null;

    // 1) URLにplace_idが直接含まれていれば、それを使う
    if (info.placeId) chosen = await getPlaceDetails(info.placeId, diag);

    // 2) 候補を集め、店舗固有ID(cid)が完全一致するものを選ぶ
    let candidates = [];
    if (!chosen) {
      candidates = await findCandidates(info, diag);
      if (info.cid) {
        for (const c of candidates.slice(0, 5)) {
          const d = await getPlaceDetails(c.place_id, diag);
          if (d && cidOf(d) === info.cid) { chosen = d; break; }
        }
      }
    }

    // 3) cidで特定できなかった場合は、ピン座標に近い候補（200m以内）を採用する
    if (!chosen && candidates.length) {
      if (hasPin) {
        const la = Number(info.lat), ln = Number(info.lng);
        const scored = candidates
          .filter(c => c.geometry && c.geometry.location)
          .map(c => ({ c, d: distanceM(la, ln, c.geometry.location.lat, c.geometry.location.lng) }))
          .sort((a, b) => a.d - b.d);
        if (scored.length && scored[0].d <= 200) chosen = scored[0].c;
      } else {
        chosen = candidates[0];
      }
    }

    if (!chosen) {
      const reason = diag.length ? diag.join(", ") : "URLから店名・座標を取得できませんでした";
      console.log("[resolve-maps-url] not found:", reason);
      res.status(422).json({
        error: `店舗情報を特定できませんでした。手動で入力してください。（${reason}）`
      });
      return;
    }

    const loc = chosen.geometry && chosen.geometry.location;
    res.json({
      name: chosen.name,
      // 緯度経度は、URLから直接取得できた正確なピン座標があればそちらを優先する
      lat: hasPin ? Number(info.lat) : (loc && loc.lat),
      lng: hasPin ? Number(info.lng) : (loc && loc.lng),
      placeid: chosen.place_id
    });
  } catch (err) {
    console.error("resolve-maps-url failed:", err);
    res.status(500).json({ error: "Googleマップの情報取得に失敗しました" });
  }
});

// ③ Hostingから渡されるパス(/api/admin/...)にルーターをマウントする
app.use("/api/admin", router);

exports.adminApi = onRequest(
  {
    region: "asia-northeast1",
    secrets: [ADMIN_USERNAME, ADMIN_PASSWORD_HASH, SESSION_SECRET, MAPS_SERVER_KEY]
  },
  app
);
