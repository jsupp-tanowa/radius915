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
async function resolveRedirect(url) {
  let current = url;
  for (let i = 0; i < 5; i++) {
    let r;
    try {
      r = await fetch(current, { method: "GET", redirect: "manual" });
    } catch {
      return current;
    }
    const loc = r.headers.get("location");
    if (!loc || r.status < 300 || r.status >= 400) return r.url || current;
    current = loc.startsWith("http") ? loc : new URL(loc, current).toString();
  }
  return current;
}

function parseMapsUrl(url) {
  let name = null, lat = null, lng = null;
  const placeMatch = url.match(/\/maps\/place\/([^/@]+)/);
  if (placeMatch) {
    name = decodeURIComponent(placeMatch[1].replace(/\+/g, " "));
  }
  // ⑤ URL中の "@lat,lng,zoom" は共有ボタンを押した時点の「地図の表示位置（パン/ズーム状態）」であり、
  //   店舗の実際の座標とは無関係にズレることがある（今回の不具合の原因）。
  //   一方、data=パラメータ内の "!3d<lat>!4d<lng>" は実際のピン（店舗）の座標なので、
  //   見つかればこちらを優先して使う。
  const pinMatch = url.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (pinMatch) {
    lat = pinMatch[1];
    lng = pinMatch[2];
  } else {
    const atMatch = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (atMatch) {
      lat = atMatch[1];
      lng = atMatch[2];
    }
  }
  return { name, lat, lng };
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
  try {
    const resolvedUrl = await resolveRedirect(url);
    const { name: nameHint, lat: latHint, lng: lngHint } = parseMapsUrl(resolvedUrl);

    const params = new URLSearchParams({
      input: nameHint || url,
      inputtype: "textquery",
      fields: "place_id,name,geometry",
      language: "ja",
      key: MAPS_SERVER_KEY.value()
    });
    if (latHint && lngHint) {
      // ⑤ 半径300m圏内に強く絞り込む(circle)ことで、同名・類似名の他拠点や
      //   無関係な施設が誤ってヒットするのを防ぐ（point指定は弱いヒントにしかならないため）
      params.set("locationbias", `circle:300@${latHint},${lngHint}`);
    }

    const apiRes = await fetch(
      `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?${params.toString()}`
    );
    const apiData = await apiRes.json();

    if (apiData.status !== "OK" || !Array.isArray(apiData.candidates) || !apiData.candidates.length) {
      res.status(422).json({ error: "店舗情報を特定できませんでした。手動で入力してください。" });
      return;
    }

    const candidate = apiData.candidates[0];
    res.json({
      name: candidate.name,
      // ⑤ 緯度経度は、URLから直接取得できた正確なピン座標があればそちらを優先する
      //   （Places APIの候補が表記ゆれ等でわずかに違う地点を指す可能性があるため）
      lat: latHint ? Number(latHint) : candidate.geometry.location.lat,
      lng: lngHint ? Number(lngHint) : candidate.geometry.location.lng,
      placeid: candidate.place_id
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
