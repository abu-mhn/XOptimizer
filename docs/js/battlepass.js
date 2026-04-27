// Web Bluetooth port of:
//   lib/services/battle_pass.dart
//   lib/services/battle_pass_factory.dart
//   lib/structs/battlepass_ble_device.dart
//   lib/battlepass/battlepass_models.dart
//   lib/battlepass/battlepass_utils.dart
//
// Single self-contained ES module. Runs in Chromium-based browsers over HTTPS.
// `BattlePassFactory.scanForBattlePass()` MUST be called from a user gesture.

const HEADER_BYTE     = 0x51;
const GET_DATA_BYTE   = 0x74;
const CLEAR_DATA_BYTE = 0x75;

const SCAN_NAME = 'BEYBLADE_TOOL01';

// Web Bluetooth requires service UUIDs to be declared up front before GATT
// access is granted. Add the battlepass GATT service UUID(s) here, otherwise
// `getPrimaryServices()` will reject.
const OPTIONAL_SERVICES = [
  '55c40000-f8eb-11ec-b939-0242ac120002',
];

// ---------- utils ----------

function convertDataViewToHexString(view) {
  let s = '';
  for (let i = 0; i < view.byteLength; i++) {
    s += view.getUint8(i).toString(16).padStart(2, '0');
  }
  return s;
}

function convertBytesToHexString(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function waitWhile(test, { pollIntervalMs = 0, timeoutMs = 60000, timeoutMessage = 'Timed out' } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      let keepWaiting;
      try { keepWaiting = test(); } catch (e) { return reject(e); }
      if (!keepWaiting) return resolve();
      if (Date.now() - start >= timeoutMs) return reject(new Error(timeoutMessage));
      setTimeout(tick, pollIntervalMs);
    };
    tick();
  });
}

// Mirrors Dart `getBytes`: pull `words` bytes from `pos` and reverse byte order
// (little-endian hex → big-endian hex).
function getBytes(hexString, pos, words) {
  const seg = hexString.substring(pos, pos + words * 2);
  const n = seg.length;
  const flipped = new Array(n);
  for (let i = 0; i < n; i += 2) {
    flipped[i]     = seg[n - i - 2];
    flipped[i + 1] = seg[n - i - 1];
  }
  return flipped.join('');
}

function splitIntoChunksUntilZeros(input) {
  const chunks = [];
  for (let i = 0; i < input.length; i += 4) {
    const chunk = input.substring(i, i + 4);
    if (chunk === '0000') break;
    chunks.push(chunk);
  }
  return chunks;
}

async function sha256Hex(text) {
  const buf  = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}

// ---------- models ----------

class BattlePassHeader {
  constructor(maxLaunchSpeed, launchCount, pageCount, raw) {
    this.maxLaunchSpeed = maxLaunchSpeed;
    this.launchCount    = launchCount;
    this.pageCount      = pageCount;
    this.raw            = raw;
  }
  toJSON() {
    return {
      maxLaunchSpeed: this.maxLaunchSpeed,
      launchCount:    this.launchCount,
      pageCount:      this.pageCount,
      raw:            this.raw,
    };
  }
}

class BattlePassLaunchData {
  constructor(header, launches, raw) {
    this.header   = header;
    this.launches = launches;
    this.raw      = raw;
  }
  toJSON() {
    return { header: this.header.toJSON(), launches: this.launches, raw: this.raw };
  }
}

// ---------- ble device wrapper ----------

class BattlepassBleDevice {
  constructor({ device = null, address, name = '', rssi = -1 }) {
    this.device       = device;
    this.address      = address;
    this.name         = name;
    this.rssi         = rssi;
    this.battlepassID = null;
  }

  // Browsers do not expose MAC addresses; `device.id` is the closest stable
  // identifier and is used as the address surrogate.
  static async fromBluetooth(device, rssi = -1) {
    const inst = new BattlepassBleDevice({
      device,
      address: device.id,
      name:    device.name ?? '',
      rssi,
    });
    inst.battlepassID = (await sha256Hex(inst.address)).substring(0, 5);
    return inst;
  }
}

// ---------- main service (connect + protocol) ----------

function isUtilityService(uuid) {
  // Skip GAP (1800), GATT (1801), Device Information (180a), and the generic
  // 0000-prefixed services that the Dart code skips.
  const u = uuid.toLowerCase();
  return u.startsWith('00001800')
      || u.startsWith('00001801')
      || u.startsWith('0000180a')
      || u.startsWith('00001');
}

class BattlePass {
  static device      = null;  // BluetoothDevice
  static server      = null;  // BluetoothRemoteGATTServer
  static service     = null;  // BluetoothRemoteGATTService
  static readChar    = null;  // BluetoothRemoteGATTCharacteristic
  static writeChar   = null;  // BluetoothRemoteGATTCharacteristic
  static readBuffer  = [];
  static _onValue    = null;
  static _onDisconn  = null;

  static get isConnected() {
    return !!(BattlePass.device && BattlePass.device.gatt && BattlePass.device.gatt.connected);
  }

  static async connect(battlepass) {
    BattlePass.device = battlepass.device;
    if (!BattlePass.device) return;

    BattlePass.server = await BattlePass.device.gatt.connect();

    const services = await BattlePass.server.getPrimaryServices();
    let mainService = null;
    for (const svc of services) {
      if (isUtilityService(svc.uuid)) continue;
      mainService = svc;
      break;
    }
    if (!mainService) throw new Error('Unable to get Bluetooth characteristics');
    BattlePass.service = mainService;

    const chars = await mainService.getCharacteristics();
    // Web Bluetooth's getCharacteristics() doesn't guarantee a consistent
    // ordering across implementations, so identify by property rather than
    // index. Write char: write or writeWithoutResponse. Read char: notify
    // (or indicate as a fallback).
    let writeChar = null;
    let readChar  = null;
    for (const c of chars) {
      const p = c.properties;
      if (!writeChar && (p.write || p.writeWithoutResponse)) writeChar = c;
      if (!readChar && (p.notify || p.indicate))             readChar  = c;
    }
    if (!writeChar || !readChar) {
      throw new Error(
        `Unable to identify GATT characteristics ` +
        `(found ${chars.length}, write=${!!writeChar}, read=${!!readChar})`
      );
    }
    BattlePass.writeChar = writeChar;
    BattlePass.readChar  = readChar;

    BattlePass.readBuffer = [];
    BattlePass._onValue = (e) => {
      BattlePass.readBuffer.push(convertDataViewToHexString(e.target.value));
    };
    BattlePass.readChar.addEventListener('characteristicvaluechanged', BattlePass._onValue);
    await BattlePass.readChar.startNotifications();

    BattlePass._onDisconn = () => {
      if (BattlePass.readChar && BattlePass._onValue) {
        BattlePass.readChar.removeEventListener('characteristicvaluechanged', BattlePass._onValue);
      }
    };
    BattlePass.device.addEventListener('gattserverdisconnected', BattlePass._onDisconn);
  }

  static async disconnect() {
    if (!BattlePass.device) return;
    try {
      if (BattlePass.readChar) {
        if (BattlePass._onValue) {
          BattlePass.readChar.removeEventListener('characteristicvaluechanged', BattlePass._onValue);
        }
        try { await BattlePass.readChar.stopNotifications(); } catch (_) {}
      }
    } finally {
      try { BattlePass.device.gatt.disconnect(); } catch (_) {}
      if (BattlePass._onDisconn) {
        BattlePass.device.removeEventListener('gattserverdisconnected', BattlePass._onDisconn);
      }
      BattlePass.device     = null;
      BattlePass.server     = null;
      BattlePass.service    = null;
      BattlePass.readChar   = null;
      BattlePass.writeChar  = null;
      BattlePass._onValue   = null;
      BattlePass._onDisconn = null;
      BattlePass.readBuffer = [];
    }
  }

  static async _write(byte) {
    const buf = Uint8Array.of(byte);
    if (BattlePass.writeChar.writeValueWithoutResponse) {
      await BattlePass.writeChar.writeValueWithoutResponse(buf);
    } else {
      await BattlePass.writeChar.writeValue(buf);
    }
  }

  static async getHeader({ timeoutMs } = {}) {
    if (!BattlePass.device || !BattlePass.readChar || !BattlePass.writeChar) return null;

    // Discard any stale/unsolicited notifications (e.g. a connect-time packet)
    // so the `length !== 1` wait condition below isn't fooled by leftover data.
    BattlePass.readBuffer = [];
    await BattlePass._write(HEADER_BYTE);

    try {
      await waitWhile(
        () => BattlePass.readBuffer.length !== 1 && BattlePass.isConnected,
        { timeoutMessage: 'Timed Out While getting Header Info', timeoutMs },
      );
    } catch (e) {
      BattlePass.readBuffer = [];
      throw e;
    }

    if (!BattlePass.isConnected) {
      BattlePass.readBuffer = [];
      throw new Error('Lost connection to Battlepass While getting Header Info');
    }

    const header = BattlePass.readBuffer[0];
    BattlePass.readBuffer = [];

    const maxLaunchSpeed = parseInt(getBytes(header, 14, 2), 16);
    const launchCount    = parseInt(getBytes(header, 18, 2), 16);
    const pageCount      = 'b7'; // matches Dart override (raw header byte ignored)

    return new BattlePassHeader(maxLaunchSpeed, launchCount, pageCount, header);
  }

  static async getLaunchData() {
    // The header request must precede each data request — the device appears
    // to use it as a position-reset for the data response. Skipping it (e.g.
    // by reusing a previously-fetched header) caused getLaunchData to return
    // only the newest record instead of the full list.
    const header = await BattlePass.getHeader();
    if (!header) return null;

    // Discard any stragglers (late header echo, unsolicited push) that landed
    // between the inner getHeader returning and us issuing the data write.
    // Without this, a stray notif gets concatenated onto the launches string
    // and parses as a phantom record.
    BattlePass.readBuffer = [];
    await BattlePass._write(GET_DATA_BYTE);

    try {
      await waitWhile(
        () => BattlePass.readBuffer.length === 0 && BattlePass.isConnected,
        { timeoutMessage: 'Timed Out While Getting First Launch Data' },
      );
    } catch (e) {
      BattlePass.readBuffer = [];
      throw e;
    }

    if (!BattlePass.isConnected) {
      BattlePass.readBuffer = [];
      throw new Error('Lost connection to Battlepass While Getting First Launch Data');
    }

    try {
      await waitWhile(
        () =>
          !BattlePass.readBuffer[BattlePass.readBuffer.length - 1].startsWith(header.pageCount)
          && BattlePass.isConnected,
        {
          timeoutMessage:
            `{ "error": "Timed Out While Getting Launch Data", "stack": ${JSON.stringify(BattlePass.readBuffer)} }`,
        },
      );
    } catch (e) {
      BattlePass.readBuffer = [];
      throw e;
    }

    if (!BattlePass.isConnected) {
      BattlePass.readBuffer = [];
      throw new Error('Lost connection to Battlepass While Getting Launch Data');
    }

    const launches = BattlePass.readBuffer.map(s => s.substring(2)).join('');
    BattlePass.readBuffer = [];

    const launchArray  = splitIntoChunksUntilZeros(launches);
    const launchPoints = launchArray.map(s => parseInt(getBytes(s, 0, 2), 16));

    return new BattlePassLaunchData(header, launchPoints, launches);
  }

  static async clearData() {
    BattlePass.readBuffer = [];
    await BattlePass._write(CLEAR_DATA_BYTE);

    try {
      await waitWhile(
        () => BattlePass.readBuffer.length < 2 && BattlePass.isConnected,
        { timeoutMessage: 'Timed Out While Clearing Battlepass' },
      );
    } catch (e) {
      BattlePass.readBuffer = [];
      throw e;
    }

    if (!BattlePass.isConnected) {
      BattlePass.readBuffer = [];
      throw new Error('Lost connection to Battlepass While Clearing Battlepass');
    }

    const pageCount = getBytes(BattlePass.readBuffer[1], 22, 1);

    try {
      await waitWhile(
        () =>
          !BattlePass.readBuffer[BattlePass.readBuffer.length - 1].startsWith(pageCount)
          && BattlePass.isConnected,
        { timeoutMessage: 'Timed Out While Verifying Battlepass Data' },
      );
    } catch (e) {
      BattlePass.readBuffer = [];
      throw e;
    }

    if (!BattlePass.isConnected) {
      BattlePass.readBuffer = [];
      throw new Error('Lost connection to Battlepass While Verifying Battlepass Data');
    }

    BattlePass.readBuffer = [];
  }

  static async getDebugInformation() {
    if (!BattlePass.device) throw new Error('connection error');

    const data = {
      services:            [],
      mainService:         null,
      readCharacteristic:  null,
      writeCharacteristic: null,
      debugHeaderData:     'NULL',
      debugLaunchData:     'NULL',
      errors:              [],
    };

    const services = await BattlePass.server.getPrimaryServices();
    for (const svc of services) {
      const chars = await svc.getCharacteristics();
      data.services.push({
        uuid: svc.uuid,
        characteristics: chars.map(c => ({ uuid: c.uuid })),
      });
    }

    let mainService = null;
    for (const svc of services) {
      if (isUtilityService(svc.uuid)) continue;
      mainService = svc;
      break;
    }
    if (!mainService) return data;

    data.mainService = mainService.uuid;
    const chars = await mainService.getCharacteristics();
    data.writeCharacteristic = chars[0]?.uuid ?? null;
    data.readCharacteristic  = chars[1]?.uuid ?? null;

    try {
      const header = await BattlePass.getHeader();
      if (header) data.debugHeaderData = header.toJSON();
      const launch = await BattlePass.getLaunchData();
      if (launch) data.debugLaunchData = launch.toJSON();
    } catch (err) {
      data.errors.push(JSON.stringify(String(err)));
    }

    return data;
  }
}

// ---------- factory (scan + connect) ----------

class BattlePassFactory {
  static currentList = [];
  static _listeners  = new Set();

  // Web Bluetooth has no continuous scan; `requestDevice` opens a chooser
  // dialog and resolves with the picked device. Must be invoked from a user
  // gesture (click handler, etc.).
  static async scanForBattlePass({ optionalServices = OPTIONAL_SERVICES } = {}) {
    if (!('bluetooth' in navigator)) {
      throw new Error('Web Bluetooth is not supported in this browser.');
    }
    const device  = await navigator.bluetooth.requestDevice({
      filters: [{ name: SCAN_NAME }],
      optionalServices,
    });
    const wrapped = await BattlepassBleDevice.fromBluetooth(device);
    BattlePassFactory.currentList = [wrapped];
    BattlePassFactory._emit();
    return wrapped;
  }

  static async endScanForBattlePass() {
    // No-op: requestDevice resolves once the user has picked.
  }

  static onScanResults(listener) {
    BattlePassFactory._listeners.add(listener);
    listener(BattlePassFactory.currentList);
    return () => BattlePassFactory._listeners.delete(listener);
  }

  static _emit() {
    for (const l of BattlePassFactory._listeners) {
      try { l(BattlePassFactory.currentList); } catch (_) {}
    }
  }

  static async connectToBattlePass(device) {
    return BattlePass.connect(device);
  }
}

// ---------- exports ----------

export {
  HEADER_BYTE,
  GET_DATA_BYTE,
  CLEAR_DATA_BYTE,
  SCAN_NAME,
  OPTIONAL_SERVICES,
  BattlePass,
  BattlePassFactory,
  BattlePassHeader,
  BattlePassLaunchData,
  BattlepassBleDevice,
  convertDataViewToHexString,
  convertBytesToHexString,
  waitWhile,
  getBytes,
  splitIntoChunksUntilZeros,
  sha256Hex,
};
