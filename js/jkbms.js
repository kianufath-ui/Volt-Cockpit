/*
 * JK BMS BLE client — Dual support: Native Capacitor BLE & Web Bluetooth
 * Service 0xFFE0, characteristic 0xFFE1 (write + notify).
 * Commands are 20-byte frames: AA 55 90 EB <cmd> 00... <crc8>
 * Responses are 300/320-byte frames: 55 AA EB 90 <type> ...
 */
(function (global) {
  'use strict';

  const SERVICE_UUID = 0xffe0;
  const CHAR_UUID = 0xffe1;
  const SERVICE_UUID_128 = '0000ffe0-0000-1000-8000-00805f9b34fb';
  const CHAR_UUID_128 = '0000ffe1-0000-1000-8000-00805f9b34fb';

  const u16 = (b, o) => b[o] | (b[o + 1] << 8);
  const i16 = (b, o) => (u16(b, o) << 16) >> 16;
  const u32 = (b, o) =>
    (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const i32 = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);

  const decoder = new TextDecoder();

  function cstr(b, o, len) {
    let end = o;
    const max = Math.min(o + len, b.length);
    while (end < max && b[end] !== 0) end++;
    return decoder.decode(b.subarray(o, end)).trim();
  }

  function popcount(x) {
    let c = 0;
    while (x) { x &= x - 1; c++; }
    return c;
  }

  function crc8(b, len) {
    let s = 0;
    for (let i = 0; i < len; i++) s = (s + b[i]) & 0xff;
    return s;
  }

  function buildCommand(cmd) {
    const f = new Uint8Array(20);
    f[0] = 0xaa; f[1] = 0x55; f[2] = 0x90; f[3] = 0xeb;
    f[4] = cmd;
    f[19] = crc8(f, 19);
    return f;
  }

  function indexOfHeader(b) {
    for (let i = 0; i + 3 < b.length; i++) {
      if (b[i] === 0x55 && b[i + 1] === 0xaa && b[i + 2] === 0xeb && b[i + 3] === 0x90) return i;
    }
    return -1;
  }

  function parseCellInfo(f) {
    const mask = u32(f, 70);
    const cellCount = mask ? popcount(mask) : 32;
    const cells = [];
    let minV = Infinity;
    let maxV = -Infinity;
    for (let i = 0; i < 32; i++) {
      const v = u16(f, 6 + i * 2) * 0.001;
      if (i < cellCount) {
        cells.push(v);
        if (v > 0.1) {
          if (v < minV) minV = v;
          if (v > maxV) maxV = v;
        }
      }
    }
    if (!isFinite(minV)) { minV = 0; maxV = 0; }
    const packV = u32(f, 150) * 0.001;
    const current = i32(f, 158) * 0.001;
    return {
      type: 'telemetry',
      packV,
      current,
      power: packV * current,
      soc: f[173],
      soh: f[190],
      remainAh: u32(f, 174) * 0.001,
      nominalAh: u32(f, 178) * 0.001,
      cycles: u32(f, 182),
      mosTemp: i16(f, 144) * 0.1,
      t1: i16(f, 162) * 0.1,
      t2: i16(f, 164) * 0.1,
      balanceA: i16(f, 170) * 0.001,
      errors: u32(f, 166),
      chargeMos: f[198] !== 0,
      dischargeMos: f[199] !== 0,
      cellCount,
      cells,
      minV,
      maxV,
      delta: maxV - minV,
      ts: Date.now(),
    };
  }

  function parseDeviceInfo(f) {
    return {
      type: 'deviceInfo',
      vendor: cstr(f, 6, 16),
      hardware: cstr(f, 22, 8),
      software: cstr(f, 30, 8),
      uptimeSec: u32(f, 38),
      powerOnCount: u32(f, 42),
      deviceName: cstr(f, 46, 16),
      passcode: cstr(f, 62, 16),
      mfgDate: cstr(f, 78, 8),
      serial: cstr(f, 86, 16),
      passcodeTag: cstr(f, 102, 5),
      userId: cstr(f, 107, 16),
    };
  }

  function parseSettings(f) {
    return {
      type: 'settings',
      smartSleepSec: u32(f, 6),
      cellUvp: u16(f, 10) * 0.001,
      cellUvpr: u16(f, 12) * 0.001,
      cellOvp: u16(f, 14) * 0.001,
      cellOvpr: u16(f, 16) * 0.001,
      balanceTriggerV: u16(f, 18) * 0.001,
      soc100V: u16(f, 20) * 0.001,
      soc0V: u16(f, 22) * 0.001,
      cellReqV: u16(f, 24) * 0.001,
      powerOffV: u16(f, 26) * 0.001,
      maxChargeA: u16(f, 28) * 0.01,
      chargeDelaySec: u16(f, 30),
      maxDischargeA: u16(f, 32) * 0.01,
      dischargeDelaySec: u16(f, 34),
      chargeOtp: i16(f, 36) * 0.1,
      chargeOtpr: i16(f, 38) * 0.1,
      dischargeOtp: i16(f, 40) * 0.1,
      dischargeOtpr: i16(f, 42) * 0.1,
      chargeUtp: i16(f, 44) * 0.1,
      chargeUtpr: i16(f, 46) * 0.1,
      mosOtp: i16(f, 48) * 0.1,
      mosOtpr: i16(f, 50) * 0.1,
      cellCountSetting: u16(f, 52),
      chargeMosSwitch: f[54] !== 0,
      dischargeMosSwitch: f[55] !== 0,
      balancerSwitch: f[56] !== 0,
      nominalCapAh: u32(f, 58) * 0.001,
      balanceMaxA: u16(f, 62) * 0.001,
    };
  }

  function parseFrame(f) {
    switch (f[4]) {
      case 0x02: return parseCellInfo(f);
      case 0x03: return parseDeviceInfo(f);
      case 0x01: return parseSettings(f);
      default: return { type: 'unknown', frameType: f[4] };
    }
  }

  class JKBms {
    constructor(opts) {
      opts = opts || {};
      this.onData = opts.onData || function () {};
      this.onStatus = opts.onStatus || function () {};
      this.onError = opts.onError || function () {};
      this.device = null;
      this.server = null;
      this.characteristic = null;
      this.buf = new Uint8Array(0);
      this.connected = false;
      this._manual = false;
      this._attempts = 0;
      this._timer = null;

      // Capacitor Native BLE state
      this.isCap = false;
      this.capDeviceId = null;
      this.capDeviceName = 'sepeda cangki';
    }

    get isCapacitor() {
      return typeof window !== 'undefined' && !!window.Capacitor && (
        (typeof window.Capacitor.isPluginAvailable === 'function' && window.Capacitor.isPluginAvailable('BluetoothLe')) ||
        (!!window.Capacitor.Plugins && !!window.Capacitor.Plugins.BluetoothLe)
      );
    }

    get supported() {
      const hasWebBt = typeof navigator !== 'undefined' && !!navigator.bluetooth;
      return hasWebBt || this.isCapacitor;
    }

    get deviceName() {
      if (this.isCap && this.capDeviceName) return this.capDeviceName;
      return (this.device && this.device.name) || 'BMS';
    }

    async connect(scanAll) {
      if (!this.supported) {
        throw new Error('Bluetooth tidak didukung pada browser/perangkat ini.');
      }
      this._manual = false;
      this._attempts = 0;
      this.onStatus('connecting', 'Mencari BMS JK...');

      // 1. Prioritaskan Capacitor Native BLE jika running di APK Android Native
      if (this.isCapacitor) {
        return this._connectCapacitor(scanAll);
      }

      // 2. Fallback ke Web Bluetooth browser jika running di Chrome HTTPS
      return this._connectWebBluetooth(scanAll);
    }

    async _connectCapacitor(scanAll) {
      const Ble = window.Capacitor.Plugins.BluetoothLe;
      await Ble.initialize();

      const savedId = localStorage.getItem('volt_bms_device_id');
      const savedName = localStorage.getItem('volt_bms_device_name') || 'sepeda cangki';

      let targetDev = null;

      // Scanning cerdas via requestLEScan (tanpa modal popup putih yang menghalangi)
      this.onStatus('connecting', 'Scanning bluetooth...');

      targetDev = await new Promise((resolve) => {
        let timer = null;
        let scanSub = null;
        const foundList = [];

        const cleanup = async () => {
          if (timer) clearTimeout(timer);
          try {
            if (scanSub && typeof scanSub.remove === 'function') await scanSub.remove();
            await Ble.stopLEScan();
          } catch (_) {}
        };

        Ble.addListener('onScanResult', async (res) => {
          if (!res || !res.device || !res.device.deviceId) return;
          const devId = res.device.deviceId;
          const devName = (res.device.name || res.localName || '').trim();
          const devLower = devName.toLowerCase();

          if (!foundList.some(d => d.deviceId === devId)) {
            foundList.push({ deviceId: devId, name: devName || devId });
          }

          // Pencocokan otomatis (case-insensitive)
          const isMatch = !scanAll && (
            (savedId && devId === savedId) ||
            devLower.includes('sepeda') ||
            devLower.includes('cangki') ||
            devLower.includes('jk') ||
            devLower.includes('bms')
          );

          if (isMatch) {
            await cleanup();
            resolve({ deviceId: devId, name: devName || 'sepeda cangki' });
          }
        }).then(sub => {
          scanSub = sub;
          // Mulai scan tanpa filter agar semua paket BLE masuk
          return Ble.requestLEScan({});
        }).catch(err => {
          console.warn('requestLEScan fallback:', err);
          cleanup();
          resolve(null);
        });

        // Batas waktu scan background 5 detik
        timer = setTimeout(async () => {
          await cleanup();
          if (foundList.length > 0) {
            const named = foundList.find(d => d.name && d.name !== d.deviceId);
            resolve(named || foundList[0]);
          } else {
            resolve(null);
          }
        }, 5000);
      });

      // Jika background scan belum menemukan, buka dialog pemilih tanpa filter ketat
      if (!targetDev) {
        try {
          this.onStatus('connecting', 'Pilih device...');
          const dev = await Ble.requestDevice({});
          if (dev && dev.deviceId) {
            targetDev = { deviceId: dev.deviceId, name: dev.name || 'sepeda cangki' };
          }
        } catch (e) {
          throw new Error('Device tidak ditemukan atau dibatalkan.');
        }
      }

      if (!targetDev || !targetDev.deviceId) {
        throw new Error('Tidak ada BMS yang ditemukan.');
      }

      this.isCap = true;
      this.capDeviceId = targetDev.deviceId;
      this.capDeviceName = targetDev.name || 'sepeda cangki';

      localStorage.setItem('volt_bms_device_id', this.capDeviceId);
      localStorage.setItem('volt_bms_device_name', this.capDeviceName);

      this.onStatus('connecting', 'Menghubungkan ke ' + this.capDeviceName + '...');

      // Connect GATT
      await Ble.connect({ deviceId: this.capDeviceId });

      // Disconnect listener
      await Ble.addListener(`disconnected|${this.capDeviceId}`, () => {
        this._onDisconnected();
      });

      // Notification listener
      const notifKey = `notification|${this.capDeviceId}|${SERVICE_UUID_128}|${CHAR_UUID_128}`;
      await Ble.addListener(notifKey, (res) => {
        if (!res || !res.value) return;
        let bytes;
        if (typeof res.value === 'string') {
          const hex = res.value.replace(/[^0-9a-fA-F]/g, '');
          const len = hex.length / 2;
          bytes = new Uint8Array(len);
          for (let i = 0; i < len; i++) {
            bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
          }
        } else if (res.value.buffer) {
          bytes = new Uint8Array(res.value.buffer, res.value.byteOffset, res.value.byteLength);
        }
        if (bytes && bytes.length) {
          this._append(bytes);
        }
      });

      // Start notifications
      await Ble.startNotifications({
        deviceId: this.capDeviceId,
        service: SERVICE_UUID_128,
        characteristic: CHAR_UUID_128,
      });

      this.connected = true;
      this._attempts = 0;
      this.onStatus('connected', this.capDeviceName);

      // Trigger inquiry frame 0x97 & 0x96
      setTimeout(() => { this._send(0x97).catch(() => {}); }, 250);
      setTimeout(() => { this._send(0x96).catch(() => {}); }, 700);
    }

    async _connectWebBluetooth(scanAll) {
      const options = scanAll
        ? { acceptAllDevices: true, optionalServices: [SERVICE_UUID] }
        : { filters: [{ namePrefix: 'sepeda' }], optionalServices: [SERVICE_UUID] };

      const device = await navigator.bluetooth.requestDevice(options);
      this.device = device;
      this.isCap = false;
      device.addEventListener('gattserverdisconnected', () => this._onDisconnected());
      await this._open();
    }

    async _open() {
      if (!this.device) return;
      this.onStatus('connecting', 'Menghubungkan...');
      try {
        this.server = await this.device.gatt.connect();
        const service = await this.server.getPrimaryService(SERVICE_UUID);
        const ch = await service.getCharacteristic(CHAR_UUID);
        this.characteristic = ch;
        ch.addEventListener('characteristicvaluechanged', (e) => this._onNotify(e));
        await ch.startNotifications();
        this.connected = true;
        this._attempts = 0;
        this.onStatus('connected', this.deviceName);

        setTimeout(() => { this._send(0x97).catch(() => {}); }, 200);
        setTimeout(() => { this._send(0x96).catch(() => {}); }, 650);
      } catch (err) {
        this.connected = false;
        this.onStatus('error', err && err.message ? err.message : String(err));
        throw err;
      }
    }

    async _send(cmd) {
      const frame = buildCommand(cmd);

      // Capacitor Native BLE write
      if (this.isCap && this.capDeviceId) {
        const Ble = window.Capacitor.Plugins.BluetoothLe;
        let hex = '';
        for (let i = 0; i < frame.length; i++) {
          const h = frame[i].toString(16);
          hex += (h.length === 1 ? '0' : '') + h;
        }
        await Ble.write({
          deviceId: this.capDeviceId,
          service: SERVICE_UUID_128,
          characteristic: CHAR_UUID_128,
          value: hex,
        });
        return;
      }

      // Web Bluetooth write
      if (!this.characteristic) throw new Error('BMS belum terhubung');
      const ch = this.characteristic;
      if (ch.properties.write && ch.writeValueWithResponse) {
        await ch.writeValueWithResponse(frame);
      } else if (ch.properties.writeWithoutResponse && ch.writeValueWithoutResponse) {
        await ch.writeValueWithoutResponse(frame);
      } else {
        await ch.writeValue(frame);
      }
    }

    _onNotify(event) {
      const v = event.target.value; // DataView
      this._append(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
    }

    _append(chunk) {
      const merged = new Uint8Array(this.buf.length + chunk.length);
      merged.set(this.buf, 0);
      merged.set(chunk, this.buf.length);
      this.buf = merged;

      let start = indexOfHeader(this.buf);
      if (start < 0) {
        if (this.buf.length > 512) this.buf = this.buf.slice(-4);
        return;
      }
      if (start > 0) this.buf = this.buf.slice(start);

      while (this.buf.length >= 300) {
        let frameLen = 0;
        if (crc8(this.buf, 299) === this.buf[299]) frameLen = 300;
        else if (this.buf.length >= 320 && crc8(this.buf, 319) === this.buf[319]) frameLen = 320;

        if (frameLen === 0) {
          const next = indexOfHeader(this.buf.subarray(1));
          if (next >= 0) this.buf = this.buf.slice(next + 1);
          else this.buf = this.buf.slice(this.buf.length - 3);
          break;
        }

        const frame = this.buf.subarray(0, frameLen);
        this.buf = this.buf.slice(frameLen);
        const parsed = parseFrame(frame);
        if (parsed) {
          this.onData(parsed);
          if (parsed.type === 'telemetry') {
            this.onStatus('connected', this.deviceName);
          }
        }
      }
    }

    _onDisconnected() {
      this.connected = false;
      this.characteristic = null;
      this.onStatus('disconnected', 'Terputus');
      if (this._manual) return;
      if (this._attempts >= 5) {
        this.onStatus('error', 'Gagal reconnect');
        return;
      }
      this._attempts++;
      clearTimeout(this._timer);
      this._timer = setTimeout(() => {
        if (this.isCap && this.capDeviceId) {
          window.Capacitor.Plugins.BluetoothLe.connect({ deviceId: this.capDeviceId })
            .then(() => {
              this.connected = true;
              this.onStatus('connected', this.capDeviceName);
              setTimeout(() => { this._send(0x97).catch(() => {}); }, 250);
            })
            .catch(() => {});
        } else {
          this._open().catch(() => {});
        }
      }, 1200 * this._attempts);
    }

    async disconnect() {
      this._manual = true;
      clearTimeout(this._timer);
      if (this.isCap && this.capDeviceId) {
        try {
          await window.Capacitor.Plugins.BluetoothLe.disconnect({ deviceId: this.capDeviceId });
        } catch (_) {}
      }
      try {
        if (this.device && this.device.gatt && this.device.gatt.connected) {
          this.device.gatt.disconnect();
        }
      } catch (e) { /* ignore */ }
      this.connected = false;
      this.characteristic = null;
      this.onStatus('disconnected', 'Terputus');
    }
  }

  global.JKBms = JKBms;
  global.JKBmsProtocol = {
    buildCommand,
    parseFrame,
    parseCellInfo,
    parseDeviceInfo,
    parseSettings,
    crc8,
    SERVICE_UUID,
    CHAR_UUID,
  };
})(window);
