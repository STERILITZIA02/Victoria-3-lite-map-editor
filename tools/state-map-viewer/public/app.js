"use strict";

// This frontend keeps all province edits in a draft first. It only asks the
// local server to write files after validation proves every province is legal.
const elements = {
  loadingOverlay: document.getElementById("loading-overlay"),
  loadingText: document.getElementById("loading-text"),
  loadingDetail: document.getElementById("loading-detail"),
  progressFill: document.getElementById("progress-fill"),
  sourceLine: document.getElementById("source-line"),
  statStates: document.getElementById("stat-states"),
  statProvinces: document.getElementById("stat-provinces"),
  statSpecial: document.getElementById("stat-special"),
  stateSearch: document.getElementById("state-search"),
  stateListMeta: document.getElementById("state-list-meta"),
  stateList: document.getElementById("state-list"),
  viewport: document.getElementById("map-viewport"),
  mapWorld: document.getElementById("map-world"),
  provinceImage: document.getElementById("province-image"),
  boundaryCanvas: document.getElementById("boundary-canvas"),
  filterCanvas: document.getElementById("filter-canvas"),
  markersLayer: document.getElementById("markers-layer"),
  focusBox: document.getElementById("focus-box"),
  hoverReadout: document.getElementById("hover-readout"),
  zoomReadout: document.getElementById("zoom-readout"),
  toggleBoundaries: document.getElementById("toggle-boundaries"),
  toggleMarkers: document.getElementById("toggle-markers"),
  selectedTitle: document.getElementById("selected-title"),
  selectedMeta: document.getElementById("selected-meta"),
  selectedProvince: document.getElementById("selected-province"),
  editStatus: document.getElementById("edit-status"),
  editActions: document.getElementById("edit-actions"),
  specialList: document.getElementById("special-list"),
  provinceList: document.getElementById("province-list"),
  freeListMeta: document.getElementById("free-list-meta"),
  freeProvinceList: document.getElementById("free-province-list"),
  lakeListMeta: document.getElementById("lake-list-meta"),
  lakeProvinceList: document.getElementById("lake-province-list"),
};

const roleLabels = {
  city: "C",
  farm: "F",
  mine: "M",
  wood: "W",
  port: "P",
  center: "O",
  prime_land: "L",
  impassable: "X",
};

const roleNames = {
  city: "city",
  farm: "farm",
  mine: "mine",
  wood: "wood",
  port: "port",
  center: "center",
  prime_land: "prime land",
  impassable: "impassable",
};

const app = {
  data: null,
  image: null,
  width: 0,
  height: 0,
  sourcePixels: null,
  colorToState: Object.create(null),
  colorToKey: Object.create(null),
  colorToRoles: Object.create(null),
  stateIsSea: Object.create(null),
  stateByName: new Map(),
  mapProvinceKeys: new Set(),
  provinceSeaTouch: new Set(),
  savedProvinceLists: new Map(),
  savedSpecials: new Map(),
  boundsByState: Object.create(null),
  boundsByProvince: Object.create(null),
  specialBounds: Object.create(null),
  transform: { x: 0, y: 0, scale: 1 },
  dragging: null,
  selectedState: null,
  selectedProvince: null,
  saving: false,
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function nextFrame() {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      resolve();
    };
    requestAnimationFrame(finish);
    setTimeout(finish, 50);
  });
}

function setProgress(value, text, detail) {
  const percent = clamp(Math.round(value), 0, 100);
  elements.progressFill.style.width = `${percent}%`;
  elements.loadingText.textContent = text;
  elements.loadingDetail.textContent = detail || `${percent}%`;
}

function provinceKeyToInt(key) {
  return parseInt(key.slice(1), 16);
}

function intToProvinceKey(value) {
  return `x${value.toString(16).padStart(6, "0").toUpperCase()}`;
}

function pixelIntAt(data, offset) {
  return (data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2];
}

function growBounds(store, key, x, y) {
  let bounds = store[key];
  if (!bounds) {
    bounds = { minX: x, minY: y, maxX: x, maxY: y, sumX: 0, sumY: 0, count: 0 };
    store[key] = bounds;
  }
  if (x < bounds.minX) bounds.minX = x;
  if (y < bounds.minY) bounds.minY = y;
  if (x > bounds.maxX) bounds.maxX = x;
  if (y > bounds.maxY) bounds.maxY = y;
  bounds.sumX += x;
  bounds.sumY += y;
  bounds.count += 1;
}

function paintPixel(out, width, height, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const index = (y * width + x) * 4;
  out[index] = r;
  out[index + 1] = g;
  out[index + 2] = b;
  out[index + 3] = a;
}

function paintPoint(out, width, height, x, y, radius, r, g, b, a) {
  for (let yy = y - radius; yy <= y + radius; yy += 1) {
    for (let xx = x - radius; xx <= x + radius; xx += 1) {
      paintPixel(out, width, height, xx, yy, r, g, b, a);
    }
  }
}

function paintBoundary(out, width, height, x, y, isStateBoundary) {
  paintPoint(out, width, height, x, y, 1, 3, 4, 4, 195);
  if (isStateBoundary) {
    paintPoint(out, width, height, x, y, 0, 235, 204, 112, 255);
  }
}

function markSeaTouch(leftColor, rightColor) {
  const leftState = app.colorToState[leftColor];
  const rightState = app.colorToState[rightColor];
  if (!leftState || !rightState || leftState === rightState) return;

  const leftIsSea = app.stateIsSea[leftState];
  const rightIsSea = app.stateIsSea[rightState];
  if (leftIsSea === rightIsSea) return;

  const landColor = leftIsSea ? rightColor : leftColor;
  app.provinceSeaTouch.add(app.colorToKey[landColor] || intToProvinceKey(landColor));
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatPathForDisplay(value) {
  return value ? value.replace(/\\/g, "/") : "unknown";
}

function firstEnvironmentWarning() {
  return Array.isArray(app.data?.environmentWarnings) && app.data.environmentWarnings.length > 0
    ? app.data.environmentWarnings[0]
    : "";
}

function buildLookups(data) {
  app.stateByName.clear();
  app.colorToState = Object.create(null);
  app.colorToKey = Object.create(null);
  app.colorToRoles = Object.create(null);
  app.stateIsSea = Object.create(null);

  for (const state of data.states) {
    app.stateByName.set(state.name, state);
    app.stateIsSea[state.name] = Boolean(state.isSea);
  }

  for (const [province, stateName] of Object.entries(data.provinceToState)) {
    const color = provinceKeyToInt(province);
    app.colorToState[color] = stateName;
    app.colorToKey[color] = province;
  }

  for (const [province, roles] of Object.entries(data.provinceRoles)) {
    if (!roles.length) continue;
    const color = provinceKeyToInt(province);
    app.colorToRoles[color] = roles;
  }
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Failed to load ${url}`));
    image.src = `${url}?v=${Date.now()}`;
  });
}

async function readJsonResponse(response, operation) {
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    const preview = text.slice(0, 120).replace(/\s+/g, " ").trim();
    throw new Error(`${operation} failed: server returned non-JSON ${response.status} ${response.statusText}${preview ? ` (${preview})` : ""}. Restart the viewer server.`);
  }

  if (!response.ok) {
    const detail = Array.isArray(payload.details) && payload.details.length ? ` ${payload.details[0]}` : "";
    throw new Error(`${payload.error || `${operation} failed with ${response.status}`}${detail}`);
  }

  return payload;
}

function assertCompatibleMapData(data) {
  if (!data.capabilities || data.capabilities.schemaVersion < 5 || !data.capabilities.resetStateRegions || !data.capabilities.reservedProvinces || !data.capabilities.historyOwnershipSync || !data.capabilities.sortedStateRegionProvinces) {
    throw new Error("Viewer server is stale. Stop the old server process and restart tools/state-map-viewer/server.js, then reload this page.");
  }
  if (!data.reservedProvinces || typeof data.reservedProvinces !== "object") {
    throw new Error("Map data is missing reserved lake province metadata. Saving is disabled until the viewer server is restarted.");
  }
}

function prepareImageCanvas(image) {
  app.width = image.naturalWidth;
  app.height = image.naturalHeight;

  elements.provinceImage.src = image.src;
  elements.provinceImage.width = app.width;
  elements.provinceImage.height = app.height;
  elements.provinceImage.style.width = `${app.width}px`;
  elements.provinceImage.style.height = `${app.height}px`;

  elements.boundaryCanvas.width = app.width;
  elements.boundaryCanvas.height = app.height;
  elements.boundaryCanvas.style.width = `${app.width}px`;
  elements.boundaryCanvas.style.height = `${app.height}px`;

  elements.filterCanvas.width = app.width;
  elements.filterCanvas.height = app.height;
  elements.filterCanvas.style.width = `${app.width}px`;
  elements.filterCanvas.style.height = `${app.height}px`;

  elements.mapWorld.style.width = `${app.width}px`;
  elements.mapWorld.style.height = `${app.height}px`;
  elements.markersLayer.style.width = `${app.width}px`;
  elements.markersLayer.style.height = `${app.height}px`;
}

function readSourcePixels() {
  const sourceCanvas = document.createElement("canvas");
  sourceCanvas.width = app.width;
  sourceCanvas.height = app.height;
  const context = sourceCanvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(app.image, 0, 0);
  const imageData = context.getImageData(0, 0, app.width, app.height);
  sourceCanvas.width = 1;
  sourceCanvas.height = 1;
  return imageData.data;
}

async function scanMapImage() {
  const width = app.width;
  const height = app.height;
  const source = app.sourcePixels;
  const context = elements.boundaryCanvas.getContext("2d");
  const overlay = context.createImageData(width, height);
  const out = overlay.data;
  const rowsPerChunk = 48;

  app.mapProvinceKeys = new Set();
  app.provinceSeaTouch = new Set();
  app.boundsByState = Object.create(null);
  app.boundsByProvince = Object.create(null);
  app.specialBounds = Object.create(null);

  for (let yStart = 0; yStart < height; yStart += rowsPerChunk) {
    const yEnd = Math.min(height, yStart + rowsPerChunk);

    for (let y = yStart; y < yEnd; y += 1) {
      const rowOffset = y * width * 4;
      const nextRowOffset = rowOffset + width * 4;

      for (let x = 0; x < width; x += 1) {
        const offset = rowOffset + x * 4;
        const color = pixelIntAt(source, offset);
        const stateName = app.colorToState[color];
        const provinceKey = app.colorToKey[color] || intToProvinceKey(color);
        app.mapProvinceKeys.add(provinceKey);
        app.colorToKey[color] = provinceKey;
        growBounds(app.boundsByProvince, provinceKey, x, y);

        if (stateName) {
          growBounds(app.boundsByState, stateName, x, y);

          if (app.colorToRoles[color]) {
            growBounds(app.specialBounds, provinceKey, x, y);
          }
        }

        if (x + 1 < width) {
          const rightColor = pixelIntAt(source, offset + 4);
          if (rightColor !== color) {
            const rightState = app.colorToState[rightColor];
            markSeaTouch(color, rightColor);
            paintBoundary(out, width, height, x, y, Boolean(stateName && rightState && stateName !== rightState));
          }
        }

        if (y + 1 < height) {
          const downColor = pixelIntAt(source, nextRowOffset + x * 4);
          if (downColor !== color) {
            const downState = app.colorToState[downColor];
            markSeaTouch(color, downColor);
            paintBoundary(out, width, height, x, y, Boolean(stateName && downState && stateName !== downState));
          }
        }
      }
    }

    const done = yEnd / height;
    setProgress(34 + done * 50, "Tracing province and state boundaries", `${Math.round(done * 100)}% of pixels scanned`);
    await nextFrame();
  }

  setProgress(86, "Compositing boundary overlay", "Drawing overlay canvas");
  await nextFrame();
  context.putImageData(overlay, 0, 0);
}

function specialEntriesForState(state) {
  if (!state) return [];
  const entries = [];

  for (const role of ["city", "farm", "mine", "wood", "port", "center"]) {
    const province = state.special[role];
    if (province) entries.push({ role, province });
  }

  for (const role of ["prime_land", "impassable"]) {
    for (const province of state.special[role] || []) {
      entries.push({ role, province });
    }
  }

  return entries;
}

function uniqueSpecialCount(state) {
  return new Set(specialEntriesForState(state).map((entry) => entry.province)).size;
}

function cloneSpecial(special) {
  return {
    city: special.city || null,
    farm: special.farm || null,
    mine: special.mine || null,
    wood: special.wood || null,
    port: special.port || null,
    center: special.center || null,
    prime_land: [...(special.prime_land || [])],
    impassable: [...(special.impassable || [])],
  };
}

function snapshotSavedProvinceLists(data) {
  app.savedProvinceLists = new Map(data.states.map((state) => [state.name, [...state.provinces]]));
  app.savedSpecials = new Map(data.states.map((state) => [state.name, cloneSpecial(state.special)]));
}

function sameProvinceList(left, right) {
  if (!left || left.length !== right.length) return false;
  return left.every((province, index) => province === right[index]);
}

function sameSpecial(left, right) {
  if (!left || !right) return false;
  for (const role of ["city", "farm", "mine", "wood", "port", "center"]) {
    if ((left[role] || null) !== (right[role] || null)) return false;
  }
  for (const role of ["prime_land", "impassable"]) {
    if (!sameProvinceList(left[role] || [], right[role] || [])) return false;
  }
  return true;
}

function changedStatePayload() {
  const changes = [];
  for (const state of app.data.states) {
    const saved = app.savedProvinceLists.get(state.name);
    const savedSpecial = app.savedSpecials.get(state.name);
    if (!sameProvinceList(saved, state.provinces) || !sameSpecial(savedSpecial, state.special)) {
      changes.push({ name: state.name, provinces: [...state.provinces], special: cloneSpecial(state.special) });
    }
  }
  return changes;
}

function reservedProvinceKind(province) {
  return app.data.reservedProvinces?.[province] || null;
}

function freeProvinces() {
  return [...app.mapProvinceKeys]
    .filter((province) => !app.data.provinceToState[province])
    .sort((a, b) => a.localeCompare(b));
}

function addableFreeProvinces() {
  return freeProvinces().filter((province) => !reservedProvinceKind(province));
}

function reservedFreeProvinces() {
  return freeProvinces().filter((province) => reservedProvinceKind(province));
}

function setEditStatus(text, kind = "") {
  elements.editStatus.textContent = text;
  elements.editStatus.classList.toggle("is-ok", kind === "ok");
  elements.editStatus.classList.toggle("is-warning", kind === "warning");
  elements.editStatus.classList.toggle("is-error", kind === "error");
}

function showBlockingMessage(message) {
  setEditStatus(message, "error");
  alert(message);
}

function rebuildDraftMaps() {
  app.data.provinceToState = {};
  app.data.provinceRoles = {};

  for (const state of app.data.states) {
    for (const province of state.provinces) {
      app.data.provinceToState[province] = state.name;
      app.data.provinceRoles[province] ||= [];
    }

    for (const role of ["city", "farm", "mine", "wood", "port", "center"]) {
      const province = state.special[role];
      if (!province) continue;
      app.data.provinceRoles[province] ||= [];
      app.data.provinceRoles[province].push({ state: state.name, role });
    }

    for (const role of ["prime_land", "impassable"]) {
      for (const province of state.special[role] || []) {
        app.data.provinceRoles[province] ||= [];
        app.data.provinceRoles[province].push({ state: state.name, role });
      }
    }
  }
}

function updateDraftSummary() {
  rebuildDraftMaps();
  app.data.summary.provinces = Object.keys(app.data.provinceToState).length;
  app.data.summary.specialProvinces = Object.values(app.data.provinceRoles).filter((roles) => roles.length > 0).length;
}

function validateDraft() {
  const errors = [];
  const provinceToState = new Map();

  if (app.data.gameWriteSafety && !app.data.gameWriteSafety.safe) {
    errors.push(app.data.gameWriteSafety.reason);
  }

  for (const state of app.data.states) {
    const seenInState = new Set();
    for (const province of state.provinces) {
      if (seenInState.has(province)) errors.push(`${province} appears more than once in ${state.name}.`);
      seenInState.add(province);

      const existing = provinceToState.get(province);
      if (existing) errors.push(`${province} appears in both ${existing} and ${state.name}.`);
      provinceToState.set(province, state.name);
    }

    const provinceSet = new Set(state.provinces);
    for (const entry of specialEntriesForState(state)) {
      if (!provinceSet.has(entry.province)) {
        errors.push(`${state.name} ${roleNames[entry.role] || entry.role} province ${entry.province} would be outside the state.`);
      }
    }
  }

  const unassignedStateProvinces = addableFreeProvinces();
  if (unassignedStateProvinces.length > 0) {
    errors.push(`${unassignedStateProvinces.length} non-lake province(s) are free. Assign them to a state before the mod file can be saved.`);
  }

  return errors;
}

function renderVisibilityFilter() {
  const context = elements.filterCanvas.getContext("2d");
  context.clearRect(0, 0, app.width, app.height);
  if (!app.selectedState || !app.sourcePixels) return;

  const overlay = context.createImageData(app.width, app.height);
  const out = overlay.data;
  const source = app.sourcePixels;

  for (let offset = 0; offset < source.length; offset += 4) {
    const color = pixelIntAt(source, offset);
    const stateName = app.colorToState[color];
    const hidden = stateName && stateName !== app.selectedState;
    if (hidden) {
      out[offset] = 0;
      out[offset + 1] = 0;
      out[offset + 2] = 0;
      out[offset + 3] = 205;
    }
  }

  context.putImageData(overlay, 0, 0);
}

function rerenderAfterDraftChange() {
  updateDraftSummary();
  buildLookups(app.data);
  renderSummary();
  renderStateList();
  renderDetails();
  renderMarkers();
  renderVisibilityFilter();
  updateMarkerSelection();
}

async function rescanAfterSavedData() {
  buildLookups(app.data);
  await scanMapImage();
  renderSummary();
  renderStateList();
  renderDetails();
  renderMarkers();
  renderVisibilityFilter();
  updateMarkerSelection();
}

async function saveDraftIfCompliant() {
  const errors = validateDraft();
  if (errors.length > 0) {
    showBlockingMessage(`Save blocked: ${errors[0]}`);
    return;
  }

  const changes = changedStatePayload();
  if (changes.length === 0) {
    setEditStatus("No unsaved province membership changes.", "ok");
    return;
  }

  app.saving = true;
  setEditStatus(`Saving ${changes.length} changed state(s)...`, "warning");
  renderDetails();
  let finalStatus = null;

  try {
    const response = await fetch("/api/save-state-regions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ states: changes }),
    });
    const result = await readJsonResponse(response, "Save");
    if (!result.ok) throw new Error(result.error || "Save failed.");

    app.data = result.mapData;
    snapshotSavedProvinceLists(app.data);
    await rescanAfterSavedData();
    finalStatus = { text: `Saved ${result.savedFiles.join(", ")}.`, kind: "ok" };
  } catch (error) {
    const message = error.message || String(error);
    finalStatus = { text: message, kind: "error" };
    alert(message);
  } finally {
    app.saving = false;
    renderDetails();
    if (finalStatus) setEditStatus(finalStatus.text, finalStatus.kind);
  }
}

async function resetToVanillaStateRegions() {
  const confirmed = confirm("Remove all active state-region override files from this mod and reload the vanilla 1.13.6 state map?");
  if (!confirmed) return;

  app.saving = true;
  setEditStatus("Resetting active state-region overrides...", "warning");

  try {
    const response = await fetch("/api/reset-state-regions", { method: "POST" });
    const result = await readJsonResponse(response, "Reset Vanilla");
    if (!result.ok) throw new Error(result.error || "Reset failed.");

    app.data = result.mapData;
    app.selectedState = null;
    app.selectedProvince = null;
    snapshotSavedProvinceLists(app.data);
    await rescanAfterSavedData();
    setFocusBox(null);
    fitWorld();

    const removedCount = result.removedFiles.length;
    setEditStatus(removedCount > 0 ? `Reset to vanilla. Removed ${removedCount} active state-region file(s).` : "Already using vanilla state regions.", "ok");
  } catch (error) {
    const message = error.message || String(error);
    setEditStatus(message, "error");
    alert(message);
  } finally {
    app.saving = false;
    renderDetails();
  }
}

function renderSummary() {
  const summary = app.data.summary;
  elements.statStates.textContent = formatNumber(summary.states);
  elements.statProvinces.textContent = formatNumber(summary.provinces);
  elements.statSpecial.textContent = formatNumber(summary.specialProvinces);
  const contentLoad = app.data.contentLoadStatus;
  const contentLoadText = contentLoad && contentLoad.files.length > 0
    ? `content_load: ${contentLoad.enabledHere ? "this mod enabled" : "this mod not enabled"}`
    : "content_load: not found";
  const warning = firstEnvironmentWarning();
  elements.sourceLine.textContent =
    `Mod: ${formatPathForDisplay(app.data.modRoot)}; state regions: ${summary.activeStateRegionFiles} active, ${summary.referenceStateRegionFiles} reference; history: ${summary.activeHistoryStateFile || 0} active; provinces image: ${app.data.image.source}; ${contentLoadText}${app.data.gameWriteSafety && !app.data.gameWriteSafety.safe ? "; save disabled: mod path is not ASCII-only" : ""}${warning ? `; warning: ${warning}` : ""}`;
}

function sortedStates() {
  return [...app.data.states].sort((a, b) => {
    if (a.id !== null && b.id !== null && a.id !== b.id) return a.id - b.id;
    return a.name.localeCompare(b.name);
  });
}

function stateMatchesSearch(state, query) {
  if (!query) return true;
  const normalized = query.toUpperCase();
  if (state.name.includes(normalized)) return true;
  if (String(state.id || "").includes(normalized)) return true;
  return state.provinces.some((province) => province.includes(normalized));
}

function renderStateList() {
  const query = elements.stateSearch.value.trim();
  const states = sortedStates().filter((state) => stateMatchesSearch(state, query));
  elements.stateList.replaceChildren();
  elements.stateListMeta.textContent = `${formatNumber(states.length)} of ${formatNumber(app.data.states.length)} states`;

  const fragment = document.createDocumentFragment();
  for (const state of states) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "state-row";
    if (state.name === app.selectedState) row.classList.add("is-active");
    row.addEventListener("click", () => selectState(state.name, true));

    const nameBlock = document.createElement("span");
    const name = document.createElement("span");
    const sub = document.createElement("span");
    const count = document.createElement("span");

    name.className = "state-name";
    sub.className = "state-sub";
    count.className = "state-count";
    name.textContent = state.name;
    sub.textContent = `id ${state.id ?? "n/a"} - ${state.file}`;
    count.textContent = `${state.provinces.length} prov`;

    nameBlock.append(name, sub);
    row.append(nameBlock, count);
    fragment.append(row);
  }

  elements.stateList.append(fragment);
}

function selectedProvinceAssignmentText(province) {
  if (!province) return "Province: none selected";

  const stateName = app.data.provinceToState[province] || null;
  if (stateName) return `Province: ${province}\nAssigned to: ${stateName}`;

  const reserved = reservedProvinceKind(province);
  if (reserved) return `Province: ${province}\nAssignment: reserved ${reserved}`;

  return `Province: ${province}\nAssignment: free province`;
}

function renderDetails() {
  const state = app.stateByName.get(app.selectedState);
  elements.provinceList.replaceChildren();
  elements.specialList.replaceChildren();
  elements.editActions.replaceChildren();
  elements.freeProvinceList.replaceChildren();
  elements.lakeProvinceList.replaceChildren();

  if (!state) {
    elements.selectedTitle.textContent = "No state selected";
    elements.selectedMeta.textContent = "Click a state in the list, a special marker, or a province on the map.";
    elements.selectedProvince.textContent = "Province: none";
    const warning = firstEnvironmentWarning();
    setEditStatus(warning || "Select a state to edit its province membership.", warning ? "warning" : "");
    elements.freeListMeta.textContent = "No state selected";
    elements.lakeListMeta.textContent = "No state selected";
    renderEmpty(elements.specialList, "No state selected");
    renderEmpty(elements.provinceList, "No state selected");
    renderEmpty(elements.freeProvinceList, "No state selected");
    renderEmpty(elements.lakeProvinceList, "No state selected");
    return;
  }

  elements.selectedTitle.textContent = state.name;
  elements.selectedMeta.textContent =
    `id ${state.id ?? "n/a"} - ${state.provinces.length} provinces - ${uniqueSpecialCount(state)} special - ${state.source} ${state.file}`;
  elements.selectedProvince.textContent = selectedProvinceAssignmentText(app.selectedProvince);
  renderEditControls(state);

  const specials = specialEntriesForState(state);
  if (specials.length === 0) {
    renderEmpty(elements.specialList, "No special provinces in this state");
  } else {
    for (const entry of specials) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "special-chip";
      if (entry.province === app.selectedProvince) chip.classList.add("is-active");
      chip.textContent = `${roleNames[entry.role]} ${entry.province}`;
      chip.title = `${entry.province} - ${entry.role}`;
      chip.addEventListener("click", () => selectProvince(entry.province, true));
      elements.specialList.append(chip);
    }
  }

  for (const province of state.provinces) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "province-chip";
    if (province === app.selectedProvince) chip.classList.add("is-active");
    chip.textContent = province;
    chip.addEventListener("click", () => selectProvince(province, true));
    elements.provinceList.append(chip);
  }

  renderFreeProvinceList();
}

function renderEditControls(state) {
  if (app.saving) {
    setEditStatus("Saving changes...", "warning");
    return;
  }

  if (app.data.gameWriteSafety && !app.data.gameWriteSafety.safe) {
    setEditStatus(app.data.gameWriteSafety.reason, "error");
    return;
  }

  const addableFreeCount = renderAddAllFreeProvincesControl(state);
  const province = app.selectedProvince;
  if (!province) {
    const freeCount = freeProvinces().length;
    const bulkHint = addableFreeCount > 0 ? " Use Add all free provinces to assign every addable free province at once." : "";
    setEditStatus(`Only ${state.name} and ${freeCount} free province(s) are visible. Select a province to edit.${bulkHint}`);
    return;
  }

  const provinceState = app.data.provinceToState[province] || null;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "edit-action";

  if (provinceState === state.name) {
    button.textContent = "Make province free";
    button.addEventListener("click", () => makeSelectedProvinceFree());
    elements.editActions.append(button);
    setEditStatus(`${province} belongs to ${state.name}. Removing it creates a temporary free province until it is assigned elsewhere.`, "warning");
    return;
  }

  if (!provinceState) {
    const reserved = reservedProvinceKind(province);
    button.textContent = `Add ${province} to ${state.name}`;
    button.disabled = Boolean(reserved);
    button.addEventListener("click", () => addSelectedFreeProvinceToState());
    elements.editActions.append(button);
    if (reserved) {
      setEditStatus(`${province} is reserved as ${reserved} and cannot be added to a state.`, "error");
    } else {
      setEditStatus(`${province} is free and can be added to ${state.name}.`, "warning");
    }
    return;
  }

  setEditStatus(`${province} belongs to ${provinceState}. Select that state first or make it free before adding it here.`, "error");
}

function renderAddAllFreeProvincesControl(state) {
  const provinces = addableFreeProvinces();
  const button = document.createElement("button");
  button.type = "button";
  button.className = "edit-action";
  button.textContent = `Add all free provinces (${formatNumber(provinces.length)})`;
  button.disabled = provinces.length === 0;
  button.addEventListener("click", () => addAllFreeProvincesToState());
  elements.editActions.append(button);
  return provinces.length;
}

function renderFreeProvinceList() {
  const addableProvinces = addableFreeProvinces();
  const reservedProvinces = reservedFreeProvinces();
  elements.freeListMeta.textContent = `${formatNumber(addableProvinces.length)} addable pending assignment`;
  elements.lakeListMeta.textContent = `${formatNumber(reservedProvinces.length)} reserved lake province(s)`;

  if (addableProvinces.length === 0) {
    renderEmpty(elements.freeProvinceList, "No addable free provinces");
  } else {
    for (const province of addableProvinces) {
      renderFreeProvinceChip(elements.freeProvinceList, province, false);
    }
  }

  if (reservedProvinces.length === 0) {
    renderEmpty(elements.lakeProvinceList, "No reserved lakes");
  } else {
    for (const province of reservedProvinces) {
      renderFreeProvinceChip(elements.lakeProvinceList, province, true);
    }
  }
}

function renderFreeProvinceChip(container, province, reserved) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "free-province-chip";
  if (reserved) chip.classList.add("is-reserved");
  if (province === app.selectedProvince) chip.classList.add("is-active");
  chip.textContent = province;
  chip.title = reserved ? `${province} - reserved ${reservedProvinceKind(province)}` : `${province} - free province`;
  chip.addEventListener("click", () => selectProvince(province, true));
  container.append(chip);
}

function provinceCenter(province) {
  const bounds = app.boundsByProvince[province];
  if (!bounds || bounds.count === 0) return null;
  return { x: bounds.sumX / bounds.count, y: bounds.sumY / bounds.count };
}

function distanceBetweenProvinces(leftProvince, rightProvince) {
  const leftCenter = provinceCenter(leftProvince);
  const rightCenter = provinceCenter(rightProvince);
  if (!leftCenter || !rightCenter) return Number.POSITIVE_INFINITY;
  const deltaX = leftCenter.x - rightCenter.x;
  const deltaY = leftCenter.y - rightCenter.y;
  return deltaX * deltaX + deltaY * deltaY;
}

function findUnusedProvinceInState(state, excludedProvince, options = {}) {
  const occupied = new Set(
    specialEntriesForState(state)
      .filter((entry) => entry.province !== excludedProvince)
      .map((entry) => entry.province),
  );
  const candidates = state.provinces.filter((province) => {
    if (province === excludedProvince || occupied.has(province)) return false;
    if (options.needsSeaAccess && !app.provinceSeaTouch.has(province)) return false;
    return true;
  });
  candidates.sort((leftProvince, rightProvince) => {
    const leftDistance = distanceBetweenProvinces(excludedProvince, leftProvince);
    const rightDistance = distanceBetweenProvinces(excludedProvince, rightProvince);
    if (leftDistance !== rightDistance) return leftDistance - rightDistance;
    return leftProvince.localeCompare(rightProvince);
  });
  return candidates[0] || null;
}

function moveSpecialRolesOffProvince(state, province) {
  const entries = specialEntriesForState(state).filter((entry) => entry.province === province);
  if (entries.length === 0) return { ok: true, message: "" };

  const rolesToMove = entries.filter((entry) => entry.role !== "impassable");
  const impassableCount = entries.length - rolesToMove.length;
  const needsSeaAccess = rolesToMove.some((entry) => entry.role === "port");
  const replacement = rolesToMove.length > 0 ? findUnusedProvinceInState(state, province, { needsSeaAccess }) : null;
  if (rolesToMove.length > 0 && !replacement) {
    const qualifier = needsSeaAccess ? " coastal" : "";
    return { ok: false, message: `${state.name} has no remaining${qualifier} province without special content to receive ${province}'s special roles.` };
  }

  for (const entry of rolesToMove) {
    if (["city", "farm", "mine", "wood", "port", "center"].includes(entry.role)) {
      state.special[entry.role] = replacement;
    }
    if (entry.role === "prime_land") {
      state.special.prime_land = state.special.prime_land.map((item) => (item === province ? replacement : item));
    }
  }

  if (impassableCount > 0) {
    state.special.impassable = state.special.impassable.filter((item) => item !== province);
  }

  const movedRoles = rolesToMove.map((entry) => roleNames[entry.role] || entry.role).join(", ");
  const removedImpassable = impassableCount > 0 ? " Removed impassable reference instead of reassigning it." : "";
  return {
    ok: true,
    message: rolesToMove.length > 0 ? `Moved ${movedRoles} from ${province} to ${replacement}.${removedImpassable}` : removedImpassable.trim(),
  };
}

async function makeSelectedProvinceFree() {
  const state = app.stateByName.get(app.selectedState);
  const province = app.selectedProvince;
  if (!state || !province || app.data.provinceToState[province] !== state.name) return;

  const specialMove = moveSpecialRolesOffProvince(state, province);
  if (!specialMove.ok) {
    showBlockingMessage(specialMove.message);
    return;
  }

  state.provinces = state.provinces.filter((item) => item !== province);
  delete app.data.provinceToState[province];
  rerenderAfterDraftChange();
  if (specialMove.message) setEditStatus(`${specialMove.message} Assign the freed province to a state before saving.`, "warning");
  await saveDraftIfCompliant();
}

async function addSelectedFreeProvinceToState() {
  const state = app.stateByName.get(app.selectedState);
  const province = app.selectedProvince;
  if (!state || !province) return;
  if (app.data.provinceToState[province]) {
    showBlockingMessage(`${province} is already assigned to ${app.data.provinceToState[province]}.`);
    return;
  }
  if (reservedProvinceKind(province)) {
    showBlockingMessage(`${province} is reserved as ${reservedProvinceKind(province)} and cannot be added to a state.`);
    return;
  }

  state.provinces.push(province);
  app.data.provinceToState[province] = state.name;
  rerenderAfterDraftChange();
  await saveDraftIfCompliant();
}

async function addAllFreeProvincesToState() {
  const state = app.stateByName.get(app.selectedState);
  if (!state || app.saving) return;

  const provinces = addableFreeProvinces();
  if (provinces.length === 0) {
    setEditStatus(`No addable free provinces can be added to ${state.name}.`, "ok");
    return;
  }

  for (const province of provinces) {
    state.provinces.push(province);
    app.data.provinceToState[province] = state.name;
  }
  rerenderAfterDraftChange();
  await saveDraftIfCompliant();
}

function renderEmpty(container, text) {
  const empty = document.createElement("span");
  empty.className = "is-empty";
  empty.textContent = text;
  container.append(empty);
}

function renderMarkers() {
  elements.markersLayer.replaceChildren();
  const fragment = document.createDocumentFragment();

  for (const [province, bounds] of Object.entries(app.specialBounds)) {
    const color = provinceKeyToInt(province);
    const roles = app.colorToRoles[color] || [];
    if (roles.length === 0 || bounds.count === 0) continue;

    const stateName = app.colorToState[color] || roles[0].state;
    const primaryRole = roles[0].role;
    const marker = document.createElement("button");
    marker.type = "button";
    marker.className = `marker role-${primaryRole}`;
    marker.dataset.province = province;
    marker.dataset.state = stateName || "";
    marker.style.left = `${bounds.sumX / bounds.count}px`;
    marker.style.top = `${bounds.sumY / bounds.count}px`;
    marker.textContent = roleLabels[primaryRole] || "?";
    marker.title = `${province} - ${stateName || "unknown"} - ${roles.map((role) => roleNames[role.role] || role.role).join(", ")}`;
    marker.addEventListener("click", (event) => {
      event.stopPropagation();
      if (stateName) selectState(stateName, false);
      selectProvince(province, true);
    });
    fragment.append(marker);
  }

  elements.markersLayer.append(fragment);
  updateMarkerSelection();
}

function updateMarkerSelection() {
  for (const marker of elements.markersLayer.querySelectorAll(".marker")) {
    marker.classList.toggle(
      "is-selected",
      marker.dataset.province === app.selectedProvince || marker.dataset.state === app.selectedState,
    );
  }
}

function setFocusBox(bounds, type) {
  if (!bounds) {
    elements.focusBox.hidden = true;
    return;
  }

  const pad = 2;
  elements.focusBox.hidden = false;
  elements.focusBox.classList.toggle("state-focus", type === "state");
  elements.focusBox.classList.toggle("province-focus", type === "province");
  elements.focusBox.style.left = `${Math.max(0, bounds.minX - pad)}px`;
  elements.focusBox.style.top = `${Math.max(0, bounds.minY - pad)}px`;
  elements.focusBox.style.width = `${Math.max(2, bounds.maxX - bounds.minX + pad * 2)}px`;
  elements.focusBox.style.height = `${Math.max(2, bounds.maxY - bounds.minY + pad * 2)}px`;
}

function selectState(name, fit) {
  const state = app.stateByName.get(name);
  if (!state) return;
  app.selectedState = name;
  app.selectedProvince = null;
  renderStateList();
  renderDetails();
  renderVisibilityFilter();
  updateMarkerSelection();
  const bounds = app.boundsByState[name];
  setFocusBox(bounds, "state");
  if (fit && bounds) fitBounds(bounds);
}

function selectProvince(province, fit) {
  const stateName = app.data.provinceToState[province];
  if (stateName) app.selectedState = stateName;
  app.selectedProvince = province;
  renderStateList();
  renderDetails();
  renderVisibilityFilter();
  updateMarkerSelection();
  const bounds = app.boundsByProvince[province];
  setFocusBox(bounds, "province");
  if (fit && bounds) fitBounds(bounds);
}

function clearSelection() {
  app.selectedState = null;
  app.selectedProvince = null;
  setFocusBox(null);
  renderStateList();
  renderDetails();
  renderVisibilityFilter();
  updateMarkerSelection();
}

function applyTransform() {
  elements.mapWorld.style.transform = `translate(${app.transform.x}px, ${app.transform.y}px) scale(${app.transform.scale})`;
  elements.mapWorld.style.setProperty("--marker-scale", String(1 / app.transform.scale));
  elements.zoomReadout.textContent = `Zoom ${Math.round(app.transform.scale * 100)}%`;
}

function fitWorld() {
  const rect = elements.viewport.getBoundingClientRect();
  const scale = Math.min(rect.width / app.width, rect.height / app.height) * 0.98;
  app.transform.scale = clamp(scale, 0.02, 20);
  app.transform.x = (rect.width - app.width * app.transform.scale) / 2;
  app.transform.y = (rect.height - app.height * app.transform.scale) / 2;
  applyTransform();
}

function fitBounds(bounds) {
  const rect = elements.viewport.getBoundingClientRect();
  const width = Math.max(20, bounds.maxX - bounds.minX);
  const height = Math.max(20, bounds.maxY - bounds.minY);
  const padding = 90;
  const scale = Math.min(rect.width / (width + padding), rect.height / (height + padding));
  app.transform.scale = clamp(scale, 0.06, 18);
  app.transform.x = rect.width / 2 - (bounds.minX + width / 2) * app.transform.scale;
  app.transform.y = rect.height / 2 - (bounds.minY + height / 2) * app.transform.scale;
  applyTransform();
}

function zoomAt(clientX, clientY, nextScale) {
  const rect = elements.viewport.getBoundingClientRect();
  const oldScale = app.transform.scale;
  const scale = clamp(nextScale, 0.02, 20);
  const mapX = (clientX - rect.left - app.transform.x) / oldScale;
  const mapY = (clientY - rect.top - app.transform.y) / oldScale;
  app.transform.scale = scale;
  app.transform.x = clientX - rect.left - mapX * scale;
  app.transform.y = clientY - rect.top - mapY * scale;
  applyTransform();
}

function viewportToMap(clientX, clientY) {
  const rect = elements.viewport.getBoundingClientRect();
  return {
    x: (clientX - rect.left - app.transform.x) / app.transform.scale,
    y: (clientY - rect.top - app.transform.y) / app.transform.scale,
  };
}

function provinceAtMapPoint(x, y) {
  const px = Math.floor(x);
  const py = Math.floor(y);
  if (!app.sourcePixels || px < 0 || py < 0 || px >= app.width || py >= app.height) return null;
  const offset = (py * app.width + px) * 4;
  const color = pixelIntAt(app.sourcePixels, offset);
  const province = app.colorToKey[color] || intToProvinceKey(color);
  const state = app.colorToState[color] || null;
  return { province, state, x: px, y: py };
}

function updateHover(event) {
  const point = viewportToMap(event.clientX, event.clientY);
  const hit = provinceAtMapPoint(point.x, point.y);
  if (!hit) {
    elements.hoverReadout.textContent = "No mapped state under cursor";
    return;
  }
  if (app.selectedState && hit.state && hit.state !== app.selectedState) {
    elements.hoverReadout.textContent = `${hit.province} belongs to ${hit.state}; hidden while editing ${app.selectedState}`;
    return;
  }
  if (!hit.state) {
    const reserved = reservedProvinceKind(hit.province);
    elements.hoverReadout.textContent = reserved ? `${hit.province} - reserved ${reserved}` : `${hit.province} - free`;
    return;
  }
  elements.hoverReadout.textContent = `${hit.state} - ${hit.province} - ${hit.x}, ${hit.y}`;
}

function wireEvents() {
  elements.stateSearch.addEventListener("input", renderStateList);

  document.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const action = button.dataset.action;
      const rect = elements.viewport.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      if (action === "reset-vanilla") {
        await resetToVanillaStateRegions();
        return;
      }
      if (action === "clear-selection") {
        clearSelection();
        return;
      }
      if (action === "zoom-in") zoomAt(cx, cy, app.transform.scale * 1.35);
      if (action === "zoom-out") zoomAt(cx, cy, app.transform.scale / 1.35);
      if (action === "fit-world" || action === "reset") {
        if (action === "reset") clearSelection();
        fitWorld();
      }
    });
  });

  elements.toggleBoundaries.addEventListener("change", () => {
    elements.boundaryCanvas.classList.toggle("is-hidden", !elements.toggleBoundaries.checked);
  });

  elements.toggleMarkers.addEventListener("change", () => {
    elements.markersLayer.classList.toggle("is-hidden", !elements.toggleMarkers.checked);
  });

  elements.viewport.addEventListener("wheel", (event) => {
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.18 : 1 / 1.18;
    zoomAt(event.clientX, event.clientY, app.transform.scale * factor);
  }, { passive: false });

  elements.viewport.addEventListener("pointerdown", (event) => {
    elements.viewport.setPointerCapture(event.pointerId);
    elements.viewport.classList.add("is-dragging");
    app.dragging = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: app.transform.x,
      originY: app.transform.y,
      moved: false,
    };
  });

  elements.viewport.addEventListener("pointermove", (event) => {
    if (app.dragging) {
      const dx = event.clientX - app.dragging.startX;
      const dy = event.clientY - app.dragging.startY;
      if (Math.abs(dx) + Math.abs(dy) > 3) app.dragging.moved = true;
      app.transform.x = app.dragging.originX + dx;
      app.transform.y = app.dragging.originY + dy;
      applyTransform();
      return;
    }
    updateHover(event);
  });

  elements.viewport.addEventListener("pointerup", (event) => {
    const drag = app.dragging;
    elements.viewport.classList.remove("is-dragging");
    app.dragging = null;
    if (!drag || drag.moved) return;

    const point = viewportToMap(event.clientX, event.clientY);
    const hit = provinceAtMapPoint(point.x, point.y);
    if (hit && app.selectedState && hit.state && hit.state !== app.selectedState) {
      elements.hoverReadout.textContent = `${hit.province} belongs to ${hit.state}; select ${hit.state} before editing it.`;
      return;
    }
    if (hit && (hit.state || app.selectedState)) {
      selectProvince(hit.province, false);
      elements.hoverReadout.textContent = `${hit.state || "free"} - ${hit.province} selected`;
    }
  });

  elements.viewport.addEventListener("pointerleave", () => {
    if (!app.dragging) elements.hoverReadout.textContent = "Move over the map to inspect a province.";
  });

  window.addEventListener("resize", () => {
    if (!app.width || !app.height) return;
    if (!app.selectedState && !app.selectedProvince) fitWorld();
  });
}

async function main() {
  wireEvents();

  try {
    setProgress(4, "Fetching state region data", "Reading parsed mod and reference files");
    const response = await fetch("/api/map-data", { cache: "no-store" });
    app.data = await readJsonResponse(response, "Map data request");
    assertCompatibleMapData(app.data);
    snapshotSavedProvinceLists(app.data);
    buildLookups(app.data);
    renderSummary();

    setProgress(14, "Loading province image", app.data.image.source);
    app.image = await loadImage(app.data.image.url);
    prepareImageCanvas(app.image);

    setProgress(24, "Reading province pixels", `${app.width} x ${app.height}`);
    await nextFrame();
    app.sourcePixels = readSourcePixels();

    setProgress(32, "Preparing boundary overlay", "Scanning provinces");
    await nextFrame();
    await scanMapImage();

    setProgress(91, "Building state and province controls", "Rendering lists");
    renderStateList();
    renderDetails();
    await nextFrame();

    setProgress(96, "Placing special province markers", "Rendering markers");
    renderMarkers();
    renderVisibilityFilter();
    fitWorld();
    await nextFrame();

    setProgress(100, "Ready", "Map loaded");
    elements.loadingOverlay.classList.add("is-hidden");
  } catch (error) {
    console.error(error);
    elements.loadingText.textContent = "Failed to load map viewer";
    elements.loadingDetail.textContent = error.message || String(error);
  }
}

main();
