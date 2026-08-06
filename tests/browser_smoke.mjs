import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const appUrl = process.env.ROADLEDGER_URL ?? 'http://127.0.0.1:4173';
const debugPort = 9333;
const profile = mkdtempSync(join(tmpdir(), 'roadledger-browser-'));
const longHistoryVehicleName = 'Long-range Test Bike';
const longHistoryBackup = join(profile, 'long-history.roadledger.json');
const longHistoryStations = ['North Fuel', 'Central Fuel', 'Riverside Fuel', 'Hilltop Fuel'];
let syntheticOdometerKm = 1000;
const longHistoryFuelLogs = Array.from({ length: 106 }, (_, index) => {
  const monthOffset = Math.floor(index / 2);
  const date = new Date(Date.UTC(2022, 2 + monthOffset, index % 2 ? 20 : 5)).toISOString().slice(0, 10);
  const quantityLiters = 8 + (index % 6) * 0.45;
  syntheticOdometerKm += 245 + (index % 8) * 9;
  return {
    id: `fuel-long-history-${String(index + 1).padStart(3, '0')}`,
    vehicleId: 'vehicle-long-history',
    date,
    odometerKm: syntheticOdometerKm,
    quantityLiters,
    totalCostMinor: Math.round(quantityLiters * (9900 + (index % 5) * 125)),
    fuelGrade: index % 7 === 0 ? 'Premium' : 'Regular',
    station: longHistoryStations[index % longHistoryStations.length],
    fullTank: true,
    missedFill: false,
    notes: '',
    attachmentDataUrl: null,
    createdAt: `${date}T08:00:00.000Z`,
    updatedAt: `${date}T08:00:00.000Z`
  };
});
writeFileSync(longHistoryBackup, JSON.stringify({
  format: 'roadledger-backup',
  version: 1,
  appVersion: '1.0.0',
  exportedAt: '2026-08-01T00:00:00.000Z',
  counts: { vehicles: 1, fuelLogs: longHistoryFuelLogs.length, serviceRecords: 0 },
  data: {
    vehicles: [{
      id: 'vehicle-long-history',
      name: longHistoryVehicleName,
      type: 'motorcycle',
      fuelType: 'Petrol',
      make: 'Example',
      model: 'Test Bike',
      year: 2022,
      registration: '',
      initialOdometerKm: 1000,
      color: '#315f9b',
      archivedAt: null,
      createdAt: '2022-03-05T08:00:00.000Z',
      updatedAt: '2026-07-20T08:00:00.000Z'
    }],
    fuelLogs: longHistoryFuelLogs,
    serviceRecords: [],
    settings: {
      id: 'app',
      currency: 'INR',
      distanceUnit: 'km',
      volumeUnit: 'L',
      consumptionUnit: 'km/L',
      theme: 'auto',
      selectedVehicleId: 'all',
      lastBackupAt: null,
      createdAt: '2022-03-05T08:00:00.000Z'
    }
  }
}, null, 2));
const chrome = spawn('google-chrome-stable', [
  '--headless=new',
  '--no-sandbox',
  '--disable-gpu',
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${profile}`,
  '--window-size=1440,1000',
  appUrl
], { stdio: ['ignore', 'ignore', 'pipe'] });

let stderr = '';
chrome.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function retry(fn, timeout = 10000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeout) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw lastError ?? new Error('Timed out.');
}

let socket;
let sequence = 0;
const pending = new Map();

function command(method, params = {}) {
  sequence += 1;
  const id = sequence;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression, awaitPromise = true) {
  const response = await command('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
  if (response.exceptionDetails) {
    const detail = response.exceptionDetails.exception?.description ?? response.exceptionDetails.exception?.value ?? response.exceptionDetails.text;
    throw new Error(`${detail}\nExpression: ${expression}`);
  }
  return response.result?.value;
}

async function waitFor(expression, timeout = 10000) {
  return retry(async () => {
    const value = await evaluate(expression);
    if (!value) throw new Error(`Condition not met: ${expression}`);
    return value;
  }, timeout);
}

try {
  const targets = await retry(async () => {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    if (!response.ok) throw new Error('Chrome debugging endpoint is not ready.');
    const items = await response.json();
    const pages = items.filter((item) => item.type === 'page' && item.url.startsWith(appUrl));
    if (!pages.length) throw new Error('No RoadLedger Chrome page target found.');
    return pages;
  });
  socket = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const handler = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) handler.reject(new Error(message.error.message));
    else handler.resolve(message.result ?? {});
  });

  await command('Page.enable');
  await command('Runtime.enable');
  await command('Network.enable');
  await waitFor(`document.readyState === 'complete' && !document.querySelector('#app').hidden && !document.querySelector('#loading-screen')`);
  assert.equal(await evaluate(`document.querySelector('#dashboard-content').textContent.includes('Your vehicle story starts here')`), true);
  await waitFor(`document.querySelector('#network-status .network-text').textContent === 'Ready offline'`, 15000);

  await evaluate(`document.querySelector('[data-action="sample"]').click()`);
  await waitFor(`document.querySelector('#dashboard-content').textContent.includes('Weekend Runner')`, 15000);
  const initialRecords = await evaluate(`document.querySelectorAll('#dashboard-content .timeline-item').length`);
  assert.ok(initialRecords > 0, 'Sample records should appear on the dashboard.');

  await evaluate(`(() => {
    document.querySelector('[data-open-kind="fuel"]').click();
    document.querySelector('#record-date').value = new Date().toISOString().slice(0, 10);
    document.querySelector('#record-odometer').value = '32950';
    document.querySelector('#fuel-quantity').value = '35.2';
    document.querySelector('#fuel-quantity').dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#fuel-cost').value = '3700';
    document.querySelector('#fuel-cost').dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#fuel-station').value = 'Smoke Test Station';
  })()`);
  assert.equal(await evaluate(`document.querySelector('#fuel-unit-price').classList.contains('ready') && document.querySelector('#fuel-unit-price').textContent.includes('per L')`), true);
  await evaluate(`document.querySelector('#record-form').requestSubmit()`);
  await waitFor(`!document.querySelector('#record-dialog').open && document.querySelector('#dashboard-content').textContent.includes('Smoke Test Station')`);

  await evaluate(`document.querySelector('[data-open-kind="fuel"]').click()`);
  await waitFor(`document.querySelector('#record-dialog').open && [...document.querySelectorAll('[data-station-pick]')].some((button) => button.textContent === 'Smoke Test Station')`);
  const fuelFormShot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(join(tmpdir(), 'roadledger-fuel-form-tested.png'), Buffer.from(fuelFormShot.data, 'base64'));
  await evaluate(`[...document.querySelectorAll('[data-station-pick]')].find((button) => button.textContent === 'Smoke Test Station').click()`);
  assert.equal(await evaluate(`document.querySelector('#fuel-station').value`), 'Smoke Test Station');
  await evaluate(`document.querySelector('#record-dialog').close()`);

  await evaluate(`(() => {
    document.querySelector('[data-open-kind="service"]').click();
    document.querySelector('#record-date').value = new Date().toISOString().slice(0, 10);
    document.querySelector('#record-odometer').value = '32950';
    document.querySelector('#service-category').value = 'Oil change';
    document.querySelector('#service-cost').value = '2500';
    document.querySelector('#service-vendor').value = 'Smoke Test Garage';
    document.querySelector('#service-next-odometer').value = '38000';
    document.querySelector('#record-form').requestSubmit();
  })()`);
  await waitFor(`!document.querySelector('#record-dialog').open && document.querySelector('#dashboard-content').textContent.includes('Smoke Test Garage')`);

  await evaluate(`document.querySelector('[data-nav="garage"]').click()`);
  await waitFor(`document.querySelector('#view-garage').classList.contains('active') && document.querySelector('.storage-status')`);
  assert.equal(await evaluate(`document.querySelector('.storage-status').textContent.includes('RoadLedger data') && !document.querySelector('.storage-status').textContent.includes('MB used')`), true);
  const immediateLightTheme = await evaluate(`(() => {
    const select = document.querySelector('#setting-theme');
    select.value = 'light';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return document.documentElement.dataset.theme;
  })()`);
  assert.equal(immediateLightTheme, 'light', 'Theme changes should apply before the settings write completes.');
  await waitFor(`document.querySelector('#setting-theme').value === 'light' && document.documentElement.dataset.theme === 'light'`);
  const immediateAutoTheme = await evaluate(`(() => {
    const select = document.querySelector('#setting-theme');
    select.value = 'auto';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return document.documentElement.dataset.theme;
  })()`);
  assert.equal(immediateAutoTheme, 'auto');
  await waitFor(`document.querySelector('#setting-theme').value === 'auto' && document.documentElement.dataset.theme === 'auto'`);

  const documentNode = await command('DOM.getDocument');
  const backupInput = await command('DOM.querySelector', {
    nodeId: documentNode.root.nodeId,
    selector: '#backup-file-input'
  });
  await command('DOM.setFileInputFiles', {
    nodeId: backupInput.nodeId,
    files: [longHistoryBackup]
  });
  await waitFor(`document.querySelector('#import-dialog').open && document.querySelector('#import-summary').textContent.includes('106')`);
  await evaluate(`document.querySelector('#import-merge-button').click()`);
  await waitFor(`!document.querySelector('#import-dialog').open && [...document.querySelector('#global-vehicle-select').options].some((option) => option.textContent === ${JSON.stringify(longHistoryVehicleName)})`);
  await evaluate(`(() => {
    const select = document.querySelector('#global-vehicle-select');
    select.value = [...select.options].find((option) => option.textContent === ${JSON.stringify(longHistoryVehicleName)}).value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitFor(`document.querySelector('#global-vehicle-select').selectedOptions[0].textContent === ${JSON.stringify(longHistoryVehicleName)}`);

  await evaluate(`document.querySelector('[data-nav="reports"]').click()`);
  await waitFor(`document.querySelector('#view-reports').classList.contains('active') && document.querySelector('#reports-content .line-chart')`);
  await evaluate(`document.querySelector('[data-period="all"]').click()`);
  await waitFor(`document.querySelectorAll('#reports-content .bar-column').length === 53`);
  assert.equal(await evaluate(`document.querySelector('#reports-content').textContent.includes('Monthly spending')`), true);
  assert.equal(await evaluate(`document.querySelector('#reports-content').textContent.includes('Fuel details') && document.querySelector('#reports-content').textContent.includes('Fuel economy by station')`), true);
  assert.equal(await evaluate(`Boolean(document.querySelector('#reports-content .odometer-chart') && document.querySelector('#reports-content .station-table') && document.querySelector('#reports-content .station-economy-chart'))`), true);
  assert.equal(await evaluate(`document.querySelector('.fuel-economy-legend').textContent.includes(${JSON.stringify(longHistoryVehicleName)})`), true, 'Fuel economy chart should identify its vehicle series.');
  assert.equal(await evaluate(`document.querySelectorAll('.bar-column[data-chart-tooltip]').length === 53`), true, 'Every all-time month should expose details.');
  const monthlyYAxis = await evaluate(`(() => {
    const frameRect = document.querySelector('.bar-chart-frame').getBoundingClientRect();
    const labels = [...document.querySelectorAll('.bar-y-axis-label')];
    return {
      count: labels.length,
      values: labels.map((label) => label.textContent.trim()),
      gridLines: document.querySelectorAll('.bar-grid-line').length,
      contained: labels.every((label) => {
        const rect = label.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.left >= frameRect.left - 1 && rect.right <= frameRect.right + 1;
      })
    };
  })()`);
  assert.ok(monthlyYAxis.count === 3 && monthlyYAxis.gridLines === 3 && monthlyYAxis.contained && monthlyYAxis.values[0] !== monthlyYAxis.values[2], `Monthly spending should show a visible currency Y-axis: ${JSON.stringify(monthlyYAxis)}`);
  assert.equal(await evaluate(`[
    '.fuel-economy-point',
    '.station-series-point',
    '.odometer-point'
  ].every((selector) => document.querySelector(selector)?.hasAttribute('data-chart-tooltip'))`), true, 'Every point chart should expose interactive details.');
  assert.ok(await evaluate(`document.querySelectorAll('#reports-content .station-series-line').length` ) >= 2, 'The shared station chart should contain multiple station series.');
  const desktopChartFit = await evaluate(`(() => [
    ['.bar-chart-frame', '.bar-chart'],
    ['.fuel-economy-frame', '.fuel-economy-chart'],
    ['.station-chart-frame', '.station-economy-chart'],
    ['.odometer-chart-frame', '.odometer-chart']
  ].map(([frameSelector, chartSelector]) => {
    const frame = document.querySelector(frameSelector);
    const chart = document.querySelector(chartSelector);
    const frameRect = frame.getBoundingClientRect();
    const chartRect = chart.getBoundingClientRect();
    return {
      frameSelector,
      clientWidth: frame.clientWidth,
      scrollWidth: frame.scrollWidth,
      chartWidth: chartRect.width,
      contained: chartRect.left >= frameRect.left - 1 && chartRect.right <= frameRect.right + 1
    };
  }))()`);
  for (const chart of desktopChartFit) {
    assert.ok(chart.contained && chart.scrollWidth <= chart.clientWidth + 1, `Report chart should fit without horizontal scrolling: ${JSON.stringify(chart)}`);
  }
  const desktopAxisFontSizes = await evaluate(`(() => [
    '.bar-axis-label',
    '.bar-y-axis-label',
    '.fuel-economy-chart text',
    '.station-economy-chart text',
    '.odometer-chart text'
  ].map((selector) => parseFloat(getComputedStyle(document.querySelector(selector)).fontSize)))()`);
  assert.equal(new Set(desktopAxisFontSizes).size, 1, `Desktop chart axes should use one label size: ${JSON.stringify(desktopAxisFontSizes)}`);
  assert.equal(desktopAxisFontSizes[0], 12, `Desktop chart axis labels should be 12px: ${JSON.stringify(desktopAxisFontSizes)}`);
  await evaluate(`(() => {
    const point = document.querySelector('.fuel-economy-point');
    point.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', clientX: 220, clientY: 260 }));
  })()`);
  await waitFor(`!document.querySelector('#chart-tooltip').hidden && document.querySelector('#chart-tooltip').textContent.includes(${JSON.stringify(longHistoryVehicleName)}) && document.querySelector('#chart-tooltip').textContent.includes('km/L')`);
  await evaluate(`document.querySelector('.fuel-economy-point').dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse' }))`);
  await waitFor(`document.querySelector('#chart-tooltip').hidden`);
  assert.equal(await evaluate(`document.querySelectorAll('dialog[open]').length`), 0);
  await evaluate(`document.querySelectorAll('.toast').forEach((element) => element.remove())`);
  await delay(300);
  const desktopShot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(join(tmpdir(), 'roadledger-reports-tested.png'), Buffer.from(desktopShot.data, 'base64'));

  await evaluate(`document.querySelector('.station-economy-chart').scrollIntoView({ block: 'center' })`);
  await delay(300);
  const reportDetailsShot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(join(tmpdir(), 'roadledger-report-details-tested.png'), Buffer.from(reportDetailsShot.data, 'base64'));

  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await waitFor(`['.fuel-economy-chart', '.station-economy-chart', '.odometer-chart'].every((selector) => {
    const chart = document.querySelector(selector);
    return Math.abs(Number(chart.dataset.chartWidth) - chart.parentElement.clientWidth) <= 2;
  })`);
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth + 1`), true);
  const mobileChartFit = await evaluate(`(() => [
    ['.bar-chart-frame', '.bar-chart'],
    ['.fuel-economy-frame', '.fuel-economy-chart'],
    ['.station-chart-frame', '.station-economy-chart'],
    ['.odometer-chart-frame', '.odometer-chart']
  ].map(([frameSelector, chartSelector]) => {
    const frame = document.querySelector(frameSelector);
    const chart = document.querySelector(chartSelector);
    const frameRect = frame.getBoundingClientRect();
    const chartRect = chart.getBoundingClientRect();
    return {
      frameSelector,
      clientWidth: frame.clientWidth,
      scrollWidth: frame.scrollWidth,
      chartWidth: chartRect.width,
      contained: chartRect.left >= frameRect.left - 1 && chartRect.right <= frameRect.right + 1
    };
  }))()`);
  for (const chart of mobileChartFit) {
    assert.ok(chart.contained && chart.scrollWidth <= chart.clientWidth + 1, `Mobile report chart should fit without horizontal scrolling: ${JSON.stringify(chart)}`);
  }
  const mobileAxisFontSizes = await evaluate(`(() => [
    '.bar-axis-label',
    '.bar-y-axis-label',
    '.fuel-economy-chart text',
    '.station-economy-chart text',
    '.odometer-chart text'
  ].map((selector) => parseFloat(getComputedStyle(document.querySelector(selector)).fontSize)))()`);
  assert.equal(new Set(mobileAxisFontSizes).size, 1, `Mobile chart axes should use one label size: ${JSON.stringify(mobileAxisFontSizes)}`);
  assert.equal(mobileAxisFontSizes[0], 14, `Mobile chart axis labels should be 14px: ${JSON.stringify(mobileAxisFontSizes)}`);
  const mobilePlotUsage = await evaluate(`(() => {
    const barFrame = document.querySelector('.bar-chart-frame');
    const barPlot = document.querySelector('.bar-plot');
    const svgUsage = (selector) => {
      const chart = document.querySelector(selector);
      const gridLine = chart.querySelector('.grid-line');
      return (Number(gridLine.getAttribute('x2')) - Number(gridLine.getAttribute('x1'))) / chart.viewBox.baseVal.width;
    };
    return {
      monthly: barPlot.getBoundingClientRect().width / barFrame.getBoundingClientRect().width,
      economy: svgUsage('.fuel-economy-chart'),
      station: svgUsage('.station-economy-chart'),
      odometer: svgUsage('.odometer-chart')
    };
  })()`);
  assert.ok(Object.values(mobilePlotUsage).every((usage) => usage >= 0.77), `Phone charts should devote at least 77% of their width to the plot: ${JSON.stringify(mobilePlotUsage)}`);
  assert.ok(mobilePlotUsage.monthly >= 0.87, `Phone monthly spending should devote at least 87% of its width to the plot: ${JSON.stringify(mobilePlotUsage)}`);
  assert.equal(await evaluate(`document.querySelector('.station-chart-legend').textContent.includes('Y-axis') && document.querySelector('.odometer-legend').textContent.includes('Y-axis')`), true, 'Compact phone axes should keep their units visible in chart legends.');
  const monthlyPhoneAxis = await evaluate(`(() => {
    const frame = document.querySelector('.bar-chart-frame');
    const frameRect = frame.getBoundingClientRect();
    const labels = [...frame.querySelectorAll('.bar-y-axis-label')];
    const subtitle = frame.closest('.chart-panel').querySelector('.panel-head p').textContent;
    return {
      labels: labels.map((label) => label.textContent.trim()),
      currency: ${JSON.stringify('INR')},
      subtitle,
      contained: labels.every((label) => {
        const rect = label.getBoundingClientRect();
        return rect.left >= frameRect.left - 1 && rect.right <= frameRect.right + 1;
      })
    };
  })()`);
  assert.ok(monthlyPhoneAxis.contained && monthlyPhoneAxis.subtitle.includes(monthlyPhoneAxis.currency) && monthlyPhoneAxis.labels.every((label) => !label.includes(monthlyPhoneAxis.currency) && !label.includes('₹')), `Phone monthly ticks should be compact while the subtitle identifies the currency: ${JSON.stringify(monthlyPhoneAxis)}`);
  const mobileMonthLabels = await evaluate(`[...document.querySelectorAll('.bar-axis-label')].map((label) => {
    const rect = label.getBoundingClientRect();
    return { text: label.textContent.trim(), left: rect.left, right: rect.right };
  })`);
  assert.ok(mobileMonthLabels.every((label, index) => index === 0 || label.left >= mobileMonthLabels[index - 1].right + 2), `Mobile monthly axis labels should not overlap: ${JSON.stringify(mobileMonthLabels)}`);
  await evaluate(`document.querySelector('.bar-chart').scrollIntoView({ block: 'start' })`);
  await delay(300);
  const monthlyMobileShot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(join(tmpdir(), 'roadledger-monthly-mobile-tested.png'), Buffer.from(monthlyMobileShot.data, 'base64'));
  await evaluate(`document.querySelector('.fuel-economy-chart').scrollIntoView({ block: 'start' })`);
  await delay(300);
  const economyMobileShot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(join(tmpdir(), 'roadledger-economy-mobile-tested.png'), Buffer.from(economyMobileShot.data, 'base64'));
  await evaluate(`document.querySelector('.station-economy-chart').scrollIntoView({ block: 'start' })`);
  await delay(300);
  const stationMobileShot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(join(tmpdir(), 'roadledger-station-mobile-tested.png'), Buffer.from(stationMobileShot.data, 'base64'));
  await evaluate(`document.querySelector('.odometer-chart').scrollIntoView({ block: 'start' })`);
  await delay(300);
  const odometerMobileLayout = await evaluate(`(() => {
    const chart = document.querySelector('.odometer-chart');
    const frame = document.querySelector('.odometer-chart-frame');
    return {
      fontSize: parseFloat(getComputedStyle(chart.querySelector('text')).fontSize),
      chartWidth: chart.getBoundingClientRect().width,
      clientWidth: frame.clientWidth,
      scrollWidth: frame.scrollWidth
    };
  })()`);
  assert.ok(odometerMobileLayout.fontSize >= 14, `Odometer labels are too small: ${JSON.stringify(odometerMobileLayout)}`);
  assert.ok(odometerMobileLayout.chartWidth <= odometerMobileLayout.clientWidth + 1 && odometerMobileLayout.scrollWidth <= odometerMobileLayout.clientWidth + 1, `Odometer chart should fit without horizontal scrolling: ${JSON.stringify(odometerMobileLayout)}`);
  const odometerMobileShot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(join(tmpdir(), 'roadledger-odometer-mobile-tested.png'), Buffer.from(odometerMobileShot.data, 'base64'));
  await evaluate(`document.querySelector('[data-nav="dashboard"]').click()`);
  await evaluate(`document.querySelectorAll('.toast').forEach((element) => element.remove())`);
  await delay(300);
  const mobileShot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(join(tmpdir(), 'roadledger-mobile-tested.png'), Buffer.from(mobileShot.data, 'base64'));
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.bottom-nav')).display === 'grid'`), true);
  const mobileLayout = await evaluate(`(() => { const rect = document.querySelector('.topbar-actions').getBoundingClientRect(); return { width: innerWidth, left: rect.left, right: rect.right, actionWidth: rect.width }; })()`);
  assert.ok(mobileLayout.actionWidth > 80 && mobileLayout.left < mobileLayout.width && mobileLayout.right <= mobileLayout.width + 1, `Topbar actions overflow the mobile viewport: ${JSON.stringify(mobileLayout)}`);
  const mobileViewLayouts = [];
  for (const view of ['logbook', 'reports', 'garage', 'dashboard']) {
    await evaluate(`document.querySelector('.bottom-nav [data-nav="${view}"]').click()`);
    await waitFor(`document.querySelector('#view-${view}').classList.contains('active')`);
    await delay(250);
    mobileViewLayouts.push(await evaluate(`(() => {
      const navRect = document.querySelector('.bottom-nav').getBoundingClientRect();
      const filter = document.querySelector('.filter-row');
      return {
        view: ${JSON.stringify(view)},
        viewportWidth: innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth,
        scrollX,
        navLeft: navRect.left,
        navRight: navRect.right,
        filterClientWidth: filter.clientWidth,
        filterScrollWidth: filter.scrollWidth
      };
    })()`));
  }
  for (const layout of mobileViewLayouts) {
    assert.ok(layout.documentWidth <= layout.viewportWidth + 1 && layout.bodyWidth <= layout.viewportWidth + 1 && Math.abs(layout.scrollX) <= 1, `Mobile ${layout.view} view should not scroll horizontally: ${JSON.stringify(layout)}`);
    assert.ok(layout.navLeft >= -1 && layout.navRight <= layout.viewportWidth + 1, `Bottom navigation should stay fixed to the viewport in ${layout.view}: ${JSON.stringify(layout)}`);
  }
  const logbookLayout = mobileViewLayouts.find((layout) => layout.view === 'logbook');
  assert.ok(logbookLayout.filterScrollWidth > logbookLayout.filterClientWidth, `Logbook filters should scroll internally without widening the page: ${JSON.stringify(logbookLayout)}`);

  await evaluate(`(() => {
    document.querySelector('#add-vehicle-button').click();
    document.querySelector('#vehicle-name').value = 'City Commuter';
    document.querySelector('#vehicle-type').value = 'bike';
    document.querySelector('#vehicle-fuel-type').value = 'Petrol';
    document.querySelector('#vehicle-odometer').value = '5200';
    document.querySelector('#vehicle-form').requestSubmit();
  })()`);
  await waitFor(`!document.querySelector('#vehicle-dialog').open && document.querySelector('#global-vehicle-select').value !== 'all' && document.querySelector('#global-vehicle-select').options.length === 4`);
  const swipeExpectation = await evaluate(`(() => {
    const select = document.querySelector('#global-vehicle-select');
    const vehicles = [...select.options].filter((option) => option.value !== 'all');
    const currentIndex = vehicles.findIndex((option) => option.value === select.value);
    const next = vehicles[(currentIndex + 1) % vehicles.length];
    return { before: select.value, nextId: next.value, nextName: next.textContent };
  })()`);
  await evaluate(`(() => {
    const switcher = document.querySelector('.vehicle-switcher');
    switcher.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 9, clientX: 260, clientY: 30 }));
    switcher.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 9, clientX: 150, clientY: 32 }));
  })()`);
  await waitFor(`document.querySelector('#global-vehicle-select').value === ${JSON.stringify(swipeExpectation.nextId)}`);
  assert.equal(await evaluate(`document.querySelector('#dashboard-content').textContent.includes(${JSON.stringify(swipeExpectation.nextName)})`), true);

  await evaluate(`navigator.serviceWorker.ready.then(() => true)`);
  await command('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await command('Page.reload', { ignoreCache: false });
  await waitFor(`document.readyState === 'complete' && !document.querySelector('#app').hidden && document.querySelector('#dashboard-content').textContent.includes(${JSON.stringify(swipeExpectation.nextName)})`, 15000);
  assert.equal(await evaluate(`navigator.serviceWorker.controller !== null`), true);

  process.stdout.write('Browser smoke passed: fit-to-width monthly/economy/station/odometer charts, legends/tooltips, readable mobile axes, station reuse/reporting, mobile swipe, and offline reload.\n');
} catch (error) {
  process.stderr.write(`${error.stack}\n${stderr.slice(-3000)}\n`);
  process.exitCode = 1;
} finally {
  socket?.close();
  chrome.kill('SIGTERM');
  await new Promise((resolve) => chrome.once('exit', resolve));
  rmSync(profile, { recursive: true, force: true });
}
