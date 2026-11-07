/*
 * JK BMS BLE client — Web Bluetooth port of the JK02_32S protocol.
 * Service 0xFFE0, characteristic 0xFFE1 (write + notify).
 * Commands are 20-byte frames: AA 55 90 EB <cmd> 00... <crc8>
 * Responses are 300/320-byte frames: 55 AA EB 90 <type> ...
 */
(function (global) {
  'use strict';

  const SERVICE_UUID = 0xffe0;
  const CHAR_UUID = 0xffe1;

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
      type: 'info',
      vendor: cstr(f, 6, 16),
      hw: cstr(f, 22, 8),
      sw: cstr(f, 30, 8),
      name: cstr(f, 46, 16),
      serial: cstr(f, 86, 16),
      mfg: cstr(f, 78, 8),
      ts: Date.now(),
    };
  }

  function parseSettings(f) {
    return {
      type: 'settings',
      cellCount: f[114],
      nominalAh: u32(f, 130) * 0.001,
      maxChargeA: u32(f, 50) * 0.001,
      maxDischargeA: u32(f, 62) * 0.001,
      cellOVP: u32(f, 18) * 0.001,
      cellOVPRecovery: u32(f, 22) * 0.001,
      cellUVP: u32(f, 10) * 0.001,
      cellUVPRecovery: u32(f, 14) * 0.001,
      balanceTrigger: u32(f, 26) * 0.001,
      balanceStartV: u32(f, 138) * 0.001,
      maxBalanceA: u32(f, 78) * 0.001,
      soc100V: u32(f, 30) * 0.001,
      soc0V: u32(f, 34) * 0.001,
      powerOffV: u32(f, 46) * 0.001,
      chargeOTP: u32(f, 82) * 0.1,
      dischargeOTP: u32(f, 90) * 0.1,
      chargeUTP: i32(f, 98) * 0.1,
      dischargeUTP: i32(f, 102) * 0.1,
      mosOTP: i32(f, 106) * 0.1,
      chargeSwitch: f[118] !== 0,
      dischargeSwitch: f[122] !== 0,
      balancerSwitch: f[126] !== 0,
      ts: Date.now(),
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
    }

    get supported() {
      return typeof navigator !== 'undefined' && !!navigator.bluetooth;
    }

    get deviceName() {
      return (this.device && this.device.name) || 'BMS';
    }

    async connect(scanAll) {
      if (!this.supported) {
        throw new Error('Web Bluetooth tidak didukung. Buka di Chrome Android via HTTPS.');
      }
      this._manual = false;
      this._attempts = 0;
      this.onStatus('connecting', 'Pilih device...');

      const options = scanAll
        ? { acceptAllDevices: true, optionalServices: [SERVICE_UUID] }
        : { filters: [{ namePrefix: 'sepeda' }], optionalServices: [SERVICE_UUID] };

      const device = await navigator.bluetooth.requestDevice(options);
      this.device = device;
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
      if (!this.characteristic) throw new Error('BMS belum terhubung');
      const frame = buildCommand(cmd);
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

        if (!frameLen) {
          this.buf = this.buf.slice(1);
          const s = indexOfHeader(this.buf);
          if (s < 0) {
            if (this.buf.length > 512) this.buf = this.buf.slice(-4);
            return;
          }
          this.buf = this.buf.slice(s);
          continue;
        }

        const frame = this.buf.slice(0, frameLen);
        this.buf = this.buf.slice(frameLen);
        try {
          this.onData(parseFrame(frame));
        } catch (e) {
          this.onError(e);
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
        this._open().catch(() => {});
      }, 1200 * this._attempts);
    }

    async disconnect() {
      this._manual = true;
      clearTimeout(this._timer);
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
