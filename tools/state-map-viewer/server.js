const http = require("http");
const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");

const PORT = Number(process.env.PORT || process.argv.find((arg) => arg.startsWith("--port="))?.split("=")[1] || 8793);
const SHOULD_OPEN = process.argv.includes("--open");

// The release package is meant to sit directly inside a Victoria 3 mod folder.
// From tools/state-map-viewer, two parent hops point at the mod root.
const toolRoot = __dirname;
const modRoot = path.resolve(process.env.VIC3_MOD_ROOT || path.resolve(toolRoot, "..", ".."));
// Bundled vanilla 1.13.6 data lets the editor work before the mod contains any map overrides.
const referenceRoot = path.resolve(process.env.VIC3_REFERENCE_ROOT || path.join(modRoot, "tools", "vanilla_1_13_6_reference", "game"));
const publicRoot = path.join(toolRoot, "public");
const historyStatesRelativePath = path.join("common", "history", "states", "00_states.txt");

const provinceValueKeys = {
  city: "city",
  farm: "farm",
  mine: "mine",
  wood: "wood",
  port: "port",
  center: "center_province",
};

const provinceListKeys = {
  prime_land: "prime_land",
  impassable: "impassable",
};

const provinceValueRoles = Object.keys(provinceValueKeys);
const provinceListRoles = Object.keys(provinceListKeys);

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

function safeJoin(root, requestPath) {
  const decoded = decodeURIComponent(requestPath);
  const normalized = path.normalize(decoded).replace(/^[/\\]+/, "").replace(/^(\.\.[/\\])+/, "");
  const rootPath = path.resolve(root);
  const resolved = path.resolve(root, normalized);
  if (resolved !== rootPath && !resolved.startsWith(`${rootPath}${path.sep}`)) {
    return null;
  }
  return resolved;
}

function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function directoryExists(filePath) {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function isAsciiPath(filePath) {
  return /^[\x00-\x7F]*$/.test(filePath);
}

// Victoria 3 can show a local mod in the launcher while silently failing to load
// files from non-ASCII paths. Saving map overrides is blocked in that case.
function gameWriteSafety() {
  if (isAsciiPath(modRoot)) {
    return { safe: true, reason: null };
  }
  return {
    safe: false,
    reason: "Victoria 3 local mods are not reliable when the mod path contains non-ASCII characters. Move the mod/gameDataPath to an ASCII-only path before saving map_data overrides.",
  };
}

function assertGameWriteSafe() {
  const safety = gameWriteSafety();
  if (!safety.safe) throw new Error(safety.reason);
}

function preferredGameFile(relativePath) {
  const activePath = path.join(modRoot, relativePath);
  if (fileExists(activePath)) {
    return { path: activePath, source: "active" };
  }
  return { path: path.join(referenceRoot, relativePath), source: "reference" };
}

function listStateRegionFiles(root, source) {
  const dir = path.join(root, "map_data", "state_regions");
  if (!directoryExists(dir)) return [];
  return fs.readdirSync(dir)
    .filter((entry) => entry.toLowerCase().endsWith(".txt"))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name, path: path.join(dir, name), source }));
}

function listReferenceStateRegionFiles() {
  return listStateRegionFiles(referenceRoot, "reference");
}

function listMergedStateRegionFiles() {
  const relativeDir = path.join("map_data", "state_regions");
  const activeDir = path.join(modRoot, relativeDir);
  const referenceDir = path.join(referenceRoot, relativeDir);
  const names = new Set();

  for (const dir of [referenceDir, activeDir]) {
    if (!directoryExists(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      if (entry.toLowerCase().endsWith(".txt")) names.add(entry);
    }
  }

  return [...names].sort((a, b) => a.localeCompare(b)).map((name) => {
    const activePath = path.join(activeDir, name);
    if (fileExists(activePath)) {
      return { name, path: activePath, source: "active" };
    }
    return { name, path: path.join(referenceDir, name), source: "reference" };
  });
}

function stripComments(text) {
  return text.replace(/^\uFEFF/, "").replace(/#.*$/gm, "");
}

function findMatchingBrace(text, openIndex) {
  let depth = 0;
  let inString = false;
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"' && text[i - 1] !== "\\") inString = !inString;
    if (inString) continue;
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function normalizeProvince(raw) {
  return raw ? `x${raw.slice(1).toUpperCase()}` : null;
}

function normalizeProvinceInput(raw) {
  if (typeof raw !== "string") return null;
  const match = raw.trim().match(/^x[0-9a-fA-F]{6}$/);
  return match ? normalizeProvince(match[0]) : null;
}

function compareProvinces(a, b) {
  return Number.parseInt(a.slice(1), 16) - Number.parseInt(b.slice(1), 16);
}

function sortProvinceList(provinces) {
  return [...provinces].sort(compareProvinces);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractProvinceList(block, key) {
  const match = block.match(new RegExp(`\\b${key}\\s*=\\s*\\{([\\s\\S]*?)\\}`, "m"));
  if (!match) return [];
  return [...match[1].matchAll(/x[0-9a-fA-F]{6}/g)].map((item) => normalizeProvince(item[0]));
}

function extractProvinceValue(block, key) {
  const match = block.match(new RegExp(`\\b${key}\\s*=\\s*"?((?:x|X)[0-9a-fA-F]{6})"?`, "m"));
  return match ? normalizeProvince(match[1]) : null;
}

function parseStateRegionFile(file) {
  const raw = fs.readFileSync(file.path, "utf8");
  const text = stripComments(raw);
  const states = [];
  const stateRegex = /\b(STATE_[A-Z0-9_]+)\s*=\s*\{/g;
  let match;

  while ((match = stateRegex.exec(text)) !== null) {
    const stateName = match[1];
    const openIndex = text.indexOf("{", match.index);
    const closeIndex = findMatchingBrace(text, openIndex);
    if (closeIndex === -1) continue;

    const block = text.slice(openIndex + 1, closeIndex);
    stateRegex.lastIndex = closeIndex + 1;

    const idMatch = block.match(/\bid\s*=\s*(\d+)/);
    const provinces = extractProvinceList(block, "provinces");
    const special = {
      city: extractProvinceValue(block, "city"),
      farm: extractProvinceValue(block, "farm"),
      mine: extractProvinceValue(block, "mine"),
      wood: extractProvinceValue(block, "wood"),
      port: extractProvinceValue(block, "port"),
      center: extractProvinceValue(block, "center_province"),
      prime_land: extractProvinceList(block, "prime_land"),
      impassable: extractProvinceList(block, "impassable"),
    };

    states.push({
      name: stateName,
      id: idMatch ? Number(idMatch[1]) : null,
      file: file.name,
      source: file.source,
      isSea: file.name === "99_seas.txt" || stateName.startsWith("STATE_SEA_"),
      provinces,
      special,
    });
  }

  return states;
}

function parseProvinceGroup(text, key) {
  const match = text.match(new RegExp(`\\b${key}\\s*=\\s*\\{([\\s\\S]*?)\\}`, "m"));
  if (!match) return [];
  return [...match[1].matchAll(/x[0-9a-fA-F]{6}/g)].map((item) => normalizeProvince(item[0]));
}

function buildReservedProvinces() {
  const file = preferredGameFile(path.join("map_data", "default.map"));
  if (!fileExists(file.path)) return {};

  const text = stripComments(fs.readFileSync(file.path, "utf8"));
  const reserved = {};
  for (const province of parseProvinceGroup(text, "lakes")) {
    reserved[province] = "lakes";
  }
  return reserved;
}

function cloneState(state) {
  return {
    ...state,
    provinces: [...state.provinces],
    special: cloneSpecial(state.special),
  };
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

function specialEntriesForState(state) {
  const entries = [];
  for (const role of provinceValueRoles) {
    const province = state.special[role];
    if (province) entries.push({ role, province });
  }
  for (const role of provinceListRoles) {
    for (const province of state.special[role] || []) {
      entries.push({ role, province });
    }
  }
  return entries;
}

function buildReferenceProvinceOrigins() {
  const origins = new Map();
  for (const state of listReferenceStateRegionFiles().flatMap(parseStateRegionFile)) {
    for (const province of state.provinces) {
      origins.set(province, { state: state.name, isSea: state.isSea });
    }
  }
  return origins;
}

function buildProvinceToStateMap(states) {
  const provinceToState = new Map();
  for (const state of states) {
    for (const province of state.provinces) {
      provinceToState.set(province, state.name);
    }
  }
  return provinceToState;
}

function validateProposedStates(states) {
  const errors = [];
  const referenceOrigins = buildReferenceProvinceOrigins();
  const provinceToState = new Map();

  for (const state of states) {
    if (state.provinces.length === 0) {
      errors.push(`${state.name} has no provinces.`);
    }

    const seenInState = new Set();
    for (const province of state.provinces) {
      if (seenInState.has(province)) {
        errors.push(`${province} appears more than once in ${state.name}.`);
      }
      seenInState.add(province);

      if (!referenceOrigins.has(province)) {
        errors.push(`${province} is not a 1.13.6 state-region province; reserved map colors such as lakes cannot be assigned to states.`);
      }

      const origin = referenceOrigins.get(province);
      if (origin && origin.isSea !== state.isSea) {
        errors.push(`${province} cannot move between land and sea state regions.`);
      }

      const existing = provinceToState.get(province);
      if (existing) {
        errors.push(`${province} appears in both ${existing} and ${state.name}.`);
      } else {
        provinceToState.set(province, state.name);
      }
    }

    const stateProvinceSet = new Set(state.provinces);
    for (const entry of specialEntriesForState(state)) {
      if (!stateProvinceSet.has(entry.province)) {
        errors.push(`${state.name} ${entry.role} province ${entry.province} must remain inside that state unless the related attribute is edited too.`);
      }
    }
  }

  for (const province of referenceOrigins.keys()) {
    if (!provinceToState.has(province)) {
      errors.push(`${province} would be left free; every non-lake 1.13.6 state-region province must belong to exactly one state before saving.`);
    }
  }

  return [...new Set(errors)];
}

function replaceStateBlock(raw, stateName, replaceBlock) {
  const stateRegex = new RegExp(`\\b${escapeRegExp(stateName)}\\s*=\\s*\\{`, "g");
  const match = stateRegex.exec(raw);
  if (!match) throw new Error(`State ${stateName} was not found in its state_region file.`);

  const openIndex = raw.indexOf("{", match.index);
  const closeIndex = findMatchingBrace(raw, openIndex);
  if (closeIndex === -1) throw new Error(`State ${stateName} has no closing brace.`);

  const block = raw.slice(openIndex + 1, closeIndex);
  const nextBlock = replaceBlock(block);
  return `${raw.slice(0, openIndex + 1)}${nextBlock}${raw.slice(closeIndex)}`;
}

function replaceStateProvinceListInBlock(block, provinces) {
  const provinceMatch = /(^[ \t]*)provinces\s*=\s*\{[\s\S]*?\}/m.exec(block);
  if (!provinceMatch) throw new Error("State has no provinces list.");

  const formatted = `${provinceMatch[1]}provinces = { ${provinces.map((province) => `"${province}"`).join(" ")} }`;
  return `${block.slice(0, provinceMatch.index)}${formatted}${block.slice(provinceMatch.index + provinceMatch[0].length)}`;
}

function insertAfterProvinceList(block, line) {
  const provinceMatch = /(^[ \t]*)provinces\s*=\s*\{[\s\S]*?\}(?:\r?\n)?/m.exec(block);
  if (!provinceMatch) return `${block}\n${line}`;
  const separator = provinceMatch[0].endsWith("\n") || provinceMatch[0].endsWith("\r") ? "" : "\n";
  return `${block.slice(0, provinceMatch.index + provinceMatch[0].length)}${separator}${line}\n${block.slice(provinceMatch.index + provinceMatch[0].length)}`;
}

function replaceProvinceValueInBlock(block, key, province) {
  const fieldRegex = new RegExp(`(^[ \\t]*)${escapeRegExp(key)}\\s*=\\s*"?x[0-9a-fA-F]{6}"?`, "m");
  const match = fieldRegex.exec(block);
  if (match) {
    const formatted = province ? `${match[1]}${key} = "${province}"` : `${match[1]}${key} = ""`;
    return `${block.slice(0, match.index)}${formatted}${block.slice(match.index + match[0].length)}`;
  }
  if (!province) return block;

  const indentMatch = /(^[ \t]*)provinces\s*=/m.exec(block);
  const indent = indentMatch ? indentMatch[1] : "    ";
  return insertAfterProvinceList(block, `${indent}${key} = "${province}"`);
}

function replaceProvinceListInBlock(block, key, provinces) {
  const fieldRegex = new RegExp(`(^[ \\t]*)${escapeRegExp(key)}\\s*=\\s*\\{[\\s\\S]*?\\}`, "m");
  const match = fieldRegex.exec(block);
  if (match) {
    const formatted = `${match[1]}${key} = { ${provinces.map((province) => `"${province}"`).join(" ")} }`;
    return `${block.slice(0, match.index)}${formatted}${block.slice(match.index + match[0].length)}`;
  }
  if (provinces.length === 0) return block;

  const indentMatch = /(^[ \t]*)provinces\s*=/m.exec(block);
  const indent = indentMatch ? indentMatch[1] : "    ";
  const formatted = `${indent}${key} = { ${provinces.map((province) => `"${province}"`).join(" ")} }`;
  return insertAfterProvinceList(block, formatted);
}

function replaceStateSpecialFieldsInBlock(block, special) {
  let nextBlock = block;
  for (const [role, key] of Object.entries(provinceValueKeys)) {
    nextBlock = replaceProvinceValueInBlock(nextBlock, key, special[role]);
  }
  for (const [role, key] of Object.entries(provinceListKeys)) {
    nextBlock = replaceProvinceListInBlock(nextBlock, key, special[role] || []);
  }
  return nextBlock;
}

function replaceStateRegionBlock(raw, replacement) {
  return replaceStateBlock(raw, replacement.name, (block) => {
    let nextBlock = replaceStateProvinceListInBlock(block, replacement.provinces);
    if (replacement.special) {
      nextBlock = replaceStateSpecialFieldsInBlock(nextBlock, replacement.special);
    }
    return nextBlock;
  });
}

function writeStateRegionOverrides(replacements) {
  const currentStates = listMergedStateRegionFiles().flatMap(parseStateRegionFile);
  const stateByName = new Map(currentStates.map((state) => [state.name, state]));
  const groupedByFile = new Map();

  for (const replacement of replacements) {
    const state = stateByName.get(replacement.name);
    if (!state) throw new Error(`Unknown state ${replacement.name}.`);
    if (!groupedByFile.has(state.file)) groupedByFile.set(state.file, []);
    groupedByFile.get(state.file).push(replacement);
  }

  const outputDir = path.join(modRoot, "map_data", "state_regions");
  fs.mkdirSync(outputDir, { recursive: true });
  const savedFiles = [];

  for (const [fileName, fileReplacements] of groupedByFile) {
    // Victoria 3 treats same-path map_data files as whole-file overrides, so
    // each affected vanilla file is copied once and only the edited state blocks are changed.
    const activePath = path.join(outputDir, fileName);
    const referencePath = path.join(referenceRoot, "map_data", "state_regions", fileName);
    const sourcePath = fileExists(activePath) ? activePath : referencePath;
    let raw = fs.readFileSync(sourcePath, "utf8");

    for (const replacement of fileReplacements) {
      raw = replaceStateRegionBlock(raw, replacement);
    }

    fs.writeFileSync(activePath, raw, "utf8");
    savedFiles.push(path.relative(modRoot, activePath));
  }

  return savedFiles;
}

function parseHistoryStatesFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const states = [];
  const stateByName = new Map();
  const ownershipByProvince = new Map();
  const stateRegex = /(^[ \t]*)s:(STATE_[A-Z0-9_]+)\s*=\s*\{/gm;
  let stateMatch;

  while ((stateMatch = stateRegex.exec(raw)) !== null) {
    const stateName = stateMatch[2];
    const openIndex = raw.indexOf("{", stateMatch.index);
    const closeIndex = findMatchingBrace(raw, openIndex);
    if (closeIndex === -1) continue;

    const contentStart = openIndex + 1;
    const block = raw.slice(contentStart, closeIndex);
    const createBlocks = [];
    const createRegex = /(^[ \t]*)create_state\s*=\s*\{/gm;
    let createMatch;

    while ((createMatch = createRegex.exec(block)) !== null) {
      const createStart = contentStart + createMatch.index;
      const createOpen = raw.indexOf("{", createStart);
      const createClose = findMatchingBrace(raw, createOpen);
      if (createClose === -1 || createClose > closeIndex) continue;

      const createBlock = raw.slice(createOpen + 1, createClose);
      const ownedMatch = /(^[ \t]*)owned_provinces\s*=\s*\{[\s\S]*?\}/m.exec(createBlock);
      const countryMatch = createBlock.match(/\bcountry\s*=\s*(c:[A-Za-z0-9_]+)/);
      const stateTypeMatch = createBlock.match(/\bstate_type\s*=\s*([A-Za-z0-9_]+)/);
      if (ownedMatch) {
        const create = {
          stateName,
          country: countryMatch ? countryMatch[1] : null,
          stateType: stateTypeMatch ? stateTypeMatch[1] : null,
          provinces: extractProvinceList(createBlock, "owned_provinces"),
          start: createStart,
          close: createClose,
          ownedStart: createOpen + 1 + ownedMatch.index,
          ownedEnd: createOpen + 1 + ownedMatch.index + ownedMatch[0].length,
          ownedIndent: ownedMatch[1],
        };
        createBlocks.push(create);
        for (const province of create.provinces) {
          if (!ownershipByProvince.has(province)) ownershipByProvince.set(province, create);
        }
      }

      createRegex.lastIndex = createClose - contentStart + 1;
    }

    const state = { name: stateName, openIndex, closeIndex, createBlocks };
    states.push(state);
    stateByName.set(stateName, state);
    stateRegex.lastIndex = closeIndex + 1;
  }

  return { raw, states, stateByName, ownershipByProvince };
}

function uniqueProvinceList(provinces) {
  const seen = new Set();
  const result = [];
  for (const province of provinces) {
    if (seen.has(province)) continue;
    seen.add(province);
    result.push(province);
  }
  return result;
}

function historyAdditionKey(stateName, country) {
  return `${stateName}\u0000${country || ""}`;
}

function formatOwnedProvinceList(indent, provinces) {
  return `${indent}owned_provinces = { ${provinces.join(" ")} }`;
}

function formatCreateStateBlock(country, stateType, provinces) {
  const lines = [
    "\t\tcreate_state = {",
    `\t\t\tcountry = ${country}`,
  ];
  if (stateType) lines.push(`\t\t\tstate_type = ${stateType}`);
  lines.push(`\t\t\towned_provinces = { ${provinces.join(" ")} }`, "\t\t}");
  return lines.join("\n");
}

function applyRawOperations(raw, operations) {
  let nextRaw = raw;
  const sorted = [...operations].sort((a, b) => b.start - a.start || b.end - a.end);
  for (const operation of sorted) {
    nextRaw = `${nextRaw.slice(0, operation.start)}${operation.text}${nextRaw.slice(operation.end)}`;
  }
  return nextRaw;
}

function deleteCreateStateEnd(raw, closeIndex) {
  const trailing = raw.slice(closeIndex + 1).match(/^(\r?\n)([ \t]*\r?\n)?/);
  return closeIndex + 1 + (trailing ? trailing[0].length : 0);
}

function buildHistoryOwnershipPlan(history, provinceToState) {
  const additions = new Map();

  for (const state of history.states) {
    for (const create of state.createBlocks) {
      for (const province of create.provinces) {
        const targetState = provinceToState.get(province);
        if (!targetState || targetState === create.stateName) continue;
        const key = historyAdditionKey(targetState, create.country);
        if (!additions.has(key)) {
          additions.set(key, { stateName: targetState, country: create.country, stateType: create.stateType, provinces: [] });
        }
        additions.get(key).provinces.push(province);
      }
    }
  }

  return additions;
}

function validateHistoryOwnership(proposedStates) {
  const errors = [];
  const historyFile = preferredGameFile(historyStatesRelativePath);
  if (!fileExists(historyFile.path)) {
    return [`${historyStatesRelativePath} was not found, so province ownership cannot be kept in sync with state-region edits.`];
  }

  const history = parseHistoryStatesFile(historyFile.path);
  const provinceToState = buildProvinceToStateMap(proposedStates);
  const stateByName = new Map(proposedStates.map((state) => [state.name, state]));
  const originalOwnedCountByState = new Map();
  const proposedOwnedCountByState = new Map();

  for (const state of history.states) {
    for (const create of state.createBlocks) {
      for (const province of create.provinces) {
        originalOwnedCountByState.set(create.stateName, (originalOwnedCountByState.get(create.stateName) || 0) + 1);
        const targetState = provinceToState.get(province);
        if (!targetState) continue;
        proposedOwnedCountByState.set(targetState, (proposedOwnedCountByState.get(targetState) || 0) + 1);
        if (targetState === create.stateName) continue;

        const target = stateByName.get(targetState);
        if (!target || target.isSea) {
          errors.push(`${province} has history ownership but would move into non-land state ${targetState}.`);
        }
        if (!create.country) {
          errors.push(`${province} is owned in ${create.stateName}, but its create_state block has no country for history sync.`);
        }
        if (!history.stateByName.has(targetState)) {
          errors.push(`${province} would move to ${targetState}, but that state has no history block in ${historyStatesRelativePath}.`);
        }
      }
    }
  }

  for (const state of proposedStates) {
    if (state.isSea) continue;
    if ((originalOwnedCountByState.get(state.name) || 0) > 0 && (proposedOwnedCountByState.get(state.name) || 0) === 0) {
      errors.push(`${state.name} would have provinces but no owned_provinces after history sync.`);
    }
  }

  return [...new Set(errors)];
}

function writeHistoryStateOverride(proposedStates) {
  const historyFile = preferredGameFile(historyStatesRelativePath);
  if (!fileExists(historyFile.path)) return [];

  const history = parseHistoryStatesFile(historyFile.path);
  const provinceToState = buildProvinceToStateMap(proposedStates);
  const additions = buildHistoryOwnershipPlan(history, provinceToState);
  const operations = [];
  const insertionsByState = new Map();

  for (const state of history.states) {
    for (const create of state.createBlocks) {
      const key = historyAdditionKey(create.stateName, create.country);
      const incoming = additions.get(key);
      const kept = create.provinces.filter((province) => !provinceToState.has(province) || provinceToState.get(province) === create.stateName);
      const provinces = uniqueProvinceList([...kept, ...((incoming && incoming.provinces) || [])]);
      if (incoming) additions.delete(key);

      if (provinces.length === 0) {
        operations.push({ start: create.start, end: deleteCreateStateEnd(history.raw, create.close), text: "" });
      } else if (JSON.stringify(provinces) !== JSON.stringify(create.provinces)) {
        operations.push({ start: create.ownedStart, end: create.ownedEnd, text: formatOwnedProvinceList(create.ownedIndent, provinces) });
      }
    }
  }

  for (const addition of additions.values()) {
    const state = history.stateByName.get(addition.stateName);
    if (!state || !addition.country) continue;
    if (!insertionsByState.has(state.name)) insertionsByState.set(state.name, []);
    insertionsByState.get(state.name).push(formatCreateStateBlock(addition.country, addition.stateType, uniqueProvinceList(addition.provinces)));
  }

  for (const [stateName, blocks] of insertionsByState) {
    const state = history.stateByName.get(stateName);
    const insertAt = state.createBlocks.length > 0 ? state.createBlocks[state.createBlocks.length - 1].close + 1 : state.openIndex + 1;
    operations.push({ start: insertAt, end: insertAt, text: `\n${blocks.join("\n")}` });
  }

  if (operations.length === 0) return [];

  const outputPath = path.join(modRoot, historyStatesRelativePath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, applyRawOperations(history.raw, operations), "utf8");
  return [path.relative(modRoot, outputPath)];
}

function resetStateRegionOverrides() {
  const activeDir = path.join(modRoot, "map_data", "state_regions");
  const removedFiles = [];

  if (directoryExists(activeDir)) {
    for (const entry of fs.readdirSync(activeDir)) {
      if (!entry.toLowerCase().endsWith(".txt")) continue;
      const filePath = path.join(activeDir, entry);
      if (!fileExists(filePath)) continue;
      fs.unlinkSync(filePath);
      removedFiles.push(path.relative(modRoot, filePath));
    }
  }

  const activeHistoryPath = path.join(modRoot, historyStatesRelativePath);
  if (fileExists(activeHistoryPath)) {
    fs.unlinkSync(activeHistoryPath);
    removedFiles.push(path.relative(modRoot, activeHistoryPath));
  }

  for (const dir of [activeDir, path.dirname(activeDir), path.dirname(activeHistoryPath), path.dirname(path.dirname(activeHistoryPath)), path.dirname(path.dirname(path.dirname(activeHistoryPath)))]) {
    try {
      if (directoryExists(dir) && fs.readdirSync(dir).length === 0) {
        fs.rmdirSync(dir);
      }
    } catch {
      // Leaving an empty directory behind is harmless; the txt overrides are what affect the game.
    }
  }

  return removedFiles;
}

function buildMapData() {
  const files = listMergedStateRegionFiles();
  const historyFile = preferredGameFile(historyStatesRelativePath);
  const states = files.flatMap(parseStateRegionFile);
  const provinceToState = {};
  const provinceRoles = {};
  const diagnostics = [];

  for (const state of states) {
    for (const province of state.provinces) {
      if (provinceToState[province]) {
        diagnostics.push(`Province ${province} appears in both ${provinceToState[province]} and ${state.name}`);
      }
      provinceToState[province] = state.name;
      provinceRoles[province] ||= [];
    }

    const sortedProvinces = sortProvinceList(state.provinces);
    if (state.provinces.some((province, index) => province !== sortedProvinces[index])) {
      diagnostics.push(`${state.name} provinces are not sorted by province id; Victoria 3 may reject the state-region file.`);
    }

    for (const role of ["city", "farm", "mine", "wood", "port", "center"]) {
      const province = state.special[role];
      if (!province) continue;
      provinceRoles[province] ||= [];
      provinceRoles[province].push({ state: state.name, role });
    }

    for (const role of ["prime_land", "impassable"]) {
      for (const province of state.special[role]) {
        provinceRoles[province] ||= [];
        provinceRoles[province].push({ state: state.name, role });
      }
    }
  }

  const provinceCount = Object.keys(provinceToState).length;
  const specialProvinceCount = Object.values(provinceRoles).filter((roles) => roles.length > 0).length;
  const image = preferredGameFile(path.join("map_data", "provinces.png"));

  const safety = gameWriteSafety();

  return {
    generatedAt: new Date().toISOString(),
    modRoot,
    referenceRoot,
    image: {
      url: "/assets/provinces.png",
      source: image.source,
    },
    sourceFiles: files.map((file) => ({
      name: file.name,
      source: file.source,
      relativePath: path.relative(modRoot, file.path),
    })),
    states,
    provinceToState,
    provinceRoles,
    reservedProvinces: buildReservedProvinces(),
    gameWriteSafety: safety,
    capabilities: {
      schemaVersion: 5,
      saveStateRegions: true,
      resetStateRegions: true,
      reservedProvinces: true,
      specialReassignment: true,
      historyOwnershipSync: true,
      sortedStateRegionProvinces: true,
      asciiModPathSafe: safety.safe,
    },
    summary: {
      states: states.length,
      provinces: provinceCount,
      specialProvinces: specialProvinceCount,
      activeStateRegionFiles: files.filter((file) => file.source === "active").length,
      referenceStateRegionFiles: files.filter((file) => file.source === "reference").length,
      activeHistoryStateFile: historyFile.source === "active" ? 1 : 0,
    },
    diagnostics,
  };
}

function sendJson(response, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(payload.statusCode || 200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function sendError(response, statusCode, message, details) {
  sendJson(response, { ok: false, statusCode, error: message, details });
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("Request body is too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body.replace(/^\uFEFF/, "")) : {});
      } catch (error) {
        reject(new Error(`Invalid JSON: ${error.message}`));
      }
    });
    request.on("error", reject);
  });
}

function parseSavePayload(payload) {
  if (!payload || !Array.isArray(payload.states)) {
    throw new Error("Payload must contain a states array.");
  }

  return payload.states.map((state) => {
    if (!state || typeof state.name !== "string" || !/^STATE_[A-Z0-9_]+$/.test(state.name)) {
      throw new Error("Each edited state must have a valid STATE_* name.");
    }
    if (!Array.isArray(state.provinces)) {
      throw new Error(`${state.name} must include a provinces array.`);
    }

    const provinces = state.provinces.map(normalizeProvinceInput);
    if (provinces.some((province) => !province)) {
      throw new Error(`${state.name} contains an invalid province id.`);
    }

    return { name: state.name, provinces: sortProvinceList(provinces), special: normalizeSpecialPayload(state.special, state.name) };
  });
}

function normalizeSpecialPayload(rawSpecial, stateName) {
  if (rawSpecial === undefined) return null;
  if (!rawSpecial || typeof rawSpecial !== "object" || Array.isArray(rawSpecial)) {
    throw new Error(`${stateName} special must be an object when provided.`);
  }

  const special = {
    city: null,
    farm: null,
    mine: null,
    wood: null,
    port: null,
    center: null,
    prime_land: [],
    impassable: [],
  };

  for (const role of provinceValueRoles) {
    const value = rawSpecial[role];
    if (value === undefined || value === null || value === "") continue;
    const province = normalizeProvinceInput(value);
    if (!province) throw new Error(`${stateName} ${role} has an invalid province id.`);
    special[role] = province;
  }

  for (const role of provinceListRoles) {
    const values = rawSpecial[role] || [];
    if (!Array.isArray(values)) throw new Error(`${stateName} ${role} must be an array.`);
    special[role] = values.map(normalizeProvinceInput);
    if (special[role].some((province) => !province)) {
      throw new Error(`${stateName} ${role} contains an invalid province id.`);
    }
    special[role] = sortProvinceList(special[role]);
  }

  return special;
}

async function handleSaveStateRegions(request, response) {
  try {
    assertGameWriteSafe();
    const replacements = parseSavePayload(await readJsonBody(request));
    const replacementByName = new Map(replacements.map((state) => [state.name, state]));
    const proposedStates = listMergedStateRegionFiles().flatMap(parseStateRegionFile).map((state) => {
      const clone = cloneState(state);
      if (replacementByName.has(state.name)) {
        const replacement = replacementByName.get(state.name);
        clone.provinces = [...replacement.provinces];
        if (replacement.special) clone.special = cloneSpecial(replacement.special);
      }
      return clone;
    });

    for (const replacement of replacements) {
      if (!proposedStates.some((state) => state.name === replacement.name)) {
        throw new Error(`Unknown state ${replacement.name}.`);
      }
    }

    const errors = validateProposedStates(proposedStates);
    errors.push(...validateHistoryOwnership(proposedStates));
    if (errors.length > 0) {
      sendError(response, 422, "State-region edits are not compliant and were not saved.", errors.slice(0, 50));
      return;
    }

    const savedFiles = [...writeStateRegionOverrides(replacements), ...writeHistoryStateOverride(proposedStates)];
    sendJson(response, { ok: true, savedFiles, mapData: buildMapData() });
  } catch (error) {
    sendError(response, 400, error.message || String(error));
  }
}

async function handleResetStateRegions(response) {
  try {
    const removedFiles = resetStateRegionOverrides();
    const mapData = buildMapData();
    if (mapData.diagnostics.length > 0) {
      sendError(response, 500, "Reset completed but the reference map data has diagnostics.", mapData.diagnostics.slice(0, 50));
      return;
    }
    sendJson(response, { ok: true, removedFiles, mapData });
  } catch (error) {
    sendError(response, 500, error.message || String(error));
  }
}

function sendFile(response, filePath) {
  fs.stat(filePath, (error, stat) => {
    if (error || !stat.isFile()) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    response.writeHead(200, {
      "Content-Type": contentTypes[ext] || "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": "no-store",
    });
    fs.createReadStream(filePath).pipe(response);
  });
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === "POST" && url.pathname === "/api/save-state-regions") {
    handleSaveStateRegions(request, response);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/reset-state-regions") {
    handleResetStateRegions(response);
    return;
  }

  if (url.pathname === "/api/map-data") {
    try {
      sendJson(response, buildMapData());
    } catch (error) {
      response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: String(error.stack || error) }));
    }
    return;
  }

  if (url.pathname === "/assets/provinces.png") {
    const image = preferredGameFile(path.join("map_data", "provinces.png"));
    sendFile(response, image.path);
    return;
  }

  let requestPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const staticPath = safeJoin(publicRoot, requestPath);
  if (!staticPath) {
    response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Forbidden");
    return;
  }
  sendFile(response, staticPath);
});

server.listen(PORT, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`Victoria 3 state map viewer running at ${url}`);
  console.log(`Mod root: ${modRoot}`);
  if (SHOULD_OPEN) {
    childProcess.exec(`start "" "${url}"`);
  }
});
