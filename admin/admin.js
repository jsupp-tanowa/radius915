const API_BASE = "/api/admin";

const loginScreen = document.getElementById("loginScreen");
const adminScreen = document.getElementById("adminScreen");
const loginForm   = document.getElementById("loginForm");
const loginError  = document.getElementById("loginError");
const loggedInAs  = document.getElementById("loggedInAs");
const logoutBtn   = document.getElementById("logoutBtn");

const shopTableBody = document.getElementById("shopTableBody");
const listEmpty     = document.getElementById("listEmpty");
const newShopBtn    = document.getElementById("newShopBtn");

const filterAllBtn         = document.getElementById("filterAllBtn");
const filterUnpublishedBtn = document.getElementById("filterUnpublishedBtn");
let currentFilter = "all";

const shopModal    = document.getElementById("shopModal");
const shopForm     = document.getElementById("shopForm");
const modalTitle   = document.getElementById("modalTitle");
const formError    = document.getElementById("formError");
const cancelModalBtn = document.getElementById("cancelModalBtn");

const mapsUrlInput   = document.getElementById("mapsUrlInput");
const mapsImportBtn  = document.getElementById("mapsImportBtn");
const mapsImportError = document.getElementById("mapsImportError");

// ④ Firebase Hostingのrewrite越しではCookieが転送されないケースがあるため、
//   セッショントークンはCookieではなくlocalStorageに保存し、
//   毎回のリクエストでAuthorizationヘッダーとして明示的に送る。
const TOKEN_KEY = "adminSessionToken";
function getToken() { return localStorage.getItem(TOKEN_KEY); }
function setToken(token) { localStorage.setItem(TOKEN_KEY, token); }
function clearToken() { localStorage.removeItem(TOKEN_KEY); }

async function apiFetch(path, options = {}) {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "Authorization": `Bearer ${token}` } : {}),
      ...(options.headers || {})
    }
  });
  return res;
}

/* ── 認証状態の確認 ── */
async function checkSession() {
  if (!getToken()) {
    showLoginScreen();
    return;
  }
  const res = await apiFetch("/session");
  const data = await res.json();
  if (data.authenticated) {
    showAdminScreen(data.username);
  } else {
    clearToken();
    showLoginScreen();
  }
}

function showLoginScreen() {
  loginScreen.style.display = "flex";
  adminScreen.style.display = "none";
}

function showAdminScreen(username) {
  loginScreen.style.display = "none";
  adminScreen.style.display = "block";
  loggedInAs.textContent = username ? `${username} でログイン中` : "";
  loadShopList();
}

/* ── ログイン／ログアウト ── */
loginForm.addEventListener("submit", async e => {
  e.preventDefault();
  loginError.style.display = "none";

  const username = document.getElementById("loginUsername").value;
  const password = document.getElementById("loginPassword").value;

  try {
    const res = await apiFetch("/login", {
      method: "POST",
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) {
      loginError.textContent = data.error || "ログインに失敗しました";
      loginError.style.display = "block";
      return;
    }
    setToken(data.token);
    showAdminScreen(data.username);
  } catch (err) {
    loginError.textContent = "通信エラーが発生しました";
    loginError.style.display = "block";
  }
});

logoutBtn.addEventListener("click", async () => {
  await apiFetch("/logout", { method: "POST" });
  clearToken();
  showLoginScreen();
});

/* ── 店舗一覧 ── */
let shops = [];

async function loadShopList() {
  try {
    const res = await apiFetch("/shops");
    if (res.status === 401) { clearToken(); showLoginScreen(); return; }
    shops = await res.json();
    renderShopTable();
  } catch (err) {
    console.error("店舗一覧の取得に失敗しました:", err);
  }
}

function renderShopTable() {
  shopTableBody.innerHTML = "";

  const visibleShops = currentFilter === "unpublished"
    ? shops.filter(shop => !shop.published)
    : shops;

  listEmpty.style.display = visibleShops.length === 0 ? "block" : "none";
  listEmpty.textContent = currentFilter === "unpublished"
    ? "非公開の店舗はありません"
    : "店舗が登録されていません";

  visibleShops.forEach(shop => {
    const tr = document.createElement("tr");

    const badgeClass = shop.published ? "on" : "off";
    const badgeText  = shop.published ? "公開中" : "非公開";

    tr.innerHTML = `
      <td>${escapeHtml(shop.name)}</td>
      <td>${escapeHtml(shop.category || "")}</td>
      <td>${escapeHtml(shop.prefecture || "")}</td>
      <td>${Number(shop.supportLevel) || 0}</td>
      <td><span class="published-badge ${badgeClass}">${badgeText}</span></td>
      <td class="actions">
        <button type="button" class="secondary-btn edit-btn">編集</button>
        <button type="button" class="secondary-btn delete-btn">削除</button>
      </td>
    `;

    tr.querySelector(".edit-btn").addEventListener("click", () => openEditModal(shop));
    tr.querySelector(".delete-btn").addEventListener("click", () => deleteShop(shop));

    shopTableBody.appendChild(tr);
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

async function deleteShop(shop) {
  if (!confirm(`「${shop.name}」を削除します。よろしいですか？`)) return;
  const res = await apiFetch(`/shops/${shop.shopId}`, { method: "DELETE" });
  if (res.status === 401) { clearToken(); showLoginScreen(); return; }
  if (!res.ok && res.status !== 204) {
    alert("削除に失敗しました");
    return;
  }
  loadShopList();
}

/* ── 一覧の絞り込み（すべて／非公開のみ） ── */
function setFilter(filter) {
  currentFilter = filter;
  filterAllBtn.classList.toggle("active", filter === "all");
  filterUnpublishedBtn.classList.toggle("active", filter === "unpublished");
  renderShopTable();
}

filterAllBtn.addEventListener("click", () => setFilter("all"));
filterUnpublishedBtn.addEventListener("click", () => setFilter("unpublished"));

/* ── 新規作成／編集モーダル ── */
newShopBtn.addEventListener("click", () => openNewModal());
cancelModalBtn.addEventListener("click", () => closeModal());

function openNewModal() {
  shopForm.reset();
  document.getElementById("shopId").value = "";
  document.getElementById("fieldPlaceId").readOnly = false;
  modalTitle.textContent = "新規店舗を登録";
  formError.style.display = "none";
  mapsImportError.style.display = "none";
  shopModal.style.display = "flex";
}

function openEditModal(shop) {
  document.getElementById("shopId").value = shop.shopId;
  document.getElementById("fieldName").value = shop.name || "";
  document.getElementById("fieldLat").value = shop.lat;
  document.getElementById("fieldLng").value = shop.lng;
  document.getElementById("fieldPlaceId").value = shop.placeid || "";
  // ③ placeidはドキュメントIDそのものなので、編集画面では変更不可にする
  //   （IDを変えたい場合は削除して新規登録し直す運用）
  document.getElementById("fieldPlaceId").readOnly = true;
  document.getElementById("fieldCategory").value = shop.category || "";
  document.getElementById("fieldPrefecture").value = shop.prefecture || "";
  document.getElementById("fieldTeam").value = shop.team || "";
  document.getElementById("fieldSupportLevel").value = Number(shop.supportLevel) || 0;
  document.getElementById("fieldNote").value = shop.note || "";
  // ③ 実データはimage(カンマ区切り文字列)。旧images(配列)が残っている場合はそちらを表示用に変換する
  document.getElementById("fieldImages").value = shop.image
    || (Array.isArray(shop.images) ? shop.images.join(", ") : "");
  document.getElementById("fieldVisited").checked = !!shop.visited;
  document.getElementById("fieldScreen").checked = !!shop.screen;
  document.getElementById("fieldVerified").checked = shop.verified !== false;
  document.getElementById("fieldPublished").checked = !!shop.published;

  modalTitle.textContent = "店舗を編集";
  formError.style.display = "none";
  mapsImportError.style.display = "none";
  mapsUrlInput.value = "";
  shopModal.style.display = "flex";
}

function closeModal() {
  shopModal.style.display = "none";
}

/* ── GoogleマップURLからの読み込み ── */
mapsImportBtn.addEventListener("click", async () => {
  mapsImportError.style.display = "none";
  const url = mapsUrlInput.value.trim();
  if (!url) return;

  mapsImportBtn.disabled = true;
  mapsImportBtn.textContent = "読み込み中...";
  try {
    const res = await apiFetch("/resolve-maps-url", {
      method: "POST",
      body: JSON.stringify({ url })
    });
    if (res.status === 401) { clearToken(); showLoginScreen(); return; }

    const data = await res.json();
    if (!res.ok) {
      mapsImportError.textContent = data.error || "読み込みに失敗しました";
      mapsImportError.style.display = "block";
      return;
    }

    if (data.name) document.getElementById("fieldName").value = data.name;
    document.getElementById("fieldLat").value = data.lat;
    document.getElementById("fieldLng").value = data.lng;
    if (data.placeid) document.getElementById("fieldPlaceId").value = data.placeid;
  } catch (err) {
    mapsImportError.textContent = "通信エラーが発生しました";
    mapsImportError.style.display = "block";
  } finally {
    mapsImportBtn.disabled = false;
    mapsImportBtn.textContent = "読み込む";
  }
});

shopForm.addEventListener("submit", async e => {
  e.preventDefault();
  formError.style.display = "none";

  const shopId = document.getElementById("shopId").value;
  const payload = {
    name: document.getElementById("fieldName").value.trim(),
    lat: Number(document.getElementById("fieldLat").value),
    lng: Number(document.getElementById("fieldLng").value),
    placeid: document.getElementById("fieldPlaceId").value.trim(),
    category: document.getElementById("fieldCategory").value.trim(),
    prefecture: document.getElementById("fieldPrefecture").value.trim(),
    team: document.getElementById("fieldTeam").value.trim(),
    supportLevel: Number(document.getElementById("fieldSupportLevel").value) || 0,
    note: document.getElementById("fieldNote").value.trim(),
    visited: document.getElementById("fieldVisited").checked,
    screen: document.getElementById("fieldScreen").checked,
    verified: document.getElementById("fieldVerified").checked,
    published: document.getElementById("fieldPublished").checked,
    // ③ 実データはimage(カンマ区切り文字列)が正のフィールド。配列に変換せずそのまま送る
    image: document.getElementById("fieldImages").value.trim()
  };

  try {
    const res = shopId
      ? await apiFetch(`/shops/${shopId}`, { method: "PUT", body: JSON.stringify(payload) })
      : await apiFetch("/shops", { method: "POST", body: JSON.stringify(payload) });

    if (res.status === 401) { clearToken(); showLoginScreen(); return; }

    const data = await res.json();
    if (!res.ok) {
      formError.textContent = data.error || "保存に失敗しました";
      formError.style.display = "block";
      return;
    }

    closeModal();
    loadShopList();
  } catch (err) {
    formError.textContent = "通信エラーが発生しました";
    formError.style.display = "block";
  }
});

checkSession();
