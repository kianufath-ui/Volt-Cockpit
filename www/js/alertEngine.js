/**
 * VOLT — Central Protection & Alert Engine
 * 
 * Intelligent real-time monitoring and safety system for electric vehicle cockpit.
 * Evaluates real sensor telemetry from JK-BMS, GPS velocity, and device health.
 * 
 * Features:
 *  - Multi-tier severity: INFO, WARNING, CRITICAL
 *  - Hysteresis & cooldown dampening (prevents boundary bouncing)
 *  - Deduplication & active condition tracking
 *  - Recovery detection (marks alerts as RESOLVED when condition clears)
 *  - Local persistence for settings and chronological alert history
 *  - Web Audio synthesized automotive chimes (zero external assets)
 *  - Native haptic vibration patterns
 *  - Strict data integrity (never triggers on missing/stale/NaN data)
 */

(function (window) {
  'use strict';

  const STORAGE_KEY_SETTINGS = 'volt_alert_settings';
  const STORAGE_KEY_HISTORY = 'volt_alert_history';
  const MAX_HISTORY_ITEMS = 100;

  // Safe baseline defaults for 16S-24S LiFePO4 / Li-ion battery packs
  const DEFAULT_SETTINGS = {
    enabled: true,

    // Notification Preferences
    notifyHud: true,
    notifyAudio: true,
    notifyVibrate: true,

    // Battery Pack
    socLowWarn: { enabled: true, threshold: 20, sev: 'WARNING' },       // %
    socCritWarn: { enabled: true, threshold: 10, sev: 'CRITICAL' },     // %
    packHighTempWarn: { enabled: true, threshold: 55, sev: 'WARNING' }, // °C
    packCritTempWarn: { enabled: true, threshold: 65, sev: 'CRITICAL' },// °C
    packLowTempWarn: { enabled: true, threshold: 2, sev: 'WARNING' },   // °C
    mosHighTempWarn: { enabled: true, threshold: 75, sev: 'WARNING' },  // °C
    overcurrentDischarge: { enabled: true, threshold: 60, sev: 'WARNING' }, // A (discharge current)
    overcurrentCharge: { enabled: true, threshold: 15, sev: 'WARNING' },    // A (charging current)

    // Cell Voltages
    cellHighWarn: { enabled: true, threshold: 4.22, sev: 'WARNING' },   // V
    cellLowWarn: { enabled: true, threshold: 2.95, sev: 'CRITICAL' },   // V
    cellImbalanceWarn: { enabled: true, threshold: 50, sev: 'WARNING' },// mV
    cellImbalanceCrit: { enabled: true, threshold: 100, sev: 'CRITICAL'},// mV

    // Vehicle
    speedLimitWarn: { enabled: true, threshold: 45, hysteresis: 3, cooldown: 15, sev: 'WARNING' }, // km/h, s

    // Connectivity & Device
    bmsWatchdog: { enabled: true, timeoutSec: 4, sev: 'CRITICAL' },     // s
    gpsWatchdog: { enabled: true, timeoutSec: 10, sev: 'WARNING' }      // s
  };

  // Internal state
  let settings = loadSettings();
  let history = loadHistory();
  const activeAlerts = new Map(); // key -> alert object
  const lastTriggeredTime = new Map(); // key -> timestamp ms
  const dismissedAlertKeys = new Set(); // keys dismissed by user during active condition
  const listeners = {
    alert: [],
    resolve: [],
    historyChange: []
  };

  // Connectivity Watchdog Trackers
  let lastBmsPacketTime = 0;
  let bmsWasConnected = false;
  let lastGpsFixTime = 0;
  let gpsWasTracking = false;
  let watchdogInterval = null;

  // Audio Context for automotive chimes
  let audioCtx = null;
  function getAudioContext() {
    if (!audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        audioCtx = new AudioContextClass();
      }
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  }

  // Pre-unlock audio on user interaction
  function unlockAudio() {
    try {
      const ctx = getAudioContext();
      if (ctx && ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }
    } catch (e) {}
  }
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('touchstart', unlockAudio, { once: true, passive: true });
    window.addEventListener('click', unlockAudio, { once: true, passive: true });
  }

  /* ---------------- Sound Synthesizer ---------------- */
  function playAlertChime(severity) {
    if (!settings.notifyAudio) return;
    try {
      const ctx = getAudioContext();
      if (!ctx) return;
      const now = ctx.currentTime;

      if (severity === 'CRITICAL') {
        // High urgency 3-tone chime (980Hz, 1175Hz, 1318Hz)
        const tones = [980, 1175, 1318];
        tones.forEach((freq, idx) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          const tStart = now + idx * 0.12;
          const tEnd = tStart + 0.10;

          osc.type = 'triangle';
          osc.frequency.setValueAtTime(freq, tStart);

          gain.gain.setValueAtTime(0.001, tStart);
          gain.gain.exponentialRampToValueAtTime(0.35, tStart + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.001, tEnd);

          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(tStart);
          osc.stop(tEnd);
        });
      } else if (severity === 'WARNING') {
        // Double pulse tone (784Hz - G5)
        [0, 0.14].forEach((delay) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          const tStart = now + delay;
          const tEnd = tStart + 0.09;

          osc.type = 'sine';
          osc.frequency.setValueAtTime(784, tStart);

          gain.gain.setValueAtTime(0.001, tStart);
          gain.gain.exponentialRampToValueAtTime(0.25, tStart + 0.015);
          gain.gain.exponentialRampToValueAtTime(0.001, tEnd);

          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(tStart);
          osc.stop(tEnd);
        });
      } else {
        // INFO: Pleasant soft rising chime (659Hz -> 880Hz)
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(659.25, now);
        osc.frequency.exponentialRampToValueAtTime(880, now + 0.16);

        gain.gain.setValueAtTime(0.001, now);
        gain.gain.exponentialRampToValueAtTime(0.2, now + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);

        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.22);
      }
    } catch (e) {
      console.warn('[AlertEngine] Audio chime error:', e);
    }
  }

  /* ---------------- Haptic Feedback ---------------- */
  function triggerHaptic(severity) {
    if (!settings.notifyVibrate) return;
    if (typeof navigator.vibrate !== 'function') return;
    try {
      if (severity === 'CRITICAL') {
        navigator.vibrate([220, 80, 220, 80, 400]);
      } else if (severity === 'WARNING') {
        navigator.vibrate([120, 60, 120]);
      } else {
        navigator.vibrate([60]);
      }
    } catch (e) {}
  }

  /* ---------------- Storage Helpers ---------------- */
  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_SETTINGS);
      if (raw) {
        const parsed = JSON.parse(raw);
        return deepMerge(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), parsed);
      }
    } catch (e) {
      console.warn('[AlertEngine] Failed to load settings from storage', e);
    }
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  }

  function saveSettings(newSettings) {
    settings = deepMerge(settings, newSettings);
    try {
      localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(settings));
    } catch (e) {
      console.error('[AlertEngine] Failed to save settings', e);
    }
    return settings;
  }

  function resetDefaults() {
    settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    try {
      localStorage.removeItem(STORAGE_KEY_SETTINGS);
    } catch (e) {}
    return settings;
  }

  function loadHistory() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_HISTORY);
      if (raw) {
        const list = JSON.parse(raw);
        if (Array.isArray(list)) return list.slice(0, MAX_HISTORY_ITEMS);
      }
    } catch (e) {}
    return [];
  }

  function persistHistory() {
    try {
      localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(history.slice(0, MAX_HISTORY_ITEMS)));
    } catch (e) {}
    emit('historyChange', history);
  }

  function clearHistory() {
    history = [];
    persistHistory();
  }

  function deepMerge(target, source) {
    if (!source || typeof source !== 'object') return target;
    for (const key of Object.keys(source)) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        if (!target[key] || typeof target[key] !== 'object') target[key] = {};
        deepMerge(target[key], source[key]);
      } else {
        target[key] = source[key];
      }
    }
    return target;
  }

  /* ---------------- Alert Trigger & Resolution ---------------- */
  function dismissAlert(key) {
    if (key) {
      dismissedAlertKeys.add(key);
    } else {
      activeAlerts.forEach((_, k) => dismissedAlertKeys.add(k));
    }
  }

  function triggerAlert(alertDef) {
    const { key, title, category, severity, valStr, thresholdStr, rawValue } = alertDef;
    const now = Date.now();

    // If dismissed by user, do not show or chime while active condition persists
    if (dismissedAlertKeys.has(key)) {
      return activeAlerts.get(key) || null;
    }

    // Cooldown check for repetitive warnings
    const cooldownMs = (alertDef.cooldownSec || 12) * 1000;
    const lastTime = lastTriggeredTime.get(key) || 0;
    const isNew = !activeAlerts.has(key);

    if (!isNew && now - lastTime < cooldownMs) {
      // Still in cooldown period, don't re-chime
      return activeAlerts.get(key);
    }

    lastTriggeredTime.set(key, now);

    const alertItem = {
      id: 'alt_' + now + '_' + Math.random().toString(36).substr(2, 5),
      key,
      title,
      category,
      severity,
      valStr,
      thresholdStr: thresholdStr || '',
      rawValue,
      timestamp: now,
      status: 'ACTIVE',
      resolvedAt: null
    };

    activeAlerts.set(key, alertItem);

    // Add to historical log (prepend)
    history.unshift(alertItem);
    if (history.length > MAX_HISTORY_ITEMS) {
      history = history.slice(0, MAX_HISTORY_ITEMS);
    }
    persistHistory();

    // Dispatch feedback
    playAlertChime(severity);
    triggerHaptic(severity);
    emit('alert', alertItem);

    return alertItem;
  }

  function resolveAlert(key, resolutionNote) {
    dismissedAlertKeys.delete(key);
    if (!activeAlerts.has(key)) return null;

    const alertItem = activeAlerts.get(key);
    activeAlerts.delete(key);

    const now = Date.now();
    alertItem.status = 'RESOLVED';
    alertItem.resolvedAt = now;
    if (resolutionNote) alertItem.resolutionNote = resolutionNote;

    // Update in history list
    const found = history.find((h) => h.id === alertItem.id);
    if (found) {
      found.status = 'RESOLVED';
      found.resolvedAt = now;
    }
    persistHistory();

    emit('resolve', alertItem);
    return alertItem;
  }

  /* ---------------- Telemetry Monitoring Engine ---------------- */
  function checkTelemetry(d) {
    if (!settings.enabled || !d) return;

    // Must be valid numeric telemetry from real BMS
    if (typeof d.packV !== 'number' || isNaN(d.packV) || d.packV <= 0) return;

    // Mark telemetry packet received (watchdog heartbeat)
    lastBmsPacketTime = Date.now();
    bmsWasConnected = true;
    resolveAlert('BMS_COMM_LOST');

    // 1. SOC Protection (Critical has precedence over Low)
    if (typeof d.soc === 'number' && !isNaN(d.soc)) {
      if (settings.socCritWarn.enabled && d.soc <= settings.socCritWarn.threshold) {
        triggerAlert({
          key: 'BATT_SOC_CRIT',
          title: 'Critical Battery Level',
          category: 'BATTERY',
          severity: 'CRITICAL',
          valStr: d.soc + '%',
          thresholdStr: 'Threshold: ≤ ' + settings.socCritWarn.threshold + '%',
          rawValue: d.soc,
          cooldownSec: 25
        });
      } else if (d.soc >= settings.socCritWarn.threshold + 2) {
        resolveAlert('BATT_SOC_CRIT');
      }

      if (settings.socLowWarn.enabled && d.soc <= settings.socLowWarn.threshold && d.soc > settings.socCritWarn.threshold) {
        triggerAlert({
          key: 'BATT_SOC_LOW',
          title: 'Low Battery Warning',
          category: 'BATTERY',
          severity: 'WARNING',
          valStr: d.soc + '%',
          thresholdStr: 'Threshold: ≤ ' + settings.socLowWarn.threshold + '%',
          rawValue: d.soc,
          cooldownSec: 30
        });
      } else if (d.soc >= settings.socLowWarn.threshold + 2) {
        resolveAlert('BATT_SOC_LOW');
      }
    }

    // 2. Cell Voltage Protection
    if (typeof d.maxV === 'number' && !isNaN(d.maxV)) {
      if (settings.cellHighWarn.enabled && d.maxV >= settings.cellHighWarn.threshold) {
        const cellLabel = d.maxCell ? ` (Cell #${d.maxCell})` : '';
        triggerAlert({
          key: 'CELL_HIGH_V',
          title: 'High Cell Voltage',
          category: 'CELLS',
          severity: 'WARNING',
          valStr: d.maxV.toFixed(3) + ' V' + cellLabel,
          thresholdStr: 'Max: ≥ ' + settings.cellHighWarn.threshold + ' V',
          rawValue: d.maxV,
          cooldownSec: 20
        });
      } else if (d.maxV <= settings.cellHighWarn.threshold - 0.03) {
        resolveAlert('CELL_HIGH_V');
      }
    }

    if (typeof d.minV === 'number' && !isNaN(d.minV) && d.minV > 1.2) { // Guard against 0V during disconnection
      if (settings.cellLowWarn.enabled && d.minV <= settings.cellLowWarn.threshold) {
        const cellLabel = d.minCell ? ` (Cell #${d.minCell})` : '';
        triggerAlert({
          key: 'CELL_LOW_V',
          title: 'Critical Low Cell Voltage',
          category: 'CELLS',
          severity: 'CRITICAL',
          valStr: d.minV.toFixed(3) + ' V' + cellLabel,
          thresholdStr: 'Min: ≤ ' + settings.cellLowWarn.threshold + ' V',
          rawValue: d.minV,
          cooldownSec: 15
        });
      } else if (d.minV >= settings.cellLowWarn.threshold + 0.04) {
        resolveAlert('CELL_LOW_V');
      }
    }

    // 3. Cell Imbalance Detection (Delta)
    if (typeof d.delta === 'number' && !isNaN(d.delta)) {
      const deltaMv = Math.round(d.delta * 1000);
      if (settings.cellImbalanceCrit.enabled && deltaMv >= settings.cellImbalanceCrit.threshold) {
        triggerAlert({
          key: 'CELL_DELTA_CRIT',
          title: 'Severe Cell Imbalance',
          category: 'CELLS',
          severity: 'CRITICAL',
          valStr: deltaMv + ' mV',
          thresholdStr: 'Max Delta: ≥ ' + settings.cellImbalanceCrit.threshold + ' mV',
          rawValue: deltaMv,
          cooldownSec: 25
        });
      } else if (deltaMv <= settings.cellImbalanceCrit.threshold - 10) {
        resolveAlert('CELL_DELTA_CRIT');
      }

      if (settings.cellImbalanceWarn.enabled && deltaMv >= settings.cellImbalanceWarn.threshold && deltaMv < settings.cellImbalanceCrit.threshold) {
        triggerAlert({
          key: 'CELL_DELTA_WARN',
          title: 'Cell Voltage Imbalance',
          category: 'CELLS',
          severity: 'WARNING',
          valStr: deltaMv + ' mV',
          thresholdStr: 'Threshold: ≥ ' + settings.cellImbalanceWarn.threshold + ' mV',
          rawValue: deltaMv,
          cooldownSec: 30
        });
      } else if (deltaMv <= settings.cellImbalanceWarn.threshold - 10) {
        resolveAlert('CELL_DELTA_WARN');
      }
    }

    // 4. Battery Pack Temperature Monitoring (Sensors T1 and T2)
    const tMax = Math.max(
      typeof d.t1 === 'number' && !isNaN(d.t1) ? d.t1 : -99,
      typeof d.t2 === 'number' && !isNaN(d.t2) ? d.t2 : -99
    );
    const tMin = Math.min(
      typeof d.t1 === 'number' && !isNaN(d.t1) ? d.t1 : 999,
      typeof d.t2 === 'number' && !isNaN(d.t2) ? d.t2 : 999
    );

    if (tMax > -90) {
      if (settings.packCritTempWarn.enabled && tMax >= settings.packCritTempWarn.threshold) {
        triggerAlert({
          key: 'PACK_TEMP_CRIT',
          title: 'Critical Battery Temperature',
          category: 'TEMP',
          severity: 'CRITICAL',
          valStr: tMax.toFixed(1) + ' °C',
          thresholdStr: 'Max: ≥ ' + settings.packCritTempWarn.threshold + ' °C',
          rawValue: tMax,
          cooldownSec: 20
        });
      } else if (tMax <= settings.packCritTempWarn.threshold - 3) {
        resolveAlert('PACK_TEMP_CRIT');
      }

      if (settings.packHighTempWarn.enabled && tMax >= settings.packHighTempWarn.threshold && tMax < settings.packCritTempWarn.threshold) {
        triggerAlert({
          key: 'PACK_TEMP_WARN',
          title: 'High Battery Temperature',
          category: 'TEMP',
          severity: 'WARNING',
          valStr: tMax.toFixed(1) + ' °C',
          thresholdStr: 'Threshold: ≥ ' + settings.packHighTempWarn.threshold + ' °C',
          rawValue: tMax,
          cooldownSec: 25
        });
      } else if (tMax <= settings.packHighTempWarn.threshold - 2) {
        resolveAlert('PACK_TEMP_WARN');
      }
    }

    if (tMin < 900 && tMin > -40) {
      if (settings.packLowTempWarn.enabled && tMin <= settings.packLowTempWarn.threshold) {
        triggerAlert({
          key: 'PACK_TEMP_LOW',
          title: 'Low Battery Temperature',
          category: 'TEMP',
          severity: 'WARNING',
          valStr: tMin.toFixed(1) + ' °C',
          thresholdStr: 'Min: ≤ ' + settings.packLowTempWarn.threshold + ' °C',
          rawValue: tMin,
          cooldownSec: 30
        });
      } else if (tMin >= settings.packLowTempWarn.threshold + 2) {
        resolveAlert('PACK_TEMP_LOW');
      }
    }

    // 5. MOSFET Power Board Temperature
    if (typeof d.mosTemp === 'number' && !isNaN(d.mosTemp)) {
      if (settings.mosHighTempWarn.enabled && d.mosTemp >= settings.mosHighTempWarn.threshold) {
        triggerAlert({
          key: 'MOS_TEMP_WARN',
          title: 'BMS MOSFET Overheat',
          category: 'TEMP',
          severity: 'WARNING',
          valStr: d.mosTemp.toFixed(1) + ' °C',
          thresholdStr: 'Threshold: ≥ ' + settings.mosHighTempWarn.threshold + ' °C',
          rawValue: d.mosTemp,
          cooldownSec: 25
        });
      } else if (d.mosTemp <= settings.mosHighTempWarn.threshold - 3) {
        resolveAlert('MOS_TEMP_WARN');
      }
    }

    // 6. Overcurrent Protection
    // Note: JK-BMS negative current = discharge, positive = charging
    if (typeof d.current === 'number' && !isNaN(d.current)) {
      const dischargeLimit = settings.overcurrentDischarge.threshold;
      if (settings.overcurrentDischarge.enabled && d.current <= -dischargeLimit) {
        triggerAlert({
          key: 'OVERCURRENT_DIS',
          title: 'High Discharge Current',
          category: 'BATTERY',
          severity: 'WARNING',
          valStr: Math.abs(d.current).toFixed(1) + ' A',
          thresholdStr: 'Limit: ' + dischargeLimit + ' A',
          rawValue: Math.abs(d.current),
          cooldownSec: 15
        });
      } else if (d.current >= -(dischargeLimit - 5)) {
        resolveAlert('OVERCURRENT_DIS');
      }

      const chargeLimit = settings.overcurrentCharge.threshold;
      if (settings.overcurrentCharge.enabled && d.current >= chargeLimit) {
        triggerAlert({
          key: 'OVERCURRENT_CHG',
          title: 'High Charge Current',
          category: 'BATTERY',
          severity: 'WARNING',
          valStr: '+' + d.current.toFixed(1) + ' A',
          thresholdStr: 'Limit: +' + chargeLimit + ' A',
          rawValue: d.current,
          cooldownSec: 15
        });
      } else if (d.current <= chargeLimit - 3) {
        resolveAlert('OVERCURRENT_CHG');
      }
    }

    // 7. BMS Hardware Error Bitmask
    if (typeof d.errors === 'number' && d.errors !== 0) {
      triggerAlert({
        key: 'BMS_HW_ERROR',
        title: 'BMS Protection Fault',
        category: 'BATTERY',
        severity: 'CRITICAL',
        valStr: 'Code: 0x' + d.errors.toString(16).toUpperCase(),
        thresholdStr: 'Hardware Fault Code Active',
        rawValue: d.errors,
        cooldownSec: 20
      });
    } else {
      resolveAlert('BMS_HW_ERROR');
    }
  }

  /* ---------------- Speed Monitoring ---------------- */
  function checkSpeed(kmh) {
    if (!settings.enabled || typeof kmh !== 'number' || isNaN(kmh) || kmh < 0) return;

    const cfg = settings.speedLimitWarn;
    if (!cfg || !cfg.enabled) {
      resolveAlert('VEHICLE_OVERSPEED');
      return;
    }

    const limit = cfg.threshold;
    const hyst = cfg.hysteresis || 3;
    const cooldown = cfg.cooldown || 15;

    if (kmh >= limit) {
      triggerAlert({
        key: 'VEHICLE_OVERSPEED',
        title: 'Speed Limit Exceeded',
        category: 'VEHICLE',
        severity: 'WARNING',
        valStr: Math.round(kmh) + ' km/h',
        thresholdStr: 'Configured Limit: ' + limit + ' km/h',
        rawValue: kmh,
        cooldownSec: cooldown
      });
    } else if (kmh <= (limit - hyst)) {
      resolveAlert('VEHICLE_OVERSPEED', 'Vehicle slowed to ' + Math.round(kmh) + ' km/h');
    }
  }

  /* ---------------- Connectivity Watchdogs ---------------- */
  function onBmsConnectionState(status) {
    if (status === 'connected') {
      bmsWasConnected = true;
      lastBmsPacketTime = Date.now();
      resolveAlert('BMS_COMM_LOST');
    } else if (status === 'disconnected' || status === 'error') {
      if (bmsWasConnected) {
        triggerAlert({
          key: 'BMS_COMM_LOST',
          title: 'BMS Connection Lost',
          category: 'DEVICE',
          severity: 'CRITICAL',
          valStr: 'Bluetooth Offline',
          thresholdStr: 'BMS Telemetry Interrupted',
          rawValue: 0,
          cooldownSec: 10
        });
      }
    }
  }

  function onGpsFix(timestamp) {
    lastGpsFixTime = timestamp || Date.now();
    gpsWasTracking = true;
    resolveAlert('GPS_SIGNAL_LOST');
  }

  function setGpsTracking(active) {
    gpsWasTracking = !!active;
    if (gpsWasTracking) {
      lastGpsFixTime = Date.now();
      resolveAlert('GPS_SIGNAL_LOST');
    } else {
      resolveAlert('GPS_SIGNAL_LOST');
    }
  }

  function startWatchdogLoop() {
    if (watchdogInterval) clearInterval(watchdogInterval);
    watchdogInterval = setInterval(() => {
      const now = Date.now();

      // BMS Watchdog
      if (settings.bmsWatchdog.enabled && bmsWasConnected) {
        const timeoutMs = (settings.bmsWatchdog.timeoutSec || 4) * 1000;
        if (now - lastBmsPacketTime > timeoutMs) {
          triggerAlert({
            key: 'BMS_COMM_LOST',
            title: 'BMS Telemetry Lost',
            category: 'DEVICE',
            severity: 'CRITICAL',
            valStr: 'No packets for > ' + settings.bmsWatchdog.timeoutSec + 's',
            thresholdStr: 'Watchdog Timeout: ' + settings.bmsWatchdog.timeoutSec + 's',
            rawValue: (now - lastBmsPacketTime) / 1000,
            cooldownSec: 15
          });
        }
      }

      // GPS Watchdog
      if (settings.gpsWatchdog.enabled && gpsWasTracking) {
        const timeoutMs = (settings.gpsWatchdog.timeoutSec || 10) * 1000;
        if (now - lastGpsFixTime > timeoutMs) {
          triggerAlert({
            key: 'GPS_SIGNAL_LOST',
            title: 'GPS Signal Lost',
            category: 'DEVICE',
            severity: 'WARNING',
            valStr: 'Searching for satellites…',
            thresholdStr: 'Watchdog Timeout: ' + settings.gpsWatchdog.timeoutSec + 's',
            rawValue: (now - lastGpsFixTime) / 1000,
            cooldownSec: 20
          });
        }
      }
    }, 1000);
  }

  /* ---------------- Event Dispatching ---------------- */
  function addListener(event, fn) {
    if (listeners[event] && typeof fn === 'function') {
      listeners[event].push(fn);
    }
  }

  function removeListener(event, fn) {
    if (listeners[event]) {
      listeners[event] = listeners[event].filter((f) => f !== fn);
    }
  }

  function emit(event, data) {
    if (!listeners[event]) return;
    listeners[event].forEach((fn) => {
      try {
        fn(data);
      } catch (e) {
        console.error('[AlertEngine] Listener error:', e);
      }
    });
  }

  // Public Interface
  window.AlertEngine = {
    init() {
      settings = loadSettings();
      history = loadHistory();
      startWatchdogLoop();
      return this;
    },
    getSettings() {
      return JSON.parse(JSON.stringify(settings));
    },
    saveSettings(newCfg) {
      return saveSettings(newCfg);
    },
    resetDefaults() {
      return resetDefaults();
    },
    getHistory(filter) {
      if (!filter || filter === 'ALL') return history;
      return history.filter((h) => h.severity === filter || h.category === filter);
    },
    getActiveAlerts() {
      return Array.from(activeAlerts.values());
    },
    getActiveCount() {
      return activeAlerts.size;
    },
    clearHistory() {
      clearHistory();
    },
    checkTelemetry(d) {
      checkTelemetry(d);
    },
    checkSpeed(kmh) {
      checkSpeed(kmh);
    },
    onBmsStatus(status) {
      onBmsConnectionState(status);
    },
    onGpsFix(ts) {
      onGpsFix(ts);
    },
    setGpsTracking(active) {
      setGpsTracking(active);
    },
    addListener(event, fn) {
      addListener(event, fn);
    },
    removeListener(event, fn) {
      removeListener(event, fn);
    },
    dismissAlert(key) {
      dismissAlert(key);
    },
    dismissActiveAlert(key) {
      dismissAlert(key);
      if (activeAlerts.has(key)) {
        activeAlerts.delete(key);
        emit('resolve', { key, dismissedManually: true });
      }
    },
    playTestSound(severity) {
      playAlertChime(severity || 'WARNING');
      triggerHaptic(severity || 'WARNING');
    }
  };

  // Initialize engine automatically on load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => window.AlertEngine.init());
  } else {
    window.AlertEngine.init();
  }

})(window);
