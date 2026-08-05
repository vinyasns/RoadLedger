import { DEFAULT_SETTINGS, normalizeSettings } from './domain.js';

const DB_NAME = 'roadledger';
const DB_VERSION = 1;
const STORES = ['vehicles', 'fuelLogs', 'serviceRecords', 'settings'];
let databasePromise;

function requestAsPromise(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result), { once: true });
    request.addEventListener('error', () => reject(request.error), { once: true });
  });
}

function transactionAsPromise(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve(), { once: true });
    transaction.addEventListener('abort', () => reject(transaction.error ?? new Error('Database transaction was aborted.')), { once: true });
    transaction.addEventListener('error', () => reject(transaction.error ?? new Error('Database transaction failed.')), { once: true });
  });
}

export function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.addEventListener('upgradeneeded', () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('vehicles')) {
        const store = database.createObjectStore('vehicles', { keyPath: 'id' });
        store.createIndex('archivedAt', 'archivedAt', { unique: false });
      }
      if (!database.objectStoreNames.contains('fuelLogs')) {
        const store = database.createObjectStore('fuelLogs', { keyPath: 'id' });
        store.createIndex('vehicleId', 'vehicleId', { unique: false });
        store.createIndex('date', 'date', { unique: false });
      }
      if (!database.objectStoreNames.contains('serviceRecords')) {
        const store = database.createObjectStore('serviceRecords', { keyPath: 'id' });
        store.createIndex('vehicleId', 'vehicleId', { unique: false });
        store.createIndex('date', 'date', { unique: false });
      }
      if (!database.objectStoreNames.contains('settings')) {
        database.createObjectStore('settings', { keyPath: 'id' });
      }
    });
    request.addEventListener('success', () => {
      const database = request.result;
      database.addEventListener('versionchange', () => database.close());
      resolve(database);
    }, { once: true });
    request.addEventListener('error', () => {
      databasePromise = null;
      reject(request.error);
    }, { once: true });
    request.addEventListener('blocked', () => reject(new Error('RoadLedger is open in another tab. Close it and try again.')), { once: true });
  });
  return databasePromise;
}

export async function getAll(storeName) {
  const database = await openDatabase();
  const transaction = database.transaction(storeName, 'readonly');
  return requestAsPromise(transaction.objectStore(storeName).getAll());
}

export async function getOne(storeName, id) {
  const database = await openDatabase();
  const transaction = database.transaction(storeName, 'readonly');
  return requestAsPromise(transaction.objectStore(storeName).get(id));
}

export async function putOne(storeName, value) {
  const database = await openDatabase();
  const transaction = database.transaction(storeName, 'readwrite');
  transaction.objectStore(storeName).put(value);
  await transactionAsPromise(transaction);
  return value;
}

export async function deleteOne(storeName, id) {
  const database = await openDatabase();
  const transaction = database.transaction(storeName, 'readwrite');
  transaction.objectStore(storeName).delete(id);
  await transactionAsPromise(transaction);
}

export async function loadData() {
  const [vehicles, fuelLogs, serviceRecords, settingsRows] = await Promise.all([
    getAll('vehicles'),
    getAll('fuelLogs'),
    getAll('serviceRecords'),
    getAll('settings')
  ]);
  const settings = normalizeSettings(settingsRows.find((item) => item.id === 'app'));
  if (!settings.createdAt) {
    settings.createdAt = new Date().toISOString();
    await putOne('settings', settings);
  }
  return { vehicles, fuelLogs, serviceRecords, settings };
}

export async function importData(data, mode = 'merge') {
  if (!['merge', 'replace'].includes(mode)) throw new Error('Unknown import mode.');
  const database = await openDatabase();
  const transaction = database.transaction(STORES, 'readwrite');
  const vehicles = transaction.objectStore('vehicles');
  const fuelLogs = transaction.objectStore('fuelLogs');
  const serviceRecords = transaction.objectStore('serviceRecords');
  const settings = transaction.objectStore('settings');

  if (mode === 'replace') {
    vehicles.clear();
    fuelLogs.clear();
    serviceRecords.clear();
    settings.clear();
  }
  for (const vehicle of data.vehicles) vehicles.put(vehicle);
  for (const record of data.fuelLogs) fuelLogs.put(record);
  for (const record of data.serviceRecords) serviceRecords.put(record);
  if (mode === 'replace') settings.put(normalizeSettings(data.settings));
  await transactionAsPromise(transaction);
}

export async function resetAllData() {
  const database = await openDatabase();
  const transaction = database.transaction(STORES, 'readwrite');
  for (const storeName of STORES) transaction.objectStore(storeName).clear();
  transaction.objectStore('settings').put({ ...DEFAULT_SETTINGS, id: 'app', createdAt: new Date().toISOString() });
  await transactionAsPromise(transaction);
}

export async function requestPersistentStorage() {
  if (!navigator.storage?.persist) return { supported: false, persisted: false };
  const alreadyPersisted = await navigator.storage.persisted();
  const persisted = alreadyPersisted || await navigator.storage.persist();
  return { supported: true, persisted };
}

export async function getStorageInfo() {
  if (!navigator.storage) return { supported: false, persisted: false, usage: 0, quota: 0 };
  const [estimate, persisted] = await Promise.all([
    navigator.storage.estimate?.() ?? Promise.resolve({ usage: 0, quota: 0 }),
    navigator.storage.persisted?.() ?? Promise.resolve(false)
  ]);
  return {
    supported: true,
    persisted,
    usage: estimate.usage ?? 0,
    quota: estimate.quota ?? 0
  };
}
