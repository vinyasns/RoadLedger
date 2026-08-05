import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKUP_VERSION,
  buildMonthlyTotals,
  buildStationStats,
  calculateFuelEconomy,
  calculateStats,
  getReminders,
  parseCSV,
  stringifyCSV,
  toCanonicalDistance,
  toCanonicalVolume,
  validateBackup
} from '../js/domain.js';

test('converts display units into canonical values', () => {
  assert.ok(Math.abs(toCanonicalDistance(100, 'mi') - 160.9344) < 0.0001);
  assert.ok(Math.abs(toCanonicalVolume(10, 'gal') - 37.85411784) < 0.0001);
  assert.equal(toCanonicalDistance(125, 'km'), 125);
  assert.equal(toCanonicalVolume(40, 'L'), 40);
});

test('calculates full-to-full economy and accumulates partial fills', () => {
  const logs = [
    { id: 'a', vehicleId: 'v', date: '2026-01-01', odometerKm: 1000, quantityLiters: 30, fullTank: true },
    { id: 'b', vehicleId: 'v', date: '2026-01-10', odometerKm: 1200, quantityLiters: 12, fullTank: false },
    { id: 'c', vehicleId: 'v', date: '2026-01-20', odometerKm: 1500, quantityLiters: 23, fullTank: true }
  ];
  const segments = calculateFuelEconomy(logs);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].distanceKm, 500);
  assert.equal(segments[0].volumeLiters, 35);
  assert.ok(Math.abs(segments[0].kmPerLiter - 14.285714) < 0.00001);
});

test('excludes a segment containing a missed fill and resumes at next baseline', () => {
  const logs = [
    { id: 'a', vehicleId: 'v', date: '2026-01-01', odometerKm: 1000, quantityLiters: 30, fullTank: true },
    { id: 'b', vehicleId: 'v', date: '2026-01-20', odometerKm: 1500, quantityLiters: 32, fullTank: true, missedFill: true },
    { id: 'c', vehicleId: 'v', date: '2026-02-10', odometerKm: 2000, quantityLiters: 25, fullTank: true }
  ];
  const segments = calculateFuelEconomy(logs);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].fromLogId, 'b');
  assert.equal(segments[0].toLogId, 'c');
  assert.equal(segments[0].kmPerLiter, 20);
});

test('attributes station economy to the starting full tank and excludes mixed partial-fill segments', () => {
  const data = {
    vehicles: [{ id: 'v', name: 'Bike' }],
    fuelLogs: [
      { id: 'a', vehicleId: 'v', date: '2026-01-01', odometerKm: 1000, quantityLiters: 30, totalCostMinor: 300000, station: 'Alpha Fuel', fullTank: true },
      { id: 'b', vehicleId: 'v', date: '2026-01-10', odometerKm: 1500, quantityLiters: 25, totalCostMinor: 262500, station: 'Beta Fuel', fullTank: true },
      { id: 'c', vehicleId: 'v', date: '2026-01-16', odometerKm: 1700, quantityLiters: 10, totalCostMinor: 105000, station: 'Corner Pump', fullTank: false },
      { id: 'd', vehicleId: 'v', date: '2026-01-24', odometerKm: 2000, quantityLiters: 18, totalCostMinor: 198000, station: 'Alpha Fuel', fullTank: true }
    ],
    serviceRecords: []
  };
  const stations = buildStationStats(data, 'v');
  const alpha = stations.find((station) => station.name === 'Alpha Fuel');
  const beta = stations.find((station) => station.name === 'Beta Fuel');
  assert.equal(alpha.fillCount, 2);
  assert.equal(alpha.segmentCount, 1);
  assert.equal(alpha.averageKmPerLiter, 20);
  assert.equal(beta.segmentCount, 0);
});

test('aggregates fuel, service and expense spending separately', () => {
  const data = {
    vehicles: [{ id: 'v', initialOdometerKm: 0 }],
    fuelLogs: [
      { id: 'a', vehicleId: 'v', date: '2026-01-01', odometerKm: 1000, quantityLiters: 20, totalCostMinor: 20000, fullTank: true },
      { id: 'b', vehicleId: 'v', date: '2026-02-01', odometerKm: 1400, quantityLiters: 25, totalCostMinor: 25000, fullTank: true }
    ],
    serviceRecords: [
      { id: 's', kind: 'service', vehicleId: 'v', date: '2026-01-15', odometerKm: 1200, totalCostMinor: 10000 },
      { id: 'e', kind: 'expense', vehicleId: 'v', date: '2026-01-20', odometerKm: 1250, totalCostMinor: 5000 }
    ]
  };
  const stats = calculateStats(data, 'v');
  assert.equal(stats.fuelSpend, 45000);
  assert.equal(stats.serviceSpend, 10000);
  assert.equal(stats.expenseSpend, 5000);
  assert.equal(stats.totalSpend, 60000);
  assert.equal(stats.distanceKm, 400);
});

test('builds every intervening month for an all-time report', () => {
  const data = {
    vehicles: [{ id: 'v', name: 'Bike' }],
    fuelLogs: [
      { id: 'a', vehicleId: 'v', date: '2024-11-10', totalCostMinor: 10000 },
      { id: 'b', vehicleId: 'v', date: '2025-02-02', totalCostMinor: 20000 }
    ],
    serviceRecords: []
  };
  const months = buildMonthlyTotals(data, 'v', null, null);
  assert.deepEqual(months.map((month) => month.key), ['2024-11', '2024-12', '2025-01', '2025-02']);
  assert.equal(months[1].total, 0);
  assert.equal(months[2].total, 0);
});

test('round-trips quoted and multiline CSV values', () => {
  const columns = ['kind', 'notes', 'cost'];
  const csv = stringifyCSV([{ kind: 'fuel', notes: 'Premium, "full"\nreceipt saved', cost: '42.00' }], columns);
  assert.deepEqual(parseCSV(csv), [{ kind: 'fuel', notes: 'Premium, "full"\nreceipt saved', cost: '42.00' }]);
});

test('validates a portable backup and vehicle relationships', () => {
  const payload = {
    format: 'roadledger-backup',
    version: BACKUP_VERSION,
    data: {
      vehicles: [{ id: 'v', name: 'Bike' }],
      fuelLogs: [{ id: 'f', vehicleId: 'v', date: '2026-01-01' }],
      serviceRecords: [],
      settings: { currency: 'INR' }
    }
  };
  assert.equal(validateBackup(payload).valid, true);
  payload.data.fuelLogs[0].vehicleId = 'missing';
  assert.equal(validateBackup(payload).valid, false);
});

test('a later service supersedes an older reminder for the same category', () => {
  const data = {
    vehicles: [{ id: 'v', name: 'Bike', initialOdometerKm: 0 }],
    fuelLogs: [],
    serviceRecords: [
      { id: 'old', kind: 'service', vehicleId: 'v', category: 'Oil change', date: '2026-01-01', odometerKm: 1000, nextDueDate: '2026-03-01' },
      { id: 'new', kind: 'service', vehicleId: 'v', category: 'Oil change', date: '2026-03-02', odometerKm: 2000, nextDueDate: '2026-09-01' }
    ]
  };
  const reminders = getReminders(data, 'v', new Date(2026, 3, 1));
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].id, 'new');
});
