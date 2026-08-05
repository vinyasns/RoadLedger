export const APP_VERSION = '1.0.0';
export const BACKUP_VERSION = 1;

export const DEFAULT_SETTINGS = Object.freeze({
  id: 'app',
  currency: 'INR',
  distanceUnit: 'km',
  volumeUnit: 'L',
  consumptionUnit: 'km/L',
  theme: 'auto',
  selectedVehicleId: 'all',
  lastBackupAt: null,
  createdAt: null
});

export const SERVICE_CATEGORIES = Object.freeze([
  'Oil change',
  'Scheduled service',
  'Tyres',
  'Brakes',
  'Battery',
  'Filters',
  'Chain and sprockets',
  'Inspection',
  'Repair',
  'Cleaning',
  'Other service'
]);

export const EXPENSE_CATEGORIES = Object.freeze([
  'Insurance',
  'Registration and tax',
  'Parking',
  'Tolls',
  'Accessories',
  'Loan payment',
  'Fine',
  'Other expense'
]);

export const CURRENCIES = Object.freeze([
  ['INR', 'Indian Rupee'],
  ['USD', 'US Dollar'],
  ['EUR', 'Euro'],
  ['GBP', 'British Pound'],
  ['AUD', 'Australian Dollar'],
  ['CAD', 'Canadian Dollar'],
  ['JPY', 'Japanese Yen'],
  ['SGD', 'Singapore Dollar'],
  ['AED', 'UAE Dirham'],
  ['BRL', 'Brazilian Real']
]);

const KM_PER_MILE = 1.609344;
const LITERS_PER_US_GALLON = 3.785411784;
const MPG_PER_KM_L = 2.352145833;

export function createId(prefix = 'item') {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${id}`;
}

export function todayISO(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function parseLocalDate(value) {
  if (!value || typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDate(value, options = {}) {
  const date = parseLocalDate(value);
  if (!date) return 'Unknown date';
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: options.short ? 'short' : 'long',
    year: options.year === false ? undefined : 'numeric'
  }).format(date);
}

export function monthKey(value) {
  const date = typeof value === 'string' ? parseLocalDate(value) : value;
  if (!date) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function addDays(date, amount) {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  result.setDate(result.getDate() + amount);
  return result;
}

export function daysBetween(from, to) {
  const start = typeof from === 'string' ? parseLocalDate(from) : from;
  const end = typeof to === 'string' ? parseLocalDate(to) : to;
  if (!start || !end) return 0;
  return Math.round((end.getTime() - start.getTime()) / 86400000);
}

export function toCanonicalDistance(value, unit = 'km') {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return unit === 'mi' ? number * KM_PER_MILE : number;
}

export function fromCanonicalDistance(km, unit = 'km') {
  const number = Number(km);
  if (!Number.isFinite(number)) return 0;
  return unit === 'mi' ? number / KM_PER_MILE : number;
}

export function toCanonicalVolume(value, unit = 'L') {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return unit === 'gal' ? number * LITERS_PER_US_GALLON : number;
}

export function fromCanonicalVolume(liters, unit = 'L') {
  const number = Number(liters);
  if (!Number.isFinite(number)) return 0;
  return unit === 'gal' ? number / LITERS_PER_US_GALLON : number;
}

export function moneyToMinor(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) : 0;
}

export function minorToMoney(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number / 100 : 0;
}

export function formatMoney(minor, currency = 'INR', options = {}) {
  const value = minorToMoney(minor);
  const absolute = Math.abs(value);
  const compact = options.compact && absolute >= 10000;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      notation: compact ? 'compact' : 'standard',
      maximumFractionDigits: compact ? 1 : absolute % 1 === 0 ? 0 : 2
    }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

export function formatNumber(value, maximumFractionDigits = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return new Intl.NumberFormat(undefined, { maximumFractionDigits }).format(number);
}

export function formatDistance(km, settings, options = {}) {
  const value = fromCanonicalDistance(km, settings.distanceUnit);
  const digits = options.precise ? 1 : value >= 100 ? 0 : 1;
  return `${formatNumber(value, digits)} ${settings.distanceUnit}`;
}

export function formatVolume(liters, settings) {
  return `${formatNumber(fromCanonicalVolume(liters, settings.volumeUnit), 2)} ${settings.volumeUnit}`;
}

export function formatEfficiency(kmPerLiter, unit = 'km/L') {
  const value = Number(kmPerLiter);
  if (!Number.isFinite(value) || value <= 0) return '—';
  if (unit === 'L/100km') return `${formatNumber(100 / value, 1)} L/100km`;
  if (unit === 'mpg') return `${formatNumber(value * MPG_PER_KM_L, 1)} mpg`;
  return `${formatNumber(value, 1)} km/L`;
}

export function escapeHTML(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function currentOdometer(vehicle, fuelLogs = [], serviceRecords = []) {
  const values = [Number(vehicle?.initialOdometerKm) || 0];
  for (const record of fuelLogs) {
    if (record.vehicleId === vehicle?.id) values.push(Number(record.odometerKm) || 0);
  }
  for (const record of serviceRecords) {
    if (record.vehicleId === vehicle?.id) values.push(Number(record.odometerKm) || 0);
  }
  return Math.max(...values);
}

export function sortRecordsNewest(records) {
  return [...records].sort((a, b) => {
    const dateDifference = String(b.date).localeCompare(String(a.date));
    if (dateDifference) return dateDifference;
    return String(b.updatedAt ?? b.createdAt ?? '').localeCompare(String(a.updatedAt ?? a.createdAt ?? ''));
  });
}

export function unifiedRecords(data, vehicleId = 'all') {
  const vehicles = new Map(data.vehicles.map((vehicle) => [vehicle.id, vehicle]));
  const allowed = (record) => vehicleId === 'all' || record.vehicleId === vehicleId;
  const fuel = data.fuelLogs.filter(allowed).map((record) => ({ ...record, kind: 'fuel', vehicle: vehicles.get(record.vehicleId) }));
  const service = data.serviceRecords.filter(allowed).map((record) => ({ ...record, kind: record.kind === 'expense' ? 'expense' : 'service', vehicle: vehicles.get(record.vehicleId) }));
  return sortRecordsNewest([...fuel, ...service]);
}

export function calculateFuelEconomy(fuelLogs, vehicleId = null) {
  const relevant = fuelLogs
    .filter((log) => !vehicleId || log.vehicleId === vehicleId)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));

  const states = new Map();
  const segments = [];
  for (const log of relevant) {
    let state = states.get(log.vehicleId) ?? { baseline: null, volume: 0, invalid: false, hadPartialFill: false, fillLogIds: [] };
    if (!state.baseline) {
      if (log.fullTank) state.baseline = log;
      states.set(log.vehicleId, state);
      continue;
    }

    state.volume += Math.max(0, Number(log.quantityLiters) || 0);
    state.fillLogIds.push(log.id);
    if (log.missedFill) state.invalid = true;
    if (!log.fullTank) state.hadPartialFill = true;

    if (log.fullTank) {
      const distanceKm = (Number(log.odometerKm) || 0) - (Number(state.baseline.odometerKm) || 0);
      if (!state.invalid && distanceKm > 0 && state.volume > 0) {
        segments.push({
          vehicleId: log.vehicleId,
          fromLogId: state.baseline.id,
          toLogId: log.id,
          date: log.date,
          distanceKm,
          volumeLiters: state.volume,
          kmPerLiter: distanceKm / state.volume,
          sourceStation: String(state.baseline.station ?? '').trim(),
          sourceFuelGrade: String(state.baseline.fuelGrade ?? '').trim(),
          destinationStation: String(log.station ?? '').trim(),
          hadPartialFill: state.hadPartialFill,
          fillLogIds: [...state.fillLogIds]
        });
      }
      state = { baseline: log, volume: 0, invalid: false, hadPartialFill: false, fillLogIds: [] };
    }
    states.set(log.vehicleId, state);
  }
  return segments;
}

export function buildStationStats(data, vehicleId = 'all', cutoffDate = null) {
  const matchesVehicle = (record) => vehicleId === 'all' || record.vehicleId === vehicleId;
  const logs = filterByPeriod(data.fuelLogs.filter(matchesVehicle), cutoffDate);
  const stations = new Map();

  function stationBucket(name) {
    const cleaned = String(name ?? '').trim();
    if (!cleaned) return null;
    const key = cleaned.toLocaleLowerCase();
    const existing = stations.get(key) ?? {
      key,
      name: cleaned,
      fillCount: 0,
      spendMinor: 0,
      volumeLiters: 0,
      segmentCount: 0,
      economyDistanceKm: 0,
      economyVolumeLiters: 0,
      lowestKmPerLiter: Infinity,
      highestKmPerLiter: 0,
      latestDate: ''
    };
    stations.set(key, existing);
    return existing;
  }

  for (const log of logs) {
    const station = stationBucket(log.station);
    if (!station) continue;
    station.fillCount += 1;
    station.spendMinor += Number(log.totalCostMinor) || 0;
    station.volumeLiters += Number(log.quantityLiters) || 0;
    if (String(log.date) >= station.latestDate) {
      station.latestDate = String(log.date);
      station.name = String(log.station).trim();
    }
  }

  const segments = filterByPeriod(calculateFuelEconomy(data.fuelLogs, vehicleId === 'all' ? null : vehicleId), cutoffDate);
  for (const segment of segments) {
    if (segment.hadPartialFill || !segment.sourceStation) continue;
    const station = stationBucket(segment.sourceStation);
    station.segmentCount += 1;
    station.economyDistanceKm += segment.distanceKm;
    station.economyVolumeLiters += segment.volumeLiters;
    station.lowestKmPerLiter = Math.min(station.lowestKmPerLiter, segment.kmPerLiter);
    station.highestKmPerLiter = Math.max(station.highestKmPerLiter, segment.kmPerLiter);
  }

  return [...stations.values()]
    .map((station) => ({
      ...station,
      averageKmPerLiter: station.economyVolumeLiters > 0 ? station.economyDistanceKm / station.economyVolumeLiters : 0,
      averagePriceMinorPerLiter: station.volumeLiters > 0 ? station.spendMinor / station.volumeLiters : 0,
      lowestKmPerLiter: Number.isFinite(station.lowestKmPerLiter) ? station.lowestKmPerLiter : 0
    }))
    .sort((a, b) => Number(b.segmentCount > 0) - Number(a.segmentCount > 0) || b.segmentCount - a.segmentCount || b.fillCount - a.fillCount || b.latestDate.localeCompare(a.latestDate));
}

export function getCutoffDate(period, now = new Date()) {
  if (period === 'all') return null;
  const days = Number(period);
  if (!Number.isFinite(days)) return null;
  return todayISO(addDays(now, -days));
}

export function filterByPeriod(records, cutoffDate) {
  if (!cutoffDate) return [...records];
  return records.filter((record) => String(record.date) >= cutoffDate);
}

export function calculateStats(data, vehicleId = 'all', cutoffDate = null) {
  const matchesVehicle = (record) => vehicleId === 'all' || record.vehicleId === vehicleId;
  const fuelLogs = filterByPeriod(data.fuelLogs.filter(matchesVehicle), cutoffDate);
  const serviceRecords = filterByPeriod(data.serviceRecords.filter(matchesVehicle), cutoffDate);
  const fuelSpend = fuelLogs.reduce((sum, item) => sum + (Number(item.totalCostMinor) || 0), 0);
  const serviceSpend = serviceRecords.filter((item) => item.kind !== 'expense').reduce((sum, item) => sum + (Number(item.totalCostMinor) || 0), 0);
  const expenseSpend = serviceRecords.filter((item) => item.kind === 'expense').reduce((sum, item) => sum + (Number(item.totalCostMinor) || 0), 0);
  const fuelVolume = fuelLogs.reduce((sum, item) => sum + (Number(item.quantityLiters) || 0), 0);
  const odometers = [...fuelLogs, ...serviceRecords].map((item) => Number(item.odometerKm)).filter(Number.isFinite);
  const distanceKm = odometers.length >= 2 ? Math.max(...odometers) - Math.min(...odometers) : 0;
  const allSegments = calculateFuelEconomy(data.fuelLogs, vehicleId === 'all' ? null : vehicleId);
  const segments = filterByPeriod(allSegments, cutoffDate);
  const segmentDistance = segments.reduce((sum, item) => sum + item.distanceKm, 0);
  const segmentVolume = segments.reduce((sum, item) => sum + item.volumeLiters, 0);
  const averageKmPerLiter = segmentDistance > 0 && segmentVolume > 0 ? segmentDistance / segmentVolume : 0;
  const totalSpend = fuelSpend + serviceSpend + expenseSpend;

  return {
    fuelLogs,
    serviceRecords,
    fuelSpend,
    serviceSpend,
    expenseSpend,
    totalSpend,
    fuelVolume,
    distanceKm,
    averageKmPerLiter,
    costPerKmMinor: distanceKm > 0 ? Math.round(totalSpend / distanceKm) : 0,
    segments,
    recordCount: fuelLogs.length + serviceRecords.length
  };
}

export function buildMonthlyTotals(data, vehicleId = 'all', cutoffDate = null, maxBuckets = 12) {
  const records = filterByPeriod(unifiedRecords(data, vehicleId), cutoffDate);
  const totals = new Map();
  for (const record of records) {
    const key = monthKey(record.date);
    if (!key) continue;
    const bucket = totals.get(key) ?? { key, fuel: 0, service: 0, expense: 0, total: 0 };
    const amount = Number(record.totalCostMinor) || 0;
    bucket[record.kind] += amount;
    bucket.total += amount;
    totals.set(key, bucket);
  }

  let keys = [...totals.keys()].sort();
  if (!keys.length) {
    const now = new Date();
    keys = [monthKey(now)];
  }
  const firstKey = keys[0];
  const lastKey = keys.at(-1);
  const [firstYear, firstMonth] = firstKey.split('-').map(Number);
  const [lastYear, lastMonth] = lastKey.split('-').map(Number);
  const completeHistoryCount = Math.max(1, (lastYear - firstYear) * 12 + lastMonth - firstMonth + 1);
  const count = maxBuckets === null
    ? completeHistoryCount
    : Math.max(1, Number(maxBuckets) || 12);
  const complete = [];
  for (let index = count - 1; index >= 0; index -= 1) {
    const date = new Date(lastYear, lastMonth - 1 - index, 1);
    const key = monthKey(date);
    complete.push(totals.get(key) ?? { key, fuel: 0, service: 0, expense: 0, total: 0 });
  }
  return complete;
}

export function categoryTotals(data, vehicleId = 'all', cutoffDate = null) {
  const rows = filterByPeriod(
    data.serviceRecords.filter((record) => vehicleId === 'all' || record.vehicleId === vehicleId),
    cutoffDate
  );
  const totals = new Map();
  for (const record of rows) {
    const key = record.category || (record.kind === 'expense' ? 'Other expense' : 'Other service');
    totals.set(key, (totals.get(key) ?? 0) + (Number(record.totalCostMinor) || 0));
  }
  return [...totals.entries()]
    .map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount);
}

export function getReminders(data, vehicleId = 'all', now = new Date()) {
  const vehicles = new Map(data.vehicles.map((vehicle) => [vehicle.id, vehicle]));
  const today = todayISO(now);
  return data.serviceRecords
    .filter((record) => record.kind !== 'expense' && (record.nextDueDate || Number(record.nextDueOdometerKm) > 0))
    .filter((record) => !data.serviceRecords.some((candidate) => {
      if (candidate.id === record.id || candidate.kind === 'expense') return false;
      if (candidate.vehicleId !== record.vehicleId || candidate.category !== record.category) return false;
      return String(candidate.date) > String(record.date)
        || (candidate.date === record.date && Number(candidate.odometerKm) > Number(record.odometerKm));
    }))
    .filter((record) => vehicleId === 'all' || record.vehicleId === vehicleId)
    .map((record) => {
      const vehicle = vehicles.get(record.vehicleId);
      const odometerKm = currentOdometer(vehicle, data.fuelLogs, data.serviceRecords);
      const dateDays = record.nextDueDate ? daysBetween(today, record.nextDueDate) : null;
      const distanceRemainingKm = Number(record.nextDueOdometerKm) > 0 ? Number(record.nextDueOdometerKm) - odometerKm : null;
      const dueByDate = dateDays !== null && dateDays <= 0;
      const dueByDistance = distanceRemainingKm !== null && distanceRemainingKm <= 0;
      const due = dueByDate || dueByDistance;
      const urgency = due ? -1 : Math.min(dateDays ?? Infinity, distanceRemainingKm !== null ? distanceRemainingKm / 50 : Infinity);
      return { ...record, vehicle, currentOdometerKm: odometerKm, dateDays, distanceRemainingKm, due, urgency };
    })
    .sort((a, b) => a.urgency - b.urgency || String(a.nextDueDate ?? '').localeCompare(String(b.nextDueDate ?? '')));
}

export function describeReminder(reminder, settings) {
  const parts = [];
  if (reminder.nextDueDate) {
    if (reminder.dateDays < 0) parts.push(`${Math.abs(reminder.dateDays)} days overdue`);
    else if (reminder.dateDays === 0) parts.push('Due today');
    else parts.push(`in ${reminder.dateDays} days`);
  }
  if (Number(reminder.nextDueOdometerKm) > 0) {
    if (reminder.distanceRemainingKm <= 0) parts.push(`${formatDistance(Math.abs(reminder.distanceRemainingKm), settings)} overdue`);
    else parts.push(`in ${formatDistance(reminder.distanceRemainingKm, settings)}`);
  }
  return parts.join(' or ');
}

export function normalizeSettings(settings = {}) {
  return { ...DEFAULT_SETTINGS, ...settings, id: 'app' };
}

function isArray(value) {
  return Array.isArray(value);
}

export function validateBackup(payload) {
  const errors = [];
  if (!payload || typeof payload !== 'object') errors.push('The selected file does not contain a valid backup object.');
  if (payload?.format !== 'roadledger-backup') errors.push('This is not a RoadLedger backup.');
  if (Number(payload?.version) !== BACKUP_VERSION) errors.push(`Backup version ${payload?.version ?? 'unknown'} is not supported.`);
  if (!payload?.data || typeof payload.data !== 'object') errors.push('The backup has no data section.');
  if (!isArray(payload?.data?.vehicles)) errors.push('Vehicle data is missing or invalid.');
  if (!isArray(payload?.data?.fuelLogs)) errors.push('Fuel log data is missing or invalid.');
  if (!isArray(payload?.data?.serviceRecords)) errors.push('Service data is missing or invalid.');
  if (errors.length) return { valid: false, errors, data: null };

  const vehicleIds = new Set();
  for (const vehicle of payload.data.vehicles) {
    if (!vehicle?.id || !vehicle?.name) errors.push('Every vehicle must have an ID and name.');
    if (vehicleIds.has(vehicle?.id)) errors.push(`Duplicate vehicle ID: ${vehicle.id}`);
    vehicleIds.add(vehicle?.id);
  }
  for (const record of [...payload.data.fuelLogs, ...payload.data.serviceRecords]) {
    if (!record?.id || !record?.vehicleId || !record?.date) errors.push('Every record must have an ID, vehicle, and date.');
    if (record?.vehicleId && !vehicleIds.has(record.vehicleId)) errors.push(`Record ${record.id ?? 'unknown'} refers to an unknown vehicle.`);
  }

  return {
    valid: errors.length === 0,
    errors,
    data: errors.length ? null : {
      vehicles: payload.data.vehicles,
      fuelLogs: payload.data.fuelLogs,
      serviceRecords: payload.data.serviceRecords,
      settings: normalizeSettings(payload.data.settings)
    }
  };
}

export function csvEscape(value) {
  const string = String(value ?? '');
  return /[",\n\r]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
}

export function stringifyCSV(rows, columns) {
  const header = columns.map((column) => csvEscape(column)).join(',');
  const body = rows.map((row) => columns.map((column) => csvEscape(row[column])).join(',')).join('\r\n');
  return `${header}\r\n${body}${body ? '\r\n' : ''}`;
}

export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field.replace(/\r$/, ''));
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field.replace(/\r$/, ''));
    if (row.some((value) => value !== '')) rows.push(row);
  }
  if (!rows.length) return [];
  const headers = rows.shift().map((header) => header.trim());
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])));
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
