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

  let _cmdSeq = 0;
  function buildCommand(cmd) {
    const f = new Uint8Array(20);
    f[0] = 0xaa; f[1] = 0x55; f[2] = 0x90; f[3] = 0xeb;
    f[4] = cmd;
    f[16] = (_cmdSeq++) & 0xff;
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
    const vendor = cstr(f, 6, 16);
    const hw = cstr(f, 22, 8);
    const sw = cstr(f, 30, 8);
    const name = cstr(f, 46, 16);
    const serial = cstr(f, 86, 16);
    const mfg = cstr(f, 78, 8);
    return {
      type: 'info',
      vendor: vendor || 'JK-BMS',
      hw: hw || '—',
      hardware: hw || '—',
      sw: sw || '—',
      software: sw || '—',
      uptimeSec: u32(f, 38),
      powerOnCount: u32(f, 42),
      name: name || 'Volt BMS',
      deviceName: name || 'Volt BMS',
      passcode: cstr(f, 62, 16),
      mfg: mfg || '—',
      mfgDate: mfg || '—',
      serial: serial || '—',
      passcodeTag: cstr(f, 102, 5),
      userId: cstr(f, 107, 16),
    };
  }

  function parseSettings(f) {
    const cellUvp = u16(f, 10) * 0.001;
    const cellUvpr = u16(f, 12) * 0.001;
    const cellOvp = u16(f, 14) * 0.001;
    const cellOvpr = u16(f, 16) * 0.001;
    const balanceTriggerV = u16(f, 18) * 0.001;
    const soc100V = u16(f, 20) * 0.001;
    const soc0V = u16(f, 22) * 0.001;
    const cellReqV = u16(f, 24) * 0.001;
    const powerOffV = u16(f, 26) * 0.001;
    const maxChargeA = u16(f, 28) * 0.01;
    const maxDischargeA = u16(f, 32) * 0.01;
    const chargeOtp = i16(f, 36) * 0.1;
    const chargeOtpr = i16(f, 38) * 0.1;
    const dischargeOtp = i16(f, 40) * 0.1;
    const dischargeOtpr = i16(f, 42) * 0.1;
    const chargeUtp = i16(f, 44) * 0.1;
    const chargeUtpr = i16(f, 46) * 0.1;
    const mosOtp = i16(f, 48) * 0.1;
    const mosOtpr = i16(f, 50) * 0.1;
    const cellCountSetting = u16(f, 52);
    const chargeMosSwitch = f[54] !== 0;
    const dischargeMosSwitch = f[55] !== 0;
    const balancerSwitch = f[56] !== 0;
    const nominalCapAh = u32(f, 58) * 0.001;
    const balanceMaxA = u16(f, 62) * 0.001;

    return {
      type: 'settings',
      smartSleepSec: u32(f, 6),
      cellCount: cellCountSetting,
      nominalAh: nominalCapAh,
      maxChargeA,
      maxDischargeA,
      cellOVP: cellOvp,
      cellOVPRecovery: cellOvpr,
      cellUVP: cellUvp,
      cellUVPRecovery: cellUvpr,
      balanceTrigger: balanceTriggerV,
      balanceStartV: cellReqV,
      maxBalanceA: balanceMaxA,
      soc100V,
      soc0V,
      powerOffV,
      chargeOTP: chargeOtp,
      dischargeOTP: dischargeOtp,
      chargeUTP: chargeUtp,
      dischargeUTP: dischargeUtp,
      mosOTP: mosOtp,
      chargeSwitch: chargeMosSwitch,
      dischargeSwitch: dischargeMosSwitch,
      balancerSwitch,
      // Original camelCase aliases:
      cellUvp,
      cellUvpr,
      cellOvp,
      cellOvpr,
      balanceTriggerV,
      nominalCapAh,
      balanceMaxA,
      chargeOtp,
      dischargeOtp,
      mosOtp,
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
      this.capDeviceId = localStorage.getItem('volt_bms_device_id') || null;
      this.capDeviceName = localStorage.getItem('volt_bms_device_name') || 'Volt BMS';
      this._scanListener = null;
      this.isScanning = false;
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
      return (this.device && this.device.name) || localStorage.getItem('volt_bms_device_name') || 'Volt BMS';
    }

    async isLocationEnabled() {
      if (!this.isCapacitor) return true;
      try {
        const Ble = window.Capacitor.Plugins.BluetoothLe;
        const res = await Ble.isLocationEnabled();
        return !!(res && res.value);
      } catch (_) {
        return true;
      }
    }

    async openLocationSettings() {
      if (!this.isCapacitor) return;
      try {
        const Ble = window.Capacitor.Plugins.BluetoothLe;
        await Ble.openLocationSettings();
      } catch (_) {}
    }

    async openBluetoothSettings() {
      if (!this.isCapacitor) return;
      try {
        const Ble = window.Capacitor.Plugins.BluetoothLe;
        await Ble.openBluetoothSettings();
      } catch (_) {}
    }

    async startNativeScan(onDevice) {
      if (!this.isCapacitor) {
        throw new Error('Native BLE scanning hanya tersedia pada aplikasi Android.');
      }
      const Ble = window.Capacitor.Plugins.BluetoothLe;
      await Ble.initialize({ androidNeverForLocation: false });

      if (typeof Ble.requestPermissions === 'function') {
        try { await Ble.requestPermissions(); } catch (e) { console.warn('requestPermissions:', e); }
      }

      try {
        const isEn = await Ble.isEnabled();
        if (isEn && !isEn.value && typeof Ble.requestEnable === 'function') {
          await Ble.requestEnable();
        }
      } catch (_) {}

      await this.stopNativeScan();

      this._scanListener = await Ble.addListener('onScanResult', (res) => {
        if (!res || !res.device) return;
        const devId = res.device.deviceId || res.device.address;
        if (!devId) return;
        const name = (res.device.name || res.localName || '').trim();
        const rssi = typeof res.rssi === 'number' ? res.rssi : null;
        if (typeof onDevice === 'function') {
          onDevice({
            deviceId: devId,
            name: name,
            rssi: rssi,
            raw: res
          });
        }
      });

      await Ble.requestLEScan({ allowDuplicates: true });
      this.isScanning = true;
    }

    async stopNativeScan() {
      if (!this.isCapacitor) return;
      const Ble = window.Capacitor.Plugins.BluetoothLe;
      if (this._scanListener && typeof this._scanListener.remove === 'function') {
        try { await this._scanListener.remove(); } catch (_) {}
        this._scanListener = null;
      }
      try {
        await Ble.stopLEScan();
      } catch (_) {}
      this.isScanning = false;
    }

    async connectToDevice(targetDev) {
      if (!targetDev || !targetDev.deviceId) {
        throw new Error('Device tidak valid.');
      }

      await this.stopNativeScan();

      this.isCap = true;
      this.capDeviceId = targetDev.deviceId;
      this.capDeviceName = targetDev.name || 'JK-BMS (' + targetDev.deviceId.slice(-5) + ')';

      localStorage.setItem('volt_bms_device_id', this.capDeviceId);
      localStorage.setItem('volt_bms_device_name', this.capDeviceName);

      this.onStatus('connecting', 'Menghubungkan ke ' + this.capDeviceName + '...');

      const Ble = window.Capacitor.Plugins.BluetoothLe;

      try { await Ble.disconnect({ deviceId: this.capDeviceId }); } catch (_) {}

      // Connect GATT
      await Ble.connect({ deviceId: this.capDeviceId });

      // Small pause for Android GATT service discovery to finalize
      await new Promise(r => setTimeout(r, 250));

      // Retrieve all services discovered by Android GATT
      let services = [];
      try {
        const sRes = await Ble.getServices({ deviceId: this.capDeviceId });
        services = (sRes && sRes.services) || [];
      } catch (e) {
        console.warn('getServices error, trying discoverServices:', e);
      }

      if (!services || services.length === 0) {
        try {
          await Ble.discoverServices({ deviceId: this.capDeviceId });
          const sRes2 = await Ble.getServices({ deviceId: this.capDeviceId });
          services = (sRes2 && sRes2.services) || [];
        } catch (e2) {
          console.warn('discoverServices error:', e2);
        }
      }

      console.log('JK-BMS Discovered services count:', services.length);

      let chosenService = null;
      let chosenNotifyChar = null;
      let chosenWriteChar = null;

      // Search matching characteristic for JK-BMS:
      // Pattern 1: Look for characteristic with 'ffe1' (standard JK BMS UART)
      for (const s of services) {
        const sUuid = (s.uuid || '').toLowerCase();
        for (const c of (s.characteristics || [])) {
          const cUuid = (c.uuid || '').toLowerCase();
          if (cUuid.includes('ffe1') || (sUuid.includes('ffe0') && (c.properties?.notify || c.properties?.indicate))) {
            chosenService = s.uuid;
            chosenNotifyChar = c.uuid;
            if (c.properties?.write || c.properties?.writeWithoutResponse) {
              chosenWriteChar = c.uuid;
            }
            break;
          }
        }
        if (chosenNotifyChar) break;
      }

      // Pattern 2: Look for 0xff01 or custom BMS characteristic with notify
      if (!chosenNotifyChar) {
        for (const s of services) {
          const sUuid = (s.uuid || '').toLowerCase();
          if (sUuid.includes('1800') || sUuid.includes('1801') || sUuid.includes('180a')) continue;
          for (const c of (s.characteristics || [])) {
            const cUuid = (c.uuid || '').toLowerCase();
            const props = c.properties || {};
            if (cUuid.includes('ff01') || cUuid.includes('ff02') || (sUuid.includes('ff00') && (props.notify || props.indicate))) {
              chosenService = s.uuid;
              chosenNotifyChar = c.uuid;
              if (props.write || props.writeWithoutResponse) {
                chosenWriteChar = c.uuid;
              }
              break;
            }
          }
          if (chosenNotifyChar) break;
        }
      }

      // Pattern 3: Any characteristic with Notify/Indicate on non-standard service
      if (!chosenNotifyChar) {
        for (const s of services) {
          const sUuid = (s.uuid || '').toLowerCase();
          if (sUuid.includes('1800') || sUuid.includes('1801') || sUuid.includes('180a')) continue;
          for (const c of (s.characteristics || [])) {
            const props = c.properties || {};
            if (props.notify || props.indicate) {
              chosenService = s.uuid;
              chosenNotifyChar = c.uuid;
              if (props.write || props.writeWithoutResponse) {
                chosenWriteChar = c.uuid;
              }
              break;
            }
          }
          if (chosenNotifyChar) break;
        }
      }

      // Pattern 4: If write is separate (like Nordic UART TX and RX)
      if (chosenService && !chosenWriteChar) {
        const sObj = services.find(s => (s.uuid || '').toLowerCase() === chosenService.toLowerCase());
        if (sObj) {
          for (const c of (sObj.characteristics || [])) {
            const props = c.properties || {};
            if (props.write || props.writeWithoutResponse) {
              chosenWriteChar = c.uuid;
              break;
            }
          }
        }
      }

      // Final fallback if discovery somehow yielded nothing
      this.activeServiceUuid = chosenService || SERVICE_UUID_128;
      this.activeNotifyUuid = chosenNotifyChar || CHAR_UUID_128;
      this.activeWriteUuid = chosenWriteChar || this.activeNotifyUuid;

      // Determine write capabilities
      const allChars = services.flatMap(s => s.characteristics || []);
      const wCharObj = allChars.find(c => (c.uuid || '').toLowerCase() === this.activeWriteUuid.toLowerCase());
      this.canWriteWithResponse = !!(wCharObj && wCharObj.properties?.write);
      this.canWriteNoResponse = !!(wCharObj && wCharObj.properties?.writeWithoutResponse);

      console.log('Active BLE Service:', this.activeServiceUuid, 'Notify:', this.activeNotifyUuid, 'Write:', this.activeWriteUuid, 'WriteNoResp:', this.canWriteNoResponse);

      // Disconnect listener
      await Ble.addListener(`disconnected|${this.capDeviceId}`, () => {
        this._onDisconnected();
      });

      // Notification listener (Capacitor stores lowercase UUIDs in event map)
      const handleNotif = (res) => {
        if (!res || !res.value) return;
        let bytes;
        if (typeof res.value === 'string') {
          const hex = res.value.replace(/[^0-9a-fA-F]/g, '');
          const len = Math.floor(hex.length / 2);
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
      };

      const sUuidLow = this.activeServiceUuid.toLowerCase();
      const cUuidLow = this.activeNotifyUuid.toLowerCase();
      const devId = this.capDeviceId;

      await Ble.addListener(`notification|${devId}|${sUuidLow}|${cUuidLow}`, handleNotif);
      if (devId.toUpperCase() !== devId) {
        await Ble.addListener(`notification|${devId.toUpperCase()}|${sUuidLow}|${cUuidLow}`, handleNotif);
      }
      if (devId.toLowerCase() !== devId) {
        await Ble.addListener(`notification|${devId.toLowerCase()}|${sUuidLow}|${cUuidLow}`, handleNotif);
      }

      // Start notifications using discovered UUIDs
      await Ble.startNotifications({
        deviceId: this.capDeviceId,
        service: this.activeServiceUuid,
        characteristic: this.activeNotifyUuid,
      });

      this.connected = true;
      this._attempts = 0;
      this.lastTelemetryTs = Date.now();
      this.onStatus('connected', this.capDeviceName);

      // Initial Handshake: Prompt BMS to start auto-streaming telemetry
      setTimeout(() => { this._send(0x97).catch(() => {}); }, 300);
      setTimeout(() => { this._send(0x96).catch(() => {}); }, 750);

      // Keep-alive Watchdog:
      // Once initiated with 0x97 & 0x96, JK-BMS streams Frame 0x02 continuously on its own (~1s interval).
      // We do NOT poll aggressively, because sending continuous write packets interrupts and stalls the stream!
      // Only if NO packet has been received for > 6 seconds do we send a gentle handshake ping to resume.
      if (this._pollTimer) clearInterval(this._pollTimer);
      this._pollTimer = setInterval(() => {
        if (this.connected) {
          const idleMs = Date.now() - (this.lastTelemetryTs || 0);
          if (idleMs >= 6000) {
            console.log('[JKBMS] Keep-alive ping (idle ' + idleMs + 'ms)');
            this._send(0x96).catch(() => {});
            setTimeout(() => {
              if (this.connected) this._send(0x97).catch(() => {});
            }, 350);
          }
        }
      }, 3000);
    }

    requestDeviceInfo() {
      return this._send(0x97).catch(() => {});
    }

    requestSettings() {
      return this._send(0x96).catch(() => {});
    }

    async connect(scanAll) {
      if (!this.supported) {
        throw new Error('Bluetooth tidak didukung pada browser/perangkat ini.');
      }
      this._manual = false;
      this._attempts = 0;

      // 1. Jika Capacitor, coba direct reconnect ke device tersimpan
      if (this.isCapacitor) {
        const savedId = localStorage.getItem('volt_bms_device_id');
        const savedName = localStorage.getItem('volt_bms_device_name');
        if (savedId && !scanAll) {
          try {
            await this.connectToDevice({ deviceId: savedId, name: savedName || 'BMS' });
            return;
          } catch (e) {
            console.warn('Direct connect to saved device failed, scan needed:', e);
            throw new Error('RESCAN_NEEDED');
          }
        } else {
          throw new Error('RESCAN_NEEDED');
        }
      }

      // 2. Fallback Web Bluetooth
      return this._connectWebBluetooth(scanAll);
    }

    async _connectWebBluetooth(scanAll) {
      const options = {
        acceptAllDevices: true,
        optionalServices: [SERVICE_UUID, SERVICE_UUID_128],
      };

      const device = await navigator.bluetooth.requestDevice(options);
      this.device = device;
      this.isCap = false;
      if (device.name) {
        localStorage.setItem('volt_bms_device_name', device.name);
      }
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
        // Capacitor bluetooth-le plugin Conversion.kt splits value by space!
        const hexArr = [];
        for (let i = 0; i < frame.length; i++) {
          hexArr.push(frame[i].toString(16).padStart(2, '0'));
        }
        const hexValue = hexArr.join(' ');

        const sUuid = this.activeServiceUuid || SERVICE_UUID_128;
        const cUuid = this.activeWriteUuid || this.activeNotifyUuid || CHAR_UUID_128;

        // Prefer writeWithoutResponse if available so Android GATT queue doesn't wait
        try {
          if (this.canWriteNoResponse) {
            await Ble.writeWithoutResponse({
              deviceId: this.capDeviceId,
              service: sUuid,
              characteristic: cUuid,
              value: hexValue,
            });
          } else {
            await Ble.write({
              deviceId: this.capDeviceId,
              service: sUuid,
              characteristic: cUuid,
              value: hexValue,
            });
          }
        } catch (writeErr) {
          try {
            await Ble.writeWithoutResponse({
              deviceId: this.capDeviceId,
              service: sUuid,
              characteristic: cUuid,
              value: hexValue,
            });
          } catch (writeErr2) {
            console.warn('BLE write error:', writeErr2);
          }
        }
        return;
      }

      // Web Bluetooth write
      if (!this.characteristic) throw new Error('BMS belum terhubung');
      const ch = this.characteristic;
      if (ch.properties.writeWithoutResponse && ch.writeValueWithoutResponse) {
        await ch.writeValueWithoutResponse(frame);
      } else if (ch.properties.write && ch.writeValueWithResponse) {
        await ch.writeValueWithResponse(frame);
      } else {
        await ch.writeValue(frame);
      }
    }

    _onNotify(event) {
      const v = event.target.value; // DataView
      this._append(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
    }

    _append(chunk) {
      if (!chunk || !chunk.length) return;

      const merged = new Uint8Array(this.buf.length + chunk.length);
      merged.set(this.buf, 0);
      merged.set(chunk, this.buf.length);
      this.buf = merged;

      // Continuously extract complete frames
      while (this.buf.length >= 300) {
        let start = indexOfHeader(this.buf);
        if (start < 0) {
          // No header in buffer: discard everything except last 3 bytes (in case header is split across chunks)
          this.buf = this.buf.slice(Math.max(0, this.buf.length - 3));
          break;
        }
        if (start > 0) {
          // Discard leading noise/padding before header
          this.buf = this.buf.slice(start);
          if (this.buf.length < 300) break;
        }

        const raw = this.buf;
        let validFrame = null;
        let frameSize = 0;

        // Check standard 300-byte frame
        if (crc8(raw, 299) === raw[299]) {
          validFrame = raw.subarray(0, 300);
          frameSize = 300;
        } else if (raw.length >= 320 && crc8(raw, 319) === raw[319]) {
          // Check 320-byte extended frame
          validFrame = raw.subarray(0, 320);
          frameSize = 320;
        }

        if (validFrame) {
          try {
            const parsed = parseFrame(validFrame);
            if (parsed) {
              this.lastTelemetryTs = Date.now();
              this.onData(parsed);
            }
          } catch (handlerErr) {
            console.warn('[JKBMS] parse/onData error:', handlerErr);
          }

          // Advance past frameSize
          this.buf = this.buf.slice(frameSize);
        } else {
          // Offset 0 had header preamble but failed CRC.
          // Look for next preamble sequence to resynchronize stream
          const nextHdr = indexOfHeader(this.buf.subarray(1));
          if (nextHdr >= 0) {
            this.buf = this.buf.slice(nextHdr + 1);
          } else {
            // No next header yet; if buffer is too large without CRC match, drop stale data
            if (this.buf.length > 640) {
              this.buf = this.buf.slice(this.buf.length - 3);
            }
            break;
          }
        }
      }
    }

    _onDisconnected() {
      this.connected = false;
      this.characteristic = null;
      if (this._watchdogTimer) {
        clearInterval(this._watchdogTimer);
        this._watchdogTimer = null;
      }
      if (this._pollTimer) {
        clearInterval(this._pollTimer);
        this._pollTimer = null;
      }
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
          this.connectToDevice({ deviceId: this.capDeviceId, name: this.capDeviceName }).catch(() => {});
        } else {
          this._open().catch(() => {});
        }
      }, 1200 * this._attempts);
    }

    async disconnect() {
      this._manual = true;
      clearTimeout(this._timer);
      if (this._watchdogTimer) {
        clearInterval(this._watchdogTimer);
        this._watchdogTimer = null;
      }
      if (this._pollTimer) {
        clearInterval(this._pollTimer);
        this._pollTimer = null;
      }
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
