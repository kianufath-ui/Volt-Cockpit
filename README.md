# Sepeda Cangki Dash — API map & navigasi

UI Ride dibuat menyerupai cluster speedometer motor: minimap + instruksi belokan di kiri, speedometer besar di tengah, gauge % baterai & km range di kanan.

## API yang dipakai (default: tanpa key)

| Fitur | API / layanan | Butuh key? | Catatan |
|---|---|---|---|
| Speed / posisi / arah | **W3C Geolocation API** (`navigator.geolocation.watchPosition`) | Tidak | Wajib HTTPS/localhost. Chrome Android: minta izin Location. |
| Telemetri BMS | **Web Bluetooth** (`FFE0` / `FFE1`, protokol JK) | Tidak (direct BLE) | Wajib HTTPS. Tutup aplikasi JK supaya single-connection bebas. |
| Tile peta | **CARTO basemaps (dark)** + OpenStreetMap via Leaflet | ✅ Key CARTO (`?key=…` di tile URL, gaya `dark_all`) | Key gratis (non-komersil 5 jt/bln, komersil 1 jt/bln); watermark "API KEY REQUIRED" hilang kalau key dipasang. Atribusi © OSM © CARTO wajib tetap tampil. Di dashboard CARTO: batasi key khusus domain hosting + jangan dipakai proyek lain. |
| Rute + "350 m Turn Left" | **OSRM** (`router.project-osrm.org`) | Tidak (demo server) | Terima titik tujuan: tap minimap → gambar rute → bedah `legs[].steps[].maneuver` buat panah belokan & jarak. Demo server = rate-limit & tanpa SLA; produksi sebaiknya self-host OSRM / pakai Valhalla. |
| Sisa jarak tempuh | Hitungan lokal dari BMS (`remainAh × packV ÷ Wh/km`) | Tidak | Wh/km dipelajari dari perjalanan (`power` ÷ jarak GPS), default 35. |
| Odometer | `localStorage` | Tidak | Total km tersimpan permanen di perangkat. |

Konfigurasi tile & routing ada di `js/config.js` (`DASH_CONFIG`).

## Pakai key CARTO (sudah terpasang)

Key sudah diisi di `js/config.js` (`mapApiKey` + `?key=` di `tileUrl`, gaya `dark_all`). Yang perlu lu lakukan di [dashboard CARTO](https://carto.com/basemaps/apikey):

1. Buka key → tambahkan **restriction**: domain HTTPS tempat dashboard di-host (plus `localhost:8080` buat testing lokal).
2. Jangan share key ke proyek lain — kuota 5 jt (non-komersil) / 1 jt (komersil) per bulan dihitung gabungan semua key di akun.
3. Kalau peta masih ada watermark "API KEY REQUIRED": hard-refresh / buka private window (tile lama ke-cache), dan pastikan key dicopy persis (case-sensitive).

Di luar itu, routing belokan tetap pakai **OSRM tanpa key** (`router.project-osrm.org`).

## Cara pakai navigasi

1. Buka halaman → GPS otomatis hidup (pill GPS hijau + panah segitiga kanan atas nyala).
2. Tap minimap = set tujuan → rute digambar + instruksi belokan muncul di bawah peta (contoh: "350 m Turn Left").
3. Tombol ✕ = hapus rute. Tombol ◎ = follow map. Tombol 📍 = start/stop GPS.

## Deploy (wajib HTTPS)

Web Bluetooth + Geolocation diblokir di `http://`. Host folder `dashboard/` di static hosting ber-HTTPS (GitHub Pages / Netlify / Cloudflare Pages), buka di Chrome Android → "Add to Home Screen" → Connect BMS.
