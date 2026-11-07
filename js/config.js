// Konfigurasi map & routing.
// Tile: CARTO basemaps (dark & light) + OpenStreetMap, pakai API key dari CARTO.
// WAJIB: batasi key di dashboard CARTO (referrer/domain + jangan dipakai proyek lain).
// Atribusi wajib tetap tampil: © OpenStreetMap, © CARTO.
window.DASH_CONFIG = {
  tileUrl: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png?key=cb1_53nv_1_36016476114a28756464cdd2',
  tileUrlDark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png?key=cb1_53nv_1_36016476114a28756464cdd2',
  tileUrlLight: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png?key=cb1_53nv_1_36016476114a28756464cdd2',
  tileAttribution: '&copy; OpenStreetMap &copy; CARTO',
  routeUrl: 'https://router.project-osrm.org/route/v1/driving/',
  mapApiKey: 'cb1_53nv_1_36016476114a28756464cdd2', // CARTO basemaps key
  mapProvider: 'carto',
};
