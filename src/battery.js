const { spawnSync } = require('node:child_process');

const JIELI_VENDOR_ID = 19530;

function parseIoregValue(block, key) {
  const pattern = new RegExp(`"${key.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}"\\s*=\\s*([^\\n]+)`);
  const match = block.match(pattern);

  if (!match) {
    return null;
  }

  const raw = match[1].trim();

  if (raw === 'Yes') {
    return true;
  }

  if (raw === 'No') {
    return false;
  }

  if (/^-?\d+$/.test(raw)) {
    return Number.parseInt(raw, 10);
  }

  const quoted = raw.match(/^"([^"]*)"$/);
  if (quoted) {
    return quoted[1];
  }

  return raw;
}

function parseIoregBlocks(output) {
  return String(output || '')
    .split(/\n(?=\+-o )/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => ({
      product: parseIoregValue(block, 'Product'),
      manufacturer: parseIoregValue(block, 'Manufacturer'),
      serialNumber: parseIoregValue(block, 'SerialNumber'),
      transport: parseIoregValue(block, 'Transport'),
      vendorId: parseIoregValue(block, 'VendorID'),
      productId: parseIoregValue(block, 'ProductID'),
      hasBattery: parseIoregValue(block, 'HasBattery'),
      batteryPercent: parseIoregValue(block, 'BatteryPercent'),
      batteryStatusFlags: parseIoregValue(block, 'BatteryStatusFlags'),
      exposesBatteryText: /Battery/.test(block)
    }));
}

function listHidBatteryReports() {
  const commands = [
    ['ioreg', ['-r', '-c', 'IOHIDDevice', '-d', '1', '-l', '-w', '0']],
    ['ioreg', ['-r', '-c', 'AppleDeviceManagementHIDEventService', '-d', '1', '-l', '-w', '0']]
  ];

  const reports = [];

  for (const [command, args] of commands) {
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024
    });

    if (result.error) {
      continue;
    }

    reports.push(...parseIoregBlocks(result.stdout || result.stderr || ''));
  }

  const seen = new Set();
  return reports.filter((report) => {
    const key = [
      report.vendorId,
      report.productId,
      report.serialNumber,
      report.transport,
      report.batteryPercent
    ].join(':');

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function batteryStatusForAudioDevice(device, reports = listHidBatteryReports()) {
  const isJieliAudio = String(device?.name || '').toLowerCase().includes('usbaudio')
    || String(device?.displayName || '').toLowerCase().includes('usbaudio');
  const jieliReports = reports.filter((report) => (
    report.vendorId === JIELI_VENDOR_ID
    || String(report.manufacturer || '').toLowerCase().includes('jieli')
    || String(report.product || '').toLowerCase().includes('usb composite device')
  ));
  const jieliBattery = jieliReports.find((report) => Number.isFinite(report.batteryPercent));

  if (isJieliAudio && jieliBattery) {
    return {
      available: true,
      percent: jieliBattery.batteryPercent,
      source: 'IOHID',
      detail: `Serial ${jieliBattery.serialNumber || 'unknown'}`
    };
  }

  if (isJieliAudio && jieliReports.length) {
    return {
      available: false,
      percent: null,
      source: 'IOHID',
      detail: 'Jieli USB HID is present, but macOS exposes no BatteryPercent field.'
    };
  }

  return {
    available: false,
    percent: null,
    source: 'macOS',
    detail: 'No battery telemetry was exposed for this audio input.'
  };
}

module.exports = {
  JIELI_VENDOR_ID,
  batteryStatusForAudioDevice,
  listHidBatteryReports,
  parseIoregBlocks,
  parseIoregValue
};
