(function () {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const fmt = (v, d) => (isFinite(v) ? Number(v).toFixed(d == null ? 1 : d) : '--');

  const MAX_KMH = 90;
  const SPEED_MULT = 1.5;   // penggali tampilan speedometer (perkalian), 0 tetap 0
  const GAUGE_LEN = 414.69;
  const SOC_LEN = 157.08; // semicircle path length (r=50)
  const SPEED_STOP = 1.0;   // m/s (~3.6 km/h) — below this the bike counts as stopped
  const ACCURACY_MAX = 60;  // m — fixes worse than this are not trusted for speed/trip

  const state = {
    bms: null,
    bmsData: null,
    bmsStatus: 'off',
    info: null,
    settings: null,
    follow: true,
    wakeLock: null,
    map: null,
    marker: null,
    trail: null,
    trailEnabled: false, // trail (garis cyan) sementara dimatikan — request user
    routeLine: null,
    destMarker: null,
    route: null, // { steps, distance, duration }
    destination: null,
    trailPts: 0,
    powerHist: [], // { t, w } — grafik power kanan
    powerLastPts: null, // pts terakhir yang di-commit — skip redraw data identik
    powerVisRaf: null, // handle rAF untuk fade-in grafik power
    gps: { watchId: null, active: false, last: null, speed: 0, heading: 0, accuracy: null, pos: null, moving: false, history: [] },
    trip: { distance: 0, maxSpeed: 0, movingMs: 0, lastTs: null },
    tripA: { distance: (Number(localStorage.getItem('tripAKm') || 0) || 0) * 1000 },
    tripB: { distance: (Number(localStorage.getItem('tripBKm') || 0) || 0) * 1000 },
    theme: localStorage.getItem('dashTheme') || 'dark',
    layoutMode: localStorage.getItem('dashLayout') || 'map',
    peakPower: 0,
    tileLayer: null,
    odoKm: Number(localStorage.getItem('odoKm') || 0) || 0,
    whPerKm: Number(localStorage.getItem('whPerKm') || 35) || 35,
    energyWh: 0,
    energyDistKm: 0,
    rideMode: localStorage.getItem('rideMode') || 'sports',
    demo: false,
    demoTimer: null,
    lang: localStorage.getItem('dashLang') || 'en',
  };

  /* ---------------- internationalization (i18n) ---------------- */
  function t(key) {
    const lang = state.lang || 'en';
    const dict = (window.I18N && window.I18N[lang]) || (window.I18N && window.I18N.en) || {};
    return dict[key] !== undefined ? dict[key] : key;
  }

  function setLanguage(lang, silent) {
    if (!window.I18N || !window.I18N[lang]) lang = 'en';
    state.lang = lang;
    try { localStorage.setItem('dashLang', lang); } catch (e) {}
    document.documentElement.setAttribute('lang', lang);

    const tag = $('#langTag');
    if (tag) tag.textContent = lang.toUpperCase();

    // Update all static data-i18n DOM elements
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const k = el.getAttribute('data-i18n');
      const val = t(k);
      if (val) el.textContent = val;
    });

    // Refresh dynamic tags
    const lTag = $('#layoutTag');
    if (lTag) lTag.textContent = state.layoutMode === 'telemetry' ? t('noMap') : t('withMap');
    const tTag = $('#themeTag');
    if (tTag) tTag.textContent = state.theme === 'light' ? t('light') : t('dark');
    const dTag = $('#demoTag');
    if (dTag) dTag.textContent = state.demo ? t('on') : t('off');
    const fTag = $('#followTag');
    if (fTag) fTag.textContent = state.follow ? t('on') : t('off');

    // Refresh controls button texts
    syncGpsButton();
    const cl = $('#connectLabel');
    if (cl) {
      cl.textContent = state.bmsStatus === 'connected' ? t('disconnectBms') : t('connectBms');
    }
    const bn = $('#bmsName');
    if (bn && (!state.info || !state.info.name)) {
      bn.textContent = state.bmsStatus === 'connected' ? t('bmsConnected') : t('bmsNotConnected');
    }

    // Refresh settings table if loaded
    if (state.info) renderInfo(state.info);
    if (state.settings) renderSettings(state.settings);

    const histV = $('#cpAlertHistoryView');
    if (histV && !histV.hidden) renderAlertHistory(currentHistFilter);

    if (!silent) toast(t('toastLangChanged'));
  }

  function toggleLanguage() {
    const langs = ['en', 'id'];
    const idx = langs.indexOf(state.lang);
    const next = langs[(idx + 1) % langs.length];
    setLanguage(next, false);
  }

  window.setDashboardLanguage = setLanguage;
  window.toggleDashboardLanguage = toggleLanguage;

  /* ---------------- helpers ---------------- */
  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const r = (d) => (d * Math.PI) / 180;
    const dLat = r(lat2 - lat1);
    const dLon = r(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function bearing(lat1, lon1, lat2, lon2) {
    const r = (d) => (d * Math.PI) / 180;
    const y = Math.sin(r(lon2 - lon1)) * Math.cos(r(lat2));
    const x = Math.cos(r(lat1)) * Math.sin(r(lat2)) -
      Math.sin(r(lat1)) * Math.cos(r(lat2)) * Math.cos(r(lon2 - lon1));
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  }

  function formatDuration(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(sec).padStart(2, '0');
    return h > 0 ? h + ':' + mm + ':' + ss : mm + ':' + ss;
  }

  function formatDate(yymmdd) {
    if (!yymmdd || yymmdd.length !== 6) return yymmdd || '—';
    return '20' + yymmdd.slice(0, 2) + '-' + yymmdd.slice(2, 4) + '-' + yymmdd.slice(4, 6);
  }

  let toastTimer;
  function toast(msg) {
    const el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2500);
  }

  function setPill(id, cls, label) {
    const el = $('#' + id + 'Pill');
    if (!el) return;
    el.className = 'cp-dot ' + cls;
  }

  function mapConfig() {
    return (typeof window !== 'undefined' && window.DASH_CONFIG) || {};
  }

  /* ---------------- map ---------------- */
  function buildSpeedTicks() {
    const g = $('#speedTicks');
    if (!g) return;
    const NS = 'http://www.w3.org/2000/svg';
    g.innerHTML = '';
    for (let v = 0; v <= 90; v += 10) {
      const pct = v / MAX_KMH;
      const angle = (-135 + pct * 270) * Math.PI / 180;
      const r = 72;
      const x = 100 + r * Math.sin(angle);
      const y = 100 - r * Math.cos(angle);
      const t = document.createElementNS(NS, 'text');
      t.setAttribute('x', x.toFixed(1));
      t.setAttribute('y', y.toFixed(1));
      t.textContent = String(v);
      g.appendChild(t);
    }
  }

  function initMap() {
    if (typeof L === 'undefined') return;
    const map = L.map('map', {
      zoomControl: false,
      attributionControl: false,
      preferCanvas: true,
    }).setView([-6.2088, 106.8456], 17);

    const cfg = mapConfig();
    const isLight = state.theme === 'light';
    const initialTileUrl = isLight
      ? (cfg.tileUrlLight || 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png?key=cb1_53nv_1_36016476114a28756464cdd2')
      : (cfg.tileUrlDark || cfg.tileUrl || 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?key=cb1_53nv_1_36016476114a28756464cdd2');
    state.tileLayer = L.tileLayer(initialTileUrl, {
      attribution: cfg.tileAttribution || '&copy; OpenStreetMap &copy; CARTO',
      subdomains: 'abcd',
      maxZoom: 18,
      detectRetina: true,
    }).addTo(map);

    state.map = map;
    state.trail = L.polyline([], {
      color: '#35b6f0', weight: 4, opacity: 0.85, lineJoin: 'round', lineCap: 'round',
    }).addTo(map);
    state.routeLine = L.polyline([], {
      color: '#35b6f0', weight: 5, opacity: 0.95, lineJoin: 'round', lineCap: 'round',
    }).addTo(map);

    const icon = L.divIcon({
      className: 'bike-marker-wrap',
      html: '<span class="arrow">▲</span>',
      iconSize: [46, 46],
      iconAnchor: [23, 23],
    });

    state.marker = L.marker([-6.2088, 106.8456], { icon, zIndexOffset: 1000 }).addTo(map);
    state.marker.setOpacity(0);

    setTimeout(() => { try { map.invalidateSize(); } catch (e) {} }, 120);
  }

  function updateMap(lat, lon, heading, moving, accuracy) {
    if (!state.map) return;
    if (!state.gps.last) {
      // GPS pertama masuk: paksa Leaflet hitung ulang ukuran container
      // (bug Safari: tile hilang setelah setView kalau size belum update).
      requestAnimationFrame(() => {
        try { state.map.invalidateSize({ pan: false }); } catch (e) { /* abaikan */ }
      });
    }
    const ll = [lat, lon];
    state.marker.setLatLng(ll);
    state.marker.setOpacity(1);

    const el = state.marker.getElement();
    if (el) {
      const arrow = el.querySelector('.arrow');
      if (arrow) arrow.style.transform = 'rotate(' + heading + 'deg)';
    }

    // Trail (garis cyan) sementara: dinonaktifkan — request user "dihapus".
    if (moving && state.trailEnabled) {
      const pts = state.trail.getLatLngs();
      const last = pts.length ? pts[pts.length - 1] : null;
      const minGap = Math.max(3, (accuracy || 0) * 0.5);
      if (!last || last.distanceTo(L.latLng(lat, lon)) > minGap) {
        state.trail.addLatLng(ll);
        state.trailPts++;
        if (state.trailPts > 6000) {
          const trimmed = state.trail.getLatLngs().slice(-5000);
          state.trail.setLatLngs(trimmed);
          state.trailPts = trimmed.length;
        }
      }
    }

    if (state.follow) {
      const targetZoom = Math.max(state.map.getZoom(), 17);
      state.map.setView(ll, targetZoom, { animate: true, duration: 0.4 });
    }
  }

  /* Navigasi sudah dihapus di tampilan baru — peta hanya background. */

  /* ---------------- speed / trip ---------------- */
  function updateSpeed(kmh) {
    const shown = clamp(kmh * SPEED_MULT, 0, 999);
    const el = $('#speed');
    if (el) el.textContent = String(Math.round(shown));
    const telEl = $('#telSpeed');
    if (telEl) telEl.textContent = String(Math.round(shown));
    const pct = clamp(shown / MAX_KMH, 0, 1);
    const gaugeArc = $('#gaugeArc');
    if (gaugeArc && gaugeArc.style) gaugeArc.style.strokeDashoffset = String(GAUGE_LEN * (1 - pct));
    const needle = $('#gaugeNeedle');
    if (needle && needle.style) needle.style.transform = 'rotate(' + (-135 + pct * 270) + 'deg)';
  }

  function updateHeading(heading, accuracy, moving) {
    const isEn = (state.lang || 'en') !== 'id';
    const dirsEn = ['N (North)', 'NE (North-East)', 'E (East)', 'SE (South-East)', 'S (South)', 'SW (South-West)', 'W (West)', 'NW (North-West)'];
    const dirsId = ['U (Utara)', 'TL (Timur Laut)', 'T (Timur)', 'TG (Tenggara)', 'S (Selatan)', 'BD (Barat Daya)', 'B (Barat)', 'BL (Barat Laut)'];
    const dir = (isEn ? dirsEn : dirsId)[Math.round(heading / 45) % 8];
    const shortDir = (isEn ? ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] : ['U', 'TL', 'T', 'TG', 'S', 'BD', 'B', 'BL'])[Math.round(heading / 45) % 8];
    const ht = $('#headingText'); if (ht) ht.textContent = moving ? shortDir : (isEn ? 'STOP' : 'BERHENTI');
    const th = $('#telHeading'); if (th) th.textContent = moving ? (dir + ' · ' + Math.round(heading) + '°') : (isEn ? 'STOPPED' : 'BERHENTI');
  }

  function updateTrip() {
    const avg = state.trip.movingMs > 0
      ? (state.trip.distance / (state.trip.movingMs / 1000)) * 3.6
      : 0;
    const distEl = $('#tripDist'); if (distEl) distEl.textContent = (state.trip.distance / 1000).toFixed(2);
    const distPEl = $('#tripDistPanel'); if (distPEl) distPEl.textContent = (state.trip.distance / 1000).toFixed(2) + ' km';
    const tripAEl = $('#tripA'); if (tripAEl) tripAEl.textContent = (state.tripA.distance / 1000).toFixed(1);
    const tripBEl = $('#tripB'); if (tripBEl) tripBEl.textContent = (state.tripB.distance / 1000).toFixed(1);
    const tripAPanel = $('#tripAPanel'); if (tripAPanel) tripAPanel.textContent = (state.tripA.distance / 1000).toFixed(2) + ' km';
    const tripBPanel = $('#tripBPanel'); if (tripBPanel) tripBPanel.textContent = (state.tripB.distance / 1000).toFixed(2) + ' km';
    const telTripA = $('#telTripA'); if (telTripA) telTripA.textContent = (state.tripA.distance / 1000).toFixed(1);
    const telTripB = $('#telTripB'); if (telTripB) telTripB.textContent = (state.tripB.distance / 1000).toFixed(1);
    const telOdo = $('#telOdo'); if (telOdo) telOdo.textContent = Math.round(state.odoKm).toLocaleString('en-US');
    const telMax = $('#telTripMax'); if (telMax) telMax.textContent = String(Math.round(state.trip.maxSpeed));
    const telAvg = $('#telTripAvg'); if (telAvg) telAvg.textContent = String(Math.round(avg));
    const telTime = $('#telTime'); if (telTime) telTime.textContent = formatDuration(state.trip.movingMs);
    const telWh = $('#telWh'); if (telWh) telWh.textContent = String(Math.round(state.whPerKm));
    const maxEl = $('#tripMax'); if (maxEl) maxEl.textContent = String(Math.round(state.trip.maxSpeed));
    const avgEl = $('#tripAvg'); if (avgEl) avgEl.textContent = String(Math.round(avg));
    const timeEl = $('#tripTime'); if (timeEl) timeEl.textContent = formatDuration(state.trip.movingMs) + ' min';
    const odoEl = $('#odo');
    if (odoEl) odoEl.textContent = Math.round(state.odoKm).toLocaleString('en-US');
    const avgWhEl = $('#avgWh');
    if (avgWhEl) avgWhEl.textContent = String(Math.round(state.whPerKm));
    const tripWhPanel = $('#tripWhPanel');
    if (tripWhPanel) tripWhPanel.textContent = Math.round(state.whPerKm) + ' Wh/km';
  }

  function addDistance(meters) {
    if (meters <= 0) return;
    state.trip.distance += meters;
    state.tripA.distance += meters;
    state.tripB.distance += meters;
    state.odoKm += meters / 1000;
  }

  let odoTimer = 0;
  function persistOdo() {
    odoTimer++;
    if (odoTimer % 10 === 0 || state.trip.movingMs === 0) {
      try {
        localStorage.setItem('odoKm', String(state.odoKm));
        localStorage.setItem('tripAKm', String(state.tripA.distance / 1000));
        localStorage.setItem('tripBKm', String(state.tripB.distance / 1000));
      } catch (e) { /* ignore */ }
    }
  }

  function resetTripA() {
    state.tripA.distance = 0;
    try { localStorage.setItem('tripAKm', '0'); } catch (e) {}
    updateTrip();
    toast(t('toastTripAReset'));
  }

  function resetTripB() {
    state.tripB.distance = 0;
    try { localStorage.setItem('tripBKm', '0'); } catch (e) {}
    updateTrip();
    toast(t('toastTripBReset'));
  }

  function resetTrip() {
    state.trip.distance = 0;
    state.tripA.distance = 0;
    state.tripB.distance = 0;
    state.trip.maxSpeed = 0;
    state.trip.movingMs = 0;
    state.trip.lastTs = null;
    try {
      localStorage.setItem('tripAKm', '0');
      localStorage.setItem('tripBKm', '0');
    } catch (e) {}
    if (state.trail) { state.trail.setLatLngs([]); state.trailPts = 0; }
    updateTrip();
    toast(t('toastAllTripsReset'));
  }

  function setTheme(theme) {
    state.theme = theme;
    try { localStorage.setItem('dashTheme', theme); } catch (e) {}
    document.documentElement.setAttribute('data-theme', theme);
    const tag = $('#themeTag');
    if (tag) tag.textContent = theme === 'light' ? t('light') : t('dark');
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) metaTheme.setAttribute('content', theme === 'light' ? '#ebf1f6' : '#070b10');
    const cfg = mapConfig();
    if (state.tileLayer) {
      const url = theme === 'light'
        ? (cfg.tileUrlLight || 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png?key=cb1_53nv_1_36016476114a28756464cdd2')
        : (cfg.tileUrlDark || cfg.tileUrl || 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?key=cb1_53nv_1_36016476114a28756464cdd2');
      state.tileLayer.setUrl(url);
    }
  }

  function toggleTheme() {
    const next = state.theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    toast(next === 'light' ? t('toastLightMode') : t('toastDarkMode'));
  }

  function setLayoutMode(mode) {
    state.layoutMode = mode;
    try { localStorage.setItem('dashLayout', mode); } catch (e) {}
    const dash = document.querySelector('.dash');
    if (dash) {
      dash.classList.toggle('mode-telemetry', mode === 'telemetry');
      dash.classList.toggle('mode-map', mode !== 'telemetry');
    }
    const tag = $('#layoutTag');
    if (tag) {
      tag.textContent = mode === 'telemetry' ? t('noMap') : t('withMap');
      tag.classList.toggle('active', mode === 'telemetry');
    }
    if (mode === 'map' && state.map) {
      setTimeout(() => { try { state.map.invalidateSize(); } catch (e) {} }, 80);
    }
  }

  function toggleLayoutMode() {
    const next = state.layoutMode === 'telemetry' ? 'map' : 'telemetry';
    setLayoutMode(next);
    toast(next === 'telemetry' ? t('toastTelemetryMode') : t('toastMapMode'));
  }

  /* ---------------- GPS ---------------- */
  function startGps() {
    if (state.gps.watchId != null) return;
    if (!('geolocation' in navigator)) {
      toast('GPS tidak didukung browser ini');
      return;
    }
    setPill('gps', 'warn', 'GPS…');
    state.gps.watchId = navigator.geolocation.watchPosition(onPosition, onGpsError, {
      enableHighAccuracy: true,
      maximumAge: 1000,
      timeout: 20000,
    });
    state.gps.active = true;
    if (window.AlertEngine) window.AlertEngine.setGpsTracking(true);
    syncGpsButton();
    requestWakeLock();
    toast('GPS aktif — cari sinyal...');
  }

  function stopGps() {
    if (state.gps.watchId != null) {
      navigator.geolocation.clearWatch(state.gps.watchId);
      state.gps.watchId = null;
    }
    state.gps.active = false;
    if (window.AlertEngine) window.AlertEngine.setGpsTracking(false);
    state.gps.speed = 0;
    state.gps.moving = false;
    state.gps.history = [];
    setPill('gps', 'off', 'GPS');
    updateSpeed(0);
    updateHeading(state.gps.heading, state.gps.accuracy, false);
    syncGpsButton();
    releaseWakeLock();
    toast('GPS dimatikan');
  }

  function syncGpsButton() {
    const btn = $('#gpsBtn');
    if (btn) btn.classList.toggle('active', state.gps.active);
    const lbl = $('#gpsLabel');
    if (lbl) lbl.textContent = state.gps.active ? t('stopTracking') : t('startTracking');
    const arrow = $('#gpsArrow');
    if (arrow) arrow.classList.toggle('on', state.gps.active);
    const tag = $('#followTag');
    if (tag) {
      tag.textContent = state.follow ? t('on') : t('off');
      tag.classList.toggle('active', state.follow);
    }
  }

  function onGpsError(err) {
    let msg = 'GPS error';
    if (err.code === 1) msg = 'Izin lokasi ditolak';
    else if (err.code === 2) msg = 'Lokasi tidak tersedia';
    else if (err.code === 3) msg = 'GPS timeout';
    setPill('gps', 'err', 'GPS');
    toast(msg + ' — cek izin lokasi Chrome');
    if (state.gps.watchId != null) {
      navigator.geolocation.clearWatch(state.gps.watchId);
      state.gps.watchId = null;
    }
    state.gps.active = false;
    if (window.AlertEngine) window.AlertEngine.setGpsTracking(false);
    syncGpsButton();
    releaseWakeLock();
  }

  function onPosition(pos) {
    const c = pos.coords;
    const t = pos.timestamp || Date.now();
    const lat = c.latitude;
    const lon = c.longitude;
    const last = state.gps.last;
    const accuracy = typeof c.accuracy === 'number' ? c.accuracy : null;
    const goodFix = accuracy == null || accuracy <= ACCURACY_MAX;

    let raw = (typeof c.speed === 'number' && isFinite(c.speed) && c.speed >= 0) ? c.speed : null;

    // Keep a short position history so we can measure real displacement over
    // ~5 s instead of trusting a single noisy fix.
    const hist = state.gps.history;
    hist.push({ lat, lon, t });
    while (hist.length > 14) hist.shift();
    while (hist.length && t - hist[0].t > 12000) hist.shift();

    let ref = null;
    let best = Infinity;
    for (let i = 0; i < hist.length; i++) {
      const age = t - hist[i].t;
      if (age < 2500 || age > 8000) continue;
      const score = Math.abs(age - 5000);
      if (score < best) { best = score; ref = hist[i]; }
    }
    const windowDt = ref ? (t - ref.t) / 1000 : 0;
    const windowD = ref ? haversine(ref.lat, ref.lon, lat, lon) : 0;
    const stillRadius = Math.max(5, (accuracy || 0) * 0.8);
    const windowStill = ref != null && windowDt >= 2.5 && windowD < stillRadius;

    if (raw == null && ref && windowDt >= 2.5 && goodFix) {
      raw = windowD > stillRadius ? windowD / windowDt : 0;
    }
    if (raw == null) raw = 0;
    if (raw > 60) raw = 0; // spike filter (216+ km/h is not a bike)
    if (!goodFix) raw = state.gps.speed; // don't trust speed on a bad fix
    if (windowStill) raw = 0; // standing still: ignore speed-field noise too

    // Stationary deadband: standing still, GPS noise is usually 0.3–1.5 m/s.
    if (raw < SPEED_STOP) raw = 0;

    if (raw === 0) {
      // Decay fast so the gauge drops to 0 within ~2 fixes.
      state.gps.speed *= 0.45;
      if (state.gps.speed < 0.25) state.gps.speed = 0;
    } else {
      state.gps.speed = state.gps.speed * 0.5 + raw * 0.5;
    }

    let kmh = state.gps.speed * 3.6;
    if (kmh < 1.5) kmh = 0;
    if (window.AlertEngine) {
      window.AlertEngine.onGpsFix(pos.timestamp || Date.now());
      window.AlertEngine.checkSpeed(kmh);
    }
    const moving = state.gps.speed >= SPEED_STOP * 0.7;

    // Only update the compass while moving; otherwise the arrow spins from noise.
    let heading = state.gps.heading;
    if (moving) {
      if (typeof c.heading === 'number' && isFinite(c.heading)) heading = c.heading;
      else if (last) heading = bearing(last.lat, last.lon, lat, lon);
    }

    state.gps.heading = heading;
    state.gps.accuracy = accuracy;
    state.gps.pos = { lat, lon };
    state.gps.moving = moving;
    setPill('gps', 'on', 'GPS');

    // Trip distance is integrated from the filtered speed, not raw position jumps,
    // so standing still never adds kilometres.
    if (last) {
      const dt = (t - last.t) / 1000;
      if (dt > 0 && dt < 15 && goodFix && moving) {
        const stepped = state.gps.speed * Math.min(dt, 5);
        addDistance(stepped);
        state.trip.movingMs += Math.min(dt, 5) * 1000;
        persistOdo();
        learnConsumption(state.bmsData, stepped);
      }
    }
    if (kmh > state.trip.maxSpeed) state.trip.maxSpeed = kmh;
    state.trip.lastTs = t;
    state.gps.last = { lat, lon, t };

    updateSpeed(kmh);
    updateHeading(heading, accuracy, moving);
    updateTrip();
    updateMap(lat, lon, heading, moving, accuracy);
  }

  /* ---------------- BMS ---------------- */
  function initBms() {
    if (typeof JKBms === 'undefined') return;
    state.bms = new JKBms({
      onData: onBmsData,
      onStatus: onBmsStatus,
      onError: (e) => console.warn('BMS parse error', e),
    });
    const savedName = localStorage.getItem('volt_bms_device_name') || 'Volt BMS';
    const bpn = $('#bmsPanelName'); if (bpn) bpn.textContent = savedName;
  }

  function onBmsStatus(status, text) {
    const prevStatus = state.bmsStatus;
    state.bmsStatus = status;
    if (window.AlertEngine) window.AlertEngine.onBmsStatus(status);
    const displayName = text || localStorage.getItem('volt_bms_device_name') || 'Volt BMS';
    if (status === 'connected') {
      setPill('bms', 'on', 'BMS');
      const bn = $('#bmsName'); if (bn) bn.textContent = displayName;
      const bpn = $('#bmsPanelName'); if (bpn) bpn.textContent = displayName;
      const cl = $('#connectLabel'); if (cl) cl.textContent = t('disconnectBms') || 'Disconnect';
      if (prevStatus !== 'connected') {
        toast((t('toastBmsConnected') || 'BMS terhubung: ') + displayName);
      }
    } else if (status === 'connecting') {
      setPill('bms', 'warn', 'BMS…');
    } else if (status === 'error') {
      setPill('bms', 'err', 'BMS');
      toast((t('toastBmsError') || 'BMS error: ') + (text || ''));
    } else {
      setPill('bms', 'off', 'BMS');
      const bn = $('#bmsName'); if (bn) bn.textContent = t('bmsNotConnected') || 'belum terhubung';
      const cl2 = $('#connectLabel'); if (cl2) cl2.textContent = t('connectBms') || 'Connect BMS';
    }
  }

  /* ---------------- Universal Bluetooth Scanner Modal ---------------- */
  const bleScanState = {
    devices: new Map(),
    filterBms: true,
    renderPending: false
  };

  function toggleBleFilter() {
    bleScanState.filterBms = !bleScanState.filterBms;
    const btn = $('#bleFilterBmsBtn');
    const txt = $('#bleFilterText');
    if (btn) btn.classList.toggle('active', bleScanState.filterBms);
    if (txt) txt.textContent = bleScanState.filterBms ? 'BMS ONLY' : 'ALL BLE';
    renderBleDeviceList();
  }

  async function openBleModal() {
    if (!state.bms || !state.bms.isCapacitor) {
      connectBmsWeb();
      return;
    }

    const modal = $('#bleModal');
    if (!modal) return;
    modal.removeAttribute('hidden');

    bleScanState.devices.clear();
    const btn = $('#bleFilterBmsBtn');
    const txt = $('#bleFilterText');
    if (btn) btn.classList.toggle('active', bleScanState.filterBms);
    if (txt) txt.textContent = bleScanState.filterBms ? 'BMS ONLY' : 'ALL BLE';

    renderBleDeviceList();
    startBleScan();
  }

  function closeBleModal() {
    const modal = $('#bleModal');
    if (modal) modal.setAttribute('hidden', '');
    if (state.bms && state.bms.isCapacitor) {
      state.bms.stopNativeScan().catch(() => {});
    }
    const dot = $('#bleScanDot');
    if (dot) dot.style.display = 'none';
  }

  async function startBleScan() {
    if (!state.bms || !state.bms.isCapacitor) return;
    const dot = $('#bleScanDot');
    if (dot) dot.style.display = 'block';

    const savedId = localStorage.getItem('volt_bms_device_id');
    const savedName = localStorage.getItem('volt_bms_device_name');
    if (savedId) {
      bleScanState.devices.set(savedId, {
        deviceId: savedId,
        name: savedName || 'Volt BMS',
        rssi: -62,
        isLastPaired: true,
        lastSeen: Date.now()
      });
      renderBleDeviceList();
    }

    try {
      await state.bms.startNativeScan((dev) => {
        const id = dev.deviceId;
        const existing = bleScanState.devices.get(id);
        const isLast = (savedId && id === savedId);

        bleScanState.devices.set(id, {
          deviceId: id,
          name: dev.name || (existing && existing.name) || '',
          rssi: dev.rssi !== null ? dev.rssi : (existing ? existing.rssi : -75),
          isLastPaired: isLast,
          lastSeen: Date.now()
        });

        if (!bleScanState.renderPending) {
          bleScanState.renderPending = true;
          requestAnimationFrame(() => {
            renderBleDeviceList();
            bleScanState.renderPending = false;
          });
        }
      });
    } catch (err) {
      console.warn('startNativeScan error:', err);
      toast('Scan error: ' + (err.message || err));
      if (dot) dot.style.display = 'none';
    }
  }

  function renderBleDeviceList() {
    const listEl = $('#bleDeviceList');
    const emptyEl = $('#bleEmptyState');
    if (!listEl) return;

    const allDevices = Array.from(bleScanState.devices.values());

    const filtered = allDevices.filter((d) => {
      if (!bleScanState.filterBms) return true;
      const lower = (d.name || '').toLowerCase();
      return (
        lower.includes('jk') ||
        lower.includes('bms') ||
        lower.includes('cangki') ||
        lower.includes('sepeda') ||
        lower.includes('volt') ||
        lower.includes('daly') ||
        lower.includes('ant') ||
        lower.includes('smart') ||
        d.isLastPaired
      );
    });

    filtered.sort((a, b) => {
      if (a.isLastPaired && !b.isLastPaired) return -1;
      if (!a.isLastPaired && b.isLastPaired) return 1;
      return (b.rssi || -99) - (a.rssi || -99);
    });

    if (filtered.length === 0) {
      listEl.innerHTML = '';
      if (emptyEl) {
        emptyEl.style.display = 'flex';
        const txt = emptyEl.querySelector('.ble-empty-text');
        if (txt) {
          txt.textContent = bleScanState.filterBms
            ? (t('bleSearchingBms') || 'Mencari BMS... (Ketuk "BMS ONLY" untuk melihat semua BLE)')
            : (t('bleSearchingTitle') || 'Mencari perangkat Bluetooth di sekitar...');
        }
      }
      return;
    }

    if (emptyEl) emptyEl.style.display = 'none';

    let html = '';
    filtered.forEach((d) => {
      const displayName = d.name || ('BMS ' + d.deviceId.slice(-5));
      const sub = d.deviceId + (d.rssi ? ' · ' + d.rssi + ' dBm' : '');

      html += `
        <div class="ble-row" data-id="${escapeHtml(d.deviceId)}">
          <div class="ble-row-left">
            <svg class="ble-row-ic" viewBox="0 0 24 24"><path d="M7 7l10 10-5 5V2l5 5L7 17"/></svg>
            <div class="ble-row-info">
              <span class="ble-row-name">${escapeHtml(displayName)}</span>
              <span class="ble-row-sub">${escapeHtml(sub)}</span>
            </div>
          </div>
          <button class="ble-row-btn" type="button">
            <span>${t('bleConnect') || 'CONNECT'}</span>
          </button>
        </div>
      `;
    });

    listEl.innerHTML = html;

    listEl.querySelectorAll('.ble-row').forEach((item) => {
      item.addEventListener('click', async () => {
        const devId = item.getAttribute('data-id');
        const devObj = bleScanState.devices.get(devId);
        if (!devObj) return;

        item.classList.add('connecting');
        const btnText = item.querySelector('.ble-row-btn span');
        if (btnText) btnText.textContent = t('bleConnecting') || 'CONNECTING...';

        try {
          const finalName = devObj.name || ('BMS ' + devObj.deviceId.slice(-5));
          await state.bms.connectToDevice({
            deviceId: devObj.deviceId,
            name: finalName
          });
          closeBleModal();
        } catch (err) {
          console.error('Connection failed:', err);
          item.classList.remove('connecting');
          if (btnText) btnText.textContent = t('bleConnect') || 'CONNECT';
          toast((t('toastConnectFailed') || 'Gagal terhubung: ') + (err.message || err));
        }
      });
    });
  }

  async function connectBmsWeb() {
    if (!state.bms) return;
    try {
      await state.bms._connectWebBluetooth(true);
    } catch (e) {
      const name = (e && e.name) || '';
      if (name === 'NotFoundError') {
        toast('Pencarian dibatalkan atau perangkat tidak dipilih.');
      } else if (name === 'SecurityError') {
        toast('Diblokir browser. Pastikan buka via HTTPS atau localhost.');
      } else {
        toast((t('toastConnectFailed') || 'Gagal connect: ') + ((e && e.message) || e));
      }
    }
  }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, (m) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[m]);
  }

  function onBmsData(d) {
    if (!d) return;
    if (d.type === 'telemetry') renderTelemetry(d);
    else if (d.type === 'info' || d.type === 'deviceInfo') renderInfo(d);
    else if (d.type === 'settings') renderSettings(d);
  }

  /* ---------------- range estimate ---------------- */
  // Learn real energy consumption (Wh/km) from BMS power + GPS distance,
  // then show remaining range in km. Falls back to 35 Wh/km.
  function learnConsumption(d, meters) {
    if (!d || meters <= 0) return;
    const wh = Math.abs(d.power || 0) / 3600 / 3.6 * meters; // W → Wh over stepped distance
    state.energyWh += wh;
    state.energyDistKm += meters / 1000;
    if (state.energyDistKm >= 0.5) {
      const measured = state.energyWh / state.energyDistKm;
      if (measured > 5 && measured < 150) {
        state.whPerKm = state.whPerKm * 0.7 + measured * 0.3;
        try { localStorage.setItem('whPerKm', String(state.whPerKm)); } catch (e) { /* ignore */ }
      }
      state.energyWh = 0;
      state.energyDistKm = 0;
    }
  }

  function rangeKm(d) {
    if (!d) return null;
    const remainWh = d.remainAh * d.packV;
    return remainWh / Math.max(10, state.whPerKm);
  }

  /* ---------------- grafik power ---------------- */
  const POWER_ANIM_MS = 320;

  function drawPowerGraph() {
    const line = $('#powerLine');
    const area = $('#powerArea');
    const dot = $('#powerDotEl');
    if (!line || !area) return;
    const W = 260;
    const H = 150;
    const hist = state.powerHist.slice(-70);
    if (!hist.length) {
      line.setAttribute('points', '');
      area.setAttribute('d', '');
      if (dot) dot.setAttribute('cx', -10);
      return;
    }
    let maxAbs = 500;
    hist.forEach((p) => { maxAbs = Math.max(maxAbs, Math.abs(p.w)); });
    maxAbs = Math.ceil((maxAbs * 1.1) / 100) * 100;
    const xFor = (i) => (hist.length === 1 ? W : (i / (hist.length - 1)) * (W - 4) + 2);
    const yFor = (w) => {
      const norm = clamp(Math.abs(w) / maxAbs, 0, 1);
      return H - (norm * (H * 0.8) + 4);
    };
    const toPtsStr = hist.map((p, i) => xFor(i).toFixed(1) + ',' + yFor(p.w).toFixed(1)).join(' ');
    const toArr = hist.map((p, i) => [xFor(i), yFor(p.w)]);
    const toDot = { cx: xFor(hist.length - 1), cy: yFor(hist[hist.length - 1].w) };
    if (state.powerLastPts === toPtsStr) return;
    state.powerLastPts = toPtsStr;
    const pts = toPtsStr;
    const lastX = toDot.cx;
    const lastY = toDot.cy;

    const easeOut = (t) => 1 - Math.pow(1 - t, 3);
    const commit = (arr) => {
      const pStr = arr.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
      line.setAttribute('points', pStr);
      area.setAttribute('d', 'M' + arr[0][0].toFixed(1) + ',' + arr[arr.length - 1][1].toFixed(1) + ' L' + pStr.replace(/ /g, ' L') + ' L' + arr[arr.length - 1][0].toFixed(1) + ',' + H + ' L' + arr[0][0].toFixed(1) + ',' + H + ' Z');
      if (dot) { dot.setAttribute('cx', arr[arr.length - 1][0]); dot.setAttribute('cy', arr[arr.length - 1][1]); }
    };

    // fade in grafik: opacity 0 → 1 (via CSS transition, pelan-pelan) — BUKAN animasi posisi
    line.style.opacity = '0';
    area.style.opacity = '0';
    if (dot) dot.style.opacity = '0';
    commit(toArr);
    state.powerVisRaf = requestAnimationFrame(() => {
      state.powerVisRaf = null;
      line.style.opacity = '1';
      area.style.opacity = '1';
      if (dot) dot.style.opacity = '1';
    });
  }

  function renderTelemetry(d) {
    state.bmsData = d;
    if (window.AlertEngine) window.AlertEngine.checkTelemetry(d);
    $('#vPack').textContent = fmt(d.packV, 2);
    $('#vCurrent').textContent = (d.current >= 0 ? '+' : '') + fmt(d.current, 2);
    $('#vPower').textContent = (d.power >= 0 ? '+' : '') + fmt(d.power, 0);
    $('#vSoc').textContent = d.soc;
    $('#vSoh').textContent = d.soh;
    $('#vRemain').textContent = fmt(d.remainAh, 2);
    $('#vNominal').textContent = fmt(d.nominalAh, 1);
    $('#vCycles').textContent = d.cycles;
    $('#vMosTemp').textContent = fmt(d.mosTemp, 1);
    $('#vTemps').textContent = fmt(d.t1, 1) + ' / ' + fmt(d.t2, 1);
    $('#vDelta').textContent = fmt(d.delta * 1000, 0);
    $('#vBalance').textContent = fmt(d.balanceA, 2);
    $('#vErrors').textContent = '0x' + d.errors.toString(16).toUpperCase().padStart(8, '0');
    $('#vMos').textContent = (d.chargeMos ? 'CHG' : '—') + ' / ' + (d.dischargeMos ? 'DIS' : '—');

    const socEl = $('#hudSoc'); if (socEl) socEl.textContent = d.soc + '%';
    const vEl = $('#hudV'); if (vEl) vEl.textContent = fmt(d.packV, 1);
    const aEl = $('#hudA');
    if (aEl) {
      if (d.current < -0.1) aEl.textContent = fmt(d.current, 1) + ' A';
      else if (d.current > 0.1) aEl.textContent = '+' + fmt(d.current, 1) + ' A';
      else aEl.textContent = '0.0 A';
    }
    const wEl = $('#hudW');
    if (wEl) {
      if (d.power < -5) wEl.textContent = fmt(d.power, 0) + ' W';
      else if (d.power > 5) wEl.textContent = '+' + fmt(d.power, 0) + ' W';
      else wEl.textContent = '0 W';
    }

    // Telemetry Cockpit (No Map) live updates
    const telV = $('#telV'); if (telV) telV.textContent = fmt(d.packV, 1);
    const telA = $('#telA');
    if (telA) {
      if (d.current < -0.1) telA.textContent = fmt(d.current, 1);
      else if (d.current > 0.1) telA.textContent = '+' + fmt(d.current, 1);
      else telA.textContent = '0.0';
    }
    const telW = $('#telW');
    if (telW) {
      if (d.power < -5) telW.textContent = fmt(d.power, 0);
      else if (d.power > 5) telW.textContent = '+' + fmt(d.power, 0);
      else telW.textContent = '0';
    }
    const telFlow = $('#telFlow');
    if (telFlow) {
      if (d.power < -10 || d.current < -0.3) {
        telFlow.textContent = 'DISCHARGE';
        telFlow.className = 'tc-tag discharge';
      } else if (d.power > 10 || d.current > 0.3) {
        telFlow.textContent = '⚡ CHARGING';
        telFlow.className = 'tc-tag charging';
      } else {
        telFlow.textContent = 'STANDBY';
        telFlow.className = 'tc-tag';
      }
    }
    const absW = Math.abs(d.power || 0);
    if (absW > state.peakPower) state.peakPower = absW;
    const telPeak = $('#telPeak'); if (telPeak) telPeak.textContent = 'PEAK ' + Math.round(state.peakPower) + ' W';
    const telPBar = $('#telPowerBar'); if (telPBar) telPBar.style.width = clamp((absW / 1500) * 100, 2, 100) + '%';
    const telSoc = $('#telSoc'); if (telSoc) telSoc.textContent = d.soc;
    const telSocFill = $('#telSocFill'); if (telSocFill) telSocFill.style.width = clamp(d.soc, 0, 100) + '%';
    const telSoh = $('#telSoh'); if (telSoh) telSoh.textContent = 'SOH ' + d.soh + '%';
    const telDelta = $('#telDelta'); if (telDelta) telDelta.textContent = fmt(d.delta * 1000, 0);
    const telBalStatus = $('#telBalStatus');
    if (telBalStatus) telBalStatus.textContent = Math.abs(d.balanceA) > 0.05 ? 'BAL ' + fmt(Math.abs(d.balanceA), 1) + 'A' : 'BAL OFF';
    const telCellSpread = $('#telCellSpread');
    if (telCellSpread) telCellSpread.textContent = fmt(d.minV, 2) + ' / ' + fmt(d.maxV, 2) + ' V';
    const telMosTemp = $('#telMosTemp'); if (telMosTemp) telMosTemp.textContent = fmt(d.mosTemp, 0);
    const telBattTemp = $('#telBattTemp'); if (telBattTemp) telBattTemp.textContent = fmt(d.t1, 0) + ' / ' + fmt(d.t2, 0);
    const telCap = $('#telCap'); if (telCap) telCap.textContent = fmt(d.remainAh, 1) + ' / ' + fmt(d.nominalAh, 0);
    const telCycles = $('#telCycles'); if (telCycles) telCycles.textContent = String(d.cycles != null ? d.cycles : '--');
    const rkVal = rangeKm(d);
    const telRange = $('#telRange'); if (telRange) telRange.textContent = rkVal == null ? '-- km' : Math.max(0, Math.round(rkVal)) + ' km';
    const telBmsStatus = $('#telBmsStatus');
    if (telBmsStatus) {
      const bad = d.errors !== 0 || d.delta > 0.15 || (d.t1 > 60) || (d.mosTemp > 80);
      const warn = !bad && (d.delta > 0.08 || d.t1 > 45 || d.soc <= 15);
      telBmsStatus.textContent = bad ? 'CHECK' : warn ? 'WASPADA' : 'NORMAL';
      telBmsStatus.style.color = bad ? '#ff5d5d' : warn ? '#ffb703' : '#38f2a0';
    }
    const chgEl = $('#hudCharge'); if (chgEl) {
      if (d.power < -10 || d.current < -0.3) {
        chgEl.textContent = 'DISCHARGE';
        chgEl.className = 'charge-indicator discharge';
      } else if (d.power > 10 || d.current > 0.3) {
        chgEl.textContent = '⚡ CHARGING';
        chgEl.className = 'charge-indicator charging';
      } else {
        chgEl.textContent = 'STANDBY';
        chgEl.className = 'charge-indicator';
      }
    }
    const tEl = $('#hudTemp'); if (tEl) tEl.textContent = fmt(d.t1, 0) + ' °C';

    const battFill = $('#battFill');
    if (battFill) battFill.style.width = clamp(d.soc, 0, 100) + '%';

    // STATUS: OK / CHECK dari error + delta + suhu
    const stState = $('#statusState');
    if (stState) {
      const bad = d.errors !== 0 || d.delta > 0.15 || (d.t1 > 60) || (d.mosTemp > 80);
      const warn = !bad && (d.delta > 0.08 || d.t1 > 45 || d.soc <= 15);
      stState.textContent = bad ? 'CHECK' : warn ? 'WASPADA' : 'NORMAL';
      stState.className = bad ? 'teal bad' : warn ? 'teal warn' : 'teal';
    }

    // grafik power: simpan tiap telemetri (~2x/detik), gambar ulang
    state.powerHist.push({ t: d.ts || Date.now(), w: d.power });
    if (state.powerHist.length > 140) state.powerHist.shift();
    drawPowerGraph();

    const arc = $('#socArc');
    if (arc && arc.style) {
      arc.style.strokeDashoffset = String(SOC_LEN * (1 - clamp(d.soc, 0, 100) / 100));
      arc.style.stroke = d.soc <= 15 ? '#ff5d5d' : d.soc <= 30 ? '#ffb703' : '#35b6f0';
    }

    const rk = rangeKm(d);
    const rangeEl = $('#rangeBig');
    if (rangeEl) rangeEl.textContent = rk == null ? '-- km' : Math.max(0, Math.round(rk)) + ' km';
    const rangeArc = $('#rangeArc');
    if (rangeArc && rangeArc.style) {
      rangeArc.style.strokeDashoffset = String(SOC_LEN * (1 - clamp(rk || 0, 0, 100) / 100));
    }

    renderCells(d.cells, d.minV, d.maxV);
  }

  function renderCells(cells, minV, maxV) {
    if (!cells || !cells.length) return;
    const wrap = $('#cells');
    if (!wrap) return;
    if (wrap.children.length !== cells.length) {
      wrap.innerHTML = '';
      cells.forEach((_, i) => {
        const el = document.createElement('div');
        el.className = 'cell';
        el.innerHTML = '<i></i><span>' + (i + 1) + '</span>';
        wrap.appendChild(el);
      });
    }
    const avg = cells.reduce((a, b) => a + b, 0) / cells.length;
    const lo = 3.0;
    const hi = 4.2;
    cells.forEach((v, i) => {
      const el = wrap.children[i];
      if (!el) return;
      const bar = el.querySelector('i');
      const pct = clamp((v - lo) / (hi - lo), 0.04, 1);
      if (bar) bar.style.height = (pct * 100) + '%';
      const dev = v - avg;
      el.classList.toggle('bad', dev < -0.04);
      el.classList.toggle('low', dev >= -0.04 && dev < -0.015);
      el.title = 'Cell ' + (i + 1) + ': ' + v.toFixed(3) + ' V';
    });
    const sumEl = $('#cellSummary');
    if (sumEl) {
      sumEl.textContent =
        cells.length + 'S · ' + minV.toFixed(3) + '–' + maxV.toFixed(3) +
        ' V · Δ ' + ((maxV - minV) * 1000).toFixed(0) + ' mV';
    }
  }

  function renderKV(container, pairs) {
    container.innerHTML = '';
    pairs.forEach((pair) => {
      const row = document.createElement('div');
      row.className = 'kv';
      const k = document.createElement('span');
      k.className = 'k';
      k.textContent = pair[0];
      const v = document.createElement('span');
      v.className = 'v';
      v.textContent = pair[1];
      row.appendChild(k);
      row.appendChild(v);
      container.appendChild(row);
    });
  }

  function renderInfo(info) {
    if (!info) return;
    state.info = info;
    renderKV($('#deviceInfo'), [
      ['Model', info.vendor || info.model || 'JK-BMS'],
      ['Hardware', info.hw || info.hardware || '—'],
      ['Software', info.sw || info.software || '—'],
      ['Nama', info.name || info.deviceName || '—'],
      ['Serial', info.serial || '—'],
      ['Produksi', formatDate(info.mfg || info.mfgDate)],
    ]);
    if (info.name || info.deviceName) {
      const n = info.name || info.deviceName;
      const bn = $('#bmsName'); if (bn) bn.textContent = n;
      const brand = $('.brand-name'); if (brand) brand.textContent = n;
    }
  }

  function renderSettings(s) {
    if (!s) return;
    state.settings = s;
    const cellCount = s.cellCount ?? s.cellCountSetting;
    const nominalAh = s.nominalAh ?? s.nominalCapAh;
    const cellOVP = s.cellOVP ?? s.cellOvp;
    const cellOVPRec = s.cellOVPRecovery ?? s.cellOvpr;
    const cellUVP = s.cellUVP ?? s.cellUvp;
    const cellUVPRec = s.cellUVPRecovery ?? s.cellUvpr;
    const balTrig = s.balanceTrigger ?? s.balanceTriggerV;
    const balStart = s.balanceStartV ?? s.cellReqV;
    const maxBal = s.maxBalanceA ?? s.balanceMaxA;
    const chgOtp = s.chargeOTP ?? s.chargeOtp;
    const disOtp = s.dischargeOTP ?? s.dischargeOtp;
    const chgUtp = s.chargeUTP ?? s.chargeUtp;
    const disUtp = s.dischargeUTP ?? s.dischargeUtp;
    const mosOtp = s.mosOTP ?? s.mosOtp;
    const chgSw = s.chargeSwitch ?? s.chargeMosSwitch;
    const disSw = s.dischargeSwitch ?? s.dischargeMosSwitch;

    renderKV($('#settingsInfo'), [
      ['Jumlah sel', cellCount ? (cellCount + 'S') : '—'],
      ['Kapasitas nominal', typeof nominalAh === 'number' ? (fmt(nominalAh, 1) + ' Ah') : '—'],
      ['Max charge', typeof s.maxChargeA === 'number' ? (fmt(s.maxChargeA, 1) + ' A') : '—'],
      ['Max discharge', typeof s.maxDischargeA === 'number' ? (fmt(s.maxDischargeA, 1) + ' A') : '—'],
      ['Cell OVP', typeof cellOVP === 'number' ? (fmt(cellOVP, 3) + ' V') : '—'],
      ['Cell OVP recovery', typeof cellOVPRec === 'number' ? (fmt(cellOVPRec, 3) + ' V') : '—'],
      ['Cell UVP', typeof cellUVP === 'number' ? (fmt(cellUVP, 3) + ' V') : '—'],
      ['Cell UVP recovery', typeof cellUVPRec === 'number' ? (fmt(cellUVPRec, 3) + ' V') : '—'],
      ['Batas delta balance', typeof balTrig === 'number' ? (fmt(balTrig * 1000, 0) + ' mV') : '—'],
      ['Mulai balance', typeof balStart === 'number' ? (fmt(balStart, 3) + ' V') : '—'],
      ['Max arus balance', typeof maxBal === 'number' ? (fmt(maxBal, 2) + ' A') : '—'],
      ['Tegangan SOC 100%', typeof s.soc100V === 'number' ? (fmt(s.soc100V, 3) + ' V') : '—'],
      ['Tegangan SOC 0%', typeof s.soc0V === 'number' ? (fmt(s.soc0V, 3) + ' V') : '—'],
      ['Power off', typeof s.powerOffV === 'number' ? (fmt(s.powerOffV, 3) + ' V') : '—'],
      ['Charge OTP', typeof chgOtp === 'number' ? (fmt(chgOtp, 1) + ' °C') : '—'],
      ['Discharge OTP', typeof disOtp === 'number' ? (fmt(disOtp, 1) + ' °C') : '—'],
      ['Charge UTP', typeof chgUtp === 'number' ? (fmt(chgUtp, 1) + ' °C') : '—'],
      ['Discharge UTP', typeof disUtp === 'number' ? (fmt(disUtp, 1) + ' °C') : '—'],
      ['MOS OTP', typeof mosOtp === 'number' ? (fmt(mosOtp, 1) + ' °C') : '—'],
      ['Saklar charge / discharge', (chgSw ? 'ON' : 'OFF') + ' / ' + (disSw ? 'ON' : 'OFF')],
      ['Saklar balancer', s.balancerSwitch ? 'ON' : 'OFF'],
    ]);
  }

  /* ---------------- wake lock ---------------- */
  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        state.wakeLock = await navigator.wakeLock.request('screen');
        state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
      }
    } catch (e) { /* ignore */ }
  }

  function releaseWakeLock() {
    if (state.wakeLock) {
      state.wakeLock.release().catch(() => {});
      state.wakeLock = null;
    }
  }

  /* ---------------- UI wiring ---------------- */
  function switchView(name) {
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === name + 'View'));
    const panel = $('#settingsPanel');
    if (panel) panel.classList.remove('cp-open');
    if (name === 'ride' && state.map) setTimeout(() => state.map.invalidateSize(), 60);
    if (name === 'bms' && state.bms && state.bms.connected) {
      if (typeof state.bms.requestDeviceInfo === 'function') state.bms.requestDeviceInfo();
      setTimeout(() => {
        if (typeof state.bms.requestSettings === 'function') state.bms.requestSettings();
      }, 300);
    }
  }

  function tickClock() {
    const d = new Date();
    const t = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const el = $('#clock');
    if (el) el.textContent = t;
    const el2 = $('#clock2');
    if (el2) el2.textContent = t;
  }

  function setMode(mode) {
    state.rideMode = mode;
    try { localStorage.setItem('rideMode', mode); } catch (e) { /* ignore */ }
    const s = $('#modeSports');
    const e = $('#modeEco');
    if (s) s.classList.toggle('active', mode === 'sports');
    if (e) e.classList.toggle('active', mode === 'eco');
    const dots = $$('.dots .dot');
    dots.forEach((d, i) => d.classList.toggle('active', (mode === 'sports') === (i === 0)));
  }

  /* ---------------- Protection & Alerts UI Management ---------------- */
  let currentHistFilter = 'ALL';
  let hudAlertTimer = null;

  function showCpView(viewName) {
    const mainV = $('#cpMainView');
    const setV = $('#cpAlertSettingsView');
    const histV = $('#cpAlertHistoryView');
    if (mainV) mainV.hidden = (viewName !== 'main');
    if (setV) setV.hidden = (viewName !== 'settings');
    if (histV) histV.hidden = (viewName !== 'history');

    if (viewName === 'settings') populateAlertSettings();
    if (viewName === 'history') renderAlertHistory(currentHistFilter);
  }

  function populateAlertSettings() {
    if (!window.AlertEngine) return;
    const cfg = window.AlertEngine.getSettings();

    // Battery
    const cl = $('#cfgLowSoc'); if (cl) cl.value = cfg.socLowWarn.threshold;
    const chkL = $('#chkLowSoc'); if (chkL) chkL.checked = cfg.socLowWarn.enabled;

    const cc = $('#cfgCritSoc'); if (cc) cc.value = cfg.socCritWarn.threshold;
    const chkC = $('#chkCritSoc'); if (chkC) chkC.checked = cfg.socCritWarn.enabled;

    const cd = $('#cfgDischargeA'); if (cd) cd.value = cfg.overcurrentDischarge.threshold;
    const chkD = $('#chkDischargeA'); if (chkD) chkD.checked = cfg.overcurrentDischarge.enabled;

    const cchg = $('#cfgChargeA'); if (cchg) cchg.value = cfg.overcurrentCharge.threshold;
    const chkChg = $('#chkChargeA'); if (chkChg) chkChg.checked = cfg.overcurrentCharge.enabled;

    // Cells
    const cch = $('#cfgCellHighV'); if (cch) cch.value = cfg.cellHighWarn.threshold;
    const chkCh = $('#chkCellHighV'); if (chkCh) chkCh.checked = cfg.cellHighWarn.enabled;

    const ccl = $('#cfgCellLowV'); if (ccl) ccl.value = cfg.cellLowWarn.threshold;
    const chkCl = $('#chkCellLowV'); if (chkCl) chkCl.checked = cfg.cellLowWarn.enabled;

    const cdw = $('#cfgDeltaWarn'); if (cdw) cdw.value = cfg.cellImbalanceWarn.threshold;
    const chkDw = $('#chkDeltaWarn'); if (chkDw) chkDw.checked = cfg.cellImbalanceWarn.enabled;

    const cdc = $('#cfgDeltaCrit'); if (cdc) cdc.value = cfg.cellImbalanceCrit.threshold;
    const chkDc = $('#chkDeltaCrit'); if (chkDc) chkDc.checked = cfg.cellImbalanceCrit.enabled;

    // Temperature
    const cpht = $('#cfgPackHighT'); if (cpht) cpht.value = cfg.packHighTempWarn.threshold;
    const chkPht = $('#chkPackHighT'); if (chkPht) chkPht.checked = cfg.packHighTempWarn.enabled;

    const cpct = $('#cfgPackCritT'); if (cpct) cpct.value = cfg.packCritTempWarn.threshold;
    const chkPct = $('#chkPackCritT'); if (chkPct) chkPct.checked = cfg.packCritTempWarn.enabled;

    const cplt = $('#cfgPackLowT'); if (cplt) cplt.value = cfg.packLowTempWarn.threshold;
    const chkPlt = $('#chkPackLowT'); if (chkPlt) chkPlt.checked = cfg.packLowTempWarn.enabled;

    const cmht = $('#cfgMosHighT'); if (cmht) cmht.value = cfg.mosHighTempWarn.threshold;
    const chkMht = $('#chkMosHighT'); if (chkMht) chkMht.checked = cfg.mosHighTempWarn.enabled;

    // Vehicle
    const csl = $('#cfgSpeedLimit'); if (csl) csl.value = cfg.speedLimitWarn.threshold;
    const chkSl = $('#chkSpeedLimit'); if (chkSl) chkSl.checked = cfg.speedLimitWarn.enabled;

    const csh = $('#cfgSpeedHyst'); if (csh) csh.value = cfg.speedLimitWarn.hysteresis || 3;
    const csc = $('#cfgSpeedCooldown'); if (csc) csc.value = cfg.speedLimitWarn.cooldown || 15;

    // Device
    const chkBms = $('#chkBmsWatchdog'); if (chkBms) chkBms.checked = cfg.bmsWatchdog.enabled;
    const chkGps = $('#chkGpsWatchdog'); if (chkGps) chkGps.checked = cfg.gpsWatchdog.enabled;

    // Notification channels
    const chkHud = $('#chkNotifyHud'); if (chkHud) chkHud.checked = cfg.notifyHud;
    const chkAud = $('#chkNotifyAudio'); if (chkAud) chkAud.checked = cfg.notifyAudio;
    const chkVib = $('#chkNotifyVibrate'); if (chkVib) chkVib.checked = cfg.notifyVibrate;
  }

  function saveAlertSettingsFromForm() {
    if (!window.AlertEngine) return;
    const cur = window.AlertEngine.getSettings();

    const numVal = (id, fallback) => {
      const el = $('#' + id);
      if (!el) return fallback;
      const v = parseFloat(el.value);
      return isNaN(v) ? fallback : v;
    };
    const boolVal = (id, fallback) => {
      const el = $('#' + id);
      return el ? el.checked : fallback;
    };

    const newSettings = {
      notifyHud: boolVal('chkNotifyHud', cur.notifyHud),
      notifyAudio: boolVal('chkNotifyAudio', cur.notifyAudio),
      notifyVibrate: boolVal('chkNotifyVibrate', cur.notifyVibrate),

      socLowWarn: { enabled: boolVal('chkLowSoc', true), threshold: numVal('cfgLowSoc', 20) },
      socCritWarn: { enabled: boolVal('chkCritSoc', true), threshold: numVal('cfgCritSoc', 10) },
      overcurrentDischarge: { enabled: boolVal('chkDischargeA', true), threshold: numVal('cfgDischargeA', 60) },
      overcurrentCharge: { enabled: boolVal('chkChargeA', true), threshold: numVal('cfgChargeA', 15) },

      cellHighWarn: { enabled: boolVal('chkCellHighV', true), threshold: numVal('cfgCellHighV', 4.22) },
      cellLowWarn: { enabled: boolVal('chkCellLowV', true), threshold: numVal('cfgCellLowV', 2.95) },
      cellImbalanceWarn: { enabled: boolVal('chkDeltaWarn', true), threshold: numVal('cfgDeltaWarn', 50) },
      cellImbalanceCrit: { enabled: boolVal('chkDeltaCrit', true), threshold: numVal('cfgDeltaCrit', 100) },

      packHighTempWarn: { enabled: boolVal('chkPackHighT', true), threshold: numVal('cfgPackHighT', 55) },
      packCritTempWarn: { enabled: boolVal('chkPackCritT', true), threshold: numVal('cfgPackCritT', 65) },
      packLowTempWarn: { enabled: boolVal('chkPackLowT', true), threshold: numVal('cfgPackLowT', 2) },
      mosHighTempWarn: { enabled: boolVal('chkMosHighT', true), threshold: numVal('cfgMosHighT', 75) },

      speedLimitWarn: {
        enabled: boolVal('chkSpeedLimit', true),
        threshold: numVal('cfgSpeedLimit', 45),
        hysteresis: numVal('cfgSpeedHyst', 3),
        cooldown: numVal('cfgSpeedCooldown', 15)
      },

      bmsWatchdog: { enabled: boolVal('chkBmsWatchdog', true), timeoutSec: cur.bmsWatchdog.timeoutSec || 4 },
      gpsWatchdog: { enabled: boolVal('chkGpsWatchdog', true), timeoutSec: cur.gpsWatchdog.timeoutSec || 10 }
    };

    window.AlertEngine.saveSettings(newSettings);
  }

  function renderAlertHistory(filter) {
    currentHistFilter = filter || 'ALL';
    const container = $('#alertHistoryList');
    if (!container || !window.AlertEngine) return;

    const items = window.AlertEngine.getHistory(currentHistFilter);
    if (!items || !items.length) {
      container.innerHTML = `<div class="alert-hist-empty">${t('noAlertsRecorded') || 'No alerts recorded'}</div>`;
      return;
    }

    const fmtTime = (ts) => {
      const d = new Date(ts);
      const h = String(d.getHours()).padStart(2, '0');
      const m = String(d.getMinutes()).padStart(2, '0');
      const s = String(d.getSeconds()).padStart(2, '0');
      return `${h}:${m}:${s}`;
    };

    let html = '';
    items.forEach((item) => {
      const sevClass = item.severity === 'CRITICAL' ? 'ahi-crit' : item.severity === 'WARNING' ? 'ahi-warn' : 'ahi-info';
      const isAct = item.status === 'ACTIVE';
      const statusText = isAct ? (t('statusActive') || 'ACTIVE') : (t('statusResolved') || 'RESOLVED');
      const statusClass = isAct ? 'active' : 'resolved';

      html += `
        <div class="alert-hist-item">
          <div class="ahi-top">
            <span class="ahi-title">${item.title}</span>
            <span class="ahi-badge ${sevClass}">${item.severity}</span>
          </div>
          <div class="ahi-bottom">
            <span class="ahi-val">${item.valStr}</span>
            <span>${fmtTime(item.timestamp)} · <span class="ahi-status ${statusClass}">${statusText}</span></span>
          </div>
        </div>
      `;
    });

    container.innerHTML = html;
  }

  function updateAlertIndicators() {
    if (!window.AlertEngine) return;
    const activeCount = window.AlertEngine.getActiveCount();
    const badge = $('#alertHistoryBadge');
    if (badge) {
      badge.textContent = activeCount;
      badge.classList.toggle('active', activeCount > 0);
      if (activeCount > 0) {
        badge.style.color = '#ff5252';
        badge.style.background = 'rgba(255, 82, 82, 0.15)';
      } else {
        badge.style.color = '';
        badge.style.background = '';
      }
    }

    const dot = $('#protStatusDot');
    if (dot) {
      if (activeCount > 0) {
        dot.className = 'cp-dot err';
      } else {
        dot.className = 'cp-dot on';
      }
    }
  }

  let currentShowingAlertKey = null;

  function showHudAlert(alertItem) {
    if (!window.AlertEngine) return;
    const cfg = window.AlertEngine.getSettings();
    if (!cfg.notifyHud) return;

    const banner = $('#hudAlertBanner');
    const title = $('#haTitle');
    const sub = $('#haSub');
    if (!banner || !title || !sub) return;

    currentShowingAlertKey = alertItem.key;

    const sevClass = (alertItem.severity === 'CRITICAL' ? 'sev-crit' : alertItem.severity === 'WARNING' ? 'sev-warn' : 'sev-info');
    banner.className = 'hud-alert-banner ha-visible ' + sevClass;
    title.textContent = alertItem.title;
    sub.textContent = alertItem.valStr + (alertItem.thresholdStr ? ' · ' + alertItem.thresholdStr : '');

    banner.hidden = false;

    if (hudAlertTimer) clearTimeout(hudAlertTimer);
    // Auto-dismiss after 5s so rider can simply ignore it while riding
    hudAlertTimer = setTimeout(() => {
      hideHudAlert();
    }, 5000);
  }

  function hideHudAlert(e) {
    if (e) {
      if (typeof e.stopPropagation === 'function') e.stopPropagation();
      if (typeof e.preventDefault === 'function') e.preventDefault();
    }
    const banner = $('#hudAlertBanner');
    if (banner) {
      banner.hidden = true;
      banner.classList.remove('ha-visible');
    }
    if (hudAlertTimer) {
      clearTimeout(hudAlertTimer);
      hudAlertTimer = null;
    }
    if (currentShowingAlertKey && window.AlertEngine) {
      window.AlertEngine.dismissAlert(currentShowingAlertKey);
    }
    currentShowingAlertKey = null;
  }

  function bindUi() {
    const on = (sel, ev, fn) => { const el = $(sel); if (el) el.addEventListener(ev, fn); };
    const closeSettings = () => {
      const panel = $('#settingsPanel');
      if (panel) panel.classList.remove('cp-open');
      showCpView('main');
    };

    on('#connectBtn', 'click', () => {
      if (state.bmsStatus === 'connected' && state.bms) state.bms.disconnect();
      else openBleModal();
    });
    on('#bleSelectBtn', 'click', () => openBleModal());
    on('#scanAllBtn', 'click', () => openBleModal());
    on('#bleFilterBmsBtn', 'click', toggleBleFilter);
    on('#bleCloseBtn', 'click', closeBleModal);
    on('#bleCancelBtn', 'click', closeBleModal);
    on('#bleModalBackdrop', 'click', closeBleModal);
    on('#bleRescanBtn', 'click', () => {
      bleScanState.devices.clear();
      renderBleDeviceList();
      startBleScan();
    });
    on('#disconnectBtn', 'click', () => {
      if (state.bms) state.bms.disconnect();
    });
    on('#resetTripBtn', 'click', resetTrip);
    on('#setResetBtn', 'click', resetTrip);
    on('#resetTripABtn', 'click', resetTripA);
    on('#resetTripBBtn', 'click', resetTripB);
    on('#themeToggleBtn', 'click', toggleTheme);
    on('#layoutToggleBtn', 'click', toggleLayoutMode);
    on('#themeBtnHeader', 'click', toggleTheme);
    on('#langToggleBtn', 'click', toggleLanguage);

    on('#gpsBtn', 'click', () => {
      if (state.gps.active) stopGps();
      else startGps();
      syncGpsButton();
    });

    on('#followBtn', 'click', () => {
      state.follow = !state.follow;
      syncGpsButton();
      toast(state.follow ? t('toastFollowOn') : t('toastFollowOff'));
    });

    on('#settingsBtn', 'click', (e) => {
      if (e) e.stopPropagation();
      const panel = $('#settingsPanel');
      if (panel) panel.classList.toggle('cp-open');
    });
    // Icon batterai (di strip bawah) juga jalan ke buka/tutup panel settings.
    const battEl = document.querySelector('.batt');
    if (battEl) {
      battEl.addEventListener('click', (e) => {
        e.stopPropagation();
        const panel = $('#settingsPanel');
        if (panel) panel.classList.toggle('cp-open');
      });
    }
    on('#setCloseBtn', 'click', closeSettings);
    $$('.close-settings-btn').forEach((btn) => btn.addEventListener('click', closeSettings));

    // Protection & Alerts Navigation & Controls
    on('#openAlertSettingsBtn', 'click', () => showCpView('settings'));
    on('#backFromAlertSettingsBtn', 'click', () => showCpView('main'));
    on('#openAlertHistoryBtn', 'click', () => showCpView('history'));
    on('#backFromAlertHistoryBtn', 'click', () => showCpView('main'));

    const cpAlertInputs = $$('#cpAlertSettingsView input');
    cpAlertInputs.forEach((input) => {
      input.addEventListener('change', saveAlertSettingsFromForm);
      if (input.type === 'number') {
        input.addEventListener('input', saveAlertSettingsFromForm);
      }
    });

    on('#resetAlertDefaultsBtn', 'click', () => {
      if (window.AlertEngine) {
        window.AlertEngine.resetDefaults();
        populateAlertSettings();
        toast(t('resetDefaults') || 'Reset ke standar');
      }
    });

    on('#clearAlertHistoryBtn', 'click', () => {
      if (window.AlertEngine) {
        window.AlertEngine.clearHistory();
        renderAlertHistory(currentHistFilter);
        toast(t('clearHistory') || 'Riwayat dihapus');
      }
    });

    $$('.cp-filter-bar .cp-pill').forEach((btn) => {
      btn.addEventListener('click', () => {
        $$('.cp-filter-bar .cp-pill').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        renderAlertHistory(btn.getAttribute('data-filter') || 'ALL');
      });
    });

    const haBanner = $('#hudAlertBanner');
    const haClose = $('#haCloseBtn');
    if (haClose) {
      haClose.addEventListener('click', hideHudAlert);
      haClose.addEventListener('touchend', hideHudAlert, { passive: false });
    }
    if (haBanner) {
      haBanner.addEventListener('click', hideHudAlert);
      haBanner.addEventListener('touchend', hideHudAlert, { passive: false });
    }

    if (window.AlertEngine) {
      window.AlertEngine.addListener('alert', (alertItem) => {
        showHudAlert(alertItem);
        updateAlertIndicators();
      });
      window.AlertEngine.addListener('resolve', () => {
        updateAlertIndicators();
        if (!$('#cpAlertHistoryView').hidden) renderAlertHistory(currentHistFilter);
      });
      window.AlertEngine.addListener('historyChange', () => {
        updateAlertIndicators();
        if (!$('#cpAlertHistoryView').hidden) renderAlertHistory(currentHistFilter);
      });
      updateAlertIndicators();
    }
    on('#setDetailBtn', 'click', () => switchView('bms'));
    on('#backBtn', 'click', () => switchView('ride'));

    // Tutup panel saat tap di luar panel & tombol ⚙️, atau tekan Escape.
    document.addEventListener('click', (e) => {
      const panel = $('#settingsPanel');
      const btn = $('#settingsBtn');
      if (!panel || !panel.classList.contains('cp-open')) return;
      if (panel.contains(e.target) || (btn && btn.contains(e.target))) return;
      panel.classList.remove('cp-open');
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeSettings();
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        const panel = $('#settingsPanel');
        if (panel) panel.classList.toggle('cp-open');
      }
    });

    const menuBtn = $('#menuBtn');
    if (menuBtn) menuBtn.addEventListener('click', () => switchView('bms'));
    const modeSports = $('#modeSports');
    if (modeSports) modeSports.addEventListener('click', () => { setMode('sports'); toast('Mode Sports'); });
    const modeEco = $('#modeEco');
    if (modeEco) modeEco.addEventListener('click', () => { setMode('eco'); toast('Mode Eco'); });

    window.addEventListener('resize', () => {
      if (state.map) try { state.map.invalidateSize({ pan: false }); } catch (e) { /* abaikan */ }
    });
    window.addEventListener('orientationchange', () => {
      if (state.map) setTimeout(() => { try { state.map.invalidateSize({ pan: false }); } catch (e) { /* abaikan */ } }, 300);
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && state.gps.active) requestWakeLock();
      try { localStorage.setItem('odoKm', String(state.odoKm)); } catch (e) { /* ignore */ }
    });

    let deferredPrompt = null;
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      $('#installBtn').hidden = false;
    });
    $('#installBtn').addEventListener('click', async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      try { await deferredPrompt.userChoice; } catch (e) { /* ignore */ }
      deferredPrompt = null;
      $('#installBtn').hidden = true;
    });
  }

  /* ---------------- demo mode (?demo=1 or toggled via menu) ---------------- */
  function startDemo() {
    state.demo = true;
    if (state.demoTimer) clearInterval(state.demoTimer);
    const badge = $('#demoBadge');
    if (badge) badge.hidden = false;
    const dTag = $('#demoTag');
    if (dTag) dTag.textContent = t('on');
    toast(t('toastDemoOn'));
    const base = { lat: -6.2088, lon: 106.8456 };
    let simT = 0;

    onBmsData({ type: 'info', vendor: 'JK_BD6A24S10P', hw: '11.XA', sw: '11.48', name: 'sepeda cangki', serial: '403153E0976', mfg: '241112' });
    onBmsData({ type: 'settings', cellCount: 20, nominalAh: 30, maxChargeA: 25, maxDischargeA: 100, cellOVP: 4.2, cellOVPRecovery: 4.18, cellUVP: 2.82, cellUVPRecovery: 2.85, balanceTrigger: 0.01, balanceStartV: 3, maxBalanceA: 0.6, soc100V: 4.19, soc0V: 2.84, powerOffV: 2.8, chargeOTP: 70, dischargeOTP: 70, chargeUTP: -20, dischargeUTP: -10, mosOTP: 100, chargeSwitch: true, dischargeSwitch: true, balancerSwitch: true });

    state.demoTimer = setInterval(() => {
      simT += 0.5;
      const kmh = 26 + 14 * Math.sin(simT / 5) + Math.random() * 3;
      const speed = kmh / 3.6;
      const lat = base.lat + Math.sin(simT / 40) * 0.004;
      const lon = base.lon + Math.cos(simT / 50) * 0.004;
      const heading = (simT * 8) % 360;

      state.gps.speed = speed;
      state.gps.accuracy = 6;
      state.gps.active = true;
      state.gps.moving = true;
      state.gps.last = { lat, lon, t: Date.now() };
      state.gps.pos = { lat, lon };
      setPill('gps', 'on', 'GPS');
      syncGpsButton();
      updateSpeed(kmh);
      updateHeading(heading, 6, true);
      updateMap(lat, lon, heading, true, 6);

      state.trip.distance += speed * 0.5;
      state.tripA.distance += speed * 0.5;
      state.tripB.distance += speed * 0.5;
      state.odoKm += (speed * 0.5) / 1000;
      state.trip.movingMs += 500;
      if (kmh > state.trip.maxSpeed) state.trip.maxSpeed = kmh;
      updateTrip();

      const soc = 53 + Math.round(Math.sin(simT / 30) * 2);
      const cells = Array.from({ length: 20 }, (_, i) =>
        3.53 + (i === 19 ? -0.07 : 0) + Math.sin(simT / 20 + i) * 0.004
      );
      const packV = cells.reduce((a, b) => a + b, 0);
      // Mode berkendara: arus MINUS (daya keluar / discharge), watt minus
      const current = -(5 + (kmh / 35) * 10 + Math.sin(simT / 3) * 2.5);
      const power = packV * current; // minus Watt saat power output
      onBmsData({
        type: 'telemetry', packV, current, power,
        soc, soh: 100, remainAh: (soc / 100) * 30, nominalAh: 30, cycles: 100,
        mosTemp: 31.9, t1: 34.5, t2: 34.3, t3: 0, t4: 0, t5: 0,
        balanceA: -0.6, errors: 0, chargeMos: true, dischargeMos: true,
        cellCount: 20, cells,
        minV: Math.min.apply(null, cells), maxV: Math.max.apply(null, cells),
        delta: Math.max.apply(null, cells) - Math.min.apply(null, cells), ts: Date.now(),
      });
    }, 500);
  }

  function stopDemo() {
    state.demo = false;
    if (state.demoTimer) {
      clearInterval(state.demoTimer);
      state.demoTimer = null;
    }
    const badge = $('#demoBadge');
    if (badge) badge.hidden = true;
    const dTag = $('#demoTag');
    if (dTag) dTag.textContent = t('off');
    updateSpeed(0);
    setPill('gps', 'off', 'GPS');
    syncGpsButton();
    toast(t('toastDemoOff'));
  }

  function toggleDemo() {
    if (state.demo) {
      stopDemo();
    } else {
      startDemo();
    }
  }

  /* ---------------- boot ---------------- */
  buildSpeedTicks();
  setLanguage(state.lang, true);
  setTheme(state.theme);
  setLayoutMode(state.layoutMode);
  initMap();
  initBms();
  bindUi();
  setMode(state.rideMode);
  tickClock();
  setInterval(tickClock, 15000);
  updateTrip();

  function runBootSequence() {
    const boot = document.getElementById('bootScreen');
    if (!boot) return;

    let finished = false;
    function finishBoot() {
      if (finished) return;
      finished = true;
      boot.classList.add('boot-done');
      setTimeout(() => {
        boot.classList.add('boot-hidden');
      }, 500);
    }

    boot.addEventListener('click', finishBoot);

    // Clean, minimalist automotive splash: auto fade out after 850ms
    setTimeout(() => {
      finishBoot();
    }, 850);
  }

  runBootSequence();

  if ('serviceWorker' in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      // A new service worker took over: reload once so fresh code is used.
      if (!hadController || refreshing) return;
      refreshing = true;
      location.reload();
    });
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
        .catch((e) => console.warn('SW', e));
    });
  }

  if (new URLSearchParams(location.search).has('demo')) {
    startDemo();
  } else if (!new URLSearchParams(location.search).has('nogps')) {
    setTimeout(startGps, 700);
  }
})();
