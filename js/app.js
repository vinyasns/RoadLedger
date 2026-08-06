import {
  APP_VERSION,
  BACKUP_VERSION,
  CURRENCIES,
  DEFAULT_SETTINGS,
  EXPENSE_CATEGORIES,
  SERVICE_CATEGORIES,
  addDays,
  buildStationStats,
  buildMonthlyTotals,
  calculateFuelEconomy,
  calculateStats,
  categoryTotals,
  clamp,
  createId,
  currentOdometer,
  daysBetween,
  describeReminder,
  escapeHTML,
  formatDate,
  formatDistance,
  formatEfficiency,
  formatMoney,
  formatNumber,
  formatVolume,
  fromCanonicalDistance,
  fromCanonicalVolume,
  getCutoffDate,
  getReminders,
  minorToMoney,
  moneyToMinor,
  monthKey,
  normalizeSettings,
  parseCSV,
  parseLocalDate,
  sortRecordsNewest,
  stringifyCSV,
  toCanonicalDistance,
  toCanonicalVolume,
  todayISO,
  unifiedRecords,
  validateBackup
} from './domain.js';
import {
  deleteOne,
  getStorageInfo,
  importData,
  loadData,
  putOne,
  requestPersistentStorage,
  resetAllData
} from './db.js';

const state = {
  data: { vehicles: [], fuelLogs: [], serviceRecords: [], settings: { ...DEFAULT_SETTINGS } },
  currentView: 'dashboard',
  selectedVehicleId: 'all',
  logFilter: 'all',
  logSearch: '',
  reportPeriod: '365',
  attachmentDataUrl: null,
  pendingImport: null,
  deferredInstallPrompt: null,
  storage: null,
  persistenceRequestDenied: false,
  offlineReady: false,
  stationSummaryExpanded: false
};

const viewMeta = {
  dashboard: ['Your garage', 'Overview'],
  logbook: ['Fuel, service and expenses', 'Logbook'],
  reports: ['Understand every kilometre', 'Reports'],
  garage: ['Vehicles and data', 'Garage']
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function activeVehicles() {
  return state.data.vehicles.filter((vehicle) => !vehicle.archivedAt);
}

function selectedVehicle() {
  return state.data.vehicles.find((vehicle) => vehicle.id === state.selectedVehicleId) ?? null;
}

function safeColor(value) {
  return /^#[0-9a-f]{6}$/i.test(value ?? '') ? value : '#2f7d5d';
}

function selectedOption(value, current) {
  return value === current ? ' selected' : '';
}

function iconForKind(kind) {
  return kind === 'fuel' ? 'i-fuel' : kind === 'expense' ? 'i-expense' : 'i-service';
}

function labelForKind(kind) {
  return kind === 'fuel' ? 'Fuel fill-up' : kind === 'expense' ? 'Expense' : 'Service';
}

function currency() {
  return state.data.settings.currency;
}

function setTheme(theme) {
  const value = ['light', 'dark', 'auto'].includes(theme) ? theme : 'auto';
  document.documentElement.dataset.theme = value;
  const isDark = value === 'dark' || (value === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  $('meta[name="theme-color"]')?.setAttribute('content', isDark ? '#121714' : '#f3f4ef');
}

async function refreshData({ render = true } = {}) {
  state.data = await loadData();
  const activeIds = new Set(activeVehicles().map((vehicle) => vehicle.id));
  const preferred = state.data.settings.selectedVehicleId ?? 'all';
  state.selectedVehicleId = preferred === 'all' || activeIds.has(preferred) ? preferred : 'all';
  setTheme(state.data.settings.theme);
  if (render) renderAll();
}

async function saveSettings(patch, { render = true } = {}) {
  const previousSettings = state.data.settings;
  const nextSettings = normalizeSettings({ ...previousSettings, ...patch });
  state.data.settings = nextSettings;
  if (Object.hasOwn(patch, 'theme')) setTheme(nextSettings.theme);
  try {
    await putOne('settings', nextSettings);
  } catch (error) {
    state.data.settings = previousSettings;
    if (Object.hasOwn(patch, 'theme')) setTheme(previousSettings.theme);
    throw error;
  }
  if (render) renderAll();
}

function toast(message, type = 'success', duration = 3200) {
  const region = $('#toast-region');
  const element = document.createElement('div');
  element.className = `toast${type === 'error' ? ' error' : ''}`;
  element.textContent = message;
  region.append(element);
  setTimeout(() => {
    element.classList.add('leaving');
    element.addEventListener('animationend', () => element.remove(), { once: true });
  }, duration);
}

function openDialog(dialog) {
  if (!dialog.open) dialog.showModal();
}

function closeDialog(dialog) {
  if (dialog?.open) dialog.close();
}

function navigate(view, { updateHash = true } = {}) {
  if (!viewMeta[view]) view = 'dashboard';
  state.currentView = view;
  $$('.view').forEach((element) => element.classList.toggle('active', element.id === `view-${view}`));
  $$('[data-nav]').forEach((element) => element.classList.toggle('active', element.dataset.nav === view));
  $('#page-eyebrow').textContent = viewMeta[view][0];
  $('#page-title').textContent = viewMeta[view][1];
  if (updateHash && location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
  if (view === 'dashboard') renderDashboard();
  if (view === 'logbook') renderLogbook();
  if (view === 'reports') renderReports();
  if (view === 'garage') renderGarage();
  $('#main-content')?.focus({ preventScroll: true });
  window.scrollTo({ top: 0, left: 0, behavior: 'smooth' });
}

function populateVehicleSelectors() {
  const vehicles = activeVehicles();
  const global = $('#global-vehicle-select');
  const switcher = $('.vehicle-switcher');
  global.innerHTML = [
    `<option value="all">${vehicles.length > 1 ? 'All vehicles' : vehicles[0] ? escapeHTML(vehicles[0].name) : 'No vehicles'}</option>`,
    ...(vehicles.length > 1 ? vehicles.map((vehicle) => `<option value="${escapeHTML(vehicle.id)}">${escapeHTML(vehicle.name)}</option>`) : [])
  ].join('');
  global.value = vehicles.length <= 1 ? 'all' : state.selectedVehicleId;
  global.disabled = vehicles.length === 0;
  switcher.dataset.swipeEnabled = String(vehicles.length > 1);
  switcher.title = vehicles.length > 1
    ? 'Choose a vehicle, or swipe left and right on this control to switch.'
    : 'Choose a vehicle.';

  const recordSelect = $('#record-vehicle');
  recordSelect.innerHTML = vehicles.map((vehicle) => `<option value="${escapeHTML(vehicle.id)}">${escapeHTML(vehicle.name)}</option>`).join('');
}

let vehicleSwitchInProgress = false;

function animateVehicleSwitcher(direction) {
  const switcher = $('.vehicle-switcher');
  const className = direction > 0 ? 'switching-next' : 'switching-previous';
  switcher.classList.remove('switching-next', 'switching-previous');
  void switcher.offsetWidth;
  switcher.classList.add(className);
  setTimeout(() => switcher.classList.remove(className), 260);
}

async function cycleVehicle(direction) {
  const vehicles = activeVehicles();
  if (vehicles.length < 2 || vehicleSwitchInProgress) return;
  const previousVehicleId = state.selectedVehicleId;
  const currentIndex = vehicles.findIndex((vehicle) => vehicle.id === state.selectedVehicleId);
  const nextIndex = currentIndex < 0
    ? (direction > 0 ? 0 : vehicles.length - 1)
    : (currentIndex + direction + vehicles.length) % vehicles.length;
  const nextVehicle = vehicles[nextIndex];
  if (!nextVehicle) return;

  vehicleSwitchInProgress = true;
  state.selectedVehicleId = nextVehicle.id;
  animateVehicleSwitcher(direction);
  try {
    await saveSettings({ selectedVehicleId: nextVehicle.id });
  } catch (error) {
    state.selectedVehicleId = previousVehicleId;
    state.data.settings.selectedVehicleId = previousVehicleId;
    renderAll();
    toast(error.message || 'Could not switch vehicles.', 'error');
  } finally {
    vehicleSwitchInProgress = false;
  }
}

function setupVehicleSwipe() {
  const switcher = $('.vehicle-switcher');
  let gesture = null;
  let suppressSelectClick = false;
  let suppressTimer = null;

  switcher.addEventListener('pointerdown', (event) => {
    if (!['touch', 'pen'].includes(event.pointerType) || activeVehicles().length < 2) return;
    gesture = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  });
  switcher.addEventListener('pointercancel', () => { gesture = null; });
  switcher.addEventListener('pointerup', (event) => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const deltaX = event.clientX - gesture.x;
    const deltaY = event.clientY - gesture.y;
    gesture = null;
    if (Math.abs(deltaX) < 44 || Math.abs(deltaX) <= Math.abs(deltaY) * 1.2) return;
    event.preventDefault();
    suppressSelectClick = true;
    clearTimeout(suppressTimer);
    suppressTimer = setTimeout(() => { suppressSelectClick = false; }, 450);
    void cycleVehicle(deltaX < 0 ? 1 : -1);
  });
  switcher.addEventListener('click', (event) => {
    if (!suppressSelectClick) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    suppressSelectClick = false;
  }, true);
}

function setupChartTooltips() {
  const tooltip = document.createElement('div');
  tooltip.id = 'chart-tooltip';
  tooltip.className = 'chart-tooltip';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.hidden = true;
  document.body.append(tooltip);
  let activeTarget = null;
  let dismissTimer = null;

  function tooltipTarget(event) {
    return event.target instanceof Element ? event.target.closest('[data-chart-tooltip]') : null;
  }

  function positionTooltip(event, target) {
    const targetRect = target.getBoundingClientRect();
    const pointerX = Number.isFinite(event?.clientX) && event.clientX > 0 ? event.clientX : targetRect.left + targetRect.width / 2;
    const pointerY = Number.isFinite(event?.clientY) && event.clientY > 0 ? event.clientY : targetRect.top;
    const tooltipRect = tooltip.getBoundingClientRect();
    const left = clamp(pointerX + 14, 8, Math.max(8, innerWidth - tooltipRect.width - 8));
    let top = pointerY - tooltipRect.height - 14;
    if (top < 8) top = Math.min(innerHeight - tooltipRect.height - 8, pointerY + 16);
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${Math.max(8, top)}px`;
  }

  function showTooltip(target, event) {
    const text = target?.dataset.chartTooltip;
    if (!text) return;
    clearTimeout(dismissTimer);
    activeTarget = target;
    tooltip.textContent = text;
    tooltip.hidden = false;
    target.setAttribute('aria-describedby', tooltip.id);
    positionTooltip(event, target);
  }

  function hideTooltip() {
    clearTimeout(dismissTimer);
    activeTarget?.removeAttribute('aria-describedby');
    activeTarget = null;
    tooltip.hidden = true;
  }

  document.addEventListener('pointerover', (event) => {
    const target = tooltipTarget(event);
    if (target) showTooltip(target, event);
  });
  document.addEventListener('pointermove', (event) => {
    if (activeTarget && event.pointerType !== 'touch') positionTooltip(event, activeTarget);
  });
  document.addEventListener('pointerout', (event) => {
    const target = tooltipTarget(event);
    if (target === activeTarget && !target.contains(event.relatedTarget)) hideTooltip();
  });
  document.addEventListener('focusin', (event) => {
    const target = tooltipTarget(event);
    if (target) showTooltip(target, null);
  });
  document.addEventListener('focusout', (event) => {
    const target = tooltipTarget(event);
    if (target === activeTarget) hideTooltip();
  });
  document.addEventListener('click', (event) => {
    const target = tooltipTarget(event);
    if (!target) {
      hideTooltip();
      return;
    }
    showTooltip(target, event);
    dismissTimer = setTimeout(hideTooltip, 4000);
  });
  document.addEventListener('scroll', hideTooltip, true);
  window.addEventListener('resize', hideTooltip);
}

function previousFuelValues(field, vehicleId, limit = 8) {
  const values = new Map();
  for (const log of state.data.fuelLogs) {
    const value = String(log[field] ?? '').trim();
    if (!value) continue;
    const key = value.toLocaleLowerCase();
    const current = values.get(key) ?? { value, count: 0, vehicleCount: 0, latestDate: '' };
    current.count += 1;
    if (log.vehicleId === vehicleId) current.vehicleCount += 1;
    if (String(log.date) >= current.latestDate) {
      current.latestDate = String(log.date);
      current.value = value;
    }
    values.set(key, current);
  }
  return [...values.values()]
    .sort((a, b) => b.vehicleCount - a.vehicleCount || b.count - a.count || b.latestDate.localeCompare(a.latestDate) || a.value.localeCompare(b.value))
    .slice(0, limit)
    .map((item) => item.value);
}

function gradeDefaults(fuelType = '') {
  const type = fuelType.toLocaleLowerCase();
  if (type.includes('diesel')) return ['Regular diesel', 'Premium diesel'];
  if (type.includes('cng')) return ['CNG'];
  if (type.includes('lpg')) return ['LPG'];
  if (type.includes('electric')) return ['Standard charging', 'Fast charging'];
  return ['Regular', 'Premium', '91 octane', '95 octane', '97 octane', '98 octane'];
}

function updateFuelSuggestions(vehicleId) {
  const vehicle = state.data.vehicles.find((item) => item.id === vehicleId);
  const stations = previousFuelValues('station', vehicleId);
  $('#station-suggestions').innerHTML = stations.map((station) => `<option value="${escapeHTML(station)}"></option>`).join('');
  const quickPicks = $('#station-quick-picks');
  quickPicks.hidden = stations.length === 0;
  quickPicks.innerHTML = stations.slice(0, 5).map((station) => `<button type="button" data-station-pick="${escapeHTML(station)}">${escapeHTML(station)}</button>`).join('');

  const previousGrades = previousFuelValues('fuelGrade', vehicleId);
  const grades = [...new Map([...previousGrades, ...gradeDefaults(vehicle?.fuelType)].map((grade) => [grade.toLocaleLowerCase(), grade])).values()];
  $('#fuel-grade-suggestions').innerHTML = grades.map((grade) => `<option value="${escapeHTML(grade)}"></option>`).join('');
}

function renderAll() {
  populateVehicleSelectors();
  updateFormUnitLabels();
  renderDashboard();
  renderLogbook();
  renderReports();
  renderGarage();
  navigate(state.currentView, { updateHash: false });
}

function recordTitle(record) {
  if (record.kind === 'fuel') return record.station || record.fuelGrade || 'Fuel fill-up';
  return record.category || labelForKind(record.kind);
}

function economyMap() {
  return new Map(calculateFuelEconomy(state.data.fuelLogs).map((segment) => [segment.toLogId, segment]));
}

function recordSubtitle(record, economyById = economyMap()) {
  const vehicleName = record.vehicle?.name ? escapeHTML(record.vehicle.name) : 'Unknown vehicle';
  const odometer = formatDistance(record.odometerKm, state.data.settings);
  if (record.kind === 'fuel') {
    const economy = economyById.get(record.id);
    const parts = [vehicleName, formatVolume(record.quantityLiters, state.data.settings), odometer];
    if (economy) parts.push(formatEfficiency(economy.kmPerLiter, state.data.settings.consumptionUnit));
    return parts.join(' · ');
  }
  return [vehicleName, record.vendor ? escapeHTML(record.vendor) : '', odometer].filter(Boolean).join(' · ');
}

function renderTimeline(records, { emptyText = 'No records yet.', limit = null } = {}) {
  const items = limit ? records.slice(0, limit) : records;
  if (!items.length) {
    return `<div class="empty-inline"><div><span class="record-icon fuel"><svg><use href="#i-logbook"></use></svg></span><strong>${escapeHTML(emptyText)}</strong><small>Add a fill-up or service to start building your vehicle history.</small><button class="text-button" type="button" data-open-kind="fuel">Add the first record</button></div></div>`;
  }
  const economies = economyMap();
  return `<div class="timeline-list">${items.map((record) => `
    <button class="timeline-item" type="button" data-edit-record="${escapeHTML(record.id)}" data-record-kind="${escapeHTML(record.kind)}">
      <span class="record-icon ${record.kind}"><svg><use href="#${iconForKind(record.kind)}"></use></svg></span>
      <span class="timeline-copy"><strong>${escapeHTML(recordTitle(record))}</strong><small>${recordSubtitle(record, economies)}</small></span>
      <span class="timeline-amount"><strong>${formatMoney(record.totalCostMinor, currency())}</strong><small>${formatDate(record.date, { short: true })}</small></span>
    </button>`).join('')}</div>`;
}

function dashboardHero(stats, records, reminders) {
  const vehicle = selectedVehicle();
  const vehicles = activeVehicles();
  let title;
  let copy;
  let dialValue;
  let dialLabel;
  if (vehicle) {
    const descriptor = [vehicle.make, vehicle.model].filter(Boolean).join(' ');
    title = `Keep ${escapeHTML(vehicle.name)} running beautifully.`;
    copy = descriptor ? `${escapeHTML(descriptor)} · ${escapeHTML(vehicle.fuelType || 'Fuel vehicle')}` : 'Your complete ownership history, kept privately on this device.';
    dialValue = formatNumber(fromCanonicalDistance(currentOdometer(vehicle, state.data.fuelLogs, state.data.serviceRecords), state.data.settings.distanceUnit), 0);
    dialLabel = `odometer ${state.data.settings.distanceUnit}`;
  } else {
    title = vehicles.length === 1 ? `Keep ${escapeHTML(vehicles[0].name)} running beautifully.` : `${vehicles.length} vehicles. One clear view.`;
    copy = reminders[0]?.due ? `${escapeHTML(reminders[0].category)} is due for ${escapeHTML(reminders[0].vehicle?.name ?? 'a vehicle')}.` : 'Fuel, maintenance and ownership costs—without giving up your data.';
    dialValue = formatNumber(records.length, 0);
    dialLabel = records.length === 1 ? 'record saved' : 'records saved';
  }
  return `
    <article class="hero-card">
      <div class="hero-content">
        <p class="eyebrow">${reminders.some((item) => item.due) ? `${reminders.filter((item) => item.due).length} maintenance alert${reminders.filter((item) => item.due).length === 1 ? '' : 's'}` : 'Everything looks on track'}</p>
        <h2>${title}</h2>
        <p>${copy}</p>
        <div class="hero-actions">
          <button class="button primary" type="button" data-open-kind="fuel"><svg><use href="#i-fuel"></use></svg>Log fuel</button>
          <button class="button subtle" type="button" data-open-kind="service"><svg><use href="#i-service"></use></svg>Log service</button>
        </div>
      </div>
      <div class="hero-vehicle"><div class="odometer-dial"><div class="dial-content"><strong>${dialValue}</strong><small>${dialLabel}</small></div></div></div>
    </article>`;
}

function renderDashboard() {
  const container = $('#dashboard-content');
  const vehicles = activeVehicles();
  if (!vehicles.length) {
    container.innerHTML = `
      <div class="welcome-card">
        <div class="welcome-inner">
          <span class="welcome-icon"><svg><use href="#i-car"></use></svg></span>
          <p class="eyebrow">Private · Offline · Yours</p>
          <h2>Your vehicle story starts here.</h2>
          <p>Track every fill-up, service and ownership cost. RoadLedger works offline and keeps everything on this device.</p>
          <div class="welcome-actions">
            <button class="button primary" type="button" data-add-vehicle><svg><use href="#i-plus"></use></svg>Add your first vehicle</button>
            <button class="button subtle" type="button" data-action="sample">Explore with sample data</button>
          </div>
        </div>
      </div>`;
    return;
  }

  const records = unifiedRecords(state.data, state.selectedVehicleId);
  const stats = calculateStats(state.data, state.selectedVehicleId);
  const monthStart = `${todayISO().slice(0, 7)}-01`;
  const monthStats = calculateStats(state.data, state.selectedVehicleId, monthStart);
  const reminders = getReminders(state.data, state.selectedVehicleId);
  const reminderHTML = reminders.length ? `<div class="reminder-list">${reminders.slice(0, 4).map((reminder) => `
    <div class="reminder-item${reminder.due ? ' due' : ''}"><span class="reminder-dot"></span><div><strong>${escapeHTML(reminder.category)} · ${escapeHTML(reminder.vehicle?.name ?? '')}</strong><small>${escapeHTML(describeReminder(reminder, state.data.settings))}</small></div></div>`).join('')}</div>` : `
    <div class="empty-inline"><div><span class="record-icon service"><svg><use href="#i-check"></use></svg></span><strong>No upcoming reminders</strong><small>Add a next date or odometer when logging a service.</small></div></div>`;

  container.innerHTML = `
    ${dashboardHero(stats, records, reminders)}
    <div class="metric-grid">
      <article class="metric-card"><div class="metric-head"><span>This month's spend</span><span class="metric-icon primary"><svg><use href="#i-chart"></use></svg></span></div><strong class="metric-value">${formatMoney(monthStats.totalSpend, currency(), { compact: true })}</strong><span class="metric-foot">Fuel, service and expenses</span></article>
      <article class="metric-card"><div class="metric-head"><span>Average economy</span><span class="metric-icon fuel"><svg><use href="#i-fuel"></use></svg></span></div><strong class="metric-value">${formatEfficiency(stats.averageKmPerLiter, state.data.settings.consumptionUnit)}</strong><span class="metric-foot">Full-to-full calculation</span></article>
      <article class="metric-card"><div class="metric-head"><span>Total fuel</span><span class="metric-icon service"><svg><use href="#i-fuel"></use></svg></span></div><strong class="metric-value">${formatVolume(stats.fuelVolume, state.data.settings)}</strong><span class="metric-foot">${formatMoney(stats.fuelSpend, currency(), { compact: true })} spent</span></article>
      <article class="metric-card"><div class="metric-head"><span>Ownership cost</span><span class="metric-icon expense"><svg><use href="#i-expense"></use></svg></span></div><strong class="metric-value">${formatMoney(stats.totalSpend, currency(), { compact: true })}</strong><span class="metric-foot">Across ${stats.recordCount} record${stats.recordCount === 1 ? '' : 's'}</span></article>
    </div>
    <div class="dashboard-grid">
      <article class="panel"><div class="panel-head"><div><h3>Recent activity</h3><p>Your latest logbook entries</p></div><button class="text-button" type="button" data-go="logbook">View all</button></div>${renderTimeline(records, { limit: 5 })}</article>
      <article class="panel"><div class="panel-head"><div><h3>Maintenance</h3><p>Upcoming date and distance reminders</p></div><button class="text-button" type="button" data-open-kind="service">Add</button></div>${reminderHTML}</article>
    </div>`;
}

function renderLogbook() {
  const container = $('#logbook-content');
  let records = unifiedRecords(state.data, state.selectedVehicleId);
  if (state.logFilter !== 'all') records = records.filter((record) => record.kind === state.logFilter);
  const query = state.logSearch.trim().toLocaleLowerCase();
  if (query) {
    records = records.filter((record) => [recordTitle(record), record.notes, record.station, record.vendor, record.category, record.vehicle?.name]
      .filter(Boolean).join(' ').toLocaleLowerCase().includes(query));
  }
  if (!records.length) {
    container.innerHTML = `<div class="logbook-card">${renderTimeline([], { emptyText: query || state.logFilter !== 'all' ? 'No records match these filters.' : 'Your logbook is empty.' })}</div>`;
    return;
  }

  const groups = new Map();
  for (const record of records) {
    const key = monthKey(record.date);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  container.innerHTML = `<div class="logbook-card">${[...groups.entries()].map(([key, group]) => {
    const date = parseLocalDate(`${key}-01`);
    const label = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(date);
    const sum = group.reduce((total, record) => total + (Number(record.totalCostMinor) || 0), 0);
    return `<section class="logbook-group"><div class="logbook-date"><strong>${escapeHTML(label)}</strong><span>${group.length} entries · ${formatMoney(sum, currency())}</span></div>${renderTimeline(group)}</section>`;
  }).join('')}</div>`;
}

function reportChartWidth({ wide = false } = {}) {
  const reportsWidth = Math.floor($('#reports-content')?.getBoundingClientRect().width || 0);
  const mainWidth = Math.floor($('#main-content')?.getBoundingClientRect().width || 0);
  const availableWidth = reportsWidth || mainWidth || Math.max(320, innerWidth - 30);
  const singleColumn = matchMedia('(max-width: 840px)').matches;
  const panelWidth = wide || singleColumn ? availableWidth : (availableWidth - 16) / 2;
  const panelInsets = matchMedia('(max-width: 560px)').matches ? 36 : 46;
  return Math.round(clamp(panelWidth - panelInsets, 280, 1200));
}

function useCompactChartAxes() {
  return matchMedia('(max-width: 560px)').matches;
}

function formatMoneyAxis(minor, compact) {
  if (!compact) return formatMoney(Math.round(minor), currency(), { compact: true });
  const value = minorToMoney(minor);
  const useCompactNotation = Math.abs(value) >= 1000;
  try {
    return new Intl.NumberFormat(undefined, {
      notation: useCompactNotation ? 'compact' : 'standard',
      minimumFractionDigits: 0,
      maximumFractionDigits: useCompactNotation ? 1 : 0
    }).format(value);
  } catch {
    return formatNumber(value, useCompactNotation ? 1 : 0);
  }
}

function formatEfficiencyAxis(kmPerLiter, compact) {
  const formatted = formatEfficiency(kmPerLiter, state.data.settings.consumptionUnit);
  if (!compact) return formatted;
  const suffix = ` ${state.data.settings.consumptionUnit}`;
  return formatted.endsWith(suffix) ? formatted.slice(0, -suffix.length) : formatted;
}

function formatDistanceAxis(km, compact) {
  if (!compact) return formatDistance(km, state.data.settings);
  const value = fromCanonicalDistance(km, state.data.settings.distanceUnit);
  return new Intl.NumberFormat(undefined, {
    notation: Math.abs(value) >= 1000 ? 'compact' : 'standard',
    minimumFractionDigits: 0,
    maximumFractionDigits: 1
  }).format(value);
}

function renderBarChart(months) {
  const maximum = Math.max(0, ...months.map((item) => item.total));
  const scaleMaximum = Math.max(1, maximum);
  const extendedTimeline = months.length > 12;
  const compactAxis = useCompactChartAxes();
  const chartWidth = reportChartWidth({ wide: true });
  const maximumLabels = chartWidth < 420 ? 4 : chartWidth < 760 ? 7 : 10;
  const labelCount = Math.min(months.length, maximumLabels);
  const labelIndexes = new Set(Array.from({ length: labelCount }, (_, index) => labelCount === 1 ? 0 : Math.round(index * (months.length - 1) / (labelCount - 1))));
  const bars = months.map((item) => {
    const totalHeight = item.total ? Math.max(4, item.total / scaleMaximum * 180) : 2;
    const fuelHeight = item.total ? item.fuel / item.total * 100 : 0;
    const serviceHeight = item.total ? item.service / item.total * 100 : 0;
    const expenseHeight = item.total ? item.expense / item.total * 100 : 0;
    const labelDate = parseLocalDate(`${item.key}-01`);
    const fullLabel = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(labelDate);
    const tooltip = `${fullLabel} · Total ${formatMoney(item.total, currency())} · Fuel ${formatMoney(item.fuel, currency())} · Service ${formatMoney(item.service, currency())} · Other ${formatMoney(item.expense, currency())}`;
    return `<div class="bar-column" tabindex="0" role="img" aria-label="${escapeHTML(tooltip)}" data-chart-tooltip="${escapeHTML(tooltip)}"><div class="bar-stack" style="height:${totalHeight}px"><span class="bar-segment fuel" style="height:${fuelHeight}%"></span><span class="bar-segment service" style="height:${serviceHeight}%"></span><span class="bar-segment expense" style="height:${expenseHeight}%"></span></div></div>`;
  }).join('');
  const labels = months.map((item, index) => {
    if (!labelIndexes.has(index)) return '';
    const labelDate = parseLocalDate(`${item.key}-01`);
    const label = new Intl.DateTimeFormat(undefined, extendedTimeline ? { month: 'short', year: '2-digit' } : { month: 'short' }).format(labelDate);
    const position = months.length === 1 ? 50 : index / (months.length - 1) * 100;
    const edgeClass = index === 0 ? ' first' : index === months.length - 1 ? ' last' : '';
    return `<span class="bar-axis-label${edgeClass}" style="left:${position}%">${escapeHTML(label)}</span>`;
  }).join('');
  const yTicks = maximum > 0
    ? [{ value: maximum, position: 0 }, { value: maximum / 2, position: 50 }, { value: 0, position: 100 }]
    : [{ value: 0, position: 100 }];
  const yTickLabels = yTicks.map((tick) => formatMoneyAxis(tick.value, compactAxis));
  const yLabels = yTicks.map((tick, index) => `<span class="bar-y-axis-label" style="top:${tick.position}%">${escapeHTML(yTickLabels[index])}</span>`).join('');
  const yAxisSizer = `<span class="bar-y-axis-sizer">${yTickLabels.map((label) => `<span>${escapeHTML(label)}</span>`).join('')}</span>`;
  const gridLines = yTicks.map((tick) => `<span class="bar-grid-line" style="top:${tick.position}%"></span>`).join('');
  return `<div class="chart-frame bar-chart-frame" role="region" aria-label="Monthly spending overview showing the complete selected period; vertical axis shows total spending"><div class="bar-chart${extendedTimeline ? ' dense' : ''}"><div class="bar-y-axis" aria-hidden="true">${yAxisSizer}${yLabels}</div><div class="bar-plot">${gridLines}${bars}</div><div class="bar-axis" aria-hidden="true">${labels}</div></div></div><small class="chart-overview-note">All ${months.length} month${months.length === 1 ? '' : 's'} shown · Tap or hover a bar for details.</small>`;
}

function renderLineChart(segments) {
  if (!segments.length) return `<div class="empty-inline"><div><span class="record-icon fuel"><svg><use href="#i-chart"></use></svg></span><strong>Not enough full tanks yet</strong><small>Economy appears after two full-tank entries. Partial fills between them are included.</small></div></div>`;
  const vehicles = new Map(state.data.vehicles.map((vehicle) => [vehicle.id, vehicle]));
  const grouped = new Map();
  for (const segment of segments) {
    const vehicle = vehicles.get(segment.vehicleId) ?? { id: segment.vehicleId, name: 'Unknown vehicle', color: '#2f7d5d' };
    const item = grouped.get(segment.vehicleId) ?? { vehicle, points: [] };
    item.points.push(segment);
    grouped.set(segment.vehicleId, item);
  }
  const series = [...grouped.values()].map((item) => ({
    ...item,
    points: item.points.sort((a, b) => String(a.date).localeCompare(String(b.date)))
  }));
  const points = series.flatMap((item) => item.points);
  const values = points.map((item) => item.kmPerLiter);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const padding = Math.max(0.8, (rawMax - rawMin) * 0.14);
  const minEfficiency = Math.max(0.1, rawMin - padding);
  const maxEfficiency = rawMax + padding;
  const compactAxis = useCompactChartAxes();
  const width = reportChartWidth();
  const left = compactAxis ? 46 : 88;
  const right = width - (compactAxis ? 8 : 12);
  const top = 22;
  const bottom = 205;
  const middle = (top + bottom) / 2;
  const dateValues = points.map((point) => parseLocalDate(point.date)?.getTime()).filter(Number.isFinite);
  const minDate = Math.min(...dateValues);
  const maxDate = Math.max(...dateValues);
  const xForDate = (date) => minDate === maxDate ? (left + right) / 2 : left + (right - left) * ((parseLocalDate(date).getTime() - minDate) / (maxDate - minDate));
  const yForEfficiency = (value) => bottom - (bottom - top) * ((value - minEfficiency) / Math.max(0.001, maxEfficiency - minEfficiency));
  const firstDate = points.reduce((earliest, point) => String(point.date) < earliest ? String(point.date) : earliest, String(points[0].date));
  const lastDate = points.reduce((latest, point) => String(point.date) > latest ? String(point.date) : latest, String(points[0].date));
  const largestSeries = Math.max(...series.map((item) => item.points.length));
  const pointSpacing = (right - left) / Math.max(1, largestSeries - 1);
  const pointRadius = pointSpacing < 4 ? 2.8 : pointSpacing < 7 ? 3.6 : 5;
  return `
    <div class="chart-legend fuel-economy-legend">${series.map((item) => `<span class="legend-item"><i style="background:${safeColor(item.vehicle.color)}"></i>${escapeHTML(item.vehicle.name)}</span>`).join('')}<span class="legend-context">${escapeHTML(state.data.settings.consumptionUnit)} · higher is better</span></div>
    <div class="chart-frame fuel-economy-frame" role="region" aria-label="Fuel economy overview showing the complete selected period">
      <svg class="line-chart fuel-economy-chart" viewBox="0 0 ${width} 250" data-chart-width="${width}" role="img" aria-label="Fuel economy trend for ${escapeHTML(series.map((item) => item.vehicle.name).join(', '))}">
        <line class="grid-line" x1="${left}" y1="${top}" x2="${right}" y2="${top}"/><line class="grid-line" x1="${left}" y1="${middle}" x2="${right}" y2="${middle}"/><line class="grid-line" x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}"/>
        <text x="${left - 8}" y="${top + 4}" text-anchor="end">${escapeHTML(formatEfficiencyAxis(maxEfficiency, compactAxis))}</text>
        <text x="${left - 8}" y="${middle + 4}" text-anchor="end">${escapeHTML(formatEfficiencyAxis((minEfficiency + maxEfficiency) / 2, compactAxis))}</text>
        <text x="${left - 8}" y="${bottom + 4}" text-anchor="end">${escapeHTML(formatEfficiencyAxis(minEfficiency, compactAxis))}</text>
        <text x="${left}" y="240" text-anchor="start">${escapeHTML(formatDate(firstDate, { short: true }))}</text><text x="${right}" y="240" text-anchor="end">${escapeHTML(formatDate(lastDate, { short: true }))}</text>
        ${series.map((item) => {
          const color = safeColor(item.vehicle.color);
          const coordinates = item.points.map((point) => ({ x: xForDate(point.date), y: yForEfficiency(point.kmPerLiter), point }));
          const path = coordinates.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
          return `<path class="fuel-economy-line" d="${path}" style="stroke:${color}"/>${coordinates.map((point) => {
            const tooltip = `${item.vehicle.name} · ${formatDate(point.point.date, { short: true })} · ${formatEfficiency(point.point.kmPerLiter, state.data.settings.consumptionUnit)} · ${formatDistance(point.point.distanceKm, state.data.settings)} on ${formatVolume(point.point.volumeLiters, state.data.settings)}`;
            return `<circle class="fuel-economy-point chart-point" cx="${point.x}" cy="${point.y}" r="${pointRadius}" style="stroke:${color}" tabindex="0" role="img" aria-label="${escapeHTML(tooltip)}" data-chart-tooltip="${escapeHTML(tooltip)}"/>`;
          }).join('')}`;
        }).join('')}
      </svg>
    </div>
    <small class="chart-overview-note">All ${points.length} segment${points.length === 1 ? '' : 's'} shown · Tap or hover a point for details.</small>`;
}

function formatPricePerVolume(spendMinor, liters) {
  const displayVolume = fromCanonicalVolume(liters, state.data.settings.volumeUnit);
  if (!displayVolume || !Number.isFinite(displayVolume)) return '—';
  return `${formatMoney(Math.round(spendMinor / displayVolume), currency())}/${state.data.settings.volumeUnit}`;
}

function renderFuelOverview(stats) {
  const logs = sortRecordsNewest(stats.fuelLogs).reverse();
  if (!logs.length) {
    return `<div class="empty-inline"><div><span class="record-icon fuel"><svg><use href="#i-fuel"></use></svg></span><strong>No fuel statistics in this period</strong><small>Add a fill-up or choose a wider report period.</small></div></div>`;
  }
  const firstDate = logs[0].date;
  const lastDate = logs.at(-1).date;
  const trackedDays = Math.max(1, daysBetween(firstDate, lastDate) + 1);
  const economyValues = stats.segments.map((segment) => segment.kmPerLiter).filter((value) => value > 0);
  const lowest = economyValues.length ? Math.min(...economyValues) : 0;
  const highest = economyValues.length ? Math.max(...economyValues) : 0;
  const displayDistance = fromCanonicalDistance(stats.distanceKm, state.data.settings.distanceUnit);
  const costPerDistance = displayDistance > 0 ? formatMoney(Math.round(stats.fuelSpend / displayDistance), currency()) : '—';
  return `
    <div class="fuel-overview-grid">
      <div class="fuel-stat"><span>Fuel cost</span><strong>${formatMoney(stats.fuelSpend, currency(), { compact: true })}</strong><small>${formatMoney(Math.round(stats.fuelSpend / trackedDays), currency())} per day</small></div>
      <div class="fuel-stat"><span>Total volume</span><strong>${formatVolume(stats.fuelVolume, state.data.settings)}</strong><small>${logs.length} fill-up${logs.length === 1 ? '' : 's'}</small></div>
      <div class="fuel-stat"><span>Average unit price</span><strong>${formatPricePerVolume(stats.fuelSpend, stats.fuelVolume)}</strong><small>Weighted by purchased volume</small></div>
      <div class="fuel-stat"><span>Fuel cost per distance</span><strong>${costPerDistance}${displayDistance > 0 ? `/${state.data.settings.distanceUnit}` : ''}</strong><small>Fuel cost only</small></div>
    </div>
    <div class="economy-range">
      <div><span>Lowest segment</span><strong>${formatEfficiency(lowest, state.data.settings.consumptionUnit)}</strong></div>
      <div class="average"><span>Weighted average</span><strong>${formatEfficiency(stats.averageKmPerLiter, state.data.settings.consumptionUnit)}</strong></div>
      <div><span>Highest segment</span><strong>${formatEfficiency(highest, state.data.settings.consumptionUnit)}</strong></div>
    </div>
    <div class="report-range-foot">${logs.length} entries · ${formatDate(firstDate, { short: true })} – ${formatDate(lastDate, { short: true })} · ${trackedDays} day${trackedDays === 1 ? '' : 's'}</div>`;
}

const STATION_CHART_COLORS = ['#4f9f7c', '#e39432', '#4388c8', '#9160c0', '#d86459', '#2c9b9a', '#b09b38', '#7086a5', '#bf6790', '#789647'];

function renderStationEconomyChart(segments, stations) {
  const stationNames = new Map(stations.map((station) => [station.key, station.name]));
  const stationOrder = new Map(stations.map((station, index) => [station.key, index]));
  const grouped = new Map();
  for (const segment of segments) {
    const station = String(segment.sourceStation ?? '').trim();
    if (!station || segment.hadPartialFill || !(Number(segment.kmPerLiter) > 0)) continue;
    const key = station.toLocaleLowerCase();
    const series = grouped.get(key) ?? { key, name: stationNames.get(key) ?? station, points: [] };
    series.points.push({ date: segment.date, kmPerLiter: Number(segment.kmPerLiter) });
    grouped.set(key, series);
  }
  const series = [...grouped.values()]
    .map((item) => ({ ...item, points: item.points.sort((a, b) => String(a.date).localeCompare(String(b.date))) }))
    .sort((a, b) => (stationOrder.get(a.key) ?? Number.MAX_SAFE_INTEGER) - (stationOrder.get(b.key) ?? Number.MAX_SAFE_INTEGER));
  const allPoints = series.flatMap((item) => item.points);
  if (!allPoints.length) {
    return `<div class="empty-inline station-chart-empty"><div><span class="record-icon fuel"><svg><use href="#i-chart"></use></svg></span><strong>Not enough station history yet</strong><small>Two full tanks with a station recorded are needed. Mixed partial-fill trips are excluded.</small></div></div>`;
  }

  const dates = allPoints.map((point) => parseLocalDate(point.date)?.getTime()).filter(Number.isFinite);
  const values = allPoints.map((point) => point.kmPerLiter);
  const minDate = Math.min(...dates);
  const maxDate = Math.max(...dates);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const padding = Math.max(0.6, (rawMax - rawMin) * 0.14);
  const minEfficiency = Math.max(0.1, rawMin - padding);
  const maxEfficiency = rawMax + padding;
  const compactAxis = useCompactChartAxes();
  const width = reportChartWidth({ wide: true });
  const left = compactAxis ? 46 : 88;
  const right = width - (compactAxis ? 8 : 12);
  const top = 22;
  const bottom = 220;
  const middle = (top + bottom) / 2;
  const xForDate = (date) => minDate === maxDate
    ? (left + right) / 2
    : left + (right - left) * ((parseLocalDate(date).getTime() - minDate) / (maxDate - minDate));
  const yForEfficiency = (value) => bottom - (bottom - top) * ((value - minEfficiency) / Math.max(0.001, maxEfficiency - minEfficiency));
  const firstDate = allPoints.reduce((earliest, point) => String(point.date) < earliest ? String(point.date) : earliest, String(allPoints[0].date));
  const lastDate = allPoints.reduce((latest, point) => String(point.date) > latest ? String(point.date) : latest, String(allPoints[0].date));
  const largestSeries = Math.max(...series.map((item) => item.points.length));
  const pointSpacing = (right - left) / Math.max(1, largestSeries - 1);
  const pointRadius = pointSpacing < 4 ? 2.8 : pointSpacing < 7 ? 3.6 : pointSpacing < 11 ? 4.2 : 5;

  return `
    <div class="station-economy-block">
      <div class="chart-legend station-chart-legend">${series.map((item, index) => {
        const tooltip = `${item.name} · latest ${formatEfficiency(item.points.at(-1).kmPerLiter, state.data.settings.consumptionUnit)} · ${item.points.length} comparable trip${item.points.length === 1 ? '' : 's'}`;
        return `<span class="legend-item" tabindex="0" data-chart-tooltip="${escapeHTML(tooltip)}"><i style="background:${STATION_CHART_COLORS[index % STATION_CHART_COLORS.length]}"></i>${escapeHTML(item.name)}</span>`;
      }).join('')}<span class="legend-context axis-unit-context">Y-axis · ${escapeHTML(state.data.settings.consumptionUnit)}</span></div>
      <div class="chart-frame station-chart-frame" role="region" aria-label="Station economy overview showing the complete selected period">
        <svg class="line-chart station-economy-chart" viewBox="0 0 ${width} 260" data-chart-width="${width}" role="img" aria-label="Fuel economy by station over time: ${escapeHTML(series.map((item) => item.name).join(', '))}">
          <line class="grid-line" x1="${left}" y1="${top}" x2="${right}" y2="${top}"/><line class="grid-line" x1="${left}" y1="${middle}" x2="${right}" y2="${middle}"/><line class="grid-line" x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}"/>
          <text x="${left - 8}" y="${top + 4}" text-anchor="end">${escapeHTML(formatEfficiencyAxis(maxEfficiency, compactAxis))}</text>
          <text x="${left - 8}" y="${middle + 4}" text-anchor="end">${escapeHTML(formatEfficiencyAxis((minEfficiency + maxEfficiency) / 2, compactAxis))}</text>
          <text x="${left - 8}" y="${bottom + 4}" text-anchor="end">${escapeHTML(formatEfficiencyAxis(minEfficiency, compactAxis))}</text>
          <text x="${left}" y="250" text-anchor="start">${escapeHTML(formatDate(firstDate, { short: true }))}</text><text x="${right}" y="250" text-anchor="end">${escapeHTML(formatDate(lastDate, { short: true }))}</text>
          ${series.map((item, index) => {
            const color = STATION_CHART_COLORS[index % STATION_CHART_COLORS.length];
            const coordinates = item.points.map((point) => ({ x: xForDate(point.date), y: yForEfficiency(point.kmPerLiter), point }));
            const path = coordinates.map((point, pointIndex) => `${pointIndex ? 'L' : 'M'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
            return `<path class="station-series-line" d="${path}" style="stroke:${color}"/>${coordinates.map((point) => {
              const tooltip = `${item.name} · trip ending ${formatDate(point.point.date, { short: true })} · ${formatEfficiency(point.point.kmPerLiter, state.data.settings.consumptionUnit)}`;
              return `<circle class="station-series-point chart-point" cx="${point.x}" cy="${point.y}" r="${pointRadius}" style="stroke:${color}" tabindex="0" role="img" aria-label="${escapeHTML(tooltip)}" data-chart-tooltip="${escapeHTML(tooltip)}"/>`;
            }).join('')}`;
          }).join('')}
        </svg>
      </div>
      <small class="chart-overview-note">All ${allPoints.length} comparable trip${allPoints.length === 1 ? '' : 's'} shown · Tap or hover a point or station name for details.</small>
    </div>`;
}

function renderStationReport(stations, segments) {
  if (!stations.length) {
    return `<div class="empty-inline"><div><span class="record-icon fuel"><svg><use href="#i-fuel"></use></svg></span><strong>No stations recorded</strong><small>Add a station name to fill-ups to compare them here.</small></div></div>`;
  }
  return `
    ${renderStationEconomyChart(segments, stations)}
    <details class="station-summary-disclosure"${state.stationSummaryExpanded ? ' open' : ''}>
      <summary class="station-summary-toggle">
        <span><strong>Station summary</strong><small>${stations.length} station${stations.length === 1 ? '' : 's'} · Weighted totals for this period</small></span>
        <span class="station-summary-action"><span class="when-closed">Show</span><span class="when-open">Hide</span><i aria-hidden="true"></i></span>
      </summary>
      <div class="station-summary-content">
        <div class="station-table" role="table" aria-label="Fuel economy by station">
          <div class="station-row station-header" role="row"><span>Station</span><span>Economy</span><span>Avg. price</span><span>Fuel spend</span></div>
          ${stations.map((station) => `
            <div class="station-row" role="row">
              <div class="station-name"><strong>${escapeHTML(station.name)}</strong><small>${station.fillCount} fill-up${station.fillCount === 1 ? '' : 's'} · ${station.segmentCount} valid trip${station.segmentCount === 1 ? '' : 's'}</small></div>
              <div data-label="Economy"><strong>${formatEfficiency(station.averageKmPerLiter, state.data.settings.consumptionUnit)}</strong>${station.segmentCount ? `<small>${formatEfficiency(station.lowestKmPerLiter, state.data.settings.consumptionUnit)} – ${formatEfficiency(station.highestKmPerLiter, state.data.settings.consumptionUnit)}</small>` : '<small>Needs another full tank</small>'}</div>
              <div data-label="Avg. price"><strong>${formatPricePerVolume(station.spendMinor, station.volumeLiters)}</strong><small>Volume weighted</small></div>
              <div data-label="Fuel spend"><strong>${formatMoney(station.spendMinor, currency(), { compact: true })}</strong><small>${formatVolume(station.volumeLiters, state.data.settings)}</small></div>
            </div>`).join('')}
        </div>
        <div class="method-note"><svg><use href="#i-check"></use></svg><span>To compare fuel quality fairly, economy is credited to the station of the starting full tank. Segments containing partial or missed fills are excluded from station economy.</span></div>
      </div>
    </details>`;
}

function odometerSeries(cutoffDate) {
  const vehicles = activeVehicles().filter((vehicle) => state.selectedVehicleId === 'all' || vehicle.id === state.selectedVehicleId);
  return vehicles.map((vehicle) => {
    const byDate = new Map();
    for (const record of unifiedRecords(state.data, vehicle.id)) {
      if (cutoffDate && String(record.date) < cutoffDate) continue;
      const previous = byDate.get(record.date);
      if (!previous || Number(record.odometerKm) > Number(previous.odometerKm)) byDate.set(record.date, record);
    }
    return {
      vehicle,
      points: [...byDate.values()]
        .sort((a, b) => String(a.date).localeCompare(String(b.date)))
        .map((record) => ({ date: record.date, odometerKm: Number(record.odometerKm) || 0 }))
    };
  }).filter((series) => series.points.length);
}

function renderOdometerChart(cutoffDate) {
  const series = odometerSeries(cutoffDate);
  const allPoints = series.flatMap((item) => item.points);
  if (!allPoints.length) {
    return `<div class="empty-inline"><div><span class="record-icon service"><svg><use href="#i-chart"></use></svg></span><strong>No odometer history in this period</strong><small>Odometer readings are captured with each fuel and service record.</small></div></div>`;
  }
  const dateValues = allPoints.map((point) => parseLocalDate(point.date)?.getTime()).filter(Number.isFinite);
  const odometerValues = allPoints.map((point) => point.odometerKm);
  const minDate = Math.min(...dateValues);
  const maxDate = Math.max(...dateValues);
  const rawMin = Math.min(...odometerValues);
  const rawMax = Math.max(...odometerValues);
  const padding = Math.max(1, (rawMax - rawMin) * 0.08);
  const minOdometer = Math.max(0, rawMin - padding);
  const maxOdometer = rawMax + padding;
  const compactAxis = useCompactChartAxes();
  const width = reportChartWidth({ wide: true });
  const left = compactAxis ? 58 : 112;
  const right = width - (compactAxis ? 8 : 12);
  const top = 24;
  const bottom = 200;
  const xForDate = (date) => minDate === maxDate ? (left + right) / 2 : left + (right - left) * ((parseLocalDate(date).getTime() - minDate) / (maxDate - minDate));
  const yForOdometer = (value) => bottom - (bottom - top) * ((value - minOdometer) / Math.max(1, maxOdometer - minOdometer));
  const xTickRatios = minDate === maxDate ? [0.5] : width > 900 ? [0, 0.25, 0.5, 0.75, 1] : [0, 0.5, 1];
  const yTicks = [maxOdometer, (minOdometer + maxOdometer) / 2, minOdometer];
  const largestSeries = Math.max(...series.map((item) => item.points.length));
  const pointSpacing = (right - left) / Math.max(1, largestSeries - 1);
  const densePoints = pointSpacing < 6;
  const pointRadius = densePoints ? 4 : pointSpacing < 7 ? 3.6 : 5;
  return `
    <div class="chart-legend odometer-legend">${series.map((item) => `<span class="legend-item"><i style="background:${safeColor(item.vehicle.color)}"></i>${escapeHTML(item.vehicle.name)}</span>`).join('')}<span class="legend-context axis-unit-context">Y-axis · ${escapeHTML(state.data.settings.distanceUnit)}</span></div>
    <div class="chart-frame odometer-chart-frame" role="region" aria-label="Odometer overview showing the complete selected period">
      <svg class="line-chart odometer-chart" viewBox="0 0 ${width} 250" data-chart-width="${width}" role="img" aria-label="Odometer history">
        ${yTicks.map((value) => {
          const y = yForOdometer(value);
          return `<line class="grid-line" x1="${left}" y1="${y}" x2="${right}" y2="${y}"/><text x="${left - 8}" y="${y + 4}" text-anchor="end">${escapeHTML(formatDistanceAxis(value, compactAxis))}</text>`;
        }).join('')}
        ${xTickRatios.map((ratio, index) => {
          const x = left + (right - left) * ratio;
          const time = minDate + (maxDate - minDate) * ratio;
          const anchor = index === 0 ? 'start' : index === xTickRatios.length - 1 ? 'end' : 'middle';
          const label = new Intl.DateTimeFormat(undefined, { month: 'short', year: width < 500 ? '2-digit' : 'numeric' }).format(new Date(time));
          return `<line class="grid-line vertical" x1="${x}" y1="${top}" x2="${x}" y2="${bottom}"/><text x="${x}" y="240" text-anchor="${anchor}">${escapeHTML(label)}</text>`;
        }).join('')}
        ${series.map((item) => {
          const coordinates = item.points.map((point) => ({ x: xForDate(point.date), y: yForOdometer(point.odometerKm), point }));
          const path = coordinates.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
          const color = safeColor(item.vehicle.color);
          const markerEvery = Math.max(1, Math.ceil(coordinates.length / 14));
          return `<path class="odometer-line" d="${path}" style="stroke:${color}"/>${coordinates.map((point, index) => {
            const tooltip = `${item.vehicle.name} · ${formatDate(point.point.date, { short: true })} · ${formatDistance(point.point.odometerKm, state.data.settings)}`;
            const marker = !densePoints || index === 0 || index === coordinates.length - 1 || index % markerEvery === 0;
            return `<circle class="odometer-point chart-point${densePoints ? ' dense-point' : ''}${marker ? ' marker' : ''}" cx="${point.x}" cy="${point.y}" r="${pointRadius}" style="--point-color:${color}" tabindex="0" role="img" aria-label="${escapeHTML(tooltip)}" data-chart-tooltip="${escapeHTML(tooltip)}"/>`;
          }).join('')}`;
        }).join('')}
      </svg>
    </div>
    <small class="chart-overview-note">All ${allPoints.length} reading${allPoints.length === 1 ? '' : 's'} shown · Tap or hover a point for details.</small>`;
}

function renderReports() {
  const container = $('#reports-content');
  const cutoff = getCutoffDate(state.reportPeriod);
  const stats = calculateStats(state.data, state.selectedVehicleId, cutoff);
  const stations = buildStationStats(state.data, state.selectedVehicleId, cutoff);
  const monthBuckets = state.reportPeriod === 'all' ? null : state.reportPeriod === '90' ? 4 : 12;
  const months = buildMonthlyTotals(state.data, state.selectedVehicleId, cutoff, monthBuckets);
  const categories = categoryTotals(state.data, state.selectedVehicleId, cutoff).slice(0, 7);
  const totalBreakdown = Math.max(1, stats.totalSpend);
  const fuelPercent = stats.totalSpend ? stats.fuelSpend / totalBreakdown * 100 : 0;
  const servicePercent = stats.totalSpend ? stats.serviceSpend / totalBreakdown * 100 : 0;
  const fuelEnd = fuelPercent;
  const serviceEnd = fuelPercent + servicePercent;
  const donutBackground = stats.totalSpend
    ? `conic-gradient(var(--fuel) 0 ${fuelEnd}%, var(--service) ${fuelEnd}% ${serviceEnd}%, var(--expense) ${serviceEnd}% 100%)`
    : 'var(--surface-3)';
  const categoryMax = Math.max(1, ...categories.map((item) => item.amount));

  container.innerHTML = `
    <div class="report-summary">
      <article class="metric-card"><div class="metric-head"><span>Total spend</span><span class="metric-icon primary"><svg><use href="#i-expense"></use></svg></span></div><strong class="metric-value">${formatMoney(stats.totalSpend, currency(), { compact: true })}</strong><span class="metric-foot">${stats.recordCount} records in range</span></article>
      <article class="metric-card"><div class="metric-head"><span>Fuel economy</span><span class="metric-icon fuel"><svg><use href="#i-fuel"></use></svg></span></div><strong class="metric-value">${formatEfficiency(stats.averageKmPerLiter, state.data.settings.consumptionUnit)}</strong><span class="metric-foot">${stats.segments.length} valid segments</span></article>
      <article class="metric-card"><div class="metric-head"><span>Distance tracked</span><span class="metric-icon service"><svg><use href="#i-chart"></use></svg></span></div><strong class="metric-value">${formatDistance(stats.distanceKm, state.data.settings)}</strong><span class="metric-foot">Odometer range</span></article>
      <article class="metric-card"><div class="metric-head"><span>Cost per distance</span><span class="metric-icon expense"><svg><use href="#i-chart"></use></svg></span></div><strong class="metric-value">${stats.distanceKm ? `${formatMoney(Math.round(stats.totalSpend / fromCanonicalDistance(stats.distanceKm, state.data.settings.distanceUnit)), currency())}/${state.data.settings.distanceUnit}` : '—'}</strong><span class="metric-foot">All ownership costs</span></article>
    </div>
    <div class="reports-grid">
      <article class="panel chart-panel wide"><div class="panel-head"><div><h3>Monthly spending</h3><p>Fuel, service and other expenses${useCompactChartAxes() ? ` · ${escapeHTML(currency())}` : ''}</p></div><div class="chart-legend"><span class="legend-item"><i style="background:var(--fuel)"></i>Fuel</span><span class="legend-item"><i style="background:var(--service)"></i>Service</span><span class="legend-item"><i style="background:var(--expense)"></i>Other</span></div></div>${renderBarChart(months)}</article>
      <article class="panel chart-panel wide"><div class="panel-head"><div><h3>Fuel details</h3><p>Cost, volume, price and economy range</p></div></div>${renderFuelOverview(stats)}</article>
      <article class="panel chart-panel"><div class="panel-head"><div><h3>Fuel economy</h3><p>Full-to-full weighted trend</p></div><strong>${formatEfficiency(stats.averageKmPerLiter, state.data.settings.consumptionUnit)}</strong></div><div class="chart-area">${renderLineChart(stats.segments)}</div><div class="method-note"><svg><use href="#i-check"></use></svg><span>Partial fills accumulate until the next full tank. Segments containing a missed fill are excluded.</span></div></article>
      <article class="panel chart-panel"><div class="panel-head"><div><h3>Cost breakdown</h3><p>Where ownership money goes</p></div></div><div class="breakdown-layout"><div class="donut" tabindex="0" data-chart-tooltip="${escapeHTML(`Total ownership spend · ${formatMoney(stats.totalSpend, currency())}`)}" style="background:${donutBackground}"><div class="donut-center"><strong>${formatMoney(stats.totalSpend, currency(), { compact: true })}</strong><small>Total</small></div></div><div class="category-bars">
        <div class="category-row" tabindex="0" data-chart-tooltip="${escapeHTML(`Fuel · ${formatMoney(stats.fuelSpend, currency())}`)}"><span>Fuel</span><span class="category-track"><span class="category-fill" style="display:block;width:${fuelPercent}%;background:var(--fuel)"></span></span><strong>${formatMoney(stats.fuelSpend, currency(), { compact: true })}</strong></div>
        <div class="category-row" tabindex="0" data-chart-tooltip="${escapeHTML(`Service · ${formatMoney(stats.serviceSpend, currency())}`)}"><span>Service</span><span class="category-track"><span class="category-fill" style="display:block;width:${stats.totalSpend ? stats.serviceSpend / totalBreakdown * 100 : 0}%;background:var(--service)"></span></span><strong>${formatMoney(stats.serviceSpend, currency(), { compact: true })}</strong></div>
        <div class="category-row" tabindex="0" data-chart-tooltip="${escapeHTML(`Other expenses · ${formatMoney(stats.expenseSpend, currency())}`)}"><span>Other</span><span class="category-track"><span class="category-fill" style="display:block;width:${stats.totalSpend ? stats.expenseSpend / totalBreakdown * 100 : 0}%;background:var(--expense)"></span></span><strong>${formatMoney(stats.expenseSpend, currency(), { compact: true })}</strong></div>
      </div></div></article>
      <article class="panel chart-panel wide"><div class="panel-head"><div><h3>Fuel economy by station</h3><p>See how every station performed over time</p></div></div>${renderStationReport(stations, stats.segments)}</article>
      <article class="panel chart-panel wide"><div class="panel-head"><div><h3>Odometer history</h3><p>Recorded distance over time</p></div></div>${renderOdometerChart(cutoff)}</article>
      <article class="panel chart-panel wide"><div class="panel-head"><div><h3>Service and expense categories</h3><p>Largest non-fuel costs</p></div></div>${categories.length ? `<div class="category-bars">${categories.map((item) => `<div class="category-row" tabindex="0" data-chart-tooltip="${escapeHTML(`${item.category} · ${formatMoney(item.amount, currency())}`)}"><span title="${escapeHTML(item.category)}">${escapeHTML(item.category)}</span><span class="category-track"><span class="category-fill" style="display:block;width:${item.amount / categoryMax * 100}%"></span></span><strong>${formatMoney(item.amount, currency(), { compact: true })}</strong></div>`).join('')}</div>` : `<div class="empty-inline"><div><strong>No service costs in this period</strong><small>Change the date range or add a service record.</small></div></div>`}</article>
    </div>`;
  const stationSummary = $('.station-summary-disclosure', container);
  stationSummary?.addEventListener('toggle', () => {
    state.stationSummaryExpanded = stationSummary.open;
  });
}

function formatBytes(bytes) {
  if (!bytes) return '0 KB';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${formatNumber(bytes / 1024 ** index, index ? 1 : 0)} ${units[index]}`;
}

function roadLedgerDataBytes() {
  try {
    const data = JSON.stringify({
      vehicles: state.data.vehicles,
      fuelLogs: state.data.fuelLogs,
      serviceRecords: state.data.serviceRecords,
      settings: state.data.settings
    });
    return new TextEncoder().encode(data).byteLength;
  } catch {
    return 0;
  }
}

function storageStatusText() {
  const size = formatBytes(roadLedgerDataBytes());
  if (!state.storage) return `RoadLedger data ≈ ${size}`;
  if (!state.storage.supported) return `Stored in this browser · RoadLedger data ≈ ${size}`;
  return `${state.storage.persisted ? 'Saved locally · Protected from automatic cleanup' : 'Saved locally · Standard browser storage'} · RoadLedger data ≈ ${size}`;
}

function renderGarage() {
  const container = $('#garage-content');
  const settings = state.data.settings;
  const vehicles = [...activeVehicles(), ...state.data.vehicles.filter((vehicle) => vehicle.archivedAt)];
  const vehicleHTML = vehicles.length ? `<div class="vehicle-list">${vehicles.map((vehicle) => {
    const odometer = currentOdometer(vehicle, state.data.fuelLogs, state.data.serviceRecords);
    const descriptor = [vehicle.year, vehicle.make, vehicle.model, vehicle.fuelType].filter(Boolean).join(' · ');
    return `<button class="vehicle-card" type="button" data-edit-vehicle="${escapeHTML(vehicle.id)}"><span class="vehicle-avatar" style="background:${safeColor(vehicle.color)}"><svg><use href="#i-car"></use></svg></span><span class="vehicle-details"><strong>${escapeHTML(vehicle.name)}${vehicle.archivedAt ? ' · Archived' : ''}</strong><small>${escapeHTML(descriptor || vehicle.type || 'Vehicle')}</small></span><span class="vehicle-stat"><strong>${formatDistance(odometer, settings)}</strong><small>Odometer</small></span></button>`;
  }).join('')}</div>` : `<div class="empty-inline"><div><strong>No vehicles yet</strong><small>Add a vehicle to start your private logbook.</small></div></div>`;
  const backupText = settings.lastBackupAt ? `Last backup ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(settings.lastBackupAt))}` : 'No backup created yet';
  const storageText = storageStatusText();

  container.innerHTML = `
    <div class="garage-grid">
      <article class="panel"><div class="panel-head"><div><h3>Vehicles</h3><p>${activeVehicles().length} active vehicle${activeVehicles().length === 1 ? '' : 's'}</p></div></div>${vehicleHTML}</article>
      <div class="settings-stack">
        <section class="settings-card"><h3>Display and units</h3><p>Values are converted without changing the original data.</p>
          <div class="settings-row"><label for="setting-currency"><strong>Currency</strong><small>Used for all costs</small></label><select id="setting-currency" data-setting="currency">${CURRENCIES.map(([code, name]) => `<option value="${code}"${selectedOption(code, settings.currency)}>${code} · ${escapeHTML(name)}</option>`).join('')}</select></div>
          <div class="settings-row"><label for="setting-distance"><strong>Distance</strong><small>Odometer and cost unit</small></label><select id="setting-distance" data-setting="distanceUnit"><option value="km"${selectedOption('km', settings.distanceUnit)}>Kilometres</option><option value="mi"${selectedOption('mi', settings.distanceUnit)}>Miles</option></select></div>
          <div class="settings-row"><label for="setting-volume"><strong>Fuel volume</strong><small>Litres or US gallons</small></label><select id="setting-volume" data-setting="volumeUnit"><option value="L"${selectedOption('L', settings.volumeUnit)}>Litres</option><option value="gal"${selectedOption('gal', settings.volumeUnit)}>US gallons</option></select></div>
          <div class="settings-row"><label for="setting-economy"><strong>Fuel economy</strong><small>Preferred consumption format</small></label><select id="setting-economy" data-setting="consumptionUnit"><option value="km/L"${selectedOption('km/L', settings.consumptionUnit)}>km/L</option><option value="L/100km"${selectedOption('L/100km', settings.consumptionUnit)}>L/100km</option><option value="mpg"${selectedOption('mpg', settings.consumptionUnit)}>US mpg</option></select></div>
          <div class="settings-row"><label for="setting-theme"><strong>Appearance</strong><small>Light, dark or device setting</small></label><select id="setting-theme" data-setting="theme"><option value="auto"${selectedOption('auto', settings.theme)}>System</option><option value="light"${selectedOption('light', settings.theme)}>Light</option><option value="dark"${selectedOption('dark', settings.theme)}>Dark</option></select></div>
        </section>
        <section class="settings-card"><h3>Data management</h3><p>${escapeHTML(backupText)}. Backups include receipt images.</p>
          <div class="data-actions">
            <button class="button primary" type="button" data-action="backup"><svg><use href="#i-download"></use></svg>Download backup</button>
            <button class="button subtle" type="button" data-action="import"><svg><use href="#i-upload"></use></svg>Import backup</button>
            <button class="button subtle" type="button" data-action="csv-export"><svg><use href="#i-download"></use></svg>Export CSV</button>
            <button class="button subtle" type="button" data-action="csv-import"><svg><use href="#i-upload"></use></svg>Import CSV</button>
          </div>
          <div class="storage-status"><svg><use href="#i-check"></use></svg><span>${escapeHTML(storageText)}</span>${state.storage?.supported && !state.storage.persisted ? '<button class="text-button" type="button" data-action="persist">Protect</button>' : ''}</div>
          <p class="storage-protection-note"${state.persistenceRequestDenied ? '' : ' hidden'}>Some browsers reconsider after you add a record, install the app, or use it more. Try <strong>Protect</strong> again later.</p>
        </section>
        <section class="settings-card"><h3>App</h3><p>RoadLedger ${APP_VERSION} · Local-first PWA</p>
          <div class="data-actions">
            <button class="button subtle" type="button" data-action="install"><svg><use href="#i-download"></use></svg>Install app</button>
            <button class="button subtle" type="button" data-action="sample">Load sample data</button>
            <a class="button subtle project-link" href="https://github.com/vinyasns/RoadLedger" target="_blank" rel="noopener noreferrer"><svg><use href="#i-external"></use></svg>View project on GitHub</a>
          </div>
          <div class="settings-row"><div><strong class="danger-zone">Reset RoadLedger</strong><small>Permanently remove all local data</small></div><button class="button danger" type="button" data-action="reset">Reset</button></div>
        </section>
      </div>
    </div>`;
  updateStorageStatus();
}

async function updateStorageStatus() {
  try {
    state.storage = await getStorageInfo();
    if (state.currentView === 'garage') {
      const element = $('.storage-status');
      if (element) {
        element.innerHTML = `<svg><use href="#i-check"></use></svg><span>${escapeHTML(storageStatusText())}</span>${state.storage.supported && !state.storage.persisted ? '<button class="text-button" type="button" data-action="persist">Protect</button>' : ''}`;
      }
      const note = $('.storage-protection-note');
      if (note) note.hidden = !state.persistenceRequestDenied;
    }
  } catch {
    // Storage estimates are a progressive enhancement.
  }
}

function updateFormUnitLabels() {
  const settings = state.data.settings;
  $('#odometer-unit-label').textContent = settings.distanceUnit;
  $('#volume-unit-label').textContent = settings.volumeUnit;
  $$('.distance-unit').forEach((element) => { element.textContent = settings.distanceUnit; });
  $$('.currency-code').forEach((element) => { element.textContent = settings.currency; });
  updateFuelUnitPrice();
}

function updateFuelUnitPrice() {
  const output = $('#fuel-unit-price');
  if (!output) return;
  const quantity = Number($('#fuel-quantity')?.value);
  const totalCost = Number($('#fuel-cost')?.value);
  const ready = Number.isFinite(quantity) && quantity > 0 && Number.isFinite(totalCost) && totalCost >= 0 && $('#fuel-cost').value !== '';
  output.classList.toggle('ready', ready);
  output.textContent = ready
    ? `Unit price: ${formatMoney(moneyToMinor(totalCost / quantity), currency())} per ${state.data.settings.volumeUnit}`
    : 'Enter quantity and cost to calculate unit price';
}

function setRecordKind(kind, { editing = false } = {}) {
  if (!['fuel', 'service', 'expense'].includes(kind)) kind = 'fuel';
  $('#record-kind').value = kind;
  $$('[data-record-kind]', $('#record-kind-control')).forEach((button) => {
    button.classList.toggle('active', button.dataset.recordKind === kind);
    button.disabled = editing && button.dataset.recordKind !== kind;
  });
  $$('.fuel-fields').forEach((element) => { element.hidden = kind !== 'fuel'; });
  $$('.service-fields').forEach((element) => { element.hidden = kind === 'fuel'; });
  $$('.service-reminder-fields').forEach((element) => { element.hidden = kind === 'expense'; });
  $('#vendor-label').textContent = kind === 'expense' ? 'Vendor or provider' : 'Workshop or vendor';
  const categories = kind === 'expense' ? EXPENSE_CATEGORIES : SERVICE_CATEGORIES;
  const select = $('#service-category');
  const previous = select.value;
  select.innerHTML = categories.map((category) => `<option value="${escapeHTML(category)}">${escapeHTML(category)}</option>`).join('');
  if (categories.includes(previous)) select.value = previous;
}

function showAttachmentPreview() {
  const preview = $('#attachment-preview');
  if (!state.attachmentDataUrl) {
    preview.hidden = true;
    preview.innerHTML = '';
    return;
  }
  preview.hidden = false;
  const source = String(state.attachmentDataUrl).startsWith('data:image/') ? state.attachmentDataUrl : '';
  if (!source) {
    state.attachmentDataUrl = null;
    preview.hidden = true;
    preview.innerHTML = '';
    return;
  }
  preview.innerHTML = `<img src="${escapeHTML(source)}" alt="Receipt preview" /><button type="button" data-remove-attachment aria-label="Remove image"><svg><use href="#i-close"></use></svg></button>`;
}

function openRecordForm(kind = 'fuel', record = null) {
  const vehicles = activeVehicles();
  if (!vehicles.length) {
    closeDialog($('#action-dialog'));
    toast('Add a vehicle before logging a record.', 'error');
    openVehicleForm();
    return;
  }
  const form = $('#record-form');
  form.reset();
  $('#record-form-error').hidden = true;
  $('#record-id').value = record?.id ?? '';
  $('#record-date').value = record?.date ?? todayISO();
  const preferredVehicle = record?.vehicleId ?? (state.selectedVehicleId !== 'all' ? state.selectedVehicleId : vehicles[0].id);
  $('#record-vehicle').value = preferredVehicle;
  const vehicle = state.data.vehicles.find((item) => item.id === preferredVehicle);
  const currentKm = currentOdometer(vehicle, state.data.fuelLogs, state.data.serviceRecords);
  $('#record-odometer').value = record ? fromCanonicalDistance(record.odometerKm, state.data.settings.distanceUnit).toFixed(1).replace(/\.0$/, '') : fromCanonicalDistance(currentKm, state.data.settings.distanceUnit).toFixed(1).replace(/\.0$/, '');
  state.attachmentDataUrl = record?.attachmentDataUrl ?? null;
  setRecordKind(kind, { editing: Boolean(record) });

  if (kind === 'fuel') {
    $('#fuel-quantity').value = record ? fromCanonicalVolume(record.quantityLiters, state.data.settings.volumeUnit).toFixed(2).replace(/0+$/, '').replace(/\.$/, '') : '';
    $('#fuel-cost').value = record ? minorToMoney(record.totalCostMinor) : '';
    $('#fuel-grade').value = record?.fuelGrade ?? '';
    $('#fuel-station').value = record?.station ?? '';
    $('#fuel-full-tank').checked = record?.fullTank ?? true;
    $('#fuel-missed-fill').checked = record?.missedFill ?? false;
    updateFuelSuggestions(preferredVehicle);
    updateFuelUnitPrice();
  } else {
    const categories = kind === 'expense' ? EXPENSE_CATEGORIES : SERVICE_CATEGORIES;
    if (record?.category && !categories.includes(record.category)) {
      $('#service-category').insertAdjacentHTML('beforeend', `<option value="${escapeHTML(record.category)}">${escapeHTML(record.category)}</option>`);
    }
    $('#service-category').value = record?.category || categories[0];
    $('#service-cost').value = record ? minorToMoney(record.totalCostMinor) : '';
    $('#service-vendor').value = record?.vendor ?? '';
    $('#service-next-date').value = record?.nextDueDate ?? '';
    $('#service-next-odometer').value = record?.nextDueOdometerKm ? fromCanonicalDistance(record.nextDueOdometerKm, state.data.settings.distanceUnit).toFixed(1).replace(/\.0$/, '') : '';
  }
  $('#record-notes').value = record?.notes ?? '';
  $('#record-dialog-title').textContent = record ? `Edit ${labelForKind(kind).toLowerCase()}` : `Add ${labelForKind(kind).toLowerCase()}`;
  $('#delete-record-button').hidden = !record;
  showAttachmentPreview();
  closeDialog($('#action-dialog'));
  openDialog($('#record-dialog'));
}

function openVehicleForm(vehicle = null) {
  const form = $('#vehicle-form');
  form.reset();
  $('#vehicle-form-error').hidden = true;
  $('#vehicle-id').value = vehicle?.id ?? '';
  $('#vehicle-name').value = vehicle?.name ?? '';
  $('#vehicle-type').value = vehicle?.type ?? 'car';
  $('#vehicle-fuel-type').value = vehicle?.fuelType ?? 'Petrol';
  $('#vehicle-make').value = vehicle?.make ?? '';
  $('#vehicle-model').value = vehicle?.model ?? '';
  $('#vehicle-year').value = vehicle?.year ?? '';
  $('#vehicle-registration').value = vehicle?.registration ?? '';
  $('#vehicle-odometer').value = vehicle ? fromCanonicalDistance(vehicle.initialOdometerKm, state.data.settings.distanceUnit).toFixed(1).replace(/\.0$/, '') : '';
  $('#vehicle-color').value = safeColor(vehicle?.color);
  $('#vehicle-dialog-title').textContent = vehicle ? 'Edit vehicle' : 'Add a vehicle';
  const archiveButton = $('#archive-vehicle-button');
  archiveButton.hidden = !vehicle;
  archiveButton.textContent = vehicle?.archivedAt ? 'Restore vehicle' : 'Archive vehicle';
  openDialog($('#vehicle-dialog'));
  setTimeout(() => $('#vehicle-name').focus(), 80);
}

async function processImage(file) {
  if (!file?.type?.startsWith('image/')) throw new Error('Please select an image file.');
  if (file.size > 20 * 1024 * 1024) throw new Error('The image is larger than 20 MB.');
  const source = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read the image.'));
    reader.readAsDataURL(file);
  });
  const image = await new Promise((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error('Could not decode the image.'));
    element.src = source;
  });
  const max = 1280;
  const scale = Math.min(1, max / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(image.naturalWidth * scale);
  canvas.height = Math.round(image.naturalHeight * scale);
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.78);
}

async function handleRecordSubmit(event) {
  event.preventDefault();
  const kind = $('#record-kind').value;
  const id = $('#record-id').value;
  const formError = $('#record-form-error');
  formError.hidden = true;
  const vehicleId = $('#record-vehicle').value;
  const date = $('#record-date').value;
  const odometerInput = Number($('#record-odometer').value);
  const vehicle = state.data.vehicles.find((item) => item.id === vehicleId);
  const odometerKm = toCanonicalDistance(odometerInput, state.data.settings.distanceUnit);
  const errors = [];
  if (!vehicle) errors.push('Choose a valid vehicle.');
  if (!parseLocalDate(date)) errors.push('Enter a valid date.');
  if (!Number.isFinite(odometerInput) || odometerInput < 0) errors.push('Enter a valid odometer reading.');
  if (vehicle && odometerKm < Number(vehicle.initialOdometerKm || 0)) errors.push('The odometer cannot be below the vehicle’s starting reading.');

  const existingFuel = state.data.fuelLogs.find((item) => item.id === id);
  const existingService = state.data.serviceRecords.find((item) => item.id === id);
  const existing = existingFuel ?? existingService;
  const duplicatePool = kind === 'fuel' ? state.data.fuelLogs : state.data.serviceRecords;
  const duplicate = duplicatePool.find((item) => item.id !== id && item.vehicleId === vehicleId && item.date === date && Math.abs(Number(item.odometerKm) - odometerKm) < 0.001);
  if (duplicate) errors.push('A record already exists for this vehicle, date and odometer.');

  let value;
  let storeName;
  if (kind === 'fuel') {
    const quantityInput = Number($('#fuel-quantity').value);
    const costInput = Number($('#fuel-cost').value);
    if (!Number.isFinite(quantityInput) || quantityInput <= 0) errors.push('Fuel quantity must be greater than zero.');
    if (!Number.isFinite(costInput) || costInput < 0) errors.push('Enter a valid fuel cost.');
    storeName = 'fuelLogs';
    value = {
      id: id || createId('fuel'),
      vehicleId,
      date,
      odometerKm,
      quantityLiters: toCanonicalVolume(quantityInput, state.data.settings.volumeUnit),
      totalCostMinor: moneyToMinor(costInput),
      fuelGrade: $('#fuel-grade').value.trim(),
      station: $('#fuel-station').value.trim(),
      fullTank: $('#fuel-full-tank').checked,
      missedFill: $('#fuel-missed-fill').checked,
      notes: $('#record-notes').value.trim(),
      attachmentDataUrl: state.attachmentDataUrl,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  } else {
    const costInput = Number($('#service-cost').value);
    if (!Number.isFinite(costInput) || costInput < 0) errors.push('Enter a valid cost.');
    if (!$('#service-category').value) errors.push('Choose a category.');
    const nextOdometerInput = Number($('#service-next-odometer').value);
    const nextDueOdometerKm = $('#service-next-odometer').value ? toCanonicalDistance(nextOdometerInput, state.data.settings.distanceUnit) : null;
    if (kind === 'service' && nextDueOdometerKm && nextDueOdometerKm <= odometerKm) errors.push('The next due odometer must be greater than the service odometer.');
    storeName = 'serviceRecords';
    value = {
      id: id || createId(kind),
      vehicleId,
      kind,
      date,
      odometerKm,
      category: $('#service-category').value,
      totalCostMinor: moneyToMinor(costInput),
      vendor: $('#service-vendor').value.trim(),
      nextDueDate: kind === 'service' ? $('#service-next-date').value || null : null,
      nextDueOdometerKm: kind === 'service' ? nextDueOdometerKm : null,
      notes: $('#record-notes').value.trim(),
      attachmentDataUrl: state.attachmentDataUrl,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }

  if (errors.length) {
    formError.textContent = errors[0];
    formError.hidden = false;
    return;
  }
  try {
    await putOne(storeName, value);
    closeDialog($('#record-dialog'));
    await refreshData();
    toast(`${labelForKind(kind)} ${id ? 'updated' : 'saved'}.`);
  } catch (error) {
    formError.textContent = error.message || 'Could not save the record.';
    formError.hidden = false;
  }
}

async function deleteCurrentRecord() {
  const id = $('#record-id').value;
  const kind = $('#record-kind').value;
  if (!id || !confirm('Delete this record permanently? This cannot be undone.')) return;
  try {
    await deleteOne(kind === 'fuel' ? 'fuelLogs' : 'serviceRecords', id);
    closeDialog($('#record-dialog'));
    await refreshData();
    toast('Record deleted.');
  } catch (error) {
    toast(error.message || 'Could not delete the record.', 'error');
  }
}

async function handleVehicleSubmit(event) {
  event.preventDefault();
  const id = $('#vehicle-id').value;
  const existing = state.data.vehicles.find((vehicle) => vehicle.id === id);
  const name = $('#vehicle-name').value.trim();
  const errorElement = $('#vehicle-form-error');
  errorElement.hidden = true;
  if (!name) {
    errorElement.textContent = 'Give the vehicle a nickname.';
    errorElement.hidden = false;
    return;
  }
  const duplicate = state.data.vehicles.find((vehicle) => vehicle.id !== id && vehicle.name.toLocaleLowerCase() === name.toLocaleLowerCase() && !vehicle.archivedAt);
  if (duplicate) {
    errorElement.textContent = 'An active vehicle already uses this nickname.';
    errorElement.hidden = false;
    return;
  }
  const year = Number($('#vehicle-year').value);
  const vehicle = {
    id: id || createId('vehicle'),
    name,
    type: $('#vehicle-type').value,
    fuelType: $('#vehicle-fuel-type').value,
    make: $('#vehicle-make').value.trim(),
    model: $('#vehicle-model').value.trim(),
    year: Number.isFinite(year) && year > 0 ? year : null,
    registration: $('#vehicle-registration').value.trim().toUpperCase(),
    initialOdometerKm: toCanonicalDistance(Number($('#vehicle-odometer').value) || 0, state.data.settings.distanceUnit),
    color: safeColor($('#vehicle-color').value),
    archivedAt: existing?.archivedAt ?? null,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  try {
    await putOne('vehicles', vehicle);
    closeDialog($('#vehicle-dialog'));
    if (!id) {
      state.selectedVehicleId = activeVehicles().length ? state.selectedVehicleId : vehicle.id;
      await saveSettings({ selectedVehicleId: vehicle.id }, { render: false });
    }
    await refreshData();
    toast(`Vehicle ${id ? 'updated' : 'added'}.`);
  } catch (error) {
    errorElement.textContent = error.message || 'Could not save the vehicle.';
    errorElement.hidden = false;
  }
}

async function toggleVehicleArchive() {
  const id = $('#vehicle-id').value;
  const vehicle = state.data.vehicles.find((item) => item.id === id);
  if (!vehicle) return;
  const action = vehicle.archivedAt ? 'restore' : 'archive';
  if (!confirm(`${action === 'archive' ? 'Archive' : 'Restore'} ${vehicle.name}? Its history will be preserved.`)) return;
  await putOne('vehicles', { ...vehicle, archivedAt: vehicle.archivedAt ? null : new Date().toISOString(), updatedAt: new Date().toISOString() });
  closeDialog($('#vehicle-dialog'));
  if (state.selectedVehicleId === id) await saveSettings({ selectedVehicleId: 'all' }, { render: false });
  await refreshData();
  toast(`Vehicle ${action === 'archive' ? 'archived' : 'restored'}.`);
}

function buildBackupPayload() {
  return {
    format: 'roadledger-backup',
    version: BACKUP_VERSION,
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    counts: {
      vehicles: state.data.vehicles.length,
      fuelLogs: state.data.fuelLogs.length,
      serviceRecords: state.data.serviceRecords.length
    },
    data: state.data
  };
}

function downloadBlob(content, filename, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function downloadBackup({ safety = false } = {}) {
  const payload = buildBackupPayload();
  const stamp = todayISO();
  downloadBlob(JSON.stringify(payload, null, 2), `roadledger-${safety ? 'safety-' : ''}${stamp}.roadledger.json`, 'application/json');
  if (!safety) {
    await saveSettings({ lastBackupAt: new Date().toISOString() }, { render: state.currentView === 'garage' });
    toast('Backup downloaded. Keep it somewhere safe.');
  }
}

function showImportReview(pending) {
  state.pendingImport = pending;
  const data = pending.data;
  const errors = pending.errors ?? [];
  $('#import-summary').innerHTML = `
    <div class="import-review">
      <p>${pending.source === 'csv' ? 'CSV records are ready to merge into this device.' : 'The backup passed its format and relationship checks.'}</p>
      <div class="import-counts"><div class="import-count"><strong>${data.vehicles.length}</strong><small>Vehicles</small></div><div class="import-count"><strong>${data.fuelLogs.length}</strong><small>Fuel logs</small></div><div class="import-count"><strong>${data.serviceRecords.length}</strong><small>Service / costs</small></div></div>
      ${errors.length ? `<div class="import-warning">${errors.slice(0, 5).map(escapeHTML).join('<br>')}</div>` : '<div class="import-warning">Replacing data downloads a safety backup first. Merging updates records with matching IDs.</div>'}
    </div>`;
  $('#import-merge-button').disabled = errors.length > 0;
  $('#import-replace-button').hidden = pending.source === 'csv';
  openDialog($('#import-dialog'));
}

async function handleBackupFile(file) {
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    const result = validateBackup(payload);
    if (!result.valid) throw new Error(result.errors[0]);
    showImportReview({ data: result.data, source: 'backup', errors: [] });
  } catch (error) {
    toast(error instanceof SyntaxError ? 'That file is not valid JSON.' : error.message, 'error', 5000);
  } finally {
    $('#backup-file-input').value = '';
  }
}

async function commitImport(mode) {
  const pending = state.pendingImport;
  if (!pending || pending.errors?.length) return;
  if (mode === 'replace') {
    if (!confirm('Replace every vehicle and record on this device with the backup?')) return;
    await downloadBackup({ safety: true });
  }
  try {
    await importData(pending.data, mode);
    closeDialog($('#import-dialog'));
    state.pendingImport = null;
    await refreshData();
    toast(mode === 'replace' ? 'Backup restored successfully.' : 'Data merged successfully.');
  } catch (error) {
    toast(error.message || 'Import failed. Existing data was not changed.', 'error', 5000);
  }
}

const CSV_COLUMNS = [
  'record_type', 'record_id', 'vehicle_id', 'vehicle_name', 'date', 'odometer', 'distance_unit',
  'quantity', 'volume_unit', 'total_cost', 'currency', 'full_tank', 'missed_fill', 'fuel_grade',
  'station', 'category', 'vendor', 'next_due_date', 'next_due_odometer', 'notes'
];

function exportCSV() {
  const settings = state.data.settings;
  const rows = unifiedRecords(state.data).reverse().map((record) => ({
    record_type: record.kind,
    record_id: record.id,
    vehicle_id: record.vehicleId,
    vehicle_name: record.vehicle?.name ?? '',
    date: record.date,
    odometer: fromCanonicalDistance(record.odometerKm, settings.distanceUnit).toFixed(1),
    distance_unit: settings.distanceUnit,
    quantity: record.kind === 'fuel' ? fromCanonicalVolume(record.quantityLiters, settings.volumeUnit).toFixed(3) : '',
    volume_unit: record.kind === 'fuel' ? settings.volumeUnit : '',
    total_cost: minorToMoney(record.totalCostMinor).toFixed(2),
    currency: settings.currency,
    full_tank: record.kind === 'fuel' ? String(Boolean(record.fullTank)) : '',
    missed_fill: record.kind === 'fuel' ? String(Boolean(record.missedFill)) : '',
    fuel_grade: record.fuelGrade ?? '',
    station: record.station ?? '',
    category: record.category ?? '',
    vendor: record.vendor ?? '',
    next_due_date: record.nextDueDate ?? '',
    next_due_odometer: record.nextDueOdometerKm ? fromCanonicalDistance(record.nextDueOdometerKm, settings.distanceUnit).toFixed(1) : '',
    notes: record.notes ?? ''
  }));
  downloadBlob(stringifyCSV(rows, CSV_COLUMNS), `roadledger-records-${todayISO()}.csv`, 'text/csv;charset=utf-8');
  toast(`Exported ${rows.length} record${rows.length === 1 ? '' : 's'} to CSV.`);
}

function booleanFromCSV(value) {
  return ['true', 'yes', '1', 'y'].includes(String(value).trim().toLocaleLowerCase());
}

async function handleCSVFile(file) {
  if (!file) return;
  try {
    const rows = parseCSV(await file.text());
    if (!rows.length) throw new Error('The CSV file contains no records.');
    if (!Object.hasOwn(rows[0], 'record_type') || !Object.hasOwn(rows[0], 'date')) throw new Error('CSV must include record_type and date columns. Export a template from RoadLedger first.');
    const byId = new Map(state.data.vehicles.map((vehicle) => [vehicle.id, vehicle]));
    const byName = new Map(state.data.vehicles.map((vehicle) => [vehicle.name.trim().toLocaleLowerCase(), vehicle]));
    const fuelLogs = [];
    const serviceRecords = [];
    const errors = [];
    rows.forEach((row, index) => {
      const line = index + 2;
      const kind = row.record_type.trim().toLocaleLowerCase();
      const vehicle = byId.get(row.vehicle_id) ?? byName.get(row.vehicle_name.trim().toLocaleLowerCase());
      if (!['fuel', 'service', 'expense'].includes(kind)) {
        errors.push(`Line ${line}: record_type must be fuel, service or expense.`);
        return;
      }
      if (!vehicle) {
        errors.push(`Line ${line}: vehicle “${row.vehicle_name || row.vehicle_id}” does not exist.`);
        return;
      }
      if (!parseLocalDate(row.date)) {
        errors.push(`Line ${line}: date must use YYYY-MM-DD.`);
        return;
      }
      const odometer = Number(row.odometer);
      const totalCost = Number(row.total_cost || 0);
      if (!Number.isFinite(odometer) || !Number.isFinite(totalCost)) {
        errors.push(`Line ${line}: odometer or total_cost is invalid.`);
        return;
      }
      const common = {
        id: row.record_id || createId(kind),
        vehicleId: vehicle.id,
        date: row.date,
        odometerKm: toCanonicalDistance(odometer, row.distance_unit === 'mi' ? 'mi' : 'km'),
        totalCostMinor: moneyToMinor(totalCost),
        notes: row.notes ?? '',
        attachmentDataUrl: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      if (kind === 'fuel') {
        const quantity = Number(row.quantity);
        if (!Number.isFinite(quantity) || quantity <= 0) {
          errors.push(`Line ${line}: fuel quantity must be greater than zero.`);
          return;
        }
        fuelLogs.push({
          ...common,
          quantityLiters: toCanonicalVolume(quantity, row.volume_unit === 'gal' ? 'gal' : 'L'),
          fullTank: booleanFromCSV(row.full_tank),
          missedFill: booleanFromCSV(row.missed_fill),
          fuelGrade: row.fuel_grade ?? '',
          station: row.station ?? ''
        });
      } else {
        const nextOdometer = Number(row.next_due_odometer);
        serviceRecords.push({
          ...common,
          kind,
          category: row.category || (kind === 'service' ? 'Other service' : 'Other expense'),
          vendor: row.vendor ?? '',
          nextDueDate: kind === 'service' && parseLocalDate(row.next_due_date) ? row.next_due_date : null,
          nextDueOdometerKm: kind === 'service' && Number.isFinite(nextOdometer) && nextOdometer > 0 ? toCanonicalDistance(nextOdometer, row.distance_unit === 'mi' ? 'mi' : 'km') : null
        });
      }
    });
    showImportReview({ data: { vehicles: [], fuelLogs, serviceRecords, settings: state.data.settings }, source: 'csv', errors });
  } catch (error) {
    toast(error.message || 'Could not read the CSV file.', 'error', 5000);
  } finally {
    $('#csv-file-input').value = '';
  }
}

function dateMonthsAgo(months, day = 8) {
  const now = new Date();
  const candidate = new Date(now.getFullYear(), now.getMonth() - months, clamp(day, 1, 28));
  return todayISO(candidate > now ? now : candidate);
}

async function loadSampleData() {
  if (state.data.vehicles.length && !confirm('Add a separate sample vehicle and records to your existing garage?')) return;
  const id = createId('vehicle');
  const now = new Date().toISOString();
  const vehicle = {
    id,
    name: 'Weekend Runner',
    type: 'car',
    fuelType: 'Petrol',
    make: 'Honda',
    model: 'City',
    year: 2021,
    registration: 'DEMO 2021',
    initialOdometerKm: 28400,
    color: '#2f7d5d',
    archivedAt: null,
    createdAt: now,
    updatedAt: now
  };
  const odometers = [28920, 29405, 29892, 30380, 30855, 31342, 31831, 32314];
  const quantities = [34.2, 33.6, 34.1, 33.8, 34.4, 33.9, 34.2, 33.7];
  const fuelLogs = odometers.map((odometer, index) => ({
    id: createId('fuel'),
    vehicleId: id,
    date: dateMonthsAgo(7 - index, 6 + index),
    odometerKm: odometer,
    quantityLiters: quantities[index],
    totalCostMinor: Math.round(quantities[index] * (100.5 + index * 1.4) * 100),
    fuelGrade: 'Regular',
    station: index % 2 ? 'IndianOil' : 'Bharat Petroleum',
    fullTank: true,
    missedFill: false,
    notes: index === 7 ? 'Tyre pressure checked.' : '',
    attachmentDataUrl: null,
    createdAt: now,
    updatedAt: now
  }));
  const serviceRecords = [
    { id: createId('service'), vehicleId: id, kind: 'service', date: dateMonthsAgo(6, 18), odometerKm: 29480, category: 'Oil change', totalCostMinor: 420000, vendor: 'Greenline Auto Care', nextDueDate: todayISO(addDays(new Date(), 45)), nextDueOdometerKm: 36500, notes: 'Synthetic 5W-30 and oil filter.', attachmentDataUrl: null, createdAt: now, updatedAt: now },
    { id: createId('service'), vehicleId: id, kind: 'service', date: dateMonthsAgo(3, 12), odometerKm: 30940, category: 'Tyres', totalCostMinor: 1860000, vendor: 'Highway Tyres', nextDueDate: null, nextDueOdometerKm: 41000, notes: 'Replaced front pair and aligned wheels.', attachmentDataUrl: null, createdAt: now, updatedAt: now },
    { id: createId('expense'), vehicleId: id, kind: 'expense', date: dateMonthsAgo(2, 3), odometerKm: 31420, category: 'Insurance', totalCostMinor: 1280000, vendor: 'Sample Insurance', nextDueDate: null, nextDueOdometerKm: null, notes: 'Annual comprehensive policy.', attachmentDataUrl: null, createdAt: now, updatedAt: now },
    { id: createId('service'), vehicleId: id, kind: 'service', date: dateMonthsAgo(1, 22), odometerKm: 31990, category: 'Cleaning', totalCostMinor: 85000, vendor: 'Detail Works', nextDueDate: null, nextDueOdometerKm: null, notes: 'Interior and exterior detail.', attachmentDataUrl: null, createdAt: now, updatedAt: now }
  ];
  await importData({ vehicles: [vehicle], fuelLogs, serviceRecords, settings: state.data.settings }, 'merge');
  await saveSettings({ selectedVehicleId: id }, { render: false });
  await refreshData();
  navigate('dashboard');
  toast('Sample vehicle added. Explore the reports.');
}

async function resetApp() {
  if (!confirm('Permanently delete every vehicle, record, receipt and setting on this device? Download a backup first if needed.')) return;
  if (!confirm('This cannot be undone. Continue with the reset?')) return;
  await resetAllData();
  state.selectedVehicleId = 'all';
  await refreshData();
  navigate('dashboard');
  toast('RoadLedger was reset.');
}

async function installApp() {
  if (matchMedia('(display-mode: standalone)').matches || navigator.standalone) {
    toast('RoadLedger is already installed.');
    return;
  }
  if (state.deferredInstallPrompt) {
    state.deferredInstallPrompt.prompt();
    await state.deferredInstallPrompt.userChoice;
    state.deferredInstallPrompt = null;
    $('#install-button').hidden = true;
    return;
  }
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  toast(isIOS ? 'In Safari, tap Share and then “Add to Home Screen”.' : 'Open your browser menu and choose “Install app” or “Add to Home screen”.', 'success', 6000);
}

async function handleDynamicAction(target) {
  const addVehicle = target.closest('[data-add-vehicle]');
  if (addVehicle) return openVehicleForm();

  const openKind = target.closest('[data-open-kind]');
  if (openKind) return openRecordForm(openKind.dataset.openKind);

  const go = target.closest('[data-go]');
  if (go) return navigate(go.dataset.go);

  const editRecord = target.closest('[data-edit-record]');
  if (editRecord) {
    const kind = editRecord.dataset.recordKind;
    const id = editRecord.dataset.editRecord;
    const record = kind === 'fuel' ? state.data.fuelLogs.find((item) => item.id === id) : state.data.serviceRecords.find((item) => item.id === id);
    if (record) openRecordForm(kind, record);
    return;
  }

  const editVehicle = target.closest('[data-edit-vehicle]');
  if (editVehicle) {
    const vehicle = state.data.vehicles.find((item) => item.id === editVehicle.dataset.editVehicle);
    if (vehicle) openVehicleForm(vehicle);
    return;
  }

  const removeAttachment = target.closest('[data-remove-attachment]');
  if (removeAttachment) {
    state.attachmentDataUrl = null;
    $('#record-attachment').value = '';
    showAttachmentPreview();
    return;
  }

  const stationPick = target.closest('[data-station-pick]');
  if (stationPick) {
    $('#fuel-station').value = stationPick.dataset.stationPick;
    $$('[data-station-pick]', $('#station-quick-picks')).forEach((button) => button.classList.toggle('selected', button === stationPick));
    $('#fuel-cost').focus();
    return;
  }

  const action = target.closest('[data-action]')?.dataset.action;
  if (!action) return;
  if (action === 'backup') await downloadBackup();
  if (action === 'import') $('#backup-file-input').click();
  if (action === 'csv-export') exportCSV();
  if (action === 'csv-import') $('#csv-file-input').click();
  if (action === 'sample') await loadSampleData();
  if (action === 'reset') await resetApp();
  if (action === 'install') await installApp();
  if (action === 'persist') {
    const result = await requestPersistentStorage();
    state.persistenceRequestDenied = result.supported && !result.persisted;
    await updateStorageStatus();
    if (result.persisted) {
      toast('Extra storage protection is active. Your data remains saved on this device.');
    } else if (!result.supported) {
      toast('Your data is saved on this device. This browser does not offer extra cleanup protection; keep a backup.', 'success', 6000);
    } else {
      toast('Your data is saved on this device. Add a record or use the installed app, then try Protect again later.', 'success', 6000);
    }
  }
}

function bindEvents() {
  setupVehicleSwipe();
  setupChartTooltips();
  let reportResizeTimer = null;
  window.addEventListener('resize', () => {
    if (state.currentView !== 'reports') return;
    clearTimeout(reportResizeTimer);
    reportResizeTimer = setTimeout(() => {
      if (state.currentView === 'reports') renderReports();
    }, 120);
  });
  document.addEventListener('click', async (event) => {
    const nav = event.target.closest('[data-nav]');
    if (nav) {
      event.preventDefault();
      navigate(nav.dataset.nav);
      return;
    }
    const close = event.target.closest('[data-close-dialog]');
    if (close) {
      closeDialog($(`#${close.dataset.closeDialog}`));
      return;
    }
    const quick = event.target.closest('[data-quick-kind]');
    if (quick) {
      openRecordForm(quick.dataset.quickKind);
      return;
    }
    const kindButton = event.target.closest('#record-kind-control [data-record-kind]');
    if (kindButton) {
      setRecordKind(kindButton.dataset.recordKind);
      return;
    }
    await handleDynamicAction(event.target);
  });

  $('#global-vehicle-select').addEventListener('change', async (event) => {
    state.selectedVehicleId = event.target.value;
    await saveSettings({ selectedVehicleId: state.selectedVehicleId });
  });
  $('#side-add-button').addEventListener('click', () => openDialog($('#action-dialog')));
  $('#mobile-add-button').addEventListener('click', () => openDialog($('#action-dialog')));
  $$('[data-open-record]').forEach((button) => button.addEventListener('click', () => openDialog($('#action-dialog'))));
  $('#add-vehicle-button').addEventListener('click', () => openVehicleForm());
  $('#record-form').addEventListener('submit', handleRecordSubmit);
  $('#vehicle-form').addEventListener('submit', handleVehicleSubmit);
  $('#delete-record-button').addEventListener('click', deleteCurrentRecord);
  $('#archive-vehicle-button').addEventListener('click', toggleVehicleArchive);
  $('#record-attachment').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      state.attachmentDataUrl = await processImage(file);
      showAttachmentPreview();
    } catch (error) {
      event.target.value = '';
      toast(error.message, 'error');
    }
  });
  $('#record-vehicle').addEventListener('change', () => {
    if ($('#record-id').value) return;
    const vehicle = state.data.vehicles.find((item) => item.id === $('#record-vehicle').value);
    $('#record-odometer').value = fromCanonicalDistance(currentOdometer(vehicle, state.data.fuelLogs, state.data.serviceRecords), state.data.settings.distanceUnit).toFixed(1).replace(/\.0$/, '');
    updateFuelSuggestions(vehicle?.id);
  });
  $('#fuel-quantity').addEventListener('input', updateFuelUnitPrice);
  $('#fuel-cost').addEventListener('input', updateFuelUnitPrice);
  $('#fuel-station').addEventListener('input', () => {
    const value = $('#fuel-station').value.trim().toLocaleLowerCase();
    $$('[data-station-pick]', $('#station-quick-picks')).forEach((button) => button.classList.toggle('selected', button.dataset.stationPick.toLocaleLowerCase() === value));
  });
  $('#logbook-search').addEventListener('input', (event) => {
    state.logSearch = event.target.value;
    renderLogbook();
  });
  $$('[data-log-filter]').forEach((button) => button.addEventListener('click', () => {
    state.logFilter = button.dataset.logFilter;
    $$('[data-log-filter]').forEach((item) => item.classList.toggle('active', item === button));
    renderLogbook();
  }));
  $$('[data-period]').forEach((button) => button.addEventListener('click', () => {
    state.reportPeriod = button.dataset.period;
    $$('[data-period]').forEach((item) => item.classList.toggle('active', item === button));
    renderReports();
  }));
  document.addEventListener('change', async (event) => {
    const select = event.target.closest('[data-setting]');
    if (!select) return;
    const key = select.dataset.setting;
    const patch = { [key]: select.value };
    if (key === 'distanceUnit' && select.value === 'mi' && state.data.settings.consumptionUnit === 'km/L') patch.consumptionUnit = 'mpg';
    if (key === 'distanceUnit' && select.value === 'km' && state.data.settings.consumptionUnit === 'mpg') patch.consumptionUnit = 'km/L';
    if (key === 'volumeUnit' && select.value === 'gal' && state.data.settings.distanceUnit === 'mi') patch.consumptionUnit = 'mpg';
    await saveSettings(patch);
    toast('Preference updated.');
  });
  $('#backup-file-input').addEventListener('change', (event) => handleBackupFile(event.target.files?.[0]));
  $('#csv-file-input').addEventListener('change', (event) => handleCSVFile(event.target.files?.[0]));
  $('#import-merge-button').addEventListener('click', () => commitImport('merge'));
  $('#import-replace-button').addEventListener('click', () => commitImport('replace'));
  $('#install-button').addEventListener('click', installApp);
  window.addEventListener('hashchange', () => navigate(location.hash.slice(1), { updateHash: false }));
  window.addEventListener('online', updateNetworkStatus);
  window.addEventListener('offline', updateNetworkStatus);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.data.settings.theme === 'auto') setTheme('auto');
  });
}

function updateNetworkStatus() {
  const element = $('#network-status');
  const online = navigator.onLine;
  element.classList.toggle('offline', !online);
  element.classList.toggle('not-ready', online && !state.offlineReady);
  const text = !online
    ? (state.offlineReady ? 'Working offline' : 'No connection')
    : (state.offlineReady ? 'Ready offline' : 'Online');
  $('.network-text', element).textContent = text;
  element.title = state.offlineReady
    ? 'The app shell is cached and RoadLedger can open without a connection.'
    : 'The app is online; offline caching is not ready yet.';
}

function setupInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    state.deferredInstallPrompt = event;
    $('#install-button').hidden = false;
  });
  window.addEventListener('appinstalled', () => {
    state.deferredInstallPrompt = null;
    $('#install-button').hidden = true;
    toast('RoadLedger installed successfully.');
  });
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    updateNetworkStatus();
    return;
  }
  try {
    await navigator.serviceWorker.register('./sw.js', { scope: './' });
    const registration = await navigator.serviceWorker.ready;
    state.offlineReady = Boolean(registration.active);
    updateNetworkStatus();
  } catch (error) {
    state.offlineReady = false;
    updateNetworkStatus();
    console.warn('Offline service worker could not be registered.', error);
  }
}

function showFatalError(error) {
  const loading = $('#loading-screen');
  loading.innerHTML = `<div class="welcome-inner"><span class="welcome-icon"><svg><use href="#i-close"></use></svg></span><h2>RoadLedger could not open</h2><p>${escapeHTML(error?.message || 'The browser could not initialise local storage.')}</p><button class="button primary" type="button" onclick="location.reload()">Try again</button></div>`;
}

async function init() {
  try {
    setupInstallPrompt();
    bindEvents();
    await refreshData({ render: false });
    state.currentView = viewMeta[location.hash.slice(1)] ? location.hash.slice(1) : 'dashboard';
    renderAll();
    updateNetworkStatus();
    $('#app').hidden = false;
    const loading = $('#loading-screen');
    loading.classList.add('leaving');
    setTimeout(() => loading.remove(), 250);
    registerServiceWorker();
    updateStorageStatus();

    const addKind = new URLSearchParams(location.search).get('add');
    if (['fuel', 'service', 'expense'].includes(addKind) && activeVehicles().length) {
      setTimeout(() => openRecordForm(addKind), 250);
    }
  } catch (error) {
    console.error(error);
    showFatalError(error);
  }
}

init();
