const assert = require('node:assert/strict');
const test = require('node:test');
const { annotateAudioDevices } = require('../src/recorder');
const {
  annotateAudioDeviceSecurity,
  classifyAudioDeviceSecurity,
  normalizeDeviceSecurityPolicy,
  parseCoreAudioInputDevices
} = require('../src/device-policy');

const coreAudioInventory = {
  SPAudioDataType: [
    {
      _items: [
        {
          _name: 'USBAudio1.0',
          coreaudio_device_input: 1,
          coreaudio_device_manufacturer: 'Jieli Technology',
          coreaudio_device_transport: 'coreaudio_device_type_usb',
          coreaudio_device_srate: 48000
        },
        {
          _name: 'MacBook Pro Microphone',
          coreaudio_device_input: 1,
          coreaudio_device_manufacturer: 'Apple Inc.',
          coreaudio_device_transport: 'coreaudio_device_type_builtin',
          coreaudio_device_srate: 96000
        },
        {
          _name: 'Caleb’s Airpod Pro',
          coreaudio_device_input: 1,
          coreaudio_device_manufacturer: 'Apple Inc.',
          coreaudio_device_transport: 'coreaudio_device_type_bluetooth',
          coreaudio_device_srate: 24000
        },
        {
          _name: 'Caleb’s Microphone',
          coreaudio_device_input: 1,
          coreaudio_device_manufacturer: 'Apple Inc.',
          coreaudio_device_transport: 'coreaudio_device_type_unknown',
          coreaudio_device_srate: 48000
        }
      ]
    }
  ]
};

test('parses CoreAudio input transport metadata', () => {
  const inputs = parseCoreAudioInputDevices(coreAudioInventory);

  assert.deepEqual(inputs.map((input) => [input.name, input.transport]), [
    ['USBAudio1.0', 'coreaudio_device_type_usb'],
    ['MacBook Pro Microphone', 'coreaudio_device_type_builtin'],
    ['Caleb’s Airpod Pro', 'coreaudio_device_type_bluetooth'],
    ['Caleb’s Microphone', 'coreaudio_device_type_unknown']
  ]);
});

test('allows only macOS-verified USB audio inputs', () => {
  const devices = annotateAudioDevices([
    { index: 0, name: 'USBAudio1.0' },
    { index: 1, name: 'MacBook Pro Microphone' },
    { index: 2, name: 'Caleb’s Airpod Pro' },
    { index: 3, name: 'Caleb’s Microphone' }
  ]);
  const secured = annotateAudioDeviceSecurity(devices, {
    coreAudioInputDevices: parseCoreAudioInputDevices(coreAudioInventory),
    usbControlDevices: []
  });

  assert.equal(secured[0].security.allowed, true);
  assert.equal(secured[1].security.allowed, false);
  assert.equal(secured[2].security.allowed, false);
  assert.equal(secured[3].security.allowed, false);
  assert.equal(secured[3].security.detail, 'Blocked because macOS did not verify this input as USB audio.');
});

test('allows a USB audio input with a matching HID control interface by default', () => {
  const [device] = annotateAudioDevices([{ index: 0, name: 'USBAudio1.0' }]);
  const security = classifyAudioDeviceSecurity(device, {
    coreAudioInputDevices: parseCoreAudioInputDevices(coreAudioInventory),
    usbControlDevices: [
      {
        product: 'USB Composite Device',
        manufacturer: 'Jieli Technology',
        transport: 'USB',
        vendorId: 19530,
        productId: 16725
      }
    ]
  });

  assert.equal(security.allowed, true);
  assert.equal(security.reason, 'usb-audio-verified');
  assert.equal(security.controlInterfaceCount, 1);
});

test('can explicitly reject a USB audio input with a matching HID control interface', () => {
  const [device] = annotateAudioDevices([{ index: 0, name: 'USBAudio1.0' }]);
  const security = classifyAudioDeviceSecurity(device, {
    coreAudioInputDevices: parseCoreAudioInputDevices(coreAudioInventory),
    policy: { rejectControlCapableUsbDevices: true },
    usbControlDevices: [
      {
        product: 'USB Composite Device',
        manufacturer: 'Jieli Technology',
        transport: 'USB',
        vendorId: 19530,
        productId: 16725
      }
    ]
  });

  assert.equal(security.allowed, false);
  assert.equal(security.reason, 'usb-control-interface');
});

test('normalizes USB-audio device policy defaults', () => {
  assert.deepEqual(normalizeDeviceSecurityPolicy(), {
    allowOnlyUsbMics: true,
    requireKnownUsbTransport: true,
    rejectControlCapableUsbDevices: false
  });

  assert.deepEqual(normalizeDeviceSecurityPolicy({
    rejectControlCapableUsbDevices: true
  }), {
    allowOnlyUsbMics: true,
    requireKnownUsbTransport: true,
    rejectControlCapableUsbDevices: true
  });

  assert.deepEqual(normalizeDeviceSecurityPolicy({
    allowOnlyUsbMics: false,
    requireKnownUsbTransport: false,
    rejectControlCapableUsbDevices: false
  }), {
    allowOnlyUsbMics: false,
    requireKnownUsbTransport: false,
    rejectControlCapableUsbDevices: false
  });
});
