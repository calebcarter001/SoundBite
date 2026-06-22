const { spawnSync } = require('node:child_process');
const { listHidBatteryReports } = require('./battery');

const DEFAULT_DEVICE_SECURITY_POLICY = Object.freeze({
  allowOnlyUsbMics: true,
  requireKnownUsbTransport: true,
  rejectControlCapableUsbDevices: false
});

function normalizeDeviceSecurityPolicy(input = {}) {
  return {
    allowOnlyUsbMics: input.allowOnlyUsbMics !== false,
    requireKnownUsbTransport: input.requireKnownUsbTransport !== false,
    rejectControlCapableUsbDevices: input.rejectControlCapableUsbDevices === true
  };
}

function normalizeDeviceName(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[’‘`]/g, "'")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function baseDisplayName(value) {
  return String(value || '').replace(/\s+#\d+$/, '');
}

function parseCoreAudioInputDevices(input) {
  let payload = input;

  if (typeof input === 'string') {
    try {
      payload = JSON.parse(input);
    } catch (_error) {
      return [];
    }
  }

  const groups = Array.isArray(payload?.SPAudioDataType) ? payload.SPAudioDataType : [];
  const items = groups.flatMap((group) => Array.isArray(group?._items) ? group._items : []);

  return items
    .filter((item) => Number.parseInt(item?.coreaudio_device_input, 10) > 0)
    .map((item) => {
      const name = String(item._name || '').trim();

      return {
        name,
        nameKey: normalizeDeviceName(name),
        manufacturer: String(item.coreaudio_device_manufacturer || '').trim(),
        transport: String(item.coreaudio_device_transport || '').trim(),
        inputChannels: Number.parseInt(item.coreaudio_device_input, 10) || 0,
        sampleRate: Number.parseInt(item.coreaudio_device_srate, 10) || null,
        defaultInput: item.coreaudio_default_audio_input_device === 'spaudio_yes'
      };
    })
    .filter((item) => item.name);
}

function listCoreAudioInputDevices() {
  if (process.platform !== 'darwin') {
    return [];
  }

  const result = spawnSync('system_profiler', ['SPAudioDataType', '-json'], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  });

  if (result.error || result.status !== 0) {
    return [];
  }

  return parseCoreAudioInputDevices(result.stdout || '');
}

function isUsbTransport(transport) {
  return /\busb\b|_usb$/i.test(String(transport || ''));
}

function transportLabel(transport) {
  const value = String(transport || '').trim();

  if (!value) {
    return 'unreported';
  }

  return value
    .replace(/^coreaudio_device_type_/, '')
    .replace(/_/g, ' ');
}

function matchCoreAudioDevice(device, coreAudioInputDevices = []) {
  const candidates = [
    device?.name,
    device?.displayName,
    baseDisplayName(device?.displayName)
  ].map(normalizeDeviceName).filter(Boolean);

  return coreAudioInputDevices.find((item) => candidates.includes(item.nameKey)) || null;
}

function listUsbControlDevices(reports = listHidBatteryReports()) {
  return reports.filter((report) => (
    String(report.transport || '').toLowerCase() === 'usb'
    && (
      Number.isFinite(report.vendorId)
      || report.product
      || report.manufacturer
    )
  ));
}

function sanitizeControlReport(report) {
  return {
    product: report.product || null,
    manufacturer: report.manufacturer || null,
    vendorId: Number.isFinite(report.vendorId) ? report.vendorId : null,
    productId: Number.isFinite(report.productId) ? report.productId : null,
    serialNumber: report.serialNumber || null
  };
}

function controlReportMatchesAudioDevice(report, device) {
  const product = normalizeDeviceName(report.product);
  const manufacturer = normalizeDeviceName(report.manufacturer);
  const deviceNames = [
    device?.name,
    device?.displayName,
    baseDisplayName(device?.displayName),
    device?.nameSlug
  ].map(normalizeDeviceName).filter(Boolean);

  if (deviceNames.some((name) => product && (product.includes(name) || name.includes(product)))) {
    return true;
  }

  if (
    deviceNames.some((name) => name.includes('usbaudio'))
    && (product.includes('usbcompositedevice') || manufacturer.includes('jieli'))
  ) {
    return true;
  }

  return false;
}

function classifyAudioDeviceSecurity(device, options = {}) {
  const policy = normalizeDeviceSecurityPolicy(options.policy);
  const coreAudioDevice = matchCoreAudioDevice(device, options.coreAudioInputDevices || []);
  const usbControlDevices = options.usbControlDevices || [];
  const matchedControlDevices = usbControlDevices.filter((report) => controlReportMatchesAudioDevice(report, device));
  const transport = coreAudioDevice?.transport || '';
  const reasons = [];

  if (policy.allowOnlyUsbMics) {
    if (!coreAudioDevice) {
      reasons.push({
        code: 'coreaudio-missing',
        detail: 'Blocked because macOS did not list this input in the CoreAudio inventory.'
      });
    } else if (!isUsbTransport(transport)) {
      const label = transportLabel(transport);
      const detail = policy.requireKnownUsbTransport && (!transport || /unknown/i.test(transport))
        ? 'Blocked because macOS did not verify this input as USB audio.'
        : `Blocked because macOS reports ${label} transport, not USB audio.`;

      reasons.push({
        code: 'non-usb-audio',
        detail
      });
    }
  }

  if (
    policy.rejectControlCapableUsbDevices
    && isUsbTransport(transport)
    && matchedControlDevices.length
  ) {
    reasons.push({
      code: 'usb-control-interface',
      detail: 'Blocked because a matching USB HID/control interface is present for this audio device.'
    });
  }

  return {
    allowed: reasons.length === 0,
    reason: reasons[0]?.code || 'usb-audio-verified',
    detail: reasons[0]?.detail || 'USB audio transport verified by macOS.',
    transport: transport || null,
    transportLabel: transportLabel(transport),
    manufacturer: coreAudioDevice?.manufacturer || null,
    coreAudioName: coreAudioDevice?.name || null,
    controlInterfaceCount: matchedControlDevices.length,
    controlInterfaces: matchedControlDevices.map(sanitizeControlReport),
    policy
  };
}

function annotateAudioDeviceSecurity(audioDevices, options = {}) {
  return audioDevices.map((device) => ({
    ...device,
    security: classifyAudioDeviceSecurity(device, options)
  }));
}

function deviceSecurityError(device) {
  const name = device?.displayName || device?.name || 'Audio input';
  const detail = device?.security?.detail || 'Blocked by the SoundBite device security policy.';

  return `${name} cannot be used for recording. ${detail}`;
}

function securitySummary(devices = [], usbControlDevices = []) {
  const blocked = devices.filter((device) => device.security && !device.security.allowed);
  const allowed = devices.filter((device) => device.security?.allowed);

  return {
    allowedCount: allowed.length,
    blockedCount: blocked.length,
    usbControlDeviceCount: usbControlDevices.length,
    blockedDevices: blocked.map((device) => ({
      key: device.key,
      displayName: device.displayName || device.name,
      reason: device.security.reason,
      detail: device.security.detail,
      transport: device.security.transport
    })),
    appPrivilegeBoundary: 'SoundBite denies renderer USB, HID, serial, display-capture, and control-style permissions. macOS still owns physical device attach and HID input handling outside this app.'
  };
}

module.exports = {
  DEFAULT_DEVICE_SECURITY_POLICY,
  annotateAudioDeviceSecurity,
  classifyAudioDeviceSecurity,
  deviceSecurityError,
  listCoreAudioInputDevices,
  listUsbControlDevices,
  normalizeDeviceName,
  normalizeDeviceSecurityPolicy,
  parseCoreAudioInputDevices,
  securitySummary
};
