/* Firebase */
const firebaseConfig = {
  apiKey: "AIzaSyCT8IjSyBtHPAGKe7U5RA9yzeRmXmOI844",
  authDomain: "supportanowa.firebaseapp.com",
  projectId: "supportanowa",
  storageBucket: "supportanowa.firebasestorage.app",
  messagingSenderId: "125051593932",
  appId: "1:125051593932:web:1b3b0b87a5aac877698e69",
  measurementId: "G-J7HPC8G6RB"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
// ① Google Analytics（GA4）計測を有効化
firebase.analytics();

let map;
let userLocation  = null;
let currentMarker = null;

/* ①絵文字置き換え：Featherアイコン風アウトラインSVG(index.html側のスプライトを参照)を
   インラインで生成するヘルパー。stroke="currentColor" のため呼び出し元の文字色をそのまま継承する。 */
function iconSvg(name, extraClass) {
  const cls = extraClass ? `icon-inline ${extraClass}` : "icon-inline";
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#icon-${name}"></use></svg>`;
}

/* ── 外部リンク（Googleマップ）遷移 ──
   iOSでホーム画面に追加して起動している場合（スタンドアロンモード）は、
   window.open() で新しいウィンドウを作ると、Googleマップアプリへ
   ハンドオフされた後に空白ページ（×ボタンのみ）が残ってしまう。
   そのため、スタンドアロンモード時は現在のウィンドウをそのまま遷移させる。
   通常のブラウザ（PC・Android等）では従来通り新しいタブで開く。 */
function openExternalMapLink(url) {
  const isStandalone = window.navigator.standalone === true;
  if (isStandalone) {
    location.href = url;
  } else {
    window.open(url, "_blank");
  }
}

/* ひらがな↔カタカナ・大文字小文字 */
function toHiragana(str) {
  return str.replace(/[\u30A1-\u30F6]/g, ch =>
    String.fromCharCode(ch.charCodeAt(0) - 0x60));
}
function toKatakana(str) {
  return str.replace(/[\u3041-\u3096]/g, ch =>
    String.fromCharCode(ch.charCodeAt(0) + 0x60));
}
function normalizeKeyword(kw) {
  const lower = kw.toLowerCase();
  return [lower, toHiragana(lower), toKatakana(lower)];
}
function matchField(field, variants) {
  if (!field) return false;
  return variants.some(v => field.toLowerCase().includes(v));
}

/* ── 2点間の距離（km）を計算（haversine公式） ──
   ④「周辺の店舗を表示」の半径フィルタで使用 */
function distanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371; // 地球の半径(km)
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* ── 中心座標＋半径(km)から地図の表示範囲(LatLngBounds)を算出 ──
   ②「周辺の店舗を表示」で、stadium.radiusを表示範囲の基準として使用 */
function boundsFromRadius(lat, lng, radiusKm) {
  const latDelta = radiusKm / 111; // 1度 ≈ 111km
  const lngDelta = radiusKm / (111 * Math.cos(lat * Math.PI / 180));
  return new google.maps.LatLngBounds(
    { lat: lat - latDelta, lng: lng - lngDelta },
    { lat: lat + latDelta, lng: lng + lngDelta }
  );
}

/* ── localStorage 保存機能 ── */
const SAVE_KEY = "supportanowa_saved";

function loadSavedData() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return { shops: [], stadiums: [] };
    const parsed = JSON.parse(raw);
    return {
      shops:    Array.isArray(parsed.shops)    ? parsed.shops    : [],
      stadiums: Array.isArray(parsed.stadiums) ? parsed.stadiums : []
    };
  } catch {
    return { shops: [], stadiums: [] };
  }
}

function saveSavedData(data) {
  localStorage.setItem(SAVE_KEY, JSON.stringify(data));
}

function isSaved(type, placeid) {
  const data = loadSavedData();
  return data[type].includes(placeid);
}

function toggleSaved(type, placeid) {
  const data = loadSavedData();
  const idx = data[type].indexOf(placeid);
  if (idx >= 0) {
    data[type].splice(idx, 1);
  } else {
    data[type].push(placeid);
  }
  saveSavedData(data);
  return idx < 0; // true: 保存された / false: 解除された
}

/* 現在地ボタン */
function moveToCurrentLocation() {
  if (!navigator.geolocation) { alert("位置情報が使えません"); return; }
  navigator.geolocation.getCurrentPosition(
    pos => {
      const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      userLocation = p;
      map.setCenter(p);
      map.setZoom(11);
      if (currentMarker) currentMarker.setMap(null);
      currentMarker = new google.maps.Marker({
        position: p, map, title: "現在地",
        icon: "http://maps.google.com/mapfiles/ms/micons/yellow-dot.png"
      });
      // ①現在地取得時に出発地を自動セット
      setOrigin({ lat: p.lat, lng: p.lng, name: "現在地" });
    },
    () => alert("位置情報の取得に失敗しました")
  );
}

/* 地図初期化 */
window.initMap = function () {

  map = new google.maps.Map(document.getElementById("map"), {
    center: { lat: 34.7284, lng: 135.4814 },
    zoom: 11,
    mapTypeControl:    false,
    // ①Google純正のズームコントロールには頼らず、独自の.zoom-control-areaに
    //   置き換えるため、ズーム関連オプションは全てfalseに統一する
    zoomControl:       false,
    streetViewControl: false,
    fullscreenControl: false,
    panControl:        false,
    rotateControl:     false
  });

  // ①独自ズームボタン(＋/－)にmap.setZoom(±1)を紐付け。
  //   ボタン自体はCSSの@media (pointer: coarse)でタッチ端末では非表示になる
  document.getElementById("zoomInBtn").addEventListener("click", () => {
    map.setZoom(map.getZoom() + 1);
  });
  document.getElementById("zoomOutBtn").addEventListener("click", () => {
    map.setZoom(map.getZoom() - 1);
  });

  let allShops       = [];
  let allStadiums    = [];
  let shopMarkers    = [];
  let stadiumMarkers = [];
  let showGeneral    = true;
  let showStadiums   = true;

  /* ── ①② 出発地管理 ── */
  let originData = null; // { lat, lng, name }

  const setOriginChk = document.getElementById("setOriginChk");

  // 出発地をセット（現在地取得時などに外部から呼ぶ）
  window.setOrigin = function(data) {
    originData = data;
    if (setOriginChk) setOriginChk.checked = true;
  };

  // チェックボックスON→出発地セット、OFF→クリア
  setOriginChk.addEventListener("change", () => {
    if (setOriginChk.checked && currentDestination) {
      originData = {
        lat:     currentDestination.lat,
        lng:     currentDestination.lng,
        name:    currentDestination.name,
        type:    currentDestination.type,    // ④ スタジアム判定用
        placeid: currentDestination.placeid  // ④ 「出発地自身の再検索」判定用
      };
    } else {
      originData = null;
    }
    // ① 出発地の変更によって「出発地＝目的地」の状態が変わるため、
    //    経路検索ボタンの有効/無効を再判定する
    updateRouteTabState();
  });

  /* ── 経路検索先 ── */
  let currentDestination = null; // { type: 'shop'|'stadium', placeid, name, lat, lng }

  /* ── 保存ボタン ── */
  const saveToggleBtn = document.getElementById("saveToggleBtn");

  function updateSaveBtnDisplay() {
    if (!currentDestination) return;
    const saved = isSaved(currentDestination.type, currentDestination.placeid);
    saveToggleBtn.querySelector(".save-toggle-label").textContent = saved ? "保存済み" : "保存";
    saveToggleBtn.querySelector(".save-star-icon").classList.toggle("icon-star-filled", saved);
    saveToggleBtn.classList.toggle("saved", saved);
  }

  saveToggleBtn.addEventListener("click", () => {
    if (!currentDestination) return;
    toggleSaved(currentDestination.type, currentDestination.placeid);
    updateSaveBtnDisplay();
  });

  /* ── カード ── */
  function openCard() {
    document.getElementById("shopCard").style.display = "flex";
  }
  function closeCard() {
    const card = document.getElementById("shopCard");
    card.style.display = "none";
    setGoHereBtnEnabled(false);
    currentDestination = null;
    if (setOriginChk) setOriginChk.checked = false;
  }

  /* ① 「ここに行く」ボタン有効/無効（旧・経路検索タブと同一機能） */
  const goHereBtn = document.getElementById("goHereBtn");
  function setGoHereBtnEnabled(enabled) {
    goHereBtn.disabled = !enabled;
  }

  // 目的地（開いているカード）と出発地が同一の場合は無効化する
  function updateRouteTabState() {
    const isSameAsOrigin =
      originData &&
      currentDestination &&
      originData.placeid === currentDestination.placeid;
    setGoHereBtnEnabled(!!currentDestination && !isSameAsOrigin);
  }

  setGoHereBtnEnabled(false);

  /* 経路検索実行（① カード内「ここに行く」ボタンから呼び出し） */
  function executeRouteSearch() {
    if (!currentDestination) return;

    // 出発地と目的地が同一の場合は経路検索を行わない
    //（ボタン自体は無効化されるが、念のための二重チェック）
    if (originData && originData.placeid === currentDestination.placeid) {
      alert("出発地と目的地が同じため、経路検索できません。\n出発地チェックを外すか、別の場所を出発地に設定してください。");
      return;
    }

    const destName    = encodeURIComponent(currentDestination.name);
    const destPlaceId = encodeURIComponent(currentDestination.placeid);

    // 出発地：originData があればそれを使用、なければ省略
    const origin = originData
      ? `${originData.lat},${originData.lng}`
      : "";

    const url = origin
      ? `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destName}&destination_place_id=${destPlaceId}&travelmode=transit`
      : `https://www.google.com/maps/dir/?api=1&destination=${destName}&destination_place_id=${destPlaceId}&travelmode=transit`;

    openExternalMapLink(url);
  }

  goHereBtn.addEventListener("click", executeRouteSearch);

  /* ── 検索バークリア ── */
  const searchInput    = document.getElementById("searchInput");
  const searchClearBtn = document.getElementById("searchClearBtn");

  function updateClearBtn() {
    searchClearBtn.style.display = searchInput.value.length > 0 ? "block" : "none";
  }
  searchClearBtn.addEventListener("click", clearSearch);
  function clearSearch() {
    searchInput.value = "";
    updateClearBtn();
    refreshShopMarkers();
    refreshStadiumMarkers();
  }

  /* ── fitBounds（stadium検索用） ── */
  function fitToMarkers(markers) {
    if (markers.length === 0) return;
    if (markers.length === 1) {
      map.setCenter(markers[0].getPosition());
      map.setZoom(13);
      return;
    }
    const bounds = new google.maps.LatLngBounds();
    markers.forEach(m => bounds.extend(m.getPosition()));
    map.fitBounds(bounds);
    google.maps.event.addListenerOnce(map, "bounds_changed", () => {
      if (map.getZoom() > 14) map.setZoom(14);
    });
  }

  /* ── スタジアムマーカー作成 ── */
  function createStadiumMarker(stadium) {
    const marker = new google.maps.Marker({
      position: { lat: Number(stadium.lat), lng: Number(stadium.lng) },
      map,
      title: stadium.name,
      icon: "http://maps.google.com/mapfiles/ms/micons/sportvenue.png"
    });

    marker.addListener("click", () => {
      openCard();
      const displayName = (stadium.subname && stadium.subname.trim())
        ? stadium.subname : stadium.name;
      document.getElementById("shopName").innerText = displayName;
      const teamsText = Array.isArray(stadium.teams) && stadium.teams.length
        ? `ホームクラブ: ${stadium.teams.join(" / ")}` : "";
      document.getElementById("shopInfo").innerHTML = teamsText;

      // ⑤ 注意文言はスタジアムカードでは非表示
      document.getElementById("shopNotice").style.display = "none";

      const gallery = document.getElementById("shopImageGallery");
      gallery.innerHTML = "";
      gallery.style.display = "none";

      document.querySelector(".detail-btn").onclick = () => {
        openExternalMapLink(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(stadium.name)}&query_place_id=${stadium.placeid}`);
      };

      // ② 周辺表示ボタン
      const showAreaBtn = document.getElementById("showAreaBtn");
      showAreaBtn.onclick = () => {
        showGeneral = true;
        const generalTab = document.getElementById("generalTab");
        if (generalTab) generalTab.style.opacity = "1";
        // ② 検索ボックスと検索結果をクリアしてから再描画
        //    （検索キーワードが残っていると店舗のcategory/team検索に
        //      ヒットせず、周辺の一般店舗や他スタジアムが表示されない不具合対策）
        clearSearch();
        // ② ピン自体は絞り込まず、stadium.radius を「表示範囲」の
        //   基準として使い、その範囲がちょうど収まるようfitBoundsする
        map.fitBounds(boundsFromRadius(
          Number(stadium.lat), Number(stadium.lng),
          Number(stadium.radius) || 3
        ));
        closeCard();
      };

      const r = Number(stadium.radius) || 3;
      const zoom = r <= 1 ? 15 : r <= 2 ? 14 : r <= 3 ? 13 : r <= 5 ? 12 : 11;
      map.setCenter({ lat: Number(stadium.lat), lng: Number(stadium.lng) });
      map.setZoom(zoom);

      currentDestination = {
        type: "stadiums",
        placeid: stadium.placeid,
        name: displayName,
        lat: Number(stadium.lat),
        lng: Number(stadium.lng)
      };
      // 既にこの場所が出発地として設定されている場合はチェック状態を反映
      setOriginChk.checked = !!(originData && originData.placeid === stadium.placeid);
      updateRouteTabState();
      updateSaveBtnDisplay();
      // ② スタジアムカードでは周辺表示ボタンを表示
      document.getElementById("showAreaBtn").style.display = "block";
    });

    marker.stadiumData = stadium;
    stadiumMarkers.push(marker);
    return marker;
  }

  /* ── verified 判定 ──
     supportLevel!==0（サポーター歓迎店）のうち、店舗からの掲載許可の
     回答が得られていない（verified===false）場合は、supportLevel=0
     の一般店舗と同一の扱いとする。verified未設定（過去データ）や
     trueの場合は従来通りサポーター歓迎店として扱う。 */
  function isEffectiveGeneral(shop) {
    if (shop.supportLevel === 0) return true;
    return shop.verified === false;
  }

  /* ── 店舗画像取得 ──
     shops.image（単数フィールド）にカンマ区切りで複数URLを設定する
     方式に対応（例: "https://a.jpg,https://b.jpg"）。
     従来のshops.images（配列）が設定されている場合はそちらを優先する
     （後方互換）。 */
  function getShopImages(shop) {
    if (Array.isArray(shop.images) && shop.images.length) return shop.images;
    if (shop.image) {
      return shop.image
        .split(",")
        .map(url => url.trim())
        .filter(url => url.length > 0);
    }
    return [];
  }

  /* ── 店舗マーカー作成 ── */
  function createShopMarker(shop) {
    const isSupporter = !isEffectiveGeneral(shop);
    const marker = new google.maps.Marker({
      position: { lat: Number(shop.lat), lng: Number(shop.lng) },
      map,
      title: shop.name,
      icon: isSupporter
        ? "http://maps.google.com/mapfiles/ms/micons/blue-dot.png"
        : "http://labs.google.com/ridefinder/images/mm_20_red.png"
    });

    marker.addListener("click", () => {
      openCard();
      document.getElementById("shopName").innerText = shop.name;
      const teamLine = (isSupporter && shop.team)
        ? `<span class="team-line">推しクラブ: ${shop.team}</span><br>` : "";

      // ③ サッカー熱狂度（supportLevel 0〜5）を炎アイコンで表現
      const level = Math.min(Math.max(Number(shop.supportLevel) || 0, 0), 5);
      const flameLine = (isSupporter && level > 0)
        ? `サッカー熱狂度: ${iconSvg("flame").repeat(level)}<br>` : "";

      // ③ 訪問済み・試合放映バッジ
      // ① supportLevel=0（非サポーター店舗）では「訪問済み」表示は不要
      const badges = [];
      if (isSupporter && shop.visited) badges.push(`${iconSvg("check")} 訪問済み`);
      if (shop.screen) badges.push(`${iconSvg("tv")} 試合放映あり`);
      const badgeLine = badges.length ? `${badges.join("　")}<br>` : "";

      const noteLine = (isSupporter && shop.note) ? `${shop.note}` : "";
      document.getElementById("shopInfo").innerHTML =
        teamLine + flameLine + `ジャンル: ${shop.category || ""}<br>` + badgeLine + noteLine;

      // ⑤ 注意文言は店舗カードのみ表示
      document.getElementById("shopNotice").style.display = "block";

      const gallery = document.getElementById("shopImageGallery");
      const images = isSupporter ? getShopImages(shop) : [];
      if (images.length) {
        gallery.innerHTML = images
          .map(url => `<img src="${url}" class="shop-image-item" alt="">`)
          .join("");
        gallery.style.display = "flex";
      } else {
        gallery.innerHTML = "";
        gallery.style.display = "none";
      }
      document.querySelector(".detail-btn").onclick = () => {
        openExternalMapLink(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(shop.name)}&query_place_id=${shop.placeid}`);
      };

      currentDestination = {
        type: "shops",
        placeid: shop.placeid,
        name: shop.name,
        lat: Number(shop.lat),
        lng: Number(shop.lng)
      };
      // 既にこの場所が出発地として設定されている場合はチェック状態を反映
      setOriginChk.checked = !!(originData && originData.placeid === shop.placeid);
      updateRouteTabState();
      updateSaveBtnDisplay();
      // ② 店舗カードでは周辺表示ボタンを非表示
      document.getElementById("showAreaBtn").style.display = "none";
    });

    marker.shopData = shop;
    shopMarkers.push(marker);
    return marker;
  }

  /* ── 店舗マーカー再描画 ── */
  function refreshShopMarkers() {
    shopMarkers.forEach(m => m.setMap(null));
    shopMarkers = [];

    const keyword  = searchInput.value.trim();
    const variants = keyword ? normalizeKeyword(keyword) : [];

    // ① 検索ボックスは shops.category / shops.team も検索対象とする
    //   （ピンの絞り込みは検索キーワード・タブのみで行う）
    allShops.filter(shop => {
      if (!shop.published) return false;
      // verified=falseのサポーター歓迎店は一般店舗と同一の表示条件とする
      if (isEffectiveGeneral(shop) && !showGeneral) return false;
      if (variants.length) {
        return (
          matchField(shop.category, variants) ||
          matchField(shop.team,     variants)
        );
      }
      return true;
    }).forEach(shop => createShopMarker(shop));
  }

  /* ── スタジアムマーカー再描画 ── */
  function refreshStadiumMarkers() {
    stadiumMarkers.forEach(m => m.setMap(null));
    stadiumMarkers = [];

    if (!showStadiums) return;

    const keyword  = searchInput.value.trim();
    const variants = keyword ? normalizeKeyword(keyword) : [];

    if (variants.length) {
      console.log("[検索]", variants, "/ スタジアム総数:", allStadiums.length);
    }

    const filtered = allStadiums.filter(s => {
      if (variants.length) {
        const teamsStr = Array.isArray(s.teams) ? s.teams.join(" ") : (s.teams || "");
        const hit = (
          matchField(s.name,       variants) ||
          matchField(s.subname,    variants) ||
          matchField(s.prefecture, variants) ||
          matchField(s.city,       variants) ||
          matchField(teamsStr,     variants)
        );
        if (hit) console.log("[ヒット]", s.name, s.prefecture, s.teams);
        return hit;
      }
      return true;
    });

    console.log("[filtered]", filtered.length, "件");

    filtered.forEach(s => createStadiumMarker(s));

    // ④ スタジアム優先ズーム：
    //    キーワードあり かつ スタジアムがヒット の場合にfitBoundsする。
    //    ただし「出発地に設定したスタジアム自身だけ」がヒットした場合は、
    //    無駄なカメラ移動を避けるためスキップする
    //    （出発地がスタジアムというだけで以降の検索が全て無視される
    //      不具合があったため、判定をplaceid単位に限定した）
    if (variants.length && stadiumMarkers.length > 0) {
      const isOnlyOriginStadiumItself =
        originData &&
        originData.type === "stadiums" &&
        filtered.length === 1 &&
        filtered[0].placeid === originData.placeid;

      if (!isOnlyOriginStadiumItself) {
        fitToMarkers(stadiumMarkers);
      }
    }
  }

  function refreshAllMarkers() {
    refreshShopMarkers();
    refreshStadiumMarkers();
  }

  /* ── ② 検索後ズーム ── */
  function fitToSearchResults() {
    const keyword = searchInput.value.trim();
    if (!keyword) return;

    // スタジアムがヒットしている場合はrefreshStadiumMarkers内のfitToMarkersに任せる
    if (stadiumMarkers.length > 0) return;

    // スタジアム未ヒット・店舗のみの場合：出発地/現在地→最近傍ピンにfit
    const shopPositions = shopMarkers.map(m => m.getPosition());
    if (shopPositions.length === 0) return;

    const base = originData
      ? new google.maps.LatLng(originData.lat, originData.lng)
      : userLocation
        ? new google.maps.LatLng(userLocation.lat, userLocation.lng)
        : null;

    if (!base) {
      const bounds = new google.maps.LatLngBounds();
      shopPositions.forEach(p => bounds.extend(p));
      map.fitBounds(bounds);
      google.maps.event.addListenerOnce(map, "bounds_changed", () => {
        if (map.getZoom() > 14) map.setZoom(14);
      });
      return;
    }

    let nearest = null;
    let minDist = Infinity;
    shopPositions.forEach(p => {
      const d = google.maps.geometry
        ? google.maps.geometry.spherical.computeDistanceBetween(base, p)
        : Math.hypot(p.lat() - base.lat(), p.lng() - base.lng());
      if (d < minDist) { minDist = d; nearest = p; }
    });

    const bounds = new google.maps.LatLngBounds();
    bounds.extend(base);
    bounds.extend(nearest);
    map.fitBounds(bounds, { padding: 80 });
    google.maps.event.addListenerOnce(map, "bounds_changed", () => {
      if (map.getZoom() > 14) map.setZoom(14);
    });
  }

  /* ── タブ：スタジアム ── */
  const stadiumTab = document.getElementById("stadiumTab");
  stadiumTab.addEventListener("click", () => {
    showStadiums = !showStadiums;
    stadiumTab.style.opacity = showStadiums ? "1" : "0.5";
    clearSearch();
    refreshStadiumMarkers();
  });
  stadiumTab.style.opacity = "1";

  /* ── タブ：一般店舗 ── */
  const generalTab = document.getElementById("generalTab");
  generalTab.addEventListener("click", () => {
    showGeneral = !showGeneral;
    generalTab.style.opacity = showGeneral ? "1" : "0.5";
    clearSearch();
    refreshShopMarkers();
  });
  generalTab.style.opacity = "1";

  /* ── タブ：保存 ── */
  const savedTab    = document.getElementById("savedTab");
  const savedScreen = document.getElementById("savedScreen");
  const savedList   = document.getElementById("savedList");
  const closeSavedBtn = document.getElementById("closeSavedBtn");

  function renderSavedList() {
    const data = loadSavedData();
    savedList.innerHTML = "";

    const shopItems = data.shops.map(placeid => {
      const shop = allShops.find(s => s.placeid === placeid);
      return shop ? { type: "shops", placeid, name: shop.name, sub: [shop.prefecture, shop.category].filter(Boolean).join(" ・ ") } : null;
    }).filter(Boolean);

    const stadiumItems = data.stadiums.map(placeid => {
      const st = allStadiums.find(s => s.placeid === placeid);
      if (!st) return null;
      const displayName = (st.subname && st.subname.trim()) ? st.subname : st.name;
      const teamsStr = Array.isArray(st.teams) ? st.teams.join(" / ") : "";
      return { type: "stadiums", placeid, name: displayName, sub: [st.prefecture, teamsStr].filter(Boolean).join(" ・ ") };
    }).filter(Boolean);

    const items = [...stadiumItems, ...shopItems];

    if (items.length === 0) {
      savedList.innerHTML = '<div class="saved-empty">保存した店舗・スタジアムはありません</div>';
      return;
    }

    items.forEach(item => {
      const row = document.createElement("div");
      row.className = "saved-item";

      const icon = item.type === "stadiums" ? iconSvg("ball") : iconSvg("restaurant");

      row.innerHTML = `
        <div class="saved-item-main">
          <span class="saved-item-icon">${icon}</span>
          <div class="saved-item-text">
            <span class="saved-item-name">${item.name}</span>
            <span class="saved-item-sub">${item.sub}</span>
          </div>
        </div>
        <button class="saved-item-remove">削除</button>
      `;

      // 項目タップ → 地図に戻ってその場所を表示
      row.querySelector(".saved-item-main").addEventListener("click", () => {
        savedScreen.style.display = "none";
        if (item.type === "shops") {
          const shop = allShops.find(s => s.placeid === item.placeid);
          if (shop) {
            map.setCenter({ lat: Number(shop.lat), lng: Number(shop.lng) });
            map.setZoom(15);
            const marker = shopMarkers.find(m => m.getTitle() === shop.name);
            if (marker) google.maps.event.trigger(marker, "click");
          }
        } else {
          const st = allStadiums.find(s => s.placeid === item.placeid);
          if (st) {
            const marker = stadiumMarkers.find(m => m.getTitle() === st.name);
            if (marker) google.maps.event.trigger(marker, "click");
          }
        }
      });

      // 削除ボタン
      row.querySelector(".saved-item-remove").addEventListener("click", () => {
        toggleSaved(item.type, item.placeid);
        renderSavedList();
        if (currentDestination && currentDestination.placeid === item.placeid) {
          updateSaveBtnDisplay();
        }
      });

      savedList.appendChild(row);
    });
  }

  savedTab.addEventListener("click", () => {
    renderSavedList();
    savedScreen.style.display = "flex";
  });

  closeSavedBtn.addEventListener("click", () => {
    savedScreen.style.display = "none";
  });

  /* ── タブ：リスト表示（③ 旧・経路検索タブの代替機能） ──
     現在地図上に表示されている（検索・絞り込み後の）店舗・スタジアムを
     一覧表示する。項目タップでそのピンのクリックと同じ動作を発火させる。 */
  const listTab    = document.getElementById("listTab");
  const listScreen = document.getElementById("listScreen");
  const listViewList = document.getElementById("listViewList");
  const closeListBtn = document.getElementById("closeListBtn");

  function renderListView() {
    listViewList.innerHTML = "";

    // 現在の地図表示範囲内にあるマーカーのみを対象とする
    const bounds = map.getBounds();
    const isVisible = m => !bounds || bounds.contains(m.getPosition());

    const stadiumItems = stadiumMarkers.filter(isVisible).map(m => {
      const st = m.stadiumData;
      const displayName = (st.subname && st.subname.trim()) ? st.subname : st.name;
      const teamsStr = Array.isArray(st.teams) ? st.teams.join(" / ") : "";
      return {
        type: "stadiums",
        marker: m,
        name: displayName,
        sub: [st.prefecture, teamsStr].filter(Boolean).join(" ・ ")
      };
    });

    const shopItems = shopMarkers.filter(isVisible).map(m => {
      const shop = m.shopData;
      return {
        type: "shops",
        marker: m,
        name: shop.name,
        sub: [shop.prefecture, shop.category].filter(Boolean).join(" ・ ")
      };
    });

    const items = [...stadiumItems, ...shopItems];

    if (items.length === 0) {
      listViewList.innerHTML = '<div class="saved-empty">現在の表示範囲内に店舗・スタジアムはありません</div>';
      return;
    }

    items.forEach(item => {
      const row = document.createElement("div");
      row.className = "saved-item";

      const icon = item.type === "stadiums" ? iconSvg("ball") : iconSvg("restaurant");

      row.innerHTML = `
        <div class="saved-item-main">
          <span class="saved-item-icon">${icon}</span>
          <div class="saved-item-text">
            <span class="saved-item-name">${item.name}</span>
            <span class="saved-item-sub">${item.sub}</span>
          </div>
        </div>
      `;

      // 項目タップ → リストを閉じて地図上のピンと同じ動作（カード表示）
      row.querySelector(".saved-item-main").addEventListener("click", () => {
        listScreen.style.display = "none";
        map.setCenter(item.marker.getPosition());
        map.setZoom(15);
        google.maps.event.trigger(item.marker, "click");
      });

      listViewList.appendChild(row);
    });
  }

  listTab.addEventListener("click", () => {
    renderListView();
    listScreen.style.display = "flex";
  });

  closeListBtn.addEventListener("click", () => {
    listScreen.style.display = "none";
  });

  /* ── ヘルプ（使い方）画面 ── */
  const helpBtn      = document.getElementById("helpBtn");
  const helpScreen   = document.getElementById("helpScreen");
  const closeHelpBtn = document.getElementById("closeHelpBtn");

  helpBtn.addEventListener("click", () => {
    helpScreen.style.display = "flex";
  });

  closeHelpBtn.addEventListener("click", () => {
    helpScreen.style.display = "none";
  });

  /* ── 検索バー入力 ── */
  searchInput.addEventListener("input", () => {
    // ② カードを開いた状態から検索を始めた場合はカードを閉じる
    const card = document.getElementById("shopCard");
    if (card.style.display !== "none") closeCard();
    updateClearBtn();
    refreshAllMarkers();
    fitToSearchResults(); // ② 検索後ズーム
  });

  /* ── データ読込（リトライ＋タイムアウト付き） ──
     長時間タブを放置した後、Firestoreの接続が内部的に切れたままになる
     問題への対策。onSnapshotによるリアルタイム監視と、復帰時の強制
     再接続を組み合わせて確実性を高める。 */

  /* onSnapshot でリアルタイム監視 ── 接続が生きている限り常に最新を反映 */
  let unsubShops    = null;
  let unsubStadiums = null;

  // 再接続処理から「実際に新しいデータが来たか」を判定するためのタイムスタンプ
  let lastShopsSnapshotAt    = 0;
  let lastStadiumsSnapshotAt = 0;

  /* ⑤ 店舗・スタジアム両方の初回読み込みが完了したらローディング画面を隠す */
  function hideLoadingOverlayIfReady() {
    if (lastShopsSnapshotAt > 0 && lastStadiumsSnapshotAt > 0) {
      const overlay = document.getElementById("loadingOverlay");
      if (overlay) overlay.classList.add("hide");
    }
  }

  function subscribeShops() {
    if (unsubShops) { unsubShops(); unsubShops = null; }
    unsubShops = db.collection("shops").onSnapshot(
      snapshot => {
        lastShopsSnapshotAt = Date.now();
        const newData = [];
        snapshot.forEach(doc => newData.push(doc.data()));
        allShops = newData;
        refreshShopMarkers();
        hideLoadingOverlayIfReady();
      },
      err => {
        console.warn("shops onSnapshot エラー:", err);
        unsubShops = null;
        // エラー時はフォールバックとして1回getを試みる
        db.collection("shops").get({ source: "server" })
          .then(snapshot => {
            lastShopsSnapshotAt = Date.now();
            const newData = [];
            snapshot.forEach(doc => newData.push(doc.data()));
            allShops = newData;
            refreshShopMarkers();
            hideLoadingOverlayIfReady();
          }).catch(() => {});
      }
    );
  }

  function subscribeStadiums() {
    if (unsubStadiums) { unsubStadiums(); unsubStadiums = null; }
    unsubStadiums = db.collection("stadiums").onSnapshot(
      snapshot => {
        lastStadiumsSnapshotAt = Date.now();
        const newData = [];
        snapshot.forEach(doc => newData.push(doc.data()));
        allStadiums = newData;
        refreshStadiumMarkers();
        hideLoadingOverlayIfReady();
      },
      err => {
        console.warn("stadiums onSnapshot エラー:", err);
        unsubStadiums = null;
        db.collection("stadiums").get({ source: "server" })
          .then(snapshot => {
            lastStadiumsSnapshotAt = Date.now();
            const newData = [];
            snapshot.forEach(doc => newData.push(doc.data()));
            allStadiums = newData;
            refreshStadiumMarkers();
            hideLoadingOverlayIfReady();
          }).catch(() => {});
      }
    );
  }

  /* 互換用エイリアス（他箇所から呼ばれているloadXxx()をそのまま使えるように） */
  function loadShops()    { subscribeShops();    }
  function loadStadiums() { subscribeStadiums(); }

  /* ── タブ復帰時に再接続（visibilitychange + pageshow 併用） ──
     放置後はFirestoreのWebSocket接続が切断されonSnapshotが止まるため、
     復帰時にネットワークを再確立してリスナーを張り直す。 */
  let isReloading  = false;
  let lastReloadAt = 0;
  function reloadOnResume() {
    const now = Date.now();
    // 前回の再接続処理がまだ完了していない間は多重実行しない
    // （disableNetwork/enableNetworkの二重呼び出しでFirestoreの接続状態が
    //   固まったままになり、ピンが復活しなくなる不具合の対策）
    if (isReloading || now - lastReloadAt < 3000) return;
    isReloading = true;
    lastReloadAt = now;
    const reloadStartedAt = now;

    // リスナーをいったん解除してからネットワーク再接続→再登録
    if (unsubShops)    { unsubShops();    unsubShops    = null; }
    if (unsubStadiums) { unsubStadiums(); unsubStadiums = null; }

    db.disableNetwork()
      .then(() => db.enableNetwork())
      .catch(() => db.enableNetwork().catch(() => {}))
      .finally(() => {
        subscribeShops();
        subscribeStadiums();

        // 一定時間経ってもonSnapshotから新しいデータが来なければ
        // 強制的にサーバーから再取得する保険（詰まり対策）
        setTimeout(() => {
          if (lastShopsSnapshotAt < reloadStartedAt) {
            db.collection("shops").get({ source: "server" })
              .then(snapshot => {
                lastShopsSnapshotAt = Date.now();
                const newData = [];
                snapshot.forEach(doc => newData.push(doc.data()));
                allShops = newData;
                refreshShopMarkers();
              }).catch(() => {});
          }
          if (lastStadiumsSnapshotAt < reloadStartedAt) {
            db.collection("stadiums").get({ source: "server" })
              .then(snapshot => {
                lastStadiumsSnapshotAt = Date.now();
                const newData = [];
                snapshot.forEach(doc => newData.push(doc.data()));
                allStadiums = newData;
                refreshStadiumMarkers();
              }).catch(() => {});
          }
          isReloading = false;
        }, 4000);
      });
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") reloadOnResume();
  });

  window.addEventListener("pageshow", () => {
    reloadOnResume();
  });

  /* ── ② 手動リロードボタン ──
     ホーム画面起動時など、自動リトライでもピンが復活しない場合の
     ユーザー自身によるリカバリー手段。押すたびに強制的に
     再接続処理を実行する。 */
  const reloadPinsBtn = document.getElementById("reloadPinsBtn");
  if (reloadPinsBtn) {
    reloadPinsBtn.addEventListener("click", () => {
      reloadPinsBtn.classList.remove("spinning");
      // 強制再生成でアニメーションを毎回再生させる
      void reloadPinsBtn.offsetWidth;
      reloadPinsBtn.classList.add("spinning");
      // ボタン手動操作時は連打防止用のクールダウンを無視して即実行したいので、
      // lastReloadAt を直接リセットしてから呼び出す
      lastReloadAt = 0;
      reloadOnResume();
    });
  }

  /* ── カード閉じる ── */
  document.getElementById("closeCardBtn").addEventListener("click", closeCard);

  /* ── 初期位置情報取得 ── */
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      pos => {
        const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        userLocation = p;
        map.setCenter(p);
        map.setZoom(11);
        if (currentMarker) currentMarker.setMap(null);
        currentMarker = new google.maps.Marker({
          position: p, map, title: "現在地",
          icon: "http://maps.google.com/mapfiles/ms/micons/yellow-dot.png"
        });
        // ①現在地取得時に出発地を自動セット
        setOrigin({ lat: p.lat, lng: p.lng, name: "現在地" });
      },
      () => {},
      { timeout: 8000 }
    );
  }

  /* ── 初回ロード ── */
  loadShops();
  loadStadiums();

  /* ── ① 起動時ウォッチドッグ ──
     ホーム画面アイコンからの新規起動（コールドスタート）時は
     visibilitychange/pageshowが発火しないため、上記の復帰時
     再接続ロジックが働かない。起動直後にFirestoreの初回接続が
     失敗して一切ピンが表示されないケースの対策として、起動から
     一定時間経ってもデータが1件も来ていなければ自動的に
     reloadOnResume() を実行し、再接続を試みる。 */
  const appLaunchedAt = Date.now();
  setTimeout(() => {
    if (lastShopsSnapshotAt < appLaunchedAt && lastStadiumsSnapshotAt < appLaunchedAt) {
      reloadOnResume();
    }
  }, 6000);

  /* ⑤ 万一データ取得が長時間失敗し続けた場合の保険として、
     一定時間経過後はローディング画面を強制的に閉じる
     （地図・再読み込みボタンに手動でアクセスできるようにするため） */
  setTimeout(() => {
    const overlay = document.getElementById("loadingOverlay");
    if (overlay) overlay.classList.add("hide");
  }, 12000);

  /* ── ブラウザのオートフィル対応：ページ読込時にクリアボタン表示を更新 ── */
  updateClearBtn();
};
