const assert = require('node:assert/strict');
const test = require('node:test');
const {
  batteryStatusForAudioDevice,
  parseIoregBlocks,
  parseIoregValue
} = require('../src/battery');

const sampleIoreg = `
+-o AppleUserUSBHostHIDDevice
    {
      "VendorID" = 19530
      "ProductID" = 16725
      "Product" = "USB Composite Device"
      "Manufacturer" = "Jieli Technology"
      "SerialNumber" = "551194549AD3E005"
      "Transport" = "USB"
    }

+-o AppleDeviceManagementHIDEventService
    {
      "VendorID" = 76
      "ProductID" = 801
      "SerialNumber" = "38:09:FB:14:E0:37"
      "Transport" = "Bluetooth"
      "HasBattery" = Yes
      "BatteryPercent" = 29
    }
`;

test('parses ioreg scalar values', () => {
  assert.equal(parseIoregValue(sampleIoreg, 'VendorID'), 19530);
  assert.equal(parseIoregValue(sampleIoreg, 'Product'), 'USB Composite Device');
});

test('parses battery-capable and non-battery HID blocks', () => {
  const reports = parseIoregBlocks(sampleIoreg);

  assert.equal(reports.length, 2);
  assert.equal(reports[0].manufacturer, 'Jieli Technology');
  assert.equal(reports[0].batteryPercent, null);
  assert.equal(reports[1].batteryPercent, 29);
});

test('reports Jieli USB audio battery as unavailable when not exposed', () => {
  const status = batteryStatusForAudioDevice(
    { name: 'USBAudio1.0', displayName: 'USBAudio1.0' },
    parseIoregBlocks(sampleIoreg)
  );

  assert.equal(status.available, false);
  assert.match(status.detail, /no BatteryPercent/);
});

test('reports Jieli USB audio battery percentage when macOS exposes it', () => {
  const status = batteryStatusForAudioDevice(
    { name: 'USBAudio1.0', displayName: 'USBAudio1.0' },
    [{
      vendorId: 19530,
      productId: 16725,
      manufacturer: 'Jieli Technology',
      batteryPercent: 64,
      serialNumber: 'abc'
    }]
  );

  assert.equal(status.available, true);
  assert.equal(status.percent, 64);
});
