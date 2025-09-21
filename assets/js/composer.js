import { fetchConfigWithYamlFallback } from './yaml.js';

// Utility helpers
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const PREFERRED_LANG_ORDER = ['en', 'zh', 'ja'];
const CLEAN_STATUS_MESSAGE = 'Synced with remote';
const DIRTY_STATUS_MESSAGE = 'Local changes pending';
const ORDER_LINE_COLORS = ['#2563eb', '#ec4899', '#f97316', '#10b981', '#8b5cf6', '#f59e0b', '#22d3ee'];

// --- Persisted UI state keys ---
const LS_KEYS = {
  cfile: 'ns_composer_file',           // 'index' | 'tabs'
  editorState: 'ns_composer_editor_state' // persisted dynamic editor info
};

// Track additional markdown editor tabs spawned from Composer
const dynamicEditorTabs = new Map();       // modeId -> { path, button, content, loaded, baseDir }
const dynamicEditorTabsByPath = new Map(); // normalizedPath -> modeId
let dynamicTabCounter = 0;
let currentMode = null;
let activeDynamicMode = null;
let detachPrimaryEditorListener = null;
let allowEditorStatePersist = false;

const DRAFT_STORAGE_KEY = 'ns_composer_drafts_v1';
const MARKDOWN_DRAFT_STORAGE_KEY = 'ns_markdown_editor_drafts_v1';

const MARKDOWN_PUSH_LABELS = {
  default: 'Synchronize',
  create: 'Create on GitHub',
  update: 'Synchronize'
};

const MARKDOWN_DISCARD_LABEL = 'Discard';

let markdownPushButton = null;
let markdownDiscardButton = null;

let activeComposerState = null;
let remoteBaseline = { index: null, tabs: null };
let composerDiffCache = { index: null, tabs: null };
let composerDraftMeta = { index: null, tabs: null };
let composerAutoSaveTimers = { index: null, tabs: null };
let composerDiffModal = null;
let composerOrderState = null;
let composerDiffResizeHandler = null;

function getActiveComposerFile() {
  try {
    const a = document.querySelector('a.vt-btn[data-cfile].active');
    const name = a && a.dataset && a.dataset.cfile;
    return name === 'tabs' ? 'tabs' : 'index';
  } catch (_) {
    return 'index';
  }
}

function deepClone(value) {
  try {
    if (typeof structuredClone === 'function') return structuredClone(value);
  } catch (_) {}
  try { return JSON.parse(JSON.stringify(value)); }
  catch (_) { return value; }
}

function safeString(value) {
  return value == null ? '' : String(value);
}

function escapeHtml(value) {
  return safeString(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function ensureToastRoot() {
  let root = document.getElementById('toast-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'toast-root';
    root.setAttribute('role', 'status');
    root.setAttribute('aria-live', 'polite');
    root.setAttribute('aria-atomic', 'true');
    root.style.position = 'fixed';
    root.style.left = '50%';
    root.style.bottom = '28px';
    root.style.transform = 'translateX(-50%)';
    root.style.display = 'flex';
    root.style.flexDirection = 'column';
    root.style.alignItems = 'center';
    root.style.gap = '.55rem';
    root.style.zIndex = '10000';
    root.style.pointerEvents = 'none';
    document.body.appendChild(root);
  }
  return root;
}

function showToast(kind, text, options = {}) {
  try {
    const message = safeString(text);
    if (!message) return;
    const root = ensureToastRoot();
    const el = document.createElement('div');
    el.className = `toast ${kind || ''}`;
    el.textContent = message;
    el.style.pointerEvents = 'auto';
    el.style.background = 'color-mix(in srgb, var(--card) 70%, #000 5%)';
    el.style.color = 'var(--text)';
    el.style.borderRadius = '999px';
    el.style.padding = '.55rem 1.1rem';
    el.style.boxShadow = '0 10px 30px rgba(15,23,42,0.18)';
    el.style.border = '1px solid color-mix(in srgb, var(--border) 70%, transparent)';
    el.style.fontSize = '.94rem';
    el.style.display = 'inline-flex';
    el.style.alignItems = 'center';
    el.style.justifyContent = 'center';
    el.style.minWidth = 'min(320px, 90vw)';
    el.style.maxWidth = '90vw';
    el.style.textAlign = 'center';
    el.style.transition = 'opacity .28s ease, transform .28s ease';
    el.style.opacity = '0';
    el.style.transform = 'translateY(12px)';
    if (kind === 'error') {
      el.style.borderColor = 'color-mix(in srgb, #dc2626 45%, transparent)';
    } else if (kind === 'success') {
      el.style.borderColor = 'color-mix(in srgb, #16a34a 45%, transparent)';
    }
    root.appendChild(el);
    requestAnimationFrame(() => {
      el.style.opacity = '1';
      el.style.transform = 'translateY(0)';
    });
    const ttl = typeof options.duration === 'number' ? Math.max(1200, options.duration) : 2300;
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(12px)';
    }, ttl);
    setTimeout(() => {
      try { el.remove(); } catch (_) {}
    }, ttl + 320);
  } catch (_) {
    try { alert(text); } catch (__) {}
  }
}

function setButtonLabel(btn, label) {
  if (!btn) return;
  const span = btn.querySelector('.btn-label');
  if (span) span.textContent = String(label || '');
  else btn.textContent = String(label || '');
}

function getButtonLabel(btn) {
  if (!btn) return '';
  const span = btn.querySelector('.btn-label');
  if (span) return span.textContent || '';
  return btn.textContent || '';
}

function truncateText(value, max = 60) {
  const str = safeString(value);
  if (str.length <= max) return str;
  return `${str.slice(0, Math.max(0, max - 1))}…`;
}

function prepareIndexState(raw) {
  const output = { __order: [] };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return output;
  const seen = new Set();
  const order = Array.isArray(raw.__order) ? raw.__order.filter(k => typeof k === 'string' && k) : [];
  order.forEach(key => {
    if (seen.has(key)) return;
    seen.add(key);
    output.__order.push(key);
    output[key] = normalizeIndexEntry(raw[key]);
  });
  Object.keys(raw).forEach(key => {
    if (key === '__order') return;
    if (seen.has(key)) {
      if (!Object.prototype.hasOwnProperty.call(output, key)) output[key] = normalizeIndexEntry(raw[key]);
      return;
    }
    seen.add(key);
    output.__order.push(key);
    output[key] = normalizeIndexEntry(raw[key]);
  });
  return output;
}

function normalizeIndexEntry(entry) {
  const out = {};
  if (!entry || typeof entry !== 'object') return out;
  Object.keys(entry).forEach(lang => {
    if (lang === '__order') return;
    const value = entry[lang];
    if (Array.isArray(value)) {
      out[lang] = value.map(item => safeString(item));
    } else if (value != null && typeof value === 'object') {
      // Unexpected object -> stringify to keep placeholder
      out[lang] = safeString(value.location || value.path || '');
    } else {
      out[lang] = safeString(value);
    }
  });
  return out;
}

function prepareTabsState(raw) {
  const output = { __order: [] };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return output;
  const seen = new Set();
  const order = Array.isArray(raw.__order) ? raw.__order.filter(k => typeof k === 'string' && k) : [];
  order.forEach(key => {
    if (seen.has(key)) return;
    seen.add(key);
    output.__order.push(key);
    output[key] = normalizeTabsEntry(raw[key]);
  });
  Object.keys(raw).forEach(key => {
    if (key === '__order') return;
    if (seen.has(key)) {
      if (!Object.prototype.hasOwnProperty.call(output, key)) output[key] = normalizeTabsEntry(raw[key]);
      return;
    }
    seen.add(key);
    output.__order.push(key);
    output[key] = normalizeTabsEntry(raw[key]);
  });
  return output;
}

function normalizeTabsEntry(entry) {
  const out = {};
  if (!entry || typeof entry !== 'object') return out;
  Object.keys(entry).forEach(lang => {
    if (lang === '__order') return;
    const value = entry[lang];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[lang] = {
        title: safeString(value.title),
        location: safeString(value.location)
      };
    } else {
      out[lang] = { title: '', location: safeString(value) };
    }
  });
  return out;
}

function arraysEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function computeIndexSignature(state) {
  if (!state) return '';
  const parts = [];
  const order = Array.isArray(state.__order) ? state.__order.slice() : [];
  parts.push(JSON.stringify(['order', order]));
  const keys = Object.keys(state).filter(k => k !== '__order').sort();
  keys.forEach(key => {
    const entry = state[key] || {};
    const langs = Object.keys(entry).sort();
    const langParts = langs.map(lang => {
      const value = entry[lang];
      if (Array.isArray(value)) return [lang, 'list', value.map(item => safeString(item))];
      return [lang, 'single', safeString(value)];
    });
    parts.push(JSON.stringify([key, langParts]));
  });
  return parts.join('|');
}

function computeTabsSignature(state) {
  if (!state) return '';
  const parts = [];
  const order = Array.isArray(state.__order) ? state.__order.slice() : [];
  parts.push(JSON.stringify(['order', order]));
  const keys = Object.keys(state).filter(k => k !== '__order').sort();
  keys.forEach(key => {
    const entry = state[key] || {};
    const langs = Object.keys(entry).sort();
    const langParts = langs.map(lang => {
      const value = entry[lang] || { title: '', location: '' };
      return [lang, safeString(value.title), safeString(value.location)];
    });
    parts.push(JSON.stringify([key, langParts]));
  });
  return parts.join('|');
}

function diffVersionLists(currentValue, baselineValue) {
  const normalize = (value) => {
    if (Array.isArray(value)) {
      return { kind: 'list', items: value.map(item => safeString(item)) };
    }
    return { kind: 'single', items: [safeString(value)] };
  };
  const cur = normalize(currentValue);
  const base = normalize(baselineValue);
  const curItems = cur.items;
  const baseItems = base.items;
  const baseMatched = new Array(baseItems.length).fill(false);
  const entries = [];
  for (let i = 0; i < curItems.length; i += 1) {
    const value = curItems[i];
    let status = 'added';
    let prevIndex = -1;
    if (i < baseItems.length && baseItems[i] === value && !baseMatched[i]) {
      status = 'unchanged';
      prevIndex = i;
      baseMatched[i] = true;
    } else {
      let foundIndex = -1;
      for (let j = 0; j < baseItems.length; j += 1) {
        if (!baseMatched[j] && baseItems[j] === value) {
          foundIndex = j;
          break;
        }
      }
      if (foundIndex !== -1) {
        status = 'moved';
        prevIndex = foundIndex;
        baseMatched[foundIndex] = true;
      } else if (i < baseItems.length) {
        status = 'changed';
        prevIndex = i;
        baseMatched[i] = true;
      }
    }
    entries.push({ value, status, prevIndex });
  }
  const removed = [];
  for (let i = 0; i < baseItems.length; i += 1) {
    if (!baseMatched[i]) removed.push({ value: baseItems[i], index: i });
  }
  const changed = cur.kind !== base.kind
    || curItems.length !== baseItems.length
    || entries.some(item => item.status !== 'unchanged')
    || removed.length > 0;
  const orderChanged = entries.some(item => item.status === 'moved')
    || (curItems.length === baseItems.length && !arraysEqual(curItems, baseItems));
  return {
    entries,
    removed,
    changed,
    orderChanged,
    kindChanged: cur.kind !== base.kind,
    kind: cur.kind
  };
}

function computeIndexDiff(current, baseline) {
  const cur = current || { __order: [] };
  const base = baseline || { __order: [] };
  const diff = {
    hasChanges: false,
    keys: {},
    orderChanged: false,
    addedKeys: [],
    removedKeys: []
  };
  const curOrder = Array.isArray(cur.__order) ? cur.__order : [];
  const baseOrder = Array.isArray(base.__order) ? base.__order : [];
  diff.orderChanged = !arraysEqual(curOrder, baseOrder);

  const keySet = new Set();
  Object.keys(cur).forEach(key => { if (key !== '__order') keySet.add(key); });
  Object.keys(base).forEach(key => { if (key !== '__order') keySet.add(key); });

  keySet.forEach(key => {
    const curEntry = cur[key];
    const baseEntry = base[key];
    const info = { state: '', langs: {}, addedLangs: [], removedLangs: [] };
    if (!baseEntry && curEntry) {
      info.state = 'added';
      diff.addedKeys.push(key);
      diff.hasChanges = true;
    } else if (baseEntry && !curEntry) {
      info.state = 'removed';
      diff.removedKeys.push(key);
      diff.hasChanges = true;
    } else if (curEntry && baseEntry) {
      const langSet = new Set();
      Object.keys(curEntry).forEach(lang => langSet.add(lang));
      Object.keys(baseEntry).forEach(lang => langSet.add(lang));
      langSet.forEach(lang => {
        const curVal = curEntry[lang];
        const baseVal = baseEntry[lang];
        if (curVal == null && baseVal == null) return;
        if (curVal == null && baseVal != null) {
          info.langs[lang] = { state: 'removed' };
          info.removedLangs.push(lang);
          diff.hasChanges = true;
          return;
        }
        if (curVal != null && baseVal == null) {
          info.langs[lang] = { state: 'added' };
          info.addedLangs.push(lang);
          diff.hasChanges = true;
          return;
        }
        const versionDiff = diffVersionLists(curVal, baseVal);
        if (versionDiff.changed) {
          info.langs[lang] = { state: 'modified', versions: versionDiff };
          diff.hasChanges = true;
        }
      });
      if (!info.state) {
        if (Object.keys(info.langs).length || info.addedLangs.length || info.removedLangs.length) {
          info.state = 'modified';
        }
      }
    }
    if (info.state || Object.keys(info.langs).length || info.addedLangs.length || info.removedLangs.length) {
      diff.keys[key] = info;
    }
  });
  diff.hasChanges = diff.hasChanges || diff.orderChanged || diff.addedKeys.length > 0 || diff.removedKeys.length > 0;
  return diff;
}

function computeTabsDiff(current, baseline) {
  const cur = current || { __order: [] };
  const base = baseline || { __order: [] };
  const diff = {
    hasChanges: false,
    keys: {},
    orderChanged: false,
    addedKeys: [],
    removedKeys: []
  };
  const curOrder = Array.isArray(cur.__order) ? cur.__order : [];
  const baseOrder = Array.isArray(base.__order) ? base.__order : [];
  diff.orderChanged = !arraysEqual(curOrder, baseOrder);

  const keySet = new Set();
  Object.keys(cur).forEach(key => { if (key !== '__order') keySet.add(key); });
  Object.keys(base).forEach(key => { if (key !== '__order') keySet.add(key); });

  keySet.forEach(key => {
    const curEntry = cur[key];
    const baseEntry = base[key];
    const info = { state: '', langs: {}, addedLangs: [], removedLangs: [] };
    if (!baseEntry && curEntry) {
      info.state = 'added';
      diff.addedKeys.push(key);
      diff.hasChanges = true;
    } else if (baseEntry && !curEntry) {
      info.state = 'removed';
      diff.removedKeys.push(key);
      diff.hasChanges = true;
    } else if (curEntry && baseEntry) {
      const langSet = new Set();
      Object.keys(curEntry).forEach(lang => langSet.add(lang));
      Object.keys(baseEntry).forEach(lang => langSet.add(lang));
      langSet.forEach(lang => {
        const curVal = curEntry[lang];
        const baseVal = baseEntry[lang];
        if (!curVal && !baseVal) return;
        if (!curVal && baseVal) {
          info.langs[lang] = { state: 'removed' };
          info.removedLangs.push(lang);
          diff.hasChanges = true;
          return;
        }
        if (curVal && !baseVal) {
          info.langs[lang] = { state: 'added' };
          info.addedLangs.push(lang);
          diff.hasChanges = true;
          return;
        }
        const curTitle = safeString(curVal.title);
        const curLoc = safeString(curVal.location);
        const baseTitle = safeString(baseVal.title);
        const baseLoc = safeString(baseVal.location);
        const titleChanged = curTitle !== baseTitle;
        const locationChanged = curLoc !== baseLoc;
        if (titleChanged || locationChanged) {
          info.langs[lang] = { state: 'modified', titleChanged, locationChanged };
          diff.hasChanges = true;
        }
      });
      if (!info.state) {
        if (Object.keys(info.langs).length || info.addedLangs.length || info.removedLangs.length) info.state = 'modified';
      }
    }
    if (info.state || Object.keys(info.langs).length || info.addedLangs.length || info.removedLangs.length) {
      diff.keys[key] = info;
    }
  });
  diff.hasChanges = diff.hasChanges || diff.orderChanged || diff.addedKeys.length > 0 || diff.removedKeys.length > 0;
  return diff;
}

function readDraftStore() {
  try {
    const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function writeDraftStore(store) {
  try {
    if (!store || !Object.keys(store).length) {
      localStorage.removeItem(DRAFT_STORAGE_KEY);
      return;
    }
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(store));
  } catch (_) {
    /* ignore storage errors */
  }
}

function normalizeMarkdownContent(text) {
  return String(text == null ? '' : text).replace(/\r\n/g, '\n');
}

function computeTextSignature(text) {
  const normalized = normalizeMarkdownContent(text || '');
  let hash = 0;
  for (let i = 0; i < normalized.length; i += 1) {
    hash = (hash * 131 + normalized.charCodeAt(i)) >>> 0; // simple rolling hash
  }
  return `${normalized.length}:${hash.toString(16)}`;
}

function readMarkdownDraftStore() {
  try {
    const raw = localStorage.getItem(MARKDOWN_DRAFT_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function writeMarkdownDraftStore(store) {
  try {
    if (!store || !Object.keys(store).length) {
      localStorage.removeItem(MARKDOWN_DRAFT_STORAGE_KEY);
      return;
    }
    localStorage.setItem(MARKDOWN_DRAFT_STORAGE_KEY, JSON.stringify(store));
  } catch (_) {
    /* ignore storage errors */
  }
}

function getMarkdownDraftEntry(path) {
  const norm = normalizeRelPath(path);
  if (!norm) return null;
  const store = readMarkdownDraftStore();
  const entry = store[norm];
  if (!entry || typeof entry !== 'object') return null;
  const content = entry.content != null ? normalizeMarkdownContent(entry.content) : '';
  const savedAt = Number(entry.savedAt);
  const remoteSignature = entry.remoteSignature ? String(entry.remoteSignature) : '';
  return {
    path: norm,
    content,
    savedAt: Number.isFinite(savedAt) ? savedAt : Date.now(),
    remoteSignature
  };
}

function saveMarkdownDraftEntry(path, content, remoteSignature = '') {
  const norm = normalizeRelPath(path);
  if (!norm) return null;
  const text = normalizeMarkdownContent(content);
  const store = readMarkdownDraftStore();
  const savedAt = Date.now();
  store[norm] = { content: text, savedAt, remoteSignature: String(remoteSignature || '') };
  writeMarkdownDraftStore(store);
  return { path: norm, content: text, savedAt, remoteSignature: String(remoteSignature || '') };
}

function clearMarkdownDraftEntry(path) {
  const norm = normalizeRelPath(path);
  if (!norm) return;
  const store = readMarkdownDraftStore();
  if (store && Object.prototype.hasOwnProperty.call(store, norm)) {
    delete store[norm];
    writeMarkdownDraftStore(store);
  }
}

function restoreMarkdownDraftForTab(tab) {
  if (!tab || !tab.path) return false;
  try { clearTimeout(tab.markdownDraftTimer); } catch (_) {}
  tab.markdownDraftTimer = null;
  const entry = getMarkdownDraftEntry(tab.path);
  if (!entry) {
    tab.localDraft = null;
    tab.draftConflict = false;
    return false;
  }
  tab.localDraft = {
    content: entry.content,
    savedAt: entry.savedAt,
    remoteSignature: entry.remoteSignature || '',
    manual: !!entry.manual
  };
  tab.content = entry.content;
  tab.draftConflict = false;
  tab.isDirty = true;
  updateDynamicTabDirtyState(tab, { autoSave: false });
  return true;
}

function saveMarkdownDraftForTab(tab, options = {}) {
  if (!tab || !tab.path) return null;
  const text = normalizeMarkdownContent(tab.content || '');
  const remoteSig = tab.remoteSignature || '';
  if (!text) {
    clearMarkdownDraftEntry(tab.path);
    tab.localDraft = null;
    tab.draftConflict = false;
    updateComposerMarkdownDraftIndicators({ path: tab.path });
    return null;
  }
  const saved = saveMarkdownDraftEntry(tab.path, text, remoteSig);
  if (saved) {
    tab.localDraft = {
      content: saved.content,
      savedAt: saved.savedAt,
      remoteSignature: saved.remoteSignature,
      manual: !!options.markManual
    };
    updateComposerMarkdownDraftIndicators({ path: tab.path });
  }
  return saved;
}

function clearMarkdownDraftForTab(tab) {
  if (!tab || !tab.path) return;
  try {
    if (tab.markdownDraftTimer) {
      clearTimeout(tab.markdownDraftTimer);
      tab.markdownDraftTimer = null;
    }
  } catch (_) {
    tab.markdownDraftTimer = null;
  }
  clearMarkdownDraftEntry(tab.path);
  tab.localDraft = null;
  tab.draftConflict = false;
  updateComposerMarkdownDraftIndicators({ path: tab.path });
}

function scheduleMarkdownDraftSave(tab) {
  if (!tab) return;
  if (tab.markdownDraftTimer) {
    clearTimeout(tab.markdownDraftTimer);
    tab.markdownDraftTimer = null;
  }
  tab.markdownDraftTimer = setTimeout(() => {
    tab.markdownDraftTimer = null;
    if (!tab.isDirty) {
      clearMarkdownDraftForTab(tab);
      return;
    }
    saveMarkdownDraftForTab(tab);
    if (currentMode === tab.mode) pushEditorCurrentFileInfo(tab);
  }, 720);
}

function flushMarkdownDraft(tab) {
  if (!tab) return;
  if (tab.markdownDraftTimer) {
    clearTimeout(tab.markdownDraftTimer);
    tab.markdownDraftTimer = null;
    if (tab.isDirty) {
      saveMarkdownDraftForTab(tab);
    }
  }
}

function updateDynamicTabDirtyState(tab, options = {}) {
  if (!tab || !tab.path) return;
  const normalizedContent = normalizeMarkdownContent(tab.content || '');
  const baseline = normalizeMarkdownContent(tab.remoteContent || '');
  const dirty = normalizedContent !== baseline;
  tab.isDirty = dirty;
  const conflict = !!(tab.localDraft
    && tab.localDraft.remoteSignature
    && tab.remoteSignature
    && tab.localDraft.remoteSignature !== tab.remoteSignature);
  tab.draftConflict = conflict;
  const btn = tab.button;
  if (btn) {
    if (dirty) btn.setAttribute('data-dirty', '1');
    else btn.removeAttribute('data-dirty');
    if (conflict) btn.setAttribute('data-draft-state', 'conflict');
    else if (tab.localDraft) btn.setAttribute('data-draft-state', 'saved');
    else btn.removeAttribute('data-draft-state');
  }
  if (!dirty) {
    clearMarkdownDraftForTab(tab);
  } else if (options.autoSave !== false) {
    scheduleMarkdownDraftSave(tab);
  }
  if (currentMode === tab.mode) {
    pushEditorCurrentFileInfo(tab);
  } else {
    updateMarkdownPushButton(tab);
  }
  updateComposerMarkdownDraftIndicators({ path: tab.path });
}

function hasUnsavedComposerChanges() {
  try {
    if (composerDiffCache && composerDiffCache.index && composerDiffCache.index.hasChanges) return true;
  } catch (_) {}
  try {
    if (composerDiffCache && composerDiffCache.tabs && composerDiffCache.tabs.hasChanges) return true;
  } catch (_) {}
  return false;
}

function hasUnsavedMarkdownDrafts() {
  for (const tab of dynamicEditorTabs.values()) {
    if (!tab) continue;
    if (tab.isDirty) return true;
    if (tab.localDraft && normalizeMarkdownContent(tab.localDraft.content || '')) return true;
  }
  try {
    const store = readMarkdownDraftStore();
    if (store && Object.keys(store).length) return true;
  } catch (_) {}
  return false;
}

function handleBeforeUnload(event) {
  try {
    dynamicEditorTabs.forEach(tab => { flushMarkdownDraft(tab); });
  } catch (_) {}
  if (hasUnsavedComposerChanges() || hasUnsavedMarkdownDrafts()) {
    try {
      event.preventDefault();
    } catch (_) {}
    event.returnValue = '';
  }
}

try {
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('beforeunload', handleBeforeUnload);
  }
} catch (_) {}



function cssEscape(value) {
  try {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(value);
  } catch (_) {}
  return safeString(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

function collectDynamicMarkdownDraftStates() {
  const map = new Map();
  dynamicEditorTabs.forEach(tab => {
    if (!tab || !tab.path) return;
    const norm = normalizeRelPath(tab.path);
    if (!norm) return;
    if (tab.draftConflict) map.set(norm, 'conflict');
    else if (tab.isDirty) map.set(norm, 'dirty');
    else if (tab.localDraft) map.set(norm, 'saved');
  });
  return map;
}

function getDraftIndicatorMessage(state) {
  switch (state) {
    case 'conflict':
      return 'Local draft conflicts with remote file';
    case 'dirty':
      return 'Unsaved changes pending in editor';
    case 'saved':
      return 'Local draft saved in browser';
    default:
      return '';
  }
}

function updateComposerDraftContainerState(container) {
  if (!container) return;
  let childState = '';
  if (container.querySelector('.ct-lang[data-draft-state="conflict"], .ci-ver-item[data-draft-state="conflict"]')) {
    childState = 'conflict';
  } else if (container.querySelector('.ct-lang[data-draft-state="dirty"], .ci-ver-item[data-draft-state="dirty"]')) {
    childState = 'dirty';
  } else {
    childState = '';
  }
  if (childState) container.setAttribute('data-child-draft', childState);
  else container.removeAttribute('data-child-draft');
}

function applyComposerDraftIndicatorState(el, state) {
  if (!el) return;
  const indicator = el.querySelector('.ct-draft-indicator, .ci-draft-indicator');
  const value = state ? String(state) : '';
  if (value) el.setAttribute('data-draft-state', value);
  else el.removeAttribute('data-draft-state');
  if (!indicator) return;
  if (value) {
    indicator.hidden = false;
    indicator.dataset.state = value;
    const label = getDraftIndicatorMessage(value);
    if (label) {
      indicator.setAttribute('title', label);
      indicator.setAttribute('aria-label', label);
      indicator.setAttribute('role', 'img');
    } else {
      indicator.removeAttribute('title');
      indicator.removeAttribute('aria-label');
      indicator.removeAttribute('role');
    }
  } else {
    indicator.hidden = true;
    indicator.dataset.state = '';
    indicator.removeAttribute('title');
    indicator.removeAttribute('aria-label');
    indicator.removeAttribute('role');
  }
  updateComposerDraftContainerState(el.closest('.ct-item, .ci-item'));
}

function updateComposerMarkdownDraftIndicators(options = {}) {
  const store = options.store || readMarkdownDraftStore();
  const overrides = options.overrideMap || collectDynamicMarkdownDraftStates();
  const normalizedPath = options.path ? normalizeRelPath(options.path) : '';
  const selectors = ['.ct-lang', '.ci-ver-item'];

  const updateElement = (el) => {
    if (!el) return;
    const raw = el.dataset ? el.dataset.mdPath : '';
    const path = normalizeRelPath(raw);
    if (path) el.dataset.mdPath = path;
    else delete el.dataset.mdPath;
    let state = '';
    if (path) {
      if (overrides && overrides.has(path)) {
        state = overrides.get(path) || '';
      } else if (store && Object.prototype.hasOwnProperty.call(store, path)) {
        state = 'saved';
      }
    }
    applyComposerDraftIndicatorState(el, state);
  };

  if (options.element) {
    updateElement(options.element);
  }

  if (normalizedPath) {
    selectors.forEach(sel => {
      const query = `${sel}[data-md-path="${cssEscape(normalizedPath)}"]`;
      $$(query).forEach(el => {
        if (options.element && el === options.element) return;
        updateElement(el);
      });
    });
    return;
  }

  if (options.element) return;

  selectors.forEach(sel => {
    $$( `${sel}[data-md-path]` ).forEach(updateElement);
  });
}

function getStateSlice(kind) {
  if (!activeComposerState) return null;
  return kind === 'tabs' ? activeComposerState.tabs : activeComposerState.index;
}

function setStateSlice(kind, value) {
  if (!activeComposerState) return;
  if (kind === 'tabs') activeComposerState.tabs = value;
  else activeComposerState.index = value;
}

function computeBaselineSignature(kind) {
  if (kind === 'tabs') return computeTabsSignature(remoteBaseline.tabs);
  return computeIndexSignature(remoteBaseline.index);
}

function recomputeDiff(kind) {
  const slice = getStateSlice(kind) || { __order: [] };
  const baselineSlice = kind === 'tabs' ? remoteBaseline.tabs : remoteBaseline.index;
  const diff = kind === 'tabs'
    ? computeTabsDiff(slice, baselineSlice)
    : computeIndexDiff(slice, baselineSlice);
  composerDiffCache[kind] = diff;
  return diff;
}

function makeDiffBadge(label, type, scope) {
  const cls = scope ? `${scope}-diff-badge` : 'diff-badge';
  return `<span class="${cls} ${cls}-${type}">${escapeHtml(label)}</span>`;
}

function buildIndexDiffBadges(info) {
  if (!info) return '';
  const badges = [];
  if (info.state === 'added') badges.push(makeDiffBadge('New', 'added', 'ci'));
  if (info.state === 'removed') badges.push(makeDiffBadge('Removed', 'removed', 'ci'));
  const handledLang = new Set();
  Object.keys(info.langs || {}).forEach(lang => {
    const detail = info.langs[lang];
    const label = lang.toUpperCase();
    handledLang.add(lang);
    if (!detail) return;
    if (detail.state === 'added') badges.push(makeDiffBadge(`+${label}`, 'added', 'ci'));
    else if (detail.state === 'removed') badges.push(makeDiffBadge(`-${label}`, 'removed', 'ci'));
    else if (detail.state === 'modified') badges.push(makeDiffBadge(`~${label}`, 'changed', 'ci'));
  });
  (info.addedLangs || []).forEach(lang => {
    if (handledLang.has(lang)) return;
    badges.push(makeDiffBadge(`+${lang.toUpperCase()}`, 'added', 'ci'));
  });
  (info.removedLangs || []).forEach(lang => {
    if (handledLang.has(lang)) return;
    badges.push(makeDiffBadge(`-${lang.toUpperCase()}`, 'removed', 'ci'));
  });
  if (!badges.length && info.state === 'modified') badges.push(makeDiffBadge('Changed', 'changed', 'ci'));
  return badges.join(' ');
}

function buildTabsDiffBadges(info) {
  if (!info) return '';
  const badges = [];
  if (info.state === 'added') badges.push(makeDiffBadge('New', 'added', 'ct'));
  if (info.state === 'removed') badges.push(makeDiffBadge('Removed', 'removed', 'ct'));
  Object.keys(info.langs || {}).forEach(lang => {
    const detail = info.langs[lang];
    if (!detail) return;
    const label = lang.toUpperCase();
    if (detail.state === 'added') badges.push(makeDiffBadge(`+${label}`, 'added', 'ct'));
    else if (detail.state === 'removed') badges.push(makeDiffBadge(`-${label}`, 'removed', 'ct'));
    else if (detail.state === 'modified') {
      const parts = [];
      if (detail.titleChanged) parts.push('title');
      if (detail.locationChanged) parts.push('location');
      const text = parts.length ? `${label} (${parts.join('&')})` : `${label}`;
      badges.push(makeDiffBadge(text, 'changed', 'ct'));
    }
  });
  if (!badges.length && info.state === 'modified') badges.push(makeDiffBadge('Changed', 'changed', 'ct'));
  return badges.join(' ');
}

function applyIndexDiffMarkers(diff) {
  const list = document.getElementById('ciList');
  if (!list) return;
  const keyDiff = (diff && diff.keys) || {};
  list.querySelectorAll('.ci-item').forEach(row => {
    const key = row.getAttribute('data-key');
    const info = keyDiff[key];
    if (info) {
      row.classList.add('is-dirty');
      row.setAttribute('data-diff', info.state || 'modified');
    } else {
      row.classList.remove('is-dirty');
      row.removeAttribute('data-diff');
    }
    const diffHost = row.querySelector('.ci-diff');
    if (diffHost) diffHost.innerHTML = buildIndexDiffBadges(info);
    const body = row.querySelector('.ci-body-inner');
    if (!body) return;
    body.querySelectorAll('.ci-lang').forEach(block => {
      const lang = block.dataset.lang;
      const langInfo = info && info.langs ? info.langs[lang] : null;
      if (langInfo) {
        block.setAttribute('data-diff', langInfo.state || 'modified');
      } else {
        block.removeAttribute('data-diff');
      }
      const removedBox = block.querySelector('[data-role="removed"]');
      if (removedBox) {
        const removed = langInfo && langInfo.versions && Array.isArray(langInfo.versions.removed)
          ? langInfo.versions.removed.map(item => item.value).filter(Boolean)
          : [];
        if (removed.length) {
          removedBox.hidden = false;
          removedBox.textContent = `Removed: ${removed.join(', ')}`;
        } else {
          removedBox.hidden = true;
          removedBox.textContent = '';
        }
      }
      const entries = langInfo && langInfo.versions && Array.isArray(langInfo.versions.entries)
        ? langInfo.versions.entries
        : null;
      block.querySelectorAll('.ci-ver-item').forEach(item => {
        if (!entries) {
          item.removeAttribute('data-diff');
          return;
        }
        const idx = Number(item.dataset.index);
        const entryInfo = entries[idx];
        if (entryInfo && entryInfo.status && entryInfo.status !== 'unchanged') {
          item.setAttribute('data-diff', entryInfo.status);
        } else {
          item.removeAttribute('data-diff');
        }
      });
    });
  });
}

function applyTabsDiffMarkers(diff) {
  const list = document.getElementById('ctList');
  if (!list) return;
  const keyDiff = (diff && diff.keys) || {};
  list.querySelectorAll('.ct-item').forEach(row => {
    const key = row.getAttribute('data-key');
    const info = keyDiff[key];
    if (info) {
      row.classList.add('is-dirty');
      row.setAttribute('data-diff', info.state || 'modified');
    } else {
      row.classList.remove('is-dirty');
      row.removeAttribute('data-diff');
    }
    const diffHost = row.querySelector('.ct-diff');
    if (diffHost) diffHost.innerHTML = buildTabsDiffBadges(info);
    const body = row.querySelector('.ct-body-inner');
    if (!body) return;
    body.querySelectorAll('.ct-lang').forEach(block => {
      const lang = block.dataset.lang;
      const langInfo = info && info.langs ? info.langs[lang] : null;
      if (langInfo) block.setAttribute('data-diff', langInfo.state || 'modified');
      else block.removeAttribute('data-diff');
      const titleInput = block.querySelector('.ct-title');
      const locInput = block.querySelector('.ct-loc');
      if (titleInput) {
        if (langInfo && langInfo.titleChanged) titleInput.setAttribute('data-diff', 'changed');
        else titleInput.removeAttribute('data-diff');
      }
      if (locInput) {
        if (langInfo && langInfo.locationChanged) locInput.setAttribute('data-diff', 'changed');
        else locInput.removeAttribute('data-diff');
      }
    });
  });
}

function updateFileDirtyBadge(kind) {
  const name = kind === 'tabs' ? 'tabs' : 'index';
  const el = document.querySelector(`a.vt-btn[data-cfile="${name}"]`);
  if (!el) return;
  const diff = composerDiffCache[kind];
  const hasChanges = !!(diff && diff.hasChanges);
  el.classList.toggle('has-draft', hasChanges);
  if (hasChanges) el.setAttribute('data-dirty', '1');
  else el.removeAttribute('data-dirty');
}

function computeUnsyncedSummary() {
  const entries = [];
  const indexDiff = composerDiffCache.index;
  const tabsDiff = composerDiffCache.tabs;
  if (indexDiff && indexDiff.hasChanges) {
    entries.push({
      kind: 'index',
      label: 'index.yaml',
      hasOrderChange: !!indexDiff.orderChanged,
      hasContentChange: Object.keys(indexDiff.keys || {}).length > 0
        || indexDiff.addedKeys.length > 0
        || indexDiff.removedKeys.length > 0
    });
  }
  if (tabsDiff && tabsDiff.hasChanges) {
    entries.push({
      kind: 'tabs',
      label: 'tabs.yaml',
      hasOrderChange: !!tabsDiff.orderChanged,
      hasContentChange: Object.keys(tabsDiff.keys || {}).length > 0
        || tabsDiff.addedKeys.length > 0
        || tabsDiff.removedKeys.length > 0
    });
  }
  return entries;
}

function updateReviewButton(summaryEntries = []) {
  const btn = document.getElementById('btnReview');
  if (!btn) return;
  const activeKind = getActiveComposerFile();
  const normalizedKind = activeKind === 'tabs' ? 'tabs' : 'index';
  const targetEntry = summaryEntries.find(entry => entry && entry.kind === normalizedKind);
  if (targetEntry) {
    btn.hidden = false;
    btn.style.display = '';
    btn.dataset.kind = targetEntry.kind === 'tabs' ? 'tabs' : 'index';
    btn.setAttribute('aria-hidden', 'false');
    const label = targetEntry.label || (targetEntry.kind === 'tabs' ? 'tabs.yaml' : 'index.yaml');
    const description = `Review changes for ${label}`;
    btn.setAttribute('aria-label', description);
    btn.title = description;
  } else {
    btn.hidden = true;
    btn.style.display = 'none';
    btn.removeAttribute('data-kind');
    btn.setAttribute('aria-hidden', 'true');
    btn.removeAttribute('title');
    btn.removeAttribute('aria-label');
  }
}

function updateDiscardButtonVisibility() {
  const btn = document.getElementById('btnDiscard');
  if (!btn) return;
  const activeKind = getActiveComposerFile();
  const normalizedKind = activeKind === 'tabs' ? 'tabs' : 'index';
  const diff = composerDiffCache[normalizedKind];
  const meta = composerDraftMeta[normalizedKind];
  const hasLocalChanges = !!(diff && diff.hasChanges);
  const hasDraft = !!meta;
  const shouldShow = hasLocalChanges || hasDraft;
  btn.hidden = !shouldShow;
  btn.setAttribute('aria-hidden', shouldShow ? 'false' : 'true');
  btn.style.display = shouldShow ? '' : 'none';
}

function updateUnsyncedSummary() {
  const el = document.getElementById('composerStatus');
  if (!el) {
    updateDiscardButtonVisibility();
    return;
  }
  const summaryEntries = computeUnsyncedSummary();
  updateDiscardButtonVisibility();
  if (summaryEntries.length) {
    el.innerHTML = '';
    const prefix = document.createElement('span');
    prefix.className = 'composer-summary-prefix';
    prefix.textContent = `${DIRTY_STATUS_MESSAGE} → `;
    el.appendChild(prefix);
    summaryEntries.forEach((entry, idx) => {
      if (idx > 0) el.append(' · ');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'composer-summary-link';
      btn.textContent = entry.label;
      btn.dataset.kind = entry.kind;
      if (entry.hasOrderChange) btn.dataset.order = '1';
      if (entry.hasContentChange) btn.dataset.content = '1';
      btn.addEventListener('click', () => openComposerDiffModal(entry.kind));
      el.appendChild(btn);
    });
    el.dataset.summary = '1';
    el.dataset.state = 'dirty';
    updateReviewButton(summaryEntries);
  } else {
    el.textContent = CLEAN_STATUS_MESSAGE;
    el.dataset.summary = '0';
    el.dataset.state = 'clean';
    updateReviewButton([]);
  }
}

function computeOrderDiffDetails(kind) {
  const baseline = kind === 'tabs' ? remoteBaseline.tabs : remoteBaseline.index;
  const current = getStateSlice(kind) || { __order: [] };
  const baseOrder = Array.isArray(baseline && baseline.__order)
    ? baseline.__order.filter(key => typeof key === 'string')
    : [];
  const curOrder = Array.isArray(current && current.__order)
    ? current.__order.filter(key => typeof key === 'string')
    : [];
  const beforeMap = new Map();
  const afterMap = new Map();
  baseOrder.forEach((key, idx) => { if (!beforeMap.has(key)) beforeMap.set(key, idx); });
  curOrder.forEach((key, idx) => { if (!afterMap.has(key)) afterMap.set(key, idx); });

  const beforeEntries = baseOrder.map((key, index) => {
    if (!afterMap.has(key)) return { key, index, status: 'removed' };
    const toIndex = afterMap.get(key);
    return {
      key,
      index,
      status: toIndex === index ? 'same' : 'moved',
      toIndex
    };
  });

  const afterEntries = curOrder.map((key, index) => {
    if (!beforeMap.has(key)) return { key, index, status: 'added' };
    const fromIndex = beforeMap.get(key);
    return {
      key,
      index,
      status: fromIndex === index ? 'same' : 'moved',
      fromIndex
    };
  });

  const connectors = beforeEntries
    .filter(entry => entry.status !== 'removed')
    .map(entry => ({
      key: entry.key,
      status: entry.status === 'moved' ? 'moved' : 'same',
      fromIndex: entry.index,
      toIndex: entry.toIndex
    }));

  const stats = {
    moved: connectors.filter(c => c.status === 'moved').length,
    added: afterEntries.filter(entry => entry.status === 'added').length,
    removed: beforeEntries.filter(entry => entry.status === 'removed').length
  };

  return { beforeEntries, afterEntries, connectors, stats };
}

function openComposerDiffModal(kind, initialTab = 'overview') {
  try {
    const modal = ensureComposerDiffModal();
    modal.open(kind, initialTab);
  } catch (err) {
    console.warn('Composer: failed to open composer diff modal', err);
  }
}

function openOrderDiffModal(kind) {
  openComposerDiffModal(kind, 'order');
}

function buildOrderDiffItem(entry, side) {
  const item = document.createElement('div');
  item.className = 'composer-order-item';
  item.dataset.status = entry.status || 'same';
  item.dataset.side = side;
  item.setAttribute('data-key', entry.key || '');

  const idxEl = document.createElement('span');
  idxEl.className = 'composer-order-index';
  idxEl.textContent = `#${entry.index + 1}`;
  item.appendChild(idxEl);

  const keyEl = document.createElement('span');
  keyEl.className = 'composer-order-key';
  keyEl.textContent = entry.key || '(empty)';
  item.appendChild(keyEl);

  const badgeEl = document.createElement('span');
  badgeEl.className = 'composer-order-badge';
  let badgeText = '';
  if (entry.status === 'moved') {
    if (side === 'before') badgeText = `→ #${(entry.toIndex == null ? entry.index : entry.toIndex) + 1}`;
    else badgeText = `from #${(entry.fromIndex == null ? entry.index : entry.fromIndex) + 1}`;
  } else if (entry.status === 'removed') {
    badgeText = 'Removed';
  } else if (entry.status === 'added') {
    badgeText = 'New';
  }
  if (badgeText) {
    badgeEl.textContent = badgeText;
  } else {
    badgeEl.classList.add('is-hidden');
  }
  item.appendChild(badgeEl);
  return item;
}


function ensureComposerDiffModal() {
  if (composerDiffModal) return composerDiffModal;

  const modal = document.createElement('div');
  modal.id = 'composerOrderModal';
  modal.className = 'ns-modal composer-order-modal composer-diff-modal';

  const dialog = document.createElement('div');
  dialog.className = 'ns-modal-dialog composer-order-dialog composer-diff-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');

  const head = document.createElement('div');
  head.className = 'composer-order-head';
  const title = document.createElement('h2');
  title.id = 'composerOrderTitle';
  title.textContent = 'Changes';
  const subtitle = document.createElement('p');
  subtitle.className = 'composer-order-subtitle';
  subtitle.textContent = 'Review differences compared to the remote baseline.';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'ns-modal-close btn-secondary composer-order-close';
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = 'Close';
  head.appendChild(title);
  head.appendChild(subtitle);
  head.appendChild(closeBtn);

  const tabsWrap = document.createElement('div');
  tabsWrap.className = 'composer-diff-tabs';
  tabsWrap.setAttribute('role', 'tablist');

  const tabDefs = [
    { id: 'overview', label: 'Overview' },
    { id: 'entries', label: 'Entries' },
    { id: 'order', label: 'Order' }
  ];
  const tabButtons = new Map();
  const tabPanels = new Map();

  function handleTabKeydown(ev, currentId) {
    if (!tabDefs.length) return;
    let nextIndex = -1;
    const currentIndex = tabDefs.findIndex(def => def.id === currentId);
    if (ev.key === 'ArrowLeft') {
      nextIndex = (currentIndex <= 0 ? tabDefs.length - 1 : currentIndex - 1);
    } else if (ev.key === 'ArrowRight') {
      nextIndex = (currentIndex + 1) % tabDefs.length;
    } else if (ev.key === 'Home') {
      nextIndex = 0;
    } else if (ev.key === 'End') {
      nextIndex = tabDefs.length - 1;
    } else {
      return;
    }
    ev.preventDefault();
    const nextId = tabDefs[nextIndex] && tabDefs[nextIndex].id;
    if (!nextId) return;
    setActiveTab(nextId);
    const btn = tabButtons.get(nextId);
    if (btn) btn.focus();
  }

  tabDefs.forEach((tab, index) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'composer-diff-tab';
    btn.textContent = tab.label;
    btn.dataset.tab = tab.id;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', index === 0 ? 'true' : 'false');
    btn.setAttribute('tabindex', index === 0 ? '0' : '-1');
    btn.addEventListener('click', () => setActiveTab(tab.id));
    btn.addEventListener('keydown', (ev) => handleTabKeydown(ev, tab.id));
    tabButtons.set(tab.id, btn);
    tabsWrap.appendChild(btn);
  });

  const viewsWrap = document.createElement('div');
  viewsWrap.className = 'composer-diff-views';

  function createView(id, extraClass) {
    const view = document.createElement('section');
    view.className = `composer-diff-view ${extraClass}`;
    view.dataset.view = id;
    view.setAttribute('role', 'tabpanel');
    view.setAttribute('tabindex', '0');
    if (id !== 'overview') {
      view.hidden = true;
      view.style.display = 'none';
      view.setAttribute('aria-hidden', 'true');
    } else {
      view.style.display = '';
      view.setAttribute('aria-hidden', 'false');
    }
    tabPanels.set(id, view);
    viewsWrap.appendChild(view);
    return view;
  }

  const viewOverview = createView('overview', 'composer-diff-view-overview');
  const viewEntries = createView('entries', 'composer-diff-view-entries');
  const viewOrder = createView('order', 'composer-diff-view-order');

  const statsWrap = document.createElement('div');
  statsWrap.className = 'composer-order-stats';

  const body = document.createElement('div');
  body.className = 'composer-order-body';

  const viz = document.createElement('div');
  viz.className = 'composer-order-visual';

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('composer-order-lines');
  svg.setAttribute('aria-hidden', 'true');

  const columns = document.createElement('div');
  columns.className = 'composer-order-columns';

  const beforeCol = document.createElement('div');
  beforeCol.className = 'composer-order-column composer-order-before';
  const beforeTitle = document.createElement('div');
  beforeTitle.className = 'composer-order-column-title';
  beforeTitle.textContent = 'Remote';
  const beforeList = document.createElement('div');
  beforeList.className = 'composer-order-list';
  beforeCol.appendChild(beforeTitle);
  beforeCol.appendChild(beforeList);

  const afterCol = document.createElement('div');
  afterCol.className = 'composer-order-column composer-order-after';
  const afterTitle = document.createElement('div');
  afterTitle.className = 'composer-order-column-title';
  afterTitle.textContent = 'Current';
  const afterList = document.createElement('div');
  afterList.className = 'composer-order-list';
  afterCol.appendChild(afterTitle);
  afterCol.appendChild(afterList);

  const emptyNotice = document.createElement('div');
  emptyNotice.className = 'composer-order-empty';
  emptyNotice.textContent = 'No items to compare yet.';

  columns.appendChild(beforeCol);
  columns.appendChild(afterCol);
  viz.appendChild(svg);
  viz.appendChild(columns);
  viz.appendChild(emptyNotice);
  body.appendChild(viz);
  viewOrder.appendChild(statsWrap);
  viewOrder.appendChild(body);

  dialog.setAttribute('aria-labelledby', title.id);
  dialog.appendChild(head);
  dialog.appendChild(tabsWrap);
  dialog.appendChild(viewsWrap);

  const actions = document.createElement('div');
  actions.className = 'composer-diff-actions';
  const syncBtn = document.createElement('button');
  syncBtn.type = 'button';
  syncBtn.className = 'btn-secondary composer-diff-sync';
  syncBtn.id = 'btnVerify';
  syncBtn.innerHTML = `
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 98 96" xmlns="http://www.w3.org/2000/svg">
      <path fill-rule="evenodd" clip-rule="evenodd" d="M48.854 0C21.839 0 0 22 0 49.217c0 21.756 13.993 40.172 33.405 46.69 2.427.49 3.316-1.059 3.316-2.362 0-1.141-.08-5.052-.08-9.127-13.59 2.934-16.42-5.867-16.42-5.867-2.184-5.704-5.42-7.17-5.42-7.17-4.448-3.015.324-3.015.324-3.015 4.934.326 7.523 5.052 7.523 5.052 4.367 7.496 11.404 5.378 14.235 4.074.404-3.178 1.699-5.378 3.074-6.6-10.839-1.141-22.243-5.378-22.243-24.283 0-5.378 1.94-9.778 5.014-13.2-.485-1.222-2.184-6.275.486-13.038 0 0 4.125-1.304 13.426 5.052a46.97 46.97 0 0 1 12.214-1.63c4.125 0 8.33.571 12.213 1.63 9.302-6.356 13.427-5.052 13.427-5.052 2.67 6.763.97 11.816.485 13.038 3.155 3.422 5.015 7.822 5.015 13.2 0 18.905-11.404 23.06-22.324 24.283 1.78 1.548 3.316 4.481 3.316 9.126 0 6.6-.08 11.897-.08 13.526 0 1.304.89 2.853 3.316 2.364 19.412-6.52 33.405-24.935 33.405-46.691C97.707 22 75.788 0 48.854 0z" fill="currentColor"/>
    </svg>
    <span class="btn-label">Synchronize</span>
  `;
  actions.appendChild(syncBtn);
  dialog.appendChild(actions);
  modal.appendChild(dialog);
  document.body.appendChild(modal);

  document.dispatchEvent(new CustomEvent('composer:verify-button-ready', { detail: { button: syncBtn } }));

  const focusableSelector = 'a[href], area[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])';
  let lastActive = null;
  let activeTab = 'overview';
  let activeKind = 'index';
  let activeDiff = null;

  const subtitleText = {
    overview: 'Review a quick summary of the unsynced changes.',
    entries: 'Inspect added, removed, and modified entries.',
    order: 'Remote baseline (left) · 当前顺序 (right)'
  };

  function prefersReducedMotion() {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (_) {
      return false;
    }
  }

  function closeModal() {
    if (composerDiffResizeHandler) {
      window.removeEventListener('resize', composerDiffResizeHandler);
      composerDiffResizeHandler = null;
    }
    composerOrderState = null;
    activeDiff = null;
    const reduce = prefersReducedMotion();
    if (reduce) {
      modal.classList.remove('is-open');
      modal.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('ns-modal-open');
      try { lastActive && lastActive.focus(); } catch (_) {}
      return;
    }
    try { modal.classList.remove('ns-anim-in'); } catch (_) {}
    try { modal.classList.add('ns-anim-out'); } catch (_) {}
    const finish = () => {
      try { modal.classList.remove('ns-anim-out'); } catch (_) {}
      modal.classList.remove('is-open');
      modal.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('ns-modal-open');
      try { lastActive && lastActive.focus(); } catch (_) {}
    };
    try {
      const onEnd = () => { dialog.removeEventListener('animationend', onEnd); finish(); };
      dialog.addEventListener('animationend', onEnd, { once: true });
      setTimeout(finish, 220);
    } catch (_) {
      finish();
    }
  }

  function updateSubtitle(tabId) {
    subtitle.textContent = subtitleText[tabId] || subtitleText.overview;
  }

  function setActiveTab(tabId) {
    if (!tabButtons.has(tabId)) tabId = 'overview';
    activeTab = tabId;
    tabButtons.forEach((btn, id) => {
      const selected = id === tabId;
      btn.classList.toggle('is-active', selected);
      btn.setAttribute('aria-selected', selected ? 'true' : 'false');
      btn.setAttribute('tabindex', selected ? '0' : '-1');
    });
    tabPanels.forEach((panel, id) => {
      const visible = id === tabId;
      panel.hidden = !visible;
      panel.style.display = visible ? '' : 'none';
      panel.classList.toggle('is-active', visible);
      panel.setAttribute('aria-hidden', visible ? 'false' : 'true');
    });
    updateSubtitle(tabId);
    if (tabId === 'order') {
      renderOrder(activeKind);
      if (!composerDiffResizeHandler) {
        composerDiffResizeHandler = () => drawOrderDiffLines();
        window.addEventListener('resize', composerDiffResizeHandler);
      }
      requestAnimationFrame(() => drawOrderDiffLines());
      setTimeout(drawOrderDiffLines, 140);
    } else if (composerDiffResizeHandler) {
      window.removeEventListener('resize', composerDiffResizeHandler);
      composerDiffResizeHandler = null;
      composerOrderState = null;
    }
  }

  function renderOverview(kind, diff) {
    viewOverview.innerHTML = '';
    if (!diff) {
      const empty = document.createElement('p');
      empty.className = 'composer-diff-empty';
      empty.textContent = 'No changes detected for this file.';
      viewOverview.appendChild(empty);
      return;
    }
    const statWrap = document.createElement('div');
    statWrap.className = 'composer-diff-overview-stats';
    const diffKeys = diff.keys || {};
    const modifiedKeys = Object.keys(diffKeys).filter(key => {
      const info = diffKeys[key];
      if (!info) return false;
      return info.state === 'modified' || (info.addedLangs && info.addedLangs.length) || (info.removedLangs && info.removedLangs.length);
    });
    const statDefs = [
      { id: 'added', label: 'Added', value: diff.addedKeys.length },
      { id: 'removed', label: 'Removed', value: diff.removedKeys.length },
      { id: 'modified', label: 'Modified', value: modifiedKeys.length },
      { id: 'order', label: 'Order', value: diff.orderChanged ? 'Changed' : 'Unchanged', state: diff.orderChanged ? 'changed' : 'clean' }
    ];
    statDefs.forEach(def => {
      const card = document.createElement('div');
      card.className = 'composer-diff-stat';
      card.dataset.id = def.id;
      if (typeof def.value === 'number') card.dataset.value = String(def.value);
      if (def.state) card.dataset.state = def.state;
      const valueEl = document.createElement('div');
      valueEl.className = 'composer-diff-stat-value';
      valueEl.textContent = String(def.value);
      const labelEl = document.createElement('div');
      labelEl.className = 'composer-diff-stat-label';
      labelEl.textContent = def.label;
      card.appendChild(valueEl);
      card.appendChild(labelEl);
      statWrap.appendChild(card);
    });
    viewOverview.appendChild(statWrap);

    const blocks = document.createElement('div');
    blocks.className = 'composer-diff-overview-blocks';
    function appendKeyBlock(title, keys) {
      if (!keys || !keys.length) return;
      const block = document.createElement('section');
      block.className = 'composer-diff-overview-block';
      const h3 = document.createElement('h3');
      h3.textContent = title;
      const list = document.createElement('ul');
      list.className = 'composer-diff-key-list';
      const max = 10;
      keys.slice(0, max).forEach(key => {
        const li = document.createElement('li');
        const code = document.createElement('code');
        code.textContent = key;
        li.appendChild(code);
        list.appendChild(li);
      });
      if (keys.length > max) {
        const more = document.createElement('li');
        more.className = 'composer-diff-key-more';
        more.textContent = `+${keys.length - max} more`;
        list.appendChild(more);
      }
      block.appendChild(h3);
      block.appendChild(list);
      blocks.appendChild(block);
    }
    appendKeyBlock('Added entries', diff.addedKeys);
    appendKeyBlock('Removed entries', diff.removedKeys);
    appendKeyBlock('Modified entries', modifiedKeys);
    if (blocks.children.length) viewOverview.appendChild(blocks);

    const langSet = new Set();
    Object.values(diffKeys).forEach(info => {
      if (!info) return;
      Object.keys(info.langs || {}).forEach(lang => langSet.add(lang.toUpperCase()));
      (info.addedLangs || []).forEach(lang => langSet.add(lang.toUpperCase()));
      (info.removedLangs || []).forEach(lang => langSet.add(lang.toUpperCase()));
    });
    if (langSet.size) {
      const p = document.createElement('p');
      p.className = 'composer-diff-overview-langs';
      p.textContent = `Languages impacted: ${Array.from(langSet).sort().join(', ')}`;
      viewOverview.appendChild(p);
    }
  }

  function describeEntrySnapshot(kind, key, source) {
    const state = source === 'baseline'
      ? (kind === 'tabs' ? remoteBaseline.tabs : remoteBaseline.index)
      : getStateSlice(kind);
    if (!state) return null;
    return state[key] || null;
  }

  function buildEntryDetails(kind, key, info, sectionType) {
    const list = document.createElement('ul');
    list.className = 'composer-diff-field-list';
    let hasContent = false;
    const push = (text) => {
      if (!text) return;
      const li = document.createElement('li');
      li.textContent = text;
      list.appendChild(li);
      hasContent = true;
    };
    if (sectionType === 'added' || sectionType === 'removed') {
      const snapshot = describeEntrySnapshot(kind, key, sectionType === 'added' ? 'current' : 'baseline');
      const langs = snapshot ? Object.keys(snapshot || {}).filter(lang => lang !== '__order') : [];
      if (!langs.length) {
        push('No language content recorded.');
      } else {
        langs.forEach(lang => {
          const label = lang.toUpperCase();
          if (kind === 'index') {
            const value = snapshot[lang];
            let count = 0;
            if (Array.isArray(value)) count = value.length;
            else if (value != null && value !== '') count = 1;
            push(`${label}: ${count ? `${count} value${count === 1 ? '' : 's'}` : 'empty entry'}`);
          } else {
            const value = snapshot[lang] || { title: '', location: '' };
            const parts = [];
            if (value.title) parts.push(`title “${truncateText(value.title, 32)}”`);
            if (value.location) parts.push(`location ${truncateText(value.location, 40)}`);
            if (!parts.length) parts.push('empty entry');
            push(`${label}: ${parts.join(', ')}`);
          }
        });
      }
    } else {
      const langSet = new Set([
        ...Object.keys(info.langs || {}),
        ...((info.addedLangs || [])),
        ...((info.removedLangs || []))
      ]);
      if (!langSet.size) return null;
      const addedLangs = new Set(info.addedLangs || []);
      const removedLangs = new Set(info.removedLangs || []);
      langSet.forEach(lang => {
        const detail = (info.langs || {})[lang];
        const label = lang.toUpperCase();
        if (!detail) {
          if (addedLangs.has(lang)) push(`${label}: added`);
          else if (removedLangs.has(lang)) push(`${label}: removed`);
          return;
        }
        if (detail.state === 'added') {
          push(`${label}: added`);
          return;
        }
        if (detail.state === 'removed') {
          push(`${label}: removed`);
          return;
        }
        if (detail.state === 'modified') {
          if (kind === 'index') {
            const versions = detail.versions || { entries: [], removed: [] };
            let addedCount = 0;
            let movedCount = 0;
            let changedCount = 0;
            (versions.entries || []).forEach(entry => {
              if (entry.status === 'added') addedCount += 1;
              else if (entry.status === 'moved') movedCount += 1;
              else if (entry.status === 'changed') changedCount += 1;
            });
            const removedCount = (versions.removed || []).length;
            const parts = [];
            if (versions.kindChanged) parts.push('type changed');
            if (addedCount) parts.push(`+${addedCount} new`);
            if (removedCount) parts.push(`-${removedCount} removed`);
            if (changedCount) parts.push(`${changedCount} updated`);
            if (versions.orderChanged || movedCount) parts.push('reordered');
            if (!parts.length) parts.push('content updated');
            push(`${label}: ${parts.join(', ')}`);
          } else {
            const changeFields = [];
            if (detail.titleChanged) changeFields.push('title');
            if (detail.locationChanged) changeFields.push('location');
            push(`${label}: updated ${changeFields.length ? changeFields.join(' & ') : 'content'}`);
          }
        }
      });
    }
    return hasContent ? list : null;
  }

  function renderEntries(kind, diff) {
    viewEntries.innerHTML = '';
    if (!diff) {
      const empty = document.createElement('p');
      empty.className = 'composer-diff-empty';
      empty.textContent = 'No content differences detected.';
      viewEntries.appendChild(empty);
      return;
    }
    const diffKeys = diff.keys || {};
    const sections = [
      { type: 'added', title: 'Added entries', keys: diff.addedKeys || [] },
      { type: 'removed', title: 'Removed entries', keys: diff.removedKeys || [] },
      { type: 'modified', title: 'Modified entries', keys: Object.keys(diffKeys).filter(key => {
        const info = diffKeys[key];
        if (!info) return false;
        return info.state === 'modified' || (info.addedLangs && info.addedLangs.length) || (info.removedLangs && info.removedLangs.length);
      }) }
    ];
    const hasData = sections.some(section => section.keys && section.keys.length);
    if (!hasData) {
      const empty = document.createElement('p');
      empty.className = 'composer-diff-empty';
      empty.textContent = 'Only ordering changed for this file.';
      viewEntries.appendChild(empty);
      return;
    }
    sections.forEach(section => {
      if (!section.keys || !section.keys.length) return;
      const block = document.createElement('section');
      block.className = 'composer-diff-section';
      block.dataset.section = section.type;
      const heading = document.createElement('h3');
      heading.textContent = section.title;
      block.appendChild(heading);
      const list = document.createElement('ul');
      list.className = 'composer-diff-entry-list';
      section.keys.forEach(key => {
        const info = diffKeys[key] || { state: section.type };
        const item = document.createElement('li');
        item.className = 'composer-diff-entry';
        const name = document.createElement('span');
        name.className = 'composer-diff-entry-key';
        name.textContent = key;
        item.appendChild(name);
        const badgeWrap = document.createElement('span');
        badgeWrap.className = 'composer-diff-entry-badges';
        const badgesHtml = kind === 'tabs' ? buildTabsDiffBadges(info) : buildIndexDiffBadges(info);
        if (badgesHtml) {
          badgeWrap.innerHTML = badgesHtml;
          item.appendChild(badgeWrap);
        }
        const details = buildEntryDetails(kind, key, info, section.type);
        if (details) item.appendChild(details);
        list.appendChild(item);
      });
      block.appendChild(list);
      viewEntries.appendChild(block);
    });
  }

  function updateOrderStats(stats) {
    statsWrap.innerHTML = '';
    const pieces = [];
    if (stats.moved) pieces.push({ label: `Moved ${stats.moved}`, status: 'moved' });
    if (stats.added) pieces.push({ label: `+${stats.added} new`, status: 'added' });
    if (stats.removed) pieces.push({ label: `-${stats.removed} removed`, status: 'removed' });
    if (!pieces.length) pieces.push({ label: 'No direct moves; changes come from additions/removals', status: 'neutral' });
    pieces.forEach(info => {
      const chip = document.createElement('span');
      chip.className = 'composer-order-chip';
      chip.dataset.status = info.status;
      chip.textContent = info.label;
      statsWrap.appendChild(chip);
    });
  }

  function renderOrder(kind) {
    const label = kind === 'tabs' ? 'tabs.yaml' : 'index.yaml';
    title.textContent = `Changes — ${label}`;
    const details = computeOrderDiffDetails(kind);
    const { beforeEntries, afterEntries, connectors, stats } = details;

    beforeList.innerHTML = '';
    afterList.innerHTML = '';
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    const leftMap = new Map();
    beforeEntries.forEach(entry => {
      const item = buildOrderDiffItem(entry, 'before');
      leftMap.set(entry.key, item);
      beforeList.appendChild(item);
    });

    const rightMap = new Map();
    afterEntries.forEach(entry => {
      const item = buildOrderDiffItem(entry, 'after');
      rightMap.set(entry.key, item);
      afterList.appendChild(item);
    });

    const hasItems = beforeEntries.length || afterEntries.length;
    if (hasItems) {
      emptyNotice.hidden = true;
      emptyNotice.style.display = 'none';
      emptyNotice.setAttribute('aria-hidden', 'true');
    } else {
      emptyNotice.hidden = false;
      emptyNotice.style.display = 'flex';
      emptyNotice.setAttribute('aria-hidden', 'false');
    }
    viz.classList.toggle('is-empty', !hasItems);

    updateOrderStats(stats);

    composerOrderState = hasItems
      ? { container: viz, svg, connectors, leftMap, rightMap }
      : null;
    if (activeTab === 'order') {
      drawOrderDiffLines();
      requestAnimationFrame(drawOrderDiffLines);
      setTimeout(drawOrderDiffLines, 120);
    }
  }

  function openModal(kind, initialTab = 'overview') {
    lastActive = document.activeElement;
    const reduce = prefersReducedMotion();
    try { modal.classList.remove('ns-anim-out'); } catch (_) {}
    modal.classList.add('is-open');
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('ns-modal-open');
    if (!reduce) {
      try {
        modal.classList.add('ns-anim-in');
        const onEnd = () => { dialog.removeEventListener('animationend', onEnd); try { modal.classList.remove('ns-anim-in'); } catch (_) {}; };
        dialog.addEventListener('animationend', onEnd, { once: true });
      } catch (_) {}
    }
    const safeKind = kind === 'tabs' ? 'tabs' : 'index';
    activeKind = safeKind;
    syncBtn.dataset.kind = safeKind;
    const label = safeKind === 'tabs' ? 'tabs.yaml' : 'index.yaml';
    title.textContent = `Changes — ${label}`;
    activeDiff = composerDiffCache[safeKind] || recomputeDiff(safeKind);
    renderOverview(safeKind, activeDiff);
    renderEntries(safeKind, activeDiff);
    renderOrder(safeKind);
    const targetTab = tabButtons.has(initialTab) ? initialTab : 'overview';
    setActiveTab(targetTab);
    setTimeout(() => {
      try { closeBtn.focus(); } catch (_) {}
    }, 0);
  }

  closeBtn.addEventListener('click', closeModal);
  modal.addEventListener('mousedown', (ev) => { if (ev.target === modal) closeModal(); });
  modal.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { ev.preventDefault(); closeModal(); return; }
    if (ev.key === 'Tab') {
      const focusables = Array.from(dialog.querySelectorAll(focusableSelector))
        .filter(el => !el.hasAttribute('disabled') && el.offsetParent !== null);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
      else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
    }
  });

  composerDiffModal = {
    open: openModal,
    close: closeModal,
    activate: setActiveTab,
    modal,
    dialog,
    title,
    subtitle,
    views: { overview: viewOverview, entries: viewEntries, order: viewOrder },
    statsWrap,
    beforeList,
    afterList,
    svg,
    emptyNotice,
    tabsWrap
  };
  return composerDiffModal;
}

function drawOrderDiffLines() {
  if (!composerOrderState) return;
  const { container, svg, connectors, leftMap, rightMap } = composerOrderState;
  if (!container || !svg) return;
  const rect = container.getBoundingClientRect();
  const width = container.clientWidth;
  const height = Math.max(container.scrollHeight, rect.height);
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  const offsetX = rect.left;
  const offsetY = rect.top;
  const scrollTop = container.scrollTop || 0;

  let movedIdx = 0;
  connectors.forEach(info => {
    const leftEl = leftMap.get(info.key);
    const rightEl = rightMap.get(info.key);
    if (!leftEl || !rightEl) return;
    const lRect = leftEl.getBoundingClientRect();
    const rRect = rightEl.getBoundingClientRect();
    let startX = (lRect.right - offsetX);
    const startY = (lRect.top - offsetY) + (lRect.height / 2) + scrollTop;
    let endX = (rRect.left - offsetX);
    const endY = (rRect.top - offsetY) + (rRect.height / 2) + scrollTop;
    if (endX <= startX) {
      const mid = (startX + endX) / 2;
      startX = mid - 1;
      endX = mid + 1;
    }
    const curve = Math.max(36, (endX - startX) * 0.35);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', `M ${startX} ${startY} C ${startX + curve} ${startY}, ${endX - curve} ${endY}, ${endX} ${endY}`);
    path.classList.add('composer-order-path');
    path.dataset.status = info.status;
    if (info.status === 'same') {
      path.setAttribute('stroke', '#94a3b8');
    } else {
      const color = ORDER_LINE_COLORS[movedIdx % ORDER_LINE_COLORS.length];
      movedIdx += 1;
      path.setAttribute('stroke', color);
    }
    svg.appendChild(path);
  });
}




function scheduleAutoDraft(kind) {
  if (composerAutoSaveTimers[kind]) {
    clearTimeout(composerAutoSaveTimers[kind]);
    composerAutoSaveTimers[kind] = null;
  }
  const diff = composerDiffCache[kind];
  if (!diff || !diff.hasChanges) {
    clearDraftStorage(kind);
    updateUnsyncedSummary();
    return;
  }
  composerAutoSaveTimers[kind] = setTimeout(() => {
    composerAutoSaveTimers[kind] = null;
    saveDraftToStorage(kind, { manual: false });
  }, 800);
}

function saveDraftToStorage(kind, opts = {}) {
  const slice = getStateSlice(kind);
  if (!slice) return null;
  const snapshot = kind === 'tabs' ? prepareTabsState(slice) : prepareIndexState(slice);
  const store = readDraftStore();
  const savedAt = Date.now();
  const baseSignature = computeBaselineSignature(kind);
  store[kind] = { savedAt, data: snapshot, baseSignature };
  writeDraftStore(store);
  composerDraftMeta[kind] = { savedAt, baseSignature, lastManual: !!opts.manual };
  updateUnsyncedSummary();
  
  return composerDraftMeta[kind];
}

function clearDraftStorage(kind) {
  const store = readDraftStore();
  if (store && Object.prototype.hasOwnProperty.call(store, kind)) {
    delete store[kind];
    writeDraftStore(store);
  }
  composerDraftMeta[kind] = null;

}

function notifyComposerChange(kind, options = {}) {
  const diff = recomputeDiff(kind);
  if (kind === 'tabs') applyTabsDiffMarkers(diff);
  else applyIndexDiffMarkers(diff);
  updateFileDirtyBadge(kind);
  if (!options.skipAutoSave) scheduleAutoDraft(kind);

  updateUnsyncedSummary();
}

function rebuildIndexUI(preserveOpen = true) {
  const root = document.getElementById('composerIndex');
  if (!root) return;
  const openKeys = preserveOpen
    ? Array.from(root.querySelectorAll('.ci-item.is-open')).map(el => el.getAttribute('data-key')).filter(Boolean)
    : [];
  buildIndexUI(root, activeComposerState);
  openKeys.forEach(key => {
    if (!key) return;
    const row = root.querySelector(`.ci-item[data-key="${cssEscape(key)}"]`);
    if (!row) return;
    const body = row.querySelector('.ci-body');
    const btn = row.querySelector('.ci-expand');
    row.classList.add('is-open');
    if (body) {
      body.style.display = '';
      body.dataset.open = '1';
    }
    if (btn) btn.setAttribute('aria-expanded', 'true');
  });
  notifyComposerChange('index', { skipAutoSave: true });
  updateComposerMarkdownDraftIndicators();
}

function rebuildTabsUI(preserveOpen = true) {
  const root = document.getElementById('composerTabs');
  if (!root) return;
  const openKeys = preserveOpen
    ? Array.from(root.querySelectorAll('.ct-item.is-open')).map(el => el.getAttribute('data-key')).filter(Boolean)
    : [];
  buildTabsUI(root, activeComposerState);
  openKeys.forEach(key => {
    if (!key) return;
    const row = root.querySelector(`.ct-item[data-key="${cssEscape(key)}"]`);
    if (!row) return;
    const body = row.querySelector('.ct-body');
    const btn = row.querySelector('.ct-expand');
    row.classList.add('is-open');
    if (body) {
      body.style.display = '';
      body.dataset.open = '1';
    }
    if (btn) btn.setAttribute('aria-expanded', 'true');
  });
  notifyComposerChange('tabs', { skipAutoSave: true });
  updateComposerMarkdownDraftIndicators();
}

function loadDraftSnapshotsIntoState(state) {
  const restored = [];
  const store = readDraftStore();
  if (!store) return restored;
  ['index', 'tabs'].forEach(kind => {
    const entry = store[kind];
    if (!entry || !entry.data) return;
    const snapshot = kind === 'tabs'
      ? prepareTabsState(entry.data)
      : prepareIndexState(entry.data);
    if (kind === 'tabs') state.tabs = snapshot;
    else state.index = snapshot;
    setStateSlice(kind, snapshot);
    composerDraftMeta[kind] = {
      savedAt: Number(entry.savedAt) || Date.now(),
      baseSignature: entry.baseSignature ? String(entry.baseSignature) : '',
      lastManual: false
    };
    restored.push(kind);
  });
  return restored;
}



async function handleComposerRefresh(btn) {
  const target = getActiveComposerFile();
  const button = btn;
  const resetButton = () => {
    if (!button) return;
    button.disabled = false;
    button.classList.remove('is-busy');
    button.removeAttribute('aria-busy');
    button.textContent = 'Refresh';
  };
  try {
    if (button) {
      button.disabled = true;
      button.classList.add('is-busy');
      button.setAttribute('aria-busy', 'true');
      button.textContent = 'Refreshing…';
    }
    const contentRoot = getContentRootSafe();
    const remote = await fetchConfigWithYamlFallback([
      `${contentRoot}/${target === 'tabs' ? 'tabs' : 'index'}.yaml`,
      `${contentRoot}/${target === 'tabs' ? 'tabs' : 'index'}.yml`
    ]);
    const prepared = target === 'tabs' ? prepareTabsState(remote || {}) : prepareIndexState(remote || {});
    const baselineSignatureBefore = computeBaselineSignature(target);
    remoteBaseline[target] = prepared;
    const diffBefore = composerDiffCache[target];
    const hadLocalChanges = diffBefore && diffBefore.hasChanges;
    if (!hadLocalChanges) {
      setStateSlice(target, deepClone(prepared));
      if (target === 'tabs') rebuildTabsUI();
      else rebuildIndexUI();
      showStatus(`${target === 'tabs' ? 'tabs' : 'index'}.yaml refreshed from remote`);
    } else {
      notifyComposerChange(target, { skipAutoSave: true });
      const baselineSignatureAfter = computeBaselineSignature(target);
      if (baselineSignatureAfter !== baselineSignatureBefore) {
        showStatus('Remote snapshot updated. Highlights now include remote differences.');
      } else {
        showStatus('Remote snapshot unchanged.');
      }
    }
  } catch (err) {
    console.error('Refresh failed', err);
    showStatus('Failed to refresh remote snapshot');
  } finally {
    resetButton();
    setTimeout(() => { showStatus(''); }, 2000);
  }
}

let discardConfirmElements = null;
let discardConfirmActiveClose = null;
let discardConfirmHideTimer = null;

function ensureComposerDiscardConfirmElements() {
  if (discardConfirmElements) return discardConfirmElements;
  if (typeof document === 'undefined') return null;
  const popover = document.createElement('div');
  popover.className = 'composer-confirm-popover';
  popover.id = 'composerDiscardConfirm';
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-modal', 'false');
  popover.hidden = true;

  const message = document.createElement('div');
  message.className = 'composer-confirm-message';
  message.id = 'composerDiscardConfirmMessage';
  popover.setAttribute('aria-labelledby', message.id);
  popover.appendChild(message);

  const actions = document.createElement('div');
  actions.className = 'composer-confirm-actions';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn-secondary composer-confirm-cancel';
  cancelBtn.textContent = 'Cancel';

  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.className = 'btn-secondary composer-confirm-confirm';
  confirmBtn.textContent = 'Confirm';

  actions.append(cancelBtn, confirmBtn);
  popover.appendChild(actions);

  document.body.appendChild(popover);
  discardConfirmElements = { popover, message, cancelBtn, confirmBtn };
  return discardConfirmElements;
}

function showComposerDiscardConfirm(anchor, messageText, options) {
  const elements = ensureComposerDiscardConfirmElements();
  if (!elements) return Promise.resolve(true);
  const { popover, message, cancelBtn, confirmBtn } = elements;
  const confirmLabel = options && options.confirmLabel ? String(options.confirmLabel) : 'Confirm';
  const cancelLabel = options && options.cancelLabel ? String(options.cancelLabel) : 'Cancel';

  message.textContent = String(messageText || '');
  cancelBtn.textContent = cancelLabel;
  confirmBtn.textContent = confirmLabel;

  if (anchor && typeof anchor.setAttribute === 'function') {
    anchor.setAttribute('aria-haspopup', 'dialog');
    anchor.setAttribute('aria-controls', popover.id);
  }

  if (typeof discardConfirmActiveClose === 'function') {
    try { discardConfirmActiveClose(false); } catch (_) {}
  }

  if (discardConfirmHideTimer) {
    window.clearTimeout(discardConfirmHideTimer);
    discardConfirmHideTimer = null;
  }

  popover.hidden = false;
  popover.style.visibility = 'hidden';
  popover.classList.remove('is-visible');
  popover.dataset.placement = 'bottom';

  return new Promise((resolve) => {
    let closed = false;

    const finish = (result) => {
      if (closed) return;
      closed = true;
      discardConfirmActiveClose = null;

      popover.classList.remove('is-visible');
      popover.style.visibility = 'hidden';
      if (discardConfirmHideTimer) {
        window.clearTimeout(discardConfirmHideTimer);
        discardConfirmHideTimer = null;
      }
      discardConfirmHideTimer = window.setTimeout(() => {
        popover.hidden = true;
        popover.style.visibility = '';
        popover.style.left = '';
        popover.style.top = '';
        discardConfirmHideTimer = null;
      }, 200);

      cancelBtn.removeEventListener('click', onCancel);
      confirmBtn.removeEventListener('click', onConfirm);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('mousedown', onOutside, true);
      document.removeEventListener('touchstart', onOutside, true);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);

      if (anchor && typeof anchor.setAttribute === 'function') {
        anchor.setAttribute('aria-expanded', 'false');
      }

      if (!result && anchor && typeof anchor.focus === 'function') {
        window.setTimeout(() => {
          try { anchor.focus({ preventScroll: true }); } catch (_) {}
        }, 120);
      }

      resolve(!!result);
    };

    const onCancel = (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      finish(false);
    };
    const onConfirm = (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      finish(true);
    };
    const onOutside = (event) => {
      const target = event && event.target;
      if (!target) return;
      if (popover.contains(target) || target === anchor) return;
      finish(false);
    };
    const onKeyDown = (event) => {
      if (!event) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
        return;
      }
      if (event.key === 'Tab') {
        const focusables = [cancelBtn, confirmBtn];
        const active = document.activeElement;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (event.shiftKey) {
          if (active === first || !focusables.includes(active)) {
            event.preventDefault();
            if (last) last.focus({ preventScroll: true });
          }
        } else {
          if (active === last) {
            event.preventDefault();
            if (first) first.focus({ preventScroll: true });
          } else if (!focusables.includes(active)) {
            event.preventDefault();
            if (first) first.focus({ preventScroll: true });
          }
        }
      }
    };

    const reposition = () => {
      if (closed) return;
      if (!anchor || !popover.isConnected) {
        finish(false);
        return;
      }
      if (typeof anchor.getBoundingClientRect !== 'function') {
        finish(false);
        return;
      }
      const rect = anchor.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        finish(false);
        return;
      }
      const scrollX = window.scrollX || window.pageXOffset || 0;
      const scrollY = window.scrollY || window.pageYOffset || 0;
      const viewportWidth = document.documentElement && document.documentElement.clientWidth
        ? document.documentElement.clientWidth
        : (window.innerWidth || 0);
      const viewportHeight = document.documentElement && document.documentElement.clientHeight
        ? document.documentElement.clientHeight
        : (window.innerHeight || 0);
      const margin = 12;
      const width = popover.offsetWidth;
      const height = popover.offsetHeight;

      let left = scrollX + rect.right - width;
      const minLeft = scrollX + margin;
      const maxLeft = scrollX + Math.max(margin, viewportWidth - margin - width);
      if (left < minLeft) left = minLeft;
      if (left > maxLeft) left = maxLeft;

      let placement = 'bottom';
      let top = scrollY + rect.bottom + 12;
      const viewportBottom = scrollY + viewportHeight;
      const fitsBelow = top + height <= viewportBottom - margin;
      if (!fitsBelow && rect.top >= height + margin) {
        placement = 'top';
        top = scrollY + rect.top - height - 12;
      } else if (!fitsBelow) {
        top = Math.max(scrollY + margin, viewportBottom - height - margin);
      }
      if (placement === 'bottom') {
        top = Math.max(top, scrollY + rect.bottom + 4);
      } else {
        top = Math.min(top, scrollY + rect.top - 4);
      }

      popover.dataset.placement = placement;
      popover.style.left = `${Math.round(left)}px`;
      popover.style.top = `${Math.round(top)}px`;
    };

    cancelBtn.addEventListener('click', onCancel);
    confirmBtn.addEventListener('click', onConfirm);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('touchstart', onOutside, true);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);

    discardConfirmActiveClose = finish;

    const runShow = () => {
      if (closed) return;
      reposition();
      if (closed) return;
      popover.style.visibility = '';
      popover.classList.add('is-visible');
      if (anchor && typeof anchor.setAttribute === 'function') {
        anchor.setAttribute('aria-expanded', 'true');
      }
      try { confirmBtn.focus({ preventScroll: true }); } catch (_) {}
    };
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(runShow);
    } else {
      runShow();
    }
  });
}

async function handleComposerDiscard(btn) {
  const target = getActiveComposerFile();
  const label = target === 'tabs' ? 'tabs.yaml' : 'index.yaml';
  const diff = composerDiffCache[target];
  const meta = composerDraftMeta[target];
  const hasChanges = !!(diff && diff.hasChanges);
  const hasDraft = !!meta;
  if (!hasChanges && !hasDraft) {
    return;
  }

  const promptMessage = `Discard local changes for ${label} and reload the remote file? This action cannot be undone.`;
  let proceed = true;
  try {
    proceed = await showComposerDiscardConfirm(btn, promptMessage, { confirmLabel: 'Confirm', cancelLabel: 'Cancel' });
  } catch (err) {
    console.warn('Custom discard prompt failed, falling back to native confirm', err);
    try {
      if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
        proceed = window.confirm(promptMessage);
      }
    } catch (_) {
      proceed = true;
    }
  }
  if (!proceed) return;

  const button = btn;
  const resetButton = () => {
    if (!button) return;
    button.disabled = false;
    button.classList.remove('is-busy');
    button.removeAttribute('aria-busy');
    button.textContent = 'Discard';
  };

  try {
    if (button) {
      button.disabled = true;
      button.classList.add('is-busy');
      button.setAttribute('aria-busy', 'true');
      button.textContent = 'Discarding…';
    }

    let prepared = null;
    let fetchedFresh = false;
    try {
      const contentRoot = getContentRootSafe();
      const remote = await fetchConfigWithYamlFallback([
        `${contentRoot}/${target === 'tabs' ? 'tabs' : 'index'}.yaml`,
        `${contentRoot}/${target === 'tabs' ? 'tabs' : 'index'}.yml`
      ]);
      if (remote != null) {
        prepared = target === 'tabs' ? prepareTabsState(remote) : prepareIndexState(remote);
        fetchedFresh = true;
      }
    } catch (err) {
      console.warn('Discard: failed to fetch fresh remote snapshot', err);
    }

    if (!prepared) {
      const baseline = remoteBaseline[target];
      prepared = baseline ? deepClone(baseline) : { __order: [] };
    }

    const normalized = deepClone(prepared);
    remoteBaseline[target] = deepClone(prepared);
    setStateSlice(target, normalized);

    if (composerAutoSaveTimers[target]) {
      clearTimeout(composerAutoSaveTimers[target]);
      composerAutoSaveTimers[target] = null;
    }

    if (target === 'tabs') rebuildTabsUI();
    else rebuildIndexUI();

    clearDraftStorage(target);

    const msg = fetchedFresh
      ? `Discarded local changes; loaded fresh ${label}`
      : `Discarded local changes; restored ${label} from cached snapshot`;
    showStatus(msg);
    setTimeout(() => { showStatus(''); }, 2000);
  } catch (err) {
    console.error('Discard failed', err);
    showStatus('Failed to discard local changes');
    setTimeout(() => { showStatus(''); }, 2000);
  } finally {
    resetButton();
  }
}

function getPrimaryEditorApi() {
  try {
    const api = window.__ns_primary_editor;
    return api && typeof api === 'object' ? api : null;
  } catch (_) {
    return null;
  }
}

function ensurePrimaryEditorListener() {
  if (detachPrimaryEditorListener) return;
  const api = getPrimaryEditorApi();
  if (!api || typeof api.onChange !== 'function') return;
  detachPrimaryEditorListener = api.onChange((value) => {
    if (!activeDynamicMode) return;
    const tab = dynamicEditorTabs.get(activeDynamicMode);
    if (tab) {
      tab.content = value;
      updateDynamicTabDirtyState(tab);
    }
  });
}

function normalizeRelPath(path) {
  const raw = String(path || '').trim();
  if (!raw) return '';
  const cleaned = raw
    .replace(/[\\]/g, '/')
    .replace(/^\//, '')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/');
  const parts = cleaned.split('/');
  const stack = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (stack.length) stack.pop();
      continue;
    }
    stack.push(part);
  }
  return stack.join('/');
}

function basenameFromPath(relPath) {
  const norm = normalizeRelPath(relPath);
  if (!norm) return '';
  const idx = norm.lastIndexOf('/');
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

function dirnameFromPath(relPath) {
  const norm = normalizeRelPath(relPath);
  if (!norm) return '';
  const idx = norm.lastIndexOf('/');
  if (idx <= 0) return '';
  return norm.slice(0, idx);
}

function getContentRootSafe() {
  try {
    const root = window.__ns_content_root;
    if (root && typeof root === 'string' && root.trim()) {
      return root.trim().replace(/[\\]/g, '/').replace(/\/?$/, '');
    }
  } catch (_) {}
  return 'wwwroot';
}

function computeBaseDirForPath(relPath) {
  const root = getContentRootSafe();
  const rel = normalizeRelPath(relPath);
  const idx = rel.lastIndexOf('/');
  const dir = idx >= 0 ? rel.slice(0, idx + 1) : '';
  const base = `${root}/${dir}`.replace(/[\\]/g, '/');
  return base.endsWith('/') ? base : `${base}/`;
}

function encodeGitHubPath(path) {
  const clean = String(path || '')
    .replace(/[\\]/g, '/')
    .replace(/^\/+/g, '')
    .replace(/\/+/g, '/')
    .replace(/\/?$/, '');
  if (!clean) return '';
  return clean.split('/').map(part => encodeURIComponent(part)).join('/');
}

function isDynamicMode(mode) {
  return !!(mode && dynamicEditorTabs.has(mode));
}

function getActiveDynamicTab() {
  if (!activeDynamicMode) return null;
  const tab = dynamicEditorTabs.get(activeDynamicMode);
  return tab || null;
}

function persistDynamicEditorState() {
  if (!allowEditorStatePersist) return;
  try {
    const store = window.localStorage;
    if (!store) return;
    const open = Array.from(dynamicEditorTabs.values())
      .map((tab) => (tab && tab.path) ? tab.path : '')
      .filter(Boolean);
    const state = { v: 1, open };
    if (currentMode === 'editor') state.mode = 'editor';
    else if (currentMode && isDynamicMode(currentMode)) {
      const active = dynamicEditorTabs.get(currentMode);
      state.mode = 'dynamic';
      state.activePath = active && active.path ? active.path : null;
    } else {
      state.mode = 'composer';
    }
    if (!open.length && state.mode === 'composer') store.removeItem(LS_KEYS.editorState);
    else store.setItem(LS_KEYS.editorState, JSON.stringify(state));
  } catch (_) {}
}

function restoreDynamicEditorState() {
  let raw = null;
  try {
    const store = window.localStorage;
    if (!store) return;
    raw = store.getItem(LS_KEYS.editorState);
  } catch (_) {
    return;
  }
  if (!raw) return;
  let data;
  try { data = JSON.parse(raw); }
  catch (_) { return; }
  if (!data || typeof data !== 'object') return;

  const open = Array.isArray(data.open) ? data.open : [];
  const seen = new Set();
  open.forEach((item) => {
    const norm = normalizeRelPath(item);
    if (!norm || seen.has(norm)) return;
    seen.add(norm);
    getOrCreateDynamicMode(norm);
  });

  const mode = (data.mode === 'editor' || data.mode === 'dynamic') ? data.mode : 'composer';
  const activePath = data.activePath ? normalizeRelPath(data.activePath) : '';

  if (mode === 'dynamic' && activePath) {
    const modeId = dynamicEditorTabsByPath.get(activePath);
    if (modeId) {
      applyMode(modeId);
      return;
    }
  }

  if (mode === 'editor') applyMode('editor');
}

function setTabLoadingState(tab, isLoading) {
  if (!tab || !tab.button) return;
  try {
    tab.button.classList.toggle('is-busy', !!isLoading);
    if (isLoading) tab.button.setAttribute('data-loading', '1');
    else tab.button.removeAttribute('data-loading');
    tab.button.setAttribute('aria-busy', isLoading ? 'true' : 'false');
  } catch (_) {}
}

const TAB_STATE_VALUES = new Set(['checking', 'existing', 'missing', 'error']);

function updateMarkdownPushButton(tab) {
  if (!markdownPushButton) {
    markdownPushButton = document.getElementById('btnPushMarkdown');
  }
  if (!markdownPushButton) return;

  const btn = markdownPushButton;
  const repo = window.__ns_site_repo || {};
  const owner = String(repo.owner || '').trim();
  const name = String(repo.name || '').trim();
  const hasRepo = !!(owner && name);

  const active = (tab && tab.mode && tab.mode === currentMode) ? tab : getActiveDynamicTab();
  const hasDraftContent = !!(active && active.localDraft && normalizeMarkdownContent(active.localDraft.content || ''));
  const hasDirty = !!(active && active.isDirty);
  const hasLocalChanges = !!(active && active.path && (hasDirty || hasDraftContent));

  if (!hasLocalChanges) {
    try { btn.classList.remove('is-busy'); } catch (_) {}
    btn.hidden = true;
    btn.setAttribute('aria-hidden', 'true');
    btn.disabled = true;
    btn.setAttribute('aria-disabled', 'true');
    btn.removeAttribute('aria-busy');
    btn.removeAttribute('data-state');
    btn.removeAttribute('title');
    return;
  }

  btn.hidden = false;
  btn.removeAttribute('aria-hidden');
  btn.removeAttribute('aria-busy');

  const state = active && active.fileStatus && active.fileStatus.state
    ? String(active.fileStatus.state)
    : '';

  let label = MARKDOWN_PUSH_LABELS.default;
  if (state === 'missing') label = MARKDOWN_PUSH_LABELS.create;
  else if (state) label = MARKDOWN_PUSH_LABELS.update;
  else if (active && active.path) label = MARKDOWN_PUSH_LABELS.update;

  let disabled = false;
  let tooltip = '';

  if (!hasRepo) {
    disabled = true;
    tooltip = 'Configure repo in site.yaml to enable GitHub push.';
  } else if (!active || !active.path) {
    disabled = true;
    tooltip = 'Open a markdown file to enable GitHub push.';
  } else if (state === 'error') {
    disabled = true;
    tooltip = 'Resolve file load error before pushing to GitHub.';
  } else if (!active.loaded) {
    tooltip = active.pending ? 'Checking remote version…' : 'Loading remote snapshot…';
  } else {
    tooltip = state === 'missing'
      ? 'Copy draft and create this file on GitHub.'
      : 'Copy draft and update this file on GitHub.';
  }

  const busy = btn.classList.contains('is-busy');
  if (busy) disabled = true;

  btn.disabled = disabled;
  btn.setAttribute('aria-disabled', disabled ? 'true' : 'false');
  if (!busy && label) setButtonLabel(btn, label);
  if (tooltip) btn.title = tooltip;
  else btn.removeAttribute('title');
  btn.setAttribute('aria-label', tooltip || label);

  if (state) btn.setAttribute('data-state', state);
  else btn.removeAttribute('data-state');
}

function updateMarkdownDiscardButton(tab) {
  if (!markdownDiscardButton) {
    markdownDiscardButton = document.getElementById('btnDiscardMarkdown');
  }
  if (!markdownDiscardButton) return;

  const btn = markdownDiscardButton;
  const active = (tab && tab.mode && tab.mode === currentMode) ? tab : getActiveDynamicTab();
  const hasBusy = btn.classList.contains('is-busy');

  const hasDraftContent = !!(active && active.localDraft && normalizeMarkdownContent(active.localDraft.content || ''));
  const dirty = !!(active && active.isDirty);
  const hasLocalChanges = !!(active && active.path && active.mode === currentMode && (dirty || hasDraftContent));

  if (!hasLocalChanges) {
    if (!hasBusy) setButtonLabel(btn, MARKDOWN_DISCARD_LABEL);
    try { btn.classList.remove('is-busy'); } catch (_) {}
    btn.hidden = true;
    btn.setAttribute('aria-hidden', 'true');
    btn.disabled = true;
    btn.setAttribute('aria-disabled', 'true');
    btn.removeAttribute('aria-busy');
    btn.removeAttribute('title');
    btn.setAttribute('aria-label', MARKDOWN_DISCARD_LABEL);
    return;
  }

  btn.hidden = false;
  btn.removeAttribute('aria-hidden');
  btn.removeAttribute('aria-busy');

  let disabled = false;
  let tooltip = 'Discard local markdown changes and restore the last loaded version.';

  if (!active || !active.path) {
    disabled = true;
    tooltip = 'Open a markdown file to discard local changes.';
  } else if (!active.loaded && !active.pending) {
    tooltip = 'Discard local markdown changes (remote snapshot will be reloaded).';
  }

  if (hasBusy) disabled = true;

  btn.disabled = disabled;
  btn.setAttribute('aria-disabled', disabled ? 'true' : 'false');
  if (!hasBusy) setButtonLabel(btn, MARKDOWN_DISCARD_LABEL);
  if (tooltip) btn.title = tooltip;
  else btn.removeAttribute('title');
  btn.setAttribute('aria-label', tooltip || MARKDOWN_DISCARD_LABEL);
}

async function openMarkdownPushOnGitHub(tab) {
  if (!tab || !tab.path) {
    showToast('info', 'Open a markdown file before pushing to GitHub.');
    return;
  }

  const repo = window.__ns_site_repo || {};
  const owner = String(repo.owner || '').trim();
  const name = String(repo.name || '').trim();
  if (!owner || !name) {
    showToast('info', 'Configure repo in site.yaml to enable GitHub push.');
    return;
  }

  try {
    if (tab.pending) {
      await tab.pending;
    } else if (!tab.loaded) {
      await loadDynamicTabContent(tab);
    }
  } catch (err) {
    console.error('Failed to prepare markdown before pushing to GitHub', err);
    showToast('error', 'Unable to load the latest markdown before pushing.');
    updateMarkdownPushButton(tab);
    return;
  }

  if (!tab.loaded) {
    showToast('error', 'Markdown file is not ready to push yet.');
    return;
  }

  const branch = String(repo.branch || 'main').trim() || 'main';
  const root = getContentRootSafe();
  const rel = normalizeRelPath(tab.path);
  if (!rel) {
    showToast('error', 'Invalid markdown path.');
    return;
  }

  const contentPath = `${root}/${rel}`.replace(/[\\]+/g, '/').replace(/^\/+/g, '');
  const encodedContentPath = encodeGitHubPath(contentPath);
  const folder = dirnameFromPath(rel);
  const fullFolder = [root, folder].filter(Boolean).join('/');
  const encodedFolder = encodeGitHubPath(fullFolder);
  const filename = basenameFromPath(rel) || 'main.md';

  const base = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const branchPart = encodeURIComponent(branch);
  const remoteState = tab.fileStatus && tab.fileStatus.state ? String(tab.fileStatus.state) : '';
  const isCreate = remoteState === 'missing';

  let href = '';
  if (isCreate) {
    href = encodedFolder
      ? `${base}/new/${branchPart}/${encodedFolder}?filename=${encodeURIComponent(filename)}`
      : `${base}/new/${branchPart}?filename=${encodeURIComponent(filename)}`;
  } else {
    href = encodedContentPath
      ? `${base}/edit/${branchPart}/${encodedContentPath}`
      : `${base}/edit/${branchPart}`;
  }

  if (!href) {
    showToast('error', 'Unable to resolve GitHub URL for this file.');
    return;
  }

  const editorApi = getPrimaryEditorApi();
  if (editorApi && typeof editorApi.getValue === 'function' && currentMode === tab.mode) {
    try { tab.content = String(editorApi.getValue() || ''); }
    catch (_) {}
  }

  try { nsCopyToClipboard(tab.content != null ? String(tab.content) : ''); }
  catch (_) {}

  try {
    window.open(href, '_blank', 'noopener');
  } catch (_) {
    try { window.location.href = href; }
    catch (__) {}
  }

  const message = isCreate
    ? 'Markdown copied. GitHub will open to create this file.'
    : 'Markdown copied. GitHub will open to update this file.';
  showToast('info', message);

  updateMarkdownPushButton(tab);
}

async function discardMarkdownLocalChanges(tab, anchor) {
  const active = (tab && tab.path) ? tab : getActiveDynamicTab();
  if (!active || !active.path) {
    showToast('info', 'Open a markdown file before discarding local changes.');
    updateMarkdownDiscardButton(null);
    return;
  }

  flushMarkdownDraft(active);
  const hasDraftContent = !!(active.localDraft && normalizeMarkdownContent(active.localDraft.content || ''));
  const dirty = !!active.isDirty;
  if (!dirty && !hasDraftContent) {
    showToast('info', 'No local markdown changes to discard.');
    updateMarkdownDiscardButton(active);
    return;
  }

  const label = active.path || 'current file';
  const trigger = anchor && typeof anchor.closest === 'function' ? anchor.closest('button') : anchor;
  const control = trigger || markdownDiscardButton;
  const promptMessage = `Discard local changes for ${label}? This action cannot be undone.`;

  let proceed = true;
  try {
    proceed = await showComposerDiscardConfirm(control, promptMessage, { confirmLabel: 'Discard', cancelLabel: 'Cancel' });
  } catch (err) {
    console.warn('Markdown discard prompt failed, falling back to native confirm', err);
    try {
      if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
        proceed = window.confirm(promptMessage);
      }
    } catch (_) {
      proceed = true;
    }
  }
  if (!proceed) return;

  const button = control || markdownDiscardButton;
  const originalLabel = getButtonLabel(button) || MARKDOWN_DISCARD_LABEL;
  const setBusyState = (busy, text) => {
    if (!button) return;
    if (busy) {
      button.classList.add('is-busy');
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      button.setAttribute('aria-disabled', 'true');
      if (text) setButtonLabel(button, text);
    } else {
      button.classList.remove('is-busy');
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.setAttribute('aria-disabled', 'false');
      if (text) setButtonLabel(button, text);
    }
  };

  setBusyState(true, 'Discarding…');

  try {
    if (active.pending) {
      try { await active.pending; }
      catch (_) {}
    } else if (!active.loaded) {
      try { await loadDynamicTabContent(active); }
      catch (err) { console.warn('Discard: failed to refresh markdown before reset', err); }
    }

    try {
      if (active.markdownDraftTimer) {
        clearTimeout(active.markdownDraftTimer);
        active.markdownDraftTimer = null;
      }
    } catch (_) {}

    const baseline = normalizeMarkdownContent(active.remoteContent != null ? active.remoteContent : '');
    active.content = baseline;
    clearMarkdownDraftForTab(active);
    active.isDirty = false;
    active.draftConflict = false;

    const editorApi = getPrimaryEditorApi();
    if (editorApi && currentMode === active.mode) {
      editorApi.setValue(baseline, { notify: true });
      try { editorApi.focus(); } catch (_) {}
    } else {
      updateDynamicTabDirtyState(active, { autoSave: false });
    }

    showToast('success', `Discarded local changes for ${label}.`);
  } catch (err) {
    console.error('Failed to discard markdown changes', err);
    showToast('error', 'Failed to discard local markdown changes.');
  } finally {
    setBusyState(false, originalLabel || MARKDOWN_DISCARD_LABEL);
    updateMarkdownDiscardButton(active);
    updateMarkdownPushButton(active);
  }
}

function pushEditorCurrentFileInfo(tab) {
  const editorApi = getPrimaryEditorApi();
  if (!editorApi || typeof editorApi.setCurrentFileLabel !== 'function') return;
  const payload = tab
    ? {
        path: tab.path || '',
        status: tab.fileStatus || null,
        dirty: !!tab.isDirty,
        loaded: !!tab.loaded,
        draft: tab.localDraft
          ? {
              savedAt: Number(tab.localDraft.savedAt) || Date.now(),
              conflict: !!tab.draftConflict,
              hasContent: true,
              remoteSignature: tab.localDraft.remoteSignature || ''
            }
          : null
      }
    : { path: '', status: null, dirty: false, draft: null };
  try { editorApi.setCurrentFileLabel(payload); }
  catch (_) {}
  const activeTab = (tab && tab.mode && tab.mode === currentMode) ? tab : getActiveDynamicTab();
  updateMarkdownPushButton(activeTab);
  updateMarkdownDiscardButton(activeTab);
}

function setDynamicTabStatus(tab, status) {
  if (!tab) return;
  const next = status && typeof status === 'object' ? { ...status } : {};
  const rawState = String(next.state || '').trim().toLowerCase();
  const state = TAB_STATE_VALUES.has(rawState) ? rawState : '';
  let checkedAt = next.checkedAt;
  if (checkedAt instanceof Date) checkedAt = checkedAt.getTime();
  if (checkedAt != null && !Number.isFinite(checkedAt)) checkedAt = Number(checkedAt);
  if (Number.isFinite(checkedAt)) checkedAt = Math.max(0, Math.floor(checkedAt));
  else checkedAt = null;

  const normalized = {
    state,
    checkedAt,
  };
  if (next.message) normalized.message = String(next.message || '');
  if (next.code != null) normalized.code = Number(next.code);

  tab.fileStatus = normalized;

  const btn = tab.button;
  if (btn) {
    if (state) btn.setAttribute('data-file-state', state);
    else btn.removeAttribute('data-file-state');
    if (checkedAt != null) btn.setAttribute('data-checked-at', String(checkedAt));
    else btn.removeAttribute('data-checked-at');
  }

  if (currentMode === tab.mode) pushEditorCurrentFileInfo(tab);
}

async function closeDynamicTab(modeId, options = {}) {
  const tab = dynamicEditorTabs.get(modeId);
  if (!tab) return false;

  const opts = options && typeof options === 'object' ? options : {};
  const hasLocalDraft = !!(tab.localDraft && normalizeMarkdownContent(tab.localDraft.content || ''));
  const hasDirty = !!tab.isDirty;

  const resolveAnchor = (candidate) => {
    if (!candidate) return null;
    if (typeof candidate.getBoundingClientRect === 'function') return candidate;
    if (typeof candidate.closest === 'function') {
      const btnEl = candidate.closest('button');
      if (btnEl && typeof btnEl.getBoundingClientRect === 'function') return btnEl;
    }
    return null;
  };

  let anchorEl = resolveAnchor(opts.anchor);
  if (!anchorEl && tab.button && typeof tab.button.getBoundingClientRect === 'function') {
    anchorEl = tab.button;
  }

  if (!opts.force && (hasDirty || hasLocalDraft)) {
    const ref = tab.path || tab.label || 'this file';
    const promptMessage = `Close ${ref}? Closing this tab will discard local markdown changes.`;
    let proceed = true;
    const runNativeConfirm = () => {
      try {
        if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
          return window.confirm(promptMessage);
        }
      } catch (_) {
        return true;
      }
      return true;
    };

    if (anchorEl) {
      try {
        proceed = await showComposerDiscardConfirm(anchorEl, promptMessage, { confirmLabel: 'Discard', cancelLabel: 'Cancel' });
      } catch (err) {
        console.warn('Markdown tab close prompt failed, falling back to native confirm', err);
        proceed = runNativeConfirm();
      }
    } else {
      proceed = runNativeConfirm();
    }

    if (!proceed) return false;
  }

  clearMarkdownDraftForTab(tab);

  dynamicEditorTabs.delete(modeId);
  if (tab.path) dynamicEditorTabsByPath.delete(tab.path);
  try { tab.button?.remove(); } catch (_) {}

  const wasActive = (currentMode === modeId);
  if (activeDynamicMode === modeId) activeDynamicMode = null;

  if (!dynamicEditorTabs.size && detachPrimaryEditorListener) {
    try { detachPrimaryEditorListener(); } catch (_) {}
    detachPrimaryEditorListener = null;
  }

  if (wasActive) {
    const remainingModes = Array.from(dynamicEditorTabs.keys());
    const fallbackMode = remainingModes.length ? remainingModes[remainingModes.length - 1] : 'composer';
    applyMode(fallbackMode);
  } else {
    persistDynamicEditorState();
  }
  updateMarkdownPushButton(getActiveDynamicTab());
  updateMarkdownDiscardButton(getActiveDynamicTab());
  updateComposerMarkdownDraftIndicators({ path: tab.path });
  return true;
}

function getOrCreateDynamicMode(path) {
  const normalized = normalizeRelPath(path);
  if (!normalized) return null;
  const existing = dynamicEditorTabsByPath.get(normalized);
  if (existing) return existing;

  const nav = $('.mode-switch');
  if (!nav) return null;

  dynamicTabCounter += 1;
  const modeId = `editor-tab-${dynamicTabCounter}`;
  const label = basenameFromPath(normalized) || normalized;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'mode-tab dynamic-mode';
  btn.dataset.mode = modeId;
  btn.dataset.path = normalized;
  btn.setAttribute('role', 'tab');
  btn.setAttribute('aria-controls', 'mode-editor');
  btn.setAttribute('aria-selected', 'false');
  btn.setAttribute('aria-label', `Open editor for ${normalized}`);
  const chip = document.createElement('span');
  chip.className = 'mode-tab-chip';

  const labelEl = document.createElement('span');
  labelEl.className = 'mode-tab-label';
  labelEl.textContent = label;
  chip.appendChild(labelEl);

  const closeEl = document.createElement('span');
  closeEl.className = 'mode-tab-close';
  closeEl.setAttribute('aria-hidden', 'true');
  closeEl.textContent = '×';
  chip.appendChild(closeEl);

  btn.appendChild(chip);
  nav.appendChild(btn);

  const data = {
    mode: modeId,
    path: normalized,
    button: btn,
    label,
    baseDir: computeBaseDirForPath(normalized),
    content: '',
    remoteContent: '',
    remoteSignature: '',
    loaded: false,
    pending: null,
    fileStatus: null,
    localDraft: null,
    draftConflict: false,
    markdownDraftTimer: null,
    isDirty: false
  };
  restoreMarkdownDraftForTab(data);
  dynamicEditorTabs.set(modeId, data);
  dynamicEditorTabsByPath.set(normalized, modeId);

  btn.addEventListener('click', (event) => {
    const target = event.target;
    if (target && target.closest && target.closest('.mode-tab-close')) {
      event.preventDefault();
      event.stopPropagation();
      const anchor = (target.closest && target.closest('button')) || btn;
      closeDynamicTab(modeId, { anchor }).catch((err) => {
        console.warn('Failed to close markdown tab', err);
      });
      return;
    }
    applyMode(modeId);
  });

  btn.addEventListener('keydown', (event) => {
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      closeDynamicTab(modeId, { anchor: btn }).catch((err) => {
        console.warn('Failed to close markdown tab', err);
      });
    }
  });

  loadDynamicTabContent(data).catch(() => {});

  persistDynamicEditorState();
  return modeId;
}

async function loadDynamicTabContent(tab) {
  if (!tab) return '';
  if (tab.loaded && typeof tab.content === 'string') return tab.content;
  if (tab.pending) return tab.pending;

  const root = getContentRootSafe();
  const rel = normalizeRelPath(tab.path);
  if (!rel) throw new Error('Invalid markdown path');
  const url = `${root}/${rel}`.replace(/[\\]/g, '/');

  const runner = async () => {
    setDynamicTabStatus(tab, { state: 'checking', checkedAt: Date.now(), message: 'Checking file…' });

    let res;
    try {
      res = await fetch(url, { cache: 'no-store' });
    } catch (err) {
      setDynamicTabStatus(tab, {
        state: 'error',
        checkedAt: Date.now(),
        message: err && err.message ? err.message : 'Network error'
      });
      throw err;
    }

    const checkedAt = Date.now();

    if (res.status === 404) {
      tab.remoteContent = '';
      tab.remoteSignature = computeTextSignature('');
      tab.loaded = true;
      if (!tab.localDraft || !tab.localDraft.content) tab.content = '';
      setDynamicTabStatus(tab, {
        state: 'missing',
        checkedAt,
        message: 'File not found on server',
        code: 404
      });
      updateDynamicTabDirtyState(tab, { autoSave: !tab.localDraft });
      return tab.content;
    }

    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      setDynamicTabStatus(tab, {
        state: 'error',
        checkedAt,
        message: err.message || `HTTP ${res.status}`,
        code: res.status
      });
      throw err;
    }

    const text = normalizeMarkdownContent(await res.text());
    tab.remoteContent = text;
    tab.remoteSignature = computeTextSignature(text);
    tab.loaded = true;
    if (!tab.localDraft || !tab.localDraft.content) {
      tab.content = text;
    }
    setDynamicTabStatus(tab, {
      state: 'existing',
      checkedAt,
      code: res.status
    });
    updateDynamicTabDirtyState(tab, { autoSave: !tab.localDraft });
    return tab.content;
  };

  tab.pending = runner().finally(() => {
    tab.pending = null;
  });

  return tab.pending;
}

function openMarkdownInEditor(path) {
  const modeId = getOrCreateDynamicMode(path);
  if (!modeId) {
    alert('Unable to open editor tab.');
    return;
  }
  applyMode(modeId);
}

// Default Markdown template for new post files (index.yaml related flows)
function makeDefaultMdTemplate(opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; // local date
  const lines = [
    '---',
    'title: ',
    `date: ${dateStr}`,
  ];
  if (options.version) lines.push(`version: ${String(options.version)}`);
  lines.push(
    'tags: ',
    'excerpt: ',
    'author: ',
    'ai: false',
    'draft: true',
    '---',
    ''
  );
  return lines.join('\n');
}

function applyMode(mode) {
  const candidate = mode || 'composer';
  const nextMode = (candidate === 'composer' || candidate === 'editor' || isDynamicMode(candidate))
    ? candidate
    : 'composer';

  const previousMode = currentMode;
  if (previousMode === nextMode) return;

  const editorApi = getPrimaryEditorApi();
  if (previousMode && isDynamicMode(previousMode) && editorApi && typeof editorApi.getValue === 'function') {
    const prevTab = dynamicEditorTabs.get(previousMode);
    if (prevTab) {
      try {
        prevTab.content = String(editorApi.getValue() || '');
      } catch (_) {}
    }
  }

  currentMode = nextMode;

  const onEditor = nextMode !== 'composer';
  try { $('#mode-editor').style.display = onEditor ? '' : 'none'; } catch (_) {}
  try { $('#mode-composer').style.display = onEditor ? 'none' : ''; } catch (_) {}
  try {
    const layout = $('#mode-editor');
    if (layout) layout.classList.toggle('is-dynamic', isDynamicMode(nextMode));
  } catch (_) {}

  try {
    $$('.mode-tab').forEach(b => {
      const isOn = (b.dataset.mode === nextMode);
      b.classList.toggle('is-active', isOn);
      b.setAttribute('aria-selected', isOn ? 'true' : 'false');
    });
  } catch (_) {}

  const scheduleEditorLayoutRefresh = () => {
    if (!editorApi || typeof editorApi.requestLayout !== 'function') return;
    const run = () => {
      if (currentMode !== nextMode) return;
      try { editorApi.requestLayout(); } catch (_) {}
    };
    try { requestAnimationFrame(run); }
    catch (_) { setTimeout(run, 0); }
  };

  if (onEditor) scheduleEditorLayoutRefresh();

  if (nextMode === 'composer') {
    activeDynamicMode = null;
    pushEditorCurrentFileInfo(null);
  } else if (isDynamicMode(nextMode)) {
    activeDynamicMode = nextMode;
    ensurePrimaryEditorListener();
    const tab = dynamicEditorTabs.get(nextMode);
    if (tab && editorApi) {
      try { editorApi.setView('edit'); } catch (_) {}
      try {
        const baseDir = computeBaseDirForPath(tab.path);
        tab.baseDir = baseDir;
        editorApi.setBaseDir(baseDir);
      } catch (_) {}
      pushEditorCurrentFileInfo(tab);

      const applyContent = (text) => {
        tab.content = String(text || '');
        if (currentMode === nextMode) {
          editorApi.setValue(tab.content, { notify: false });
          scheduleEditorLayoutRefresh();
          try { editorApi.focus(); } catch (_) {}
          try { window.scrollTo({ top: 0, behavior: 'smooth' }); }
          catch (_) { window.scrollTo(0, 0); }
          updateDynamicTabDirtyState(tab, { autoSave: false });
        }
      };

      if (tab.loaded || (tab.localDraft && tab.localDraft.content)) {
        applyContent(tab.content);
      } else {
        setTabLoadingState(tab, true);
        loadDynamicTabContent(tab).then((text) => {
          setTabLoadingState(tab, false);
          if (currentMode !== nextMode) return;
          applyContent(text);
        }).catch((err) => {
          setTabLoadingState(tab, false);
          if (currentMode === nextMode) {
            console.error('Composer editor: failed to load markdown', err);
            const message = (tab.fileStatus && tab.fileStatus.message)
              ? tab.fileStatus.message
              : (err && err.message) ? err.message : 'Unknown error';
            alert(`Failed to load file\n${tab.path}\n${message}`);
          }
        });
      }
    }
  } else {
    activeDynamicMode = null;
    if (editorApi) {
      try { editorApi.setView('edit'); } catch (_) {}
      scheduleEditorLayoutRefresh();
    }
    pushEditorCurrentFileInfo(null);
  }

  // Sync preload attribute so CSS with !important stops forcing previous mode
  try {
    if (nextMode === 'composer') document.documentElement.setAttribute('data-init-mode', 'composer');
    else document.documentElement.removeAttribute('data-init-mode');
  } catch (_) {}

  persistDynamicEditorState();
}

function getInitialComposerFile() {
  try {
    const v = (localStorage.getItem(LS_KEYS.cfile) || '').toLowerCase();
    if (v === 'tabs' || v === 'index') return v;
  } catch (_) {}
  return 'index';
}

function applyComposerFile(name) {
  const isIndex = name !== 'tabs';
  try { $('#composerIndex').style.display = isIndex ? 'block' : 'none'; } catch (_) {}
  try { $('#composerTabs').style.display = isIndex ? 'none' : 'block'; } catch (_) {}
  try {
    $$('a.vt-btn[data-cfile]').forEach(a => {
      a.classList.toggle('active', a.dataset.cfile === (isIndex ? 'index' : 'tabs'));
    });
  } catch (_) {}
  try {
    const btn = $('#btnAddItem');
    if (btn) btn.textContent = isIndex ? 'New Post Wizard' : 'New Tab Wizard';
  } catch (_) {}
  // Sync preload attribute to avoid CSS forcing the wrong sub-file
  try {
    if (!isIndex) document.documentElement.setAttribute('data-init-cfile', 'tabs');
    else document.documentElement.removeAttribute('data-init-cfile');
  } catch (_) {}

  try { updateUnsyncedSummary(); } catch (_) {}

}

// Apply initial state as early as possible to avoid flash on reload
(() => {
  try { applyMode('composer'); } catch (_) {}
  try { applyComposerFile(getInitialComposerFile()); } catch (_) {}
})();

// Robust clipboard helper available to all composer flows
async function nsCopyToClipboard(text) {
  const val = String(text || '');
  // Prefer async Clipboard API when in a secure context
  try {
    if (navigator.clipboard && window.isSecureContext) {
      // Intentionally do not await in callers to better preserve user-activation
      await navigator.clipboard.writeText(val);
      return true;
    }
  } catch (_) { /* fall through to legacy */ }
  // Legacy fallback: temporary textarea + execCommand('copy')
  try {
    const ta = document.createElement('textarea');
    ta.value = val;
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.width = '1px';
    ta.style.height = '1px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
    try { document.body.removeChild(ta); } catch (_) {}
    return ok;
  } catch (_) { return false; }
}

// Smooth expand/collapse for details panels
const __activeAnims = new WeakMap();
const SLIDE_OPEN_DUR = 320;   // slower, smoother
const SLIDE_CLOSE_DUR = 280;  // slightly faster than open

function parsePx(value) {
  const n = parseFloat(value);
  return isNaN(n) ? 0 : n;
}

function getSlidePadding(el) {
  const cs = window.getComputedStyle(el);
  return {
    top: parsePx(cs.paddingTop),
    bottom: parsePx(cs.paddingBottom)
  };
}

function clearInlineSlideStyles(el) {
  el.style.overflow = '';
  el.style.height = '';
  el.style.opacity = '';
  el.style.paddingTop = '';
  el.style.paddingBottom = '';
}

function forgetActiveAnim(el, anim) {
  const stored = __activeAnims.get(el);
  if (stored && stored.anim === anim) __activeAnims.delete(el);
}

function finalizeAnimation(el, anim) {
  if (!anim) return;
  try { anim.onfinish = null; } catch (_) {}
  try { anim.oncancel = null; } catch (_) {}
  try { anim.commitStyles(); } catch (_) {}
  try { anim.cancel(); } catch (_) {}
  forgetActiveAnim(el, anim);
}

function slideToggle(el, toOpen) {
  if (!el) return;
  const isReduced = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let computedDisplay = '';
  try { computedDisplay = window.getComputedStyle(el).display; } catch (_) { computedDisplay = el.style.display; }
  const running = __activeAnims.get(el);
  const runningTarget = running && typeof running.target === 'boolean' ? running.target : null;
  const currentState = (runningTarget !== null)
    ? runningTarget
    : (el.dataset.open === '1' ? true : el.dataset.open === '0' ? false : (computedDisplay !== 'none'));
  const open = (typeof toOpen === 'boolean') ? toOpen : !currentState;

  if (runningTarget !== null) {
    if (open === runningTarget) return;
    try { running.anim?.cancel(); } catch (_) {}
    __activeAnims.delete(el);
  } else if (open === currentState) {
    return;
  }

  if (isReduced) {
    el.style.display = open ? 'block' : 'none';
    el.dataset.open = open ? '1' : '0';
    clearInlineSlideStyles(el);
    return;
  }

  if (open) {
    el.dataset.open = '1';
    el.style.display = 'block';
    const pad = getSlidePadding(el);
    const totalEnd = el.scrollHeight;
    const contentTarget = Math.max(0, totalEnd - pad.top - pad.bottom);
    try {
      el.style.overflow = 'hidden';
      el.style.paddingTop = '0px';
      el.style.paddingBottom = '0px';
      el.style.height = '0px';
      el.style.opacity = '0';
      void el.offsetWidth;
      const anim = el.animate([
        { height: '0px', opacity: 0, paddingTop: '0px', paddingBottom: '0px' },
        { height: contentTarget + 'px', opacity: 1, paddingTop: pad.top + 'px', paddingBottom: pad.bottom + 'px' }
      ], { duration: SLIDE_OPEN_DUR, easing: 'ease', fill: 'forwards' });
      __activeAnims.set(el, { target: true, anim });
      anim.onfinish = () => {
        finalizeAnimation(el, anim);
        el.dataset.open = '1';
        clearInlineSlideStyles(el);
      };
      anim.oncancel = () => {
        clearInlineSlideStyles(el);
        forgetActiveAnim(el, anim);
      };
    } catch (_) {
      clearInlineSlideStyles(el);
      el.dataset.open = '1';
    }
  } else {
    el.dataset.open = '0';
    const pad = getSlidePadding(el);
    const totalStart = el.scrollHeight;
    const contentStart = Math.max(0, totalStart - pad.top - pad.bottom);
    try {
      el.style.overflow = 'hidden';
      el.style.display = 'block';
      el.style.paddingTop = pad.top + 'px';
      el.style.paddingBottom = pad.bottom + 'px';
      el.style.height = contentStart + 'px';
      el.style.opacity = '1';
      void el.offsetHeight;
      const anim = el.animate([
        { height: contentStart + 'px', opacity: 1, paddingTop: pad.top + 'px', paddingBottom: pad.bottom + 'px' },
        { height: '0px', opacity: 0, paddingTop: '0px', paddingBottom: '0px' }
      ], { duration: SLIDE_CLOSE_DUR, easing: 'ease', fill: 'forwards' });
      __activeAnims.set(el, { target: false, anim });
      anim.onfinish = () => {
        finalizeAnimation(el, anim);
        el.style.display = 'none';
        el.dataset.open = '0';
        clearInlineSlideStyles(el);
      };
      anim.oncancel = () => {
        clearInlineSlideStyles(el);
        forgetActiveAnim(el, anim);
      };
    } catch (_) {
      el.style.display = 'none';
      clearInlineSlideStyles(el);
      el.dataset.open = '0';
    }
  }
}

function sortLangKeys(obj) {
  const keys = Object.keys(obj || {});
  return keys.sort((a, b) => {
    const ia = PREFERRED_LANG_ORDER.indexOf(a);
    const ib = PREFERRED_LANG_ORDER.indexOf(b);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    return a.localeCompare(b);
  });
}

// Localized display names for languages in UI menus
function displayLangName(code) {
  const c = String(code || '').toLowerCase();
  if (c === 'en') return 'English';
  if (c === 'zh') return '中文';
  if (c === 'ja') return '日本語';
  return c.toUpperCase();
}

function langFlag(code) {
  const c = String(code || '').toLowerCase();
  if (c === 'en') return '🇺🇸';
  if (c === 'zh') return '🇨🇳';
  if (c === 'ja') return '🇯🇵';
  return '';
}

function q(s) {
  // Double-quoted YAML scalar with basic escapes
  const str = String(s ?? '');
  return '"' + str
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/\"/g, '\\"') + '"';
}

function toIndexYaml(data) {
  const lines = [
    '# yaml-language-server: $schema=../assets/schema/index.json',
    ''
  ];
  const keys = data.__order && Array.isArray(data.__order) ? data.__order.slice() : Object.keys(data).filter(k => k !== '__order');
  keys.forEach(key => {
    const entry = data[key];
    if (!entry || typeof entry !== 'object') return;
    lines.push(`${key}:`);
    const langs = sortLangKeys(entry);
    langs.forEach(lang => {
      const v = entry[lang];
      if (Array.isArray(v)) {
        if (v.length <= 1) {
          const one = v[0] ?? '';
          lines.push(`  ${lang}: ${one ? one : '""'}`);
        } else {
          lines.push(`  ${lang}:`);
          v.forEach(p => lines.push(`    - ${p}`));
        }
      } else if (typeof v === 'string') {
        lines.push(`  ${lang}: ${v}`);
      }
    });
  });
  return lines.join('\n') + '\n';
}

function toTabsYaml(data) {
  const lines = [
    '# yaml-language-server: $schema=../assets/schema/tabs.json',
    ''
  ];
  const keys = data.__order && Array.isArray(data.__order) ? data.__order.slice() : Object.keys(data).filter(k => k !== '__order');
  keys.forEach(tab => {
    const entry = data[tab];
    if (!entry || typeof entry !== 'object') return;
    lines.push(`${tab}:`);
    const langs = sortLangKeys(entry);
    langs.forEach(lang => {
      const v = entry[lang];
      if (v && typeof v === 'object') {
        const title = v.title ?? '';
        const loc = v.location ?? '';
        lines.push(`  ${lang}:`);
        lines.push(`    title: ${q(title)}`);
        lines.push(`    location: ${loc ? loc : '""'}`);
      }
    });
    lines.push('');
  });
  // Remove extra trailing blank line
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n') + '\n';
}

function makeDragList(container, onReorder) {
  // Pointer-driven drag that moves the original element; siblings animate via FLIP
  const keySelector = '[data-key]';
  const getKey = (el) => el && el.getAttribute && el.getAttribute('data-key');
  const childItems = () => Array.from(container.querySelectorAll(keySelector));

  let dragging = null;
  let placeholder = null;
  let offsetX = 0, offsetY = 0;

  // Utility: snapshot and animate siblings (ignore the dragged element)
  const snapshotRects = () => {
    const m = new Map();
    childItems().forEach(el => { m.set(getKey(el), el.getBoundingClientRect()); });
    return m;
  };
  const animateFrom = (prevRects) => {
    childItems().forEach(el => {
      if (el === dragging) return;
      const key = getKey(el);
      const prev = prevRects.get(key);
      if (!prev) return;
      const now = el.getBoundingClientRect();
      const dx = prev.left - now.left;
      const dy = prev.top - now.top;
      if (dx || dy) {
        try {
          el.animate([
            { transform: `translate(${dx}px, ${dy}px)` },
            { transform: 'translate(0, 0)' }
          ], { duration: 240, easing: 'ease', composite: 'replace' });
        } catch (_) {
          el.style.transition = 'none';
          el.style.transform = `translate(${dx}px, ${dy}px)`;
          requestAnimationFrame(() => {
            el.style.transition = 'transform 240ms ease';
            el.style.transform = '';
            const clear = () => { el.style.transition = ''; el.removeEventListener('transitionend', clear); };
            el.addEventListener('transitionend', clear);
          });
        }
      }
    });
  };

  const getAfterByY = (c, y) => {
    const els = [...c.querySelectorAll(`${keySelector}:not(.dragging)`)];
    return els.reduce((closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) return { offset, element: child };
      else return closest;
    }, { offset: Number.NEGATIVE_INFINITY }).element;
  };

  const onPointerDown = (e) => {
    if (e.button !== 0 && e.pointerType !== 'touch') return; // left click or touch only
    const target = e.target;
    if (target.closest('button, input, textarea, select, a')) return; // don't start drag from controls
    const li = target.closest(keySelector);
    if (!li || !container.contains(li)) return;

    e.preventDefault();

    dragging = li;
    const r = li.getBoundingClientRect();
    offsetX = e.clientX - r.left;
    offsetY = e.clientY - r.top;

    // placeholder keeps layout
    placeholder = document.createElement('div');
    placeholder.className = 'drag-placeholder';
    placeholder.style.height = r.height + 'px';
    placeholder.style.margin = getComputedStyle(li).margin;
    li.parentNode.insertBefore(placeholder, li.nextSibling);

    // elevate original element and follow pointer
    li.style.width = r.width + 'px';
    li.style.height = r.height + 'px';
    li.style.position = 'fixed';
    li.style.left = (e.clientX - offsetX) + 'px';
    li.style.top = (e.clientY - offsetY) + 'px';
    li.style.zIndex = '2147483646';
    li.style.pointerEvents = 'none';
    li.style.willChange = 'transform, top, left';
    li.classList.add('dragging');
    container.classList.add('is-dragging-list');
    document.body.classList.add('ns-noselect');

    try { e.target.setPointerCapture(e.pointerId); } catch (_) {}
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp, { once: true });
  };

  const onPointerMove = (e) => {
    if (!dragging) return;
    dragging.style.left = (e.clientX - offsetX) + 'px';
    dragging.style.top = (e.clientY - offsetY) + 'px';

    const prev = snapshotRects();
    const after = getAfterByY(container, e.clientY);
    if (after == null) container.appendChild(placeholder);
    else container.insertBefore(placeholder, after);
    animateFrom(prev);
  };

  const onPointerUp = () => {
    if (!dragging) return;
    // current visual position of the fixed element (origin)
    const origin = dragging.getBoundingClientRect();
    // target position equals the placeholder's rect
    const target = placeholder.getBoundingClientRect();
    const dx = origin.left - target.left;
    const dy = origin.top - target.top;

    // place the element where the placeholder sits in DOM order
    placeholder.parentNode.insertBefore(dragging, placeholder);
    placeholder.remove();
    placeholder = null;

    // reset positioning to re-enter normal flow
    dragging.style.position = '';
    dragging.style.left = '';
    dragging.style.top = '';
    dragging.style.width = '';
    dragging.style.height = '';
    dragging.style.zIndex = '';
    dragging.style.pointerEvents = '';
    dragging.style.willChange = '';
    dragging.classList.remove('dragging');

    // animate the snap from origin -> target (FLIP on the dragged element)
    try {
      dragging.animate([
        { transform: `translate(${dx}px, ${dy}px)` },
        { transform: 'translate(0, 0)' }
      ], { duration: 240, easing: 'ease' });
    } catch (_) {
      // Fallback: CSS transition
      dragging.style.transition = 'none';
      dragging.style.transform = `translate(${dx}px, ${dy}px)`;
      requestAnimationFrame(() => {
        dragging.style.transition = 'transform 240ms ease';
        dragging.style.transform = '';
        const clear = () => { dragging.style.transition = ''; dragging.removeEventListener('transitionend', clear); };
        dragging.addEventListener('transitionend', clear);
      });
    }

    container.classList.remove('is-dragging-list');
    document.body.classList.remove('ns-noselect');
    window.removeEventListener('pointermove', onPointerMove);

    const order = childItems().map(el => el.dataset.key);
    if (onReorder) onReorder(order);
    dragging = null;
  };

  // Disable native HTML5 DnD on this container
  container.addEventListener('dragstart', (e) => e.preventDefault());
  container.addEventListener('pointerdown', onPointerDown);
}

function buildIndexUI(root, state) {
  root.innerHTML = '';
  const list = document.createElement('div');
  list.id = 'ciList';
  root.appendChild(list);

  const markDirty = () => { try { notifyComposerChange('index'); } catch (_) {}; };

  const order = state.index.__order;
  order.forEach(key => {
    const entry = state.index[key] || {};
    const row = document.createElement('div');
    row.className = 'ci-item';
    row.setAttribute('data-key', key);
    row.setAttribute('draggable', 'true');
    row.innerHTML = `
      <div class="ci-head">
        <span class="ci-grip" title="Drag to reorder" aria-hidden="true">⋮⋮</span>
        <strong class="ci-key">${key}</strong>
        <span class="ci-meta">${Object.keys(entry).length} lang</span>
        <span class="ci-diff" aria-live="polite"></span>
        <span class="ci-actions">
          <button class="btn-secondary ci-expand" aria-expanded="false"><span class="caret" aria-hidden="true"></span>Details</button>
          <button class="btn-secondary ci-del">Delete</button>
        </span>
      </div>
      <div class="ci-body"><div class="ci-body-inner"></div></div>
    `;
    list.appendChild(row);

    const body = $('.ci-body', row);
    const bodyInner = $('.ci-body-inner', row);
    const btnExpand = $('.ci-expand', row);
    const btnDel = $('.ci-del', row);

    body.dataset.open = '0';
    body.style.display = 'none';

    const renderBody = () => {
      bodyInner.innerHTML = '';
      const langs = sortLangKeys(entry);
      langs.forEach(lang => {
        const block = document.createElement('div');
        block.className = 'ci-lang';
        block.dataset.lang = lang;
        const val = entry[lang];
        // Normalize to array for UI
        const arr = Array.isArray(val) ? val.slice() : (val ? [val] : []);
        block.innerHTML = `
          <div class="ci-lang-head">
            <strong>${lang.toUpperCase()}</strong>
            <span class="ci-lang-actions">
              <button class="btn-secondary ci-lang-addver">+ Version</button>
              <button class="btn-secondary ci-lang-del">Remove Lang</button>
            </span>
          </div>
          <div class="ci-ver-list"></div>
          <div class="ci-ver-removed" data-role="removed" hidden></div>
        `;
        const verList = $('.ci-ver-list', block);
        const removedBox = block.querySelector('[data-role="removed"]');
        // Stable IDs for FLIP animations across re-renders
        let verIds = arr.map(() => Math.random().toString(36).slice(2));

        const snapRects = () => {
          const map = new Map();
          verList.querySelectorAll('.ci-ver-item').forEach(el => {
            const id = el.getAttribute('data-id');
            if (!id) return;
            map.set(id, el.getBoundingClientRect());
          });
          return map;
        };

        const animateFrom = (prev) => {
          if (!prev) return;
          verList.querySelectorAll('.ci-ver-item').forEach(el => {
            const id = el.getAttribute('data-id');
            const r0 = id && prev.get(id);
            if (!r0) return;
            const r1 = el.getBoundingClientRect();
            const dx = r0.left - r1.left;
            const dy = r0.top - r1.top;
            if (dx || dy) {
              try {
                el.animate([
                  { transform: `translate(${dx}px, ${dy}px)` },
                  { transform: 'translate(0, 0)' }
                ], { duration: 240, easing: 'ease', composite: 'replace' });
              } catch (_) {
                el.style.transition = 'none';
                el.style.transform = `translate(${dx}px, ${dy}px)`;
                requestAnimationFrame(() => {
                  el.style.transition = 'transform 240ms ease';
                  el.style.transform = '';
                  const clear = () => { el.style.transition = ''; el.removeEventListener('transitionend', clear); };
                  el.addEventListener('transitionend', clear);
                });
              }
            }
          });
        };

        const renderVers = (prevRects = null) => {
          verList.innerHTML = '';
          arr.forEach((p, i) => {
            const id = verIds[i] || (verIds[i] = Math.random().toString(36).slice(2));
          const row = document.createElement('div');
          row.className = 'ci-ver-item';
          row.setAttribute('data-id', id);
          row.dataset.lang = lang;
          row.dataset.index = String(i);
          row.dataset.value = p || '';
          const normalizedPath = normalizeRelPath(p);
          if (normalizedPath) row.dataset.mdPath = normalizedPath;
          else delete row.dataset.mdPath;
          row.innerHTML = `
            <span class="ci-draft-indicator" aria-hidden="true" hidden></span>
            <input class="ci-path" type="text" placeholder="post/.../file.md" value="${p || ''}" />
            <span class="ci-ver-actions">
              <button type="button" class="btn-secondary ci-edit" title="Open in editor">Edit</button>
              <button class="btn-secondary ci-up" title="Move up">↑</button>
                <button class="btn-secondary ci-down" title="Move down">↓</button>
                <button class="btn-secondary ci-remove" title="Remove">✕</button>
              </span>
            `;
          const up = $('.ci-up', row);
          const down = $('.ci-down', row);
          // Disable ↑ for first, ↓ for last
          if (i === 0) up.setAttribute('disabled', ''); else up.removeAttribute('disabled');
          if (i === arr.length - 1) down.setAttribute('disabled', ''); else down.removeAttribute('disabled');
          updateComposerMarkdownDraftIndicators({ element: row, path: normalizedPath });

          $('.ci-path', row).addEventListener('input', (e) => {
            const prevPath = row.dataset.mdPath || '';
            arr[i] = e.target.value;
            entry[lang] = arr.slice();
            row.dataset.value = arr[i] || '';
            const nextPath = normalizeRelPath(arr[i]);
            if (nextPath) row.dataset.mdPath = nextPath;
            else delete row.dataset.mdPath;
            updateComposerMarkdownDraftIndicators({ element: row });
            if (prevPath && prevPath !== nextPath) updateComposerMarkdownDraftIndicators({ path: prevPath });
            if (nextPath) updateComposerMarkdownDraftIndicators({ path: nextPath });
            markDirty();
          });
            $('.ci-edit', row).addEventListener('click', () => {
              const rel = normalizeRelPath(arr[i]);
              if (!rel) {
                alert('Enter a markdown path before opening the editor.');
                return;
              }
              openMarkdownInEditor(rel);
            });
            up.addEventListener('click', () => {
              if (i <= 0) return;
              const prev = snapRects();
              [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]];
              [verIds[i - 1], verIds[i]] = [verIds[i], verIds[i - 1]];
              entry[lang] = arr.slice();
              renderVers(prev);
              markDirty();
            });
            down.addEventListener('click', () => {
              if (i >= arr.length - 1) return;
              const prev = snapRects();
              [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]];
              [verIds[i + 1], verIds[i]] = [verIds[i], verIds[i + 1]];
              entry[lang] = arr.slice();
              renderVers(prev);
              markDirty();
            });
            $('.ci-remove', row).addEventListener('click', () => {
              const prev = snapRects();
              arr.splice(i, 1);
              verIds.splice(i, 1);
              entry[lang] = arr.slice();
        renderVers(prev);
        markDirty();
      });
      verList.appendChild(row);
    });
    animateFrom(prevRects);
    updateComposerDraftContainerState(verList.closest('.ci-item'));
  };
  renderVers();
        $('.ci-lang-addver', block).addEventListener('click', () => {
          const prev = snapRects();
          arr.push('');
          verIds.push(Math.random().toString(36).slice(2));
          entry[lang] = arr.slice();
          renderVers(prev);
          markDirty();
        });
        $('.ci-lang-del', block).addEventListener('click', () => {
          delete entry[lang];
          row.querySelector('.ci-meta').textContent = `${Object.keys(entry).length} lang`;
          renderBody();
          markDirty();
        });
        bodyInner.appendChild(block);
      });

      // Add-language via custom dropdown showing only missing languages
      const supportedLangs = PREFERRED_LANG_ORDER.slice();
      const available = supportedLangs.filter(l => !entry[l]);
      if (available.length > 0) {
        const addLangWrap = document.createElement('div');
        addLangWrap.className = 'ci-add-lang has-menu';
        addLangWrap.innerHTML = `
          <button type="button" class="btn-secondary ci-add-lang-btn" aria-haspopup="listbox" aria-expanded="false">+ Add Language</button>
          <div class="ci-lang-menu ns-menu" role="listbox" hidden>
            ${available.map(l => `<button type="button" role="option" class="ns-menu-item" data-lang="${l}">${displayLangName(l)}</button>`).join('')}
          </div>
        `;
        const btn = $('.ci-add-lang-btn', addLangWrap);
        const menu = $('.ci-lang-menu', addLangWrap);
        function closeMenu(){
          if (menu.hidden) return;
          // animate out, then hide
          const finish = () => {
            menu.hidden = true;
            btn.classList.remove('is-open');
            addLangWrap.classList.remove('is-open');
            btn.setAttribute('aria-expanded','false');
            document.removeEventListener('mousedown', onDocDown, true);
            document.removeEventListener('keydown', onKeyDown, true);
            menu.classList.remove('is-closing');
          };
          try {
            menu.classList.add('is-closing');
            const onEnd = () => { menu.removeEventListener('animationend', onEnd); finish(); };
            menu.addEventListener('animationend', onEnd, { once: true });
            // safety timeout
            setTimeout(finish, 180);
          } catch(_) { finish(); }
        }
        function openMenu(){
          if (!menu.hidden) return;
          menu.hidden = false;
          try { menu.classList.remove('is-closing'); } catch(_){}
          btn.classList.add('is-open');
          addLangWrap.classList.add('is-open');
          btn.setAttribute('aria-expanded','true');
          try { menu.querySelector('.ns-menu-item')?.focus(); } catch(_){}
          document.addEventListener('mousedown', onDocDown, true);
          document.addEventListener('keydown', onKeyDown, true);
        }
        function onDocDown(e){ if (!addLangWrap.contains(e.target)) closeMenu(); }
        function onKeyDown(e){ if (e.key === 'Escape') { e.preventDefault(); closeMenu(); } }
        btn.addEventListener('click', () => { btn.classList.contains('is-open') ? closeMenu() : openMenu(); });
        menu.querySelectorAll('.ns-menu-item').forEach(it => {
          it.addEventListener('click', () => {
            const code = String(it.getAttribute('data-lang')||'').trim();
            if (!code || entry[code]) return;
            entry[code] = [''];
            row.querySelector('.ci-meta').textContent = `${Object.keys(entry).length} lang`;
            closeMenu();
            renderBody();
            markDirty();
          });
        });
        bodyInner.appendChild(addLangWrap);
      }
      updateComposerDraftContainerState(row);
    };
    renderBody();

    btnExpand.addEventListener('click', () => {
      const isOpen = body.dataset.open === '1';
      const next = !isOpen;
      row.classList.toggle('is-open', next);
      btnExpand.setAttribute('aria-expanded', String(next));
      slideToggle(body, next);
    });
    btnDel.addEventListener('click', () => {
      const i = state.index.__order.indexOf(key);
      if (i >= 0) state.index.__order.splice(i, 1);
      delete state.index[key];
      row.remove();
      markDirty();
    });
  });

  makeDragList(list, (newOrder) => {
    state.index.__order = newOrder;
    markDirty();
  });
}

function buildTabsUI(root, state) {
  root.innerHTML = '';
  const list = document.createElement('div');
  list.id = 'ctList';
  root.appendChild(list);

  const markDirty = () => { try { notifyComposerChange('tabs'); } catch (_) {}; };

  const order = state.tabs.__order;
  order.forEach(tab => {
    const entry = state.tabs[tab] || {};
    const row = document.createElement('div');
    row.className = 'ct-item';
    row.setAttribute('data-key', tab);
    row.setAttribute('draggable', 'true');
    row.innerHTML = `
      <div class="ct-head">
        <span class="ct-grip" title="Drag to reorder" aria-hidden="true">⋮⋮</span>
        <strong class="ct-key">${tab}</strong>
        <span class="ct-meta">${Object.keys(entry).length} lang</span>
        <span class="ct-diff" aria-live="polite"></span>
        <span class="ct-actions">
          <button class="btn-secondary ct-expand" aria-expanded="false"><span class="caret" aria-hidden="true"></span>Details</button>
          <button class="btn-secondary ct-del">Delete</button>
        </span>
      </div>
      <div class="ct-body"><div class="ct-body-inner"></div></div>
    `;
    list.appendChild(row);

    const body = $('.ct-body', row);
    const bodyInner = $('.ct-body-inner', row);
    const btnExpand = $('.ct-expand', row);
    const btnDel = $('.ct-del', row);

    body.dataset.open = '0';
    body.style.display = 'none';

    const renderBody = () => {
      bodyInner.innerHTML = '';
      const langs = sortLangKeys(entry);
      langs.forEach(lang => {
        const v = entry[lang] || { title: '', location: '' };
        const flag = langFlag(lang);
        const langLabel = displayLangName(lang);
        const safeLabel = String(langLabel || '').replace(/"/g, '&quot;');
        const flagSpan = flag ? `<span class="ct-lang-flag" aria-hidden="true">${flag}</span>` : '';
        const block = document.createElement('div');
        block.className = 'ct-lang';
        block.dataset.lang = lang;
        const initialPath = normalizeRelPath(v.location);
        if (initialPath) block.dataset.mdPath = initialPath;
        else delete block.dataset.mdPath;
        block.innerHTML = `
          <div class="ct-lang-label" aria-label="${safeLabel}" title="${safeLabel}">
            <span class="ct-draft-indicator" aria-hidden="true" hidden></span>
            ${flagSpan}
            <span class="ct-lang-code" aria-hidden="true">${lang.toUpperCase()}</span>
          </div>
          <div class="ct-lang-main">
            <label class="ct-field ct-field-title">Title <input class="ct-title" type="text" value="${v.title || ''}" /></label>
            <label class="ct-field ct-field-location">Location <input class="ct-loc" type="text" placeholder="tab/.../file.md" value="${v.location || ''}" /></label>
            <div class="ct-lang-actions">
              <button type="button" class="btn-secondary ct-edit">Edit</button>
              <button type="button" class="btn-secondary ct-lang-del">Remove Lang</button>
            </div>
          </div>
        `;
        const titleInput = $('.ct-title', block);
        const locInput = $('.ct-loc', block);
        if (titleInput) {
          titleInput.dataset.lang = lang;
          titleInput.dataset.field = 'title';
        }
        if (locInput) {
          locInput.dataset.lang = lang;
          locInput.dataset.field = 'location';
        }
        updateComposerMarkdownDraftIndicators({ element: block, path: initialPath });
        titleInput.addEventListener('input', (e) => {
          entry[lang] = entry[lang] || {};
          entry[lang].title = e.target.value;
          markDirty();
        });
        locInput.addEventListener('input', (e) => {
          const prevPath = block.dataset.mdPath || '';
          entry[lang] = entry[lang] || {};
          entry[lang].location = e.target.value;
          const nextPath = normalizeRelPath(e.target.value);
          if (nextPath) block.dataset.mdPath = nextPath;
          else delete block.dataset.mdPath;
          updateComposerMarkdownDraftIndicators({ element: block });
          if (prevPath && prevPath !== nextPath) updateComposerMarkdownDraftIndicators({ path: prevPath });
          if (nextPath) updateComposerMarkdownDraftIndicators({ path: nextPath });
          markDirty();
        });
        $('.ct-edit', block).addEventListener('click', () => {
          const rel = normalizeRelPath(locInput.value);
          if (!rel) {
            alert('Enter a markdown location before opening the editor.');
            return;
          }
          openMarkdownInEditor(rel);
        });
        $('.ct-lang-del', block).addEventListener('click', () => {
          delete entry[lang];
          row.querySelector('.ct-meta').textContent = `${Object.keys(entry).length} lang`;
          renderBody();
          markDirty();
        });
        bodyInner.appendChild(block);
      });

      // Add-language via custom dropdown showing only missing languages
      const supportedLangs = PREFERRED_LANG_ORDER.slice();
      const available = supportedLangs.filter(l => !entry[l]);
      if (available.length > 0) {
        const addLangWrap = document.createElement('div');
        addLangWrap.className = 'ct-add-lang has-menu';
        addLangWrap.innerHTML = `
          <button type="button" class="btn-secondary ct-add-lang-btn" aria-haspopup="listbox" aria-expanded="false">+ Add Language</button>
          <div class="ct-lang-menu ns-menu" role="listbox" hidden>
            ${available.map(l => `<button type=\"button\" role=\"option\" class=\"ns-menu-item\" data-lang=\"${l}\">${displayLangName(l)}</button>`).join('')}
          </div>
        `;
        const btn = $('.ct-add-lang-btn', addLangWrap);
        const menu = $('.ct-lang-menu', addLangWrap);
        function closeMenu(){
          if (menu.hidden) return;
          const finish = () => {
            menu.hidden = true;
            btn.classList.remove('is-open');
            addLangWrap.classList.remove('is-open');
            btn.setAttribute('aria-expanded','false');
            document.removeEventListener('mousedown', onDocDown, true);
            document.removeEventListener('keydown', onKeyDown, true);
            menu.classList.remove('is-closing');
          };
          try {
            menu.classList.add('is-closing');
            const onEnd = () => { menu.removeEventListener('animationend', onEnd); finish(); };
            menu.addEventListener('animationend', onEnd, { once: true });
            setTimeout(finish, 180);
          } catch(_) { finish(); }
        }
        function openMenu(){
          if (!menu.hidden) return;
          menu.hidden = false;
          try { menu.classList.remove('is-closing'); } catch(_){}
          btn.classList.add('is-open');
          addLangWrap.classList.add('is-open');
          btn.setAttribute('aria-expanded','true');
          try { menu.querySelector('.ns-menu-item')?.focus(); } catch(_){}
          document.addEventListener('mousedown', onDocDown, true);
          document.addEventListener('keydown', onKeyDown, true);
        }
        function onDocDown(e){ if (!addLangWrap.contains(e.target)) closeMenu(); }
        function onKeyDown(e){ if (e.key === 'Escape') { e.preventDefault(); closeMenu(); } }
        btn.addEventListener('click', () => { btn.classList.contains('is-open') ? closeMenu() : openMenu(); });
        menu.querySelectorAll('.ns-menu-item').forEach(it => {
          it.addEventListener('click', () => {
            const code = String(it.getAttribute('data-lang')||'').trim();
            if (!code || entry[code]) return;
            entry[code] = { title: '', location: '' };
            row.querySelector('.ct-meta').textContent = `${Object.keys(entry).length} lang`;
            closeMenu();
            renderBody();
            markDirty();
          });
        });
        bodyInner.appendChild(addLangWrap);
      }
      updateComposerDraftContainerState(row);
    };
    renderBody();

    btnExpand.addEventListener('click', () => {
      const isOpen = body.dataset.open === '1';
      const next = !isOpen;
      row.classList.toggle('is-open', next);
      btnExpand.setAttribute('aria-expanded', String(next));
      slideToggle(body, next);
    });
    btnDel.addEventListener('click', () => {
      const i = state.tabs.__order.indexOf(tab);
      if (i >= 0) state.tabs.__order.splice(i, 1);
      delete state.tabs[tab];
      row.remove();
      markDirty();
    });
  });

  makeDragList(list, (newOrder) => {
    state.tabs.__order = newOrder;
    markDirty();
  });
}

function bindComposerUI(state) {
  // Mode switch (Editor <-> Composer)
  $$('.mode-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      applyMode(mode);
    });
  });

  // File switch (index.yaml <-> tabs.yaml)
  const links = $$('a.vt-btn[data-cfile]');
  const setFile = (name) => {
    applyComposerFile(name);
    try { localStorage.setItem(LS_KEYS.cfile, (name === 'tabs') ? 'tabs' : 'index'); } catch (_) {}
  };
  links.forEach(a => a.addEventListener('click', (e) => { e.preventDefault(); setFile(a.dataset.cfile); }));
  // Respect persisted selection on load
  setFile(getInitialComposerFile());

  // ----- Composer: New Post Wizard -----
  // Build a small guided flow to:
  // 1) Set metadata (key, languages, filename)
  // 2) Guide creating folder + file on GitHub
  // 3) Add entry to index.yaml via Composer, then export YAML
  (function buildComposerGuide(){
    const host = document.getElementById('mode-composer');
    if (!host) return;
    const section = host.querySelector('section.editor-main');
    if (!section) return;
    const toolbar = section.querySelector('.toolbar');

    const wrap = document.createElement('div');
    wrap.id = 'composerGuide';
    wrap.className = 'comp-guide';
    wrap.innerHTML = `
      <div class="comp-guide-head">
        <strong>Composer Wizard - Post</strong>
        <span class="muted">Create files on GitHub and update YAML</span>
      </div>
      <div class="comp-form">
        <label>Key <input id="compKey" type="text" placeholder="e.g., myPost" /></label>
        <div id="compTitlesWrap" class="comp-titles" style="display:none;"></div>
        <label>Filename <input id="compFilename" type="text" value="main.md" /></label>
        <div class="comp-langs">
          <span class="lab">Languages</span>
          <label><input type="checkbox" value="en" id="compLangEN" checked><span>EN</span></label>
          <label><input type="checkbox" value="zh" id="compLangZH"><span>ZH</span></label>
          <label><input type="checkbox" value="ja" id="compLangJA"><span>JA</span></label>
        </div>
        <div class="comp-actions">
          <button class="btn-secondary" id="compGen">Generate Steps</button>
        </div>
      </div>
      <div class="comp-divider" id="compDivider" hidden></div>
      <div class="comp-steps" id="compSteps" hidden></div>
      <div class="comp-footer" style="display:flex; justify-content:flex-end; gap:.5rem; margin-top:.5rem;">
        <span id="compHint" class="comp-hint" hidden>Wait for GitHub Pages to finish deploying (may take a few minutes) before verifying.</span>
        <button class="btn-primary" id="compFinish" hidden>Verify Setup</button>
      </div>
    `;
    // Create a modal container and mount the wizard inside
    const modal = document.createElement('div');
    modal.id = 'compModal';
    modal.className = 'ns-modal';
    modal.setAttribute('aria-hidden', 'true');

    const dialog = document.createElement('div');
    dialog.className = 'ns-modal-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'compGuideTitle');

    // Add close button
    const btnClose = document.createElement('button');
    btnClose.className = 'ns-modal-close btn-secondary';
    btnClose.type = 'button';
    btnClose.setAttribute('aria-label', 'Cancel');
    btnClose.textContent = 'Cancel';

    // Label the title for a11y and restructure header to include the close button
    const headStrong = document.createElement('strong');
    headStrong.id = 'compGuideTitle';
    headStrong.textContent = 'Composer Wizard - Post';
    const head = wrap.querySelector('.comp-guide-head');
    if (head) {
      const muted = head.querySelector('.muted');
      const left = document.createElement('div');
      left.className = 'comp-head-left';
      left.appendChild(headStrong);
      if (muted) left.appendChild(muted);
      head.innerHTML = '';
      head.appendChild(left);
      head.appendChild(btnClose);
    }

    dialog.appendChild(wrap);
    modal.appendChild(dialog);
    document.body.appendChild(modal);

    // Modal behaviors
    const focusableSelector = 'a[href], area[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])';
    let lastActive = null;
    let compMode = 'index'; // 'index' | 'tabs'
    function getActiveTarget(){ try { return ($('#composerIndex').style.display !== 'none') ? 'index' : 'tabs'; } catch(_) { return 'index'; } }

    function openModal() {
      lastActive = document.activeElement;
      const reduce = (function(){ try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch(_) { return false; } })();
      // Ensure we start clean
      try { modal.classList.remove('ns-anim-out'); } catch(_) {}
      modal.classList.add('is-open');
      modal.setAttribute('aria-hidden', 'false');
      document.body.classList.add('ns-modal-open');
      if (!reduce) {
        try {
          // Trigger enter animation
          modal.classList.add('ns-anim-in');
          const onEnd = () => { try { modal.classList.remove('ns-anim-in'); } catch(_) {}; dialog.removeEventListener('animationend', onEnd); };
          dialog.addEventListener('animationend', onEnd, { once: true });
        } catch(_) {}
      }
      // Default to Cancel until verification passes
      try { btnClose.textContent = 'Cancel'; btnClose.setAttribute('aria-label', 'Cancel'); } catch(_){}
      // Unlock form controls for a new session
      try { if (typeof setFormLocked === 'function') setFormLocked(false); } catch(_){}
      // Clear any floating bubble
      try { if (typeof hideKeyBubble === 'function') hideKeyBubble(); } catch(_){}
      // Hide Verify until steps are generated again
      try { if (typeof setVerifyVisible === 'function') setVerifyVisible(false); } catch(_){}
      // Clear any title bubble
      try { if (typeof hideTitleBubble === 'function') hideTitleBubble(); } catch(_){}
      // Adapt header and fields by active file type
      try {
        compMode = getActiveTarget();
        if (compMode === 'tabs') {
          headStrong.textContent = 'Composer Wizard - Tab';
          updateTitlesUI();
        } else {
          headStrong.textContent = 'Composer Wizard - Post';
          updateTitlesUI();
        }
      } catch(_) {}
      setTimeout(() => { try { wrap.querySelector('#compKey')?.focus(); } catch(_){} }, 0);
    }
    function closeModal() {
      const reduce = (function(){ try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch(_) { return false; } })();
      if (reduce) {
        modal.classList.remove('is-open');
        modal.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('ns-modal-open');
        try { lastActive && lastActive.focus(); } catch(_){}
        return;
      }
      try { modal.classList.remove('ns-anim-in'); } catch(_) {}
      try { modal.classList.add('ns-anim-out'); } catch(_) {}
      const finish = () => {
        try { modal.classList.remove('ns-anim-out'); } catch(_) {}
        modal.classList.remove('is-open');
        modal.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('ns-modal-open');
        try { lastActive && lastActive.focus(); } catch(_){}
      };
      try {
        const onEnd = () => { dialog.removeEventListener('animationend', onEnd); finish(); };
        dialog.addEventListener('animationend', onEnd, { once: true });
        // Safety net in case animationend doesn't fire
        setTimeout(finish, 220);
      } catch(_) { finish(); }
    }

    modal.__open = openModal;
    modal.__close = closeModal;
    modal.addEventListener('mousedown', (e) => { if (e.target === modal) closeModal(); });
    modal.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeModal(); return; }
      if (e.key === 'Tab') {
        const focusables = Array.from(dialog.querySelectorAll(focusableSelector)).filter(el => el.offsetParent !== null || el === document.activeElement);
        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });

    const compKey = $('#compKey', wrap);
    const compFilename = $('#compFilename', wrap);
    const compTitlesWrap = $('#compTitlesWrap', wrap);
    const titlesStore = Object.create(null); // { lang: title }

    function langNameFor(code){
      const c = String(code||'').toLowerCase();
      if (c==='en') return 'EN';
      if (c==='zh') return 'ZH';
      if (c==='ja') return 'JA';
      return c.toUpperCase();
    }

    function getSelectedLangs(){
      const arr = [];
      try { const el = wrap.querySelector('#compLangEN'); if (el && el.checked) arr.push('en'); } catch(_){}
      try { const el = wrap.querySelector('#compLangZH'); if (el && el.checked) arr.push('zh'); } catch(_){}
      try { const el = wrap.querySelector('#compLangJA'); if (el && el.checked) arr.push('ja'); } catch(_){}
      // keep preferred order
      const set = Array.from(new Set(arr));
      return set.sort((a,b)=>{
        const ia = PREFERRED_LANG_ORDER.indexOf(a);
        const ib = PREFERRED_LANG_ORDER.indexOf(b);
        if (ia !== -1 || ib !== -1) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
        return a.localeCompare(b);
      });
    }

    function updateTitlesUI(){
      if (!compTitlesWrap) return;
      const isTabs = compMode === 'tabs';
      compTitlesWrap.style.display = isTabs ? '' : 'none';
      if (!isTabs) { compTitlesWrap.innerHTML = ''; return; }
      const langs = getSelectedLangs();
      // preserve existing input values
      try {
        Array.from(compTitlesWrap.querySelectorAll('input[data-lang]')).forEach(inp=>{
          const l = inp.getAttribute('data-lang');
          if (l) titlesStore[l] = inp.value;
        });
      } catch(_){}
      compTitlesWrap.innerHTML = '';
      langs.forEach(l => {
        const label = document.createElement('label');
        label.setAttribute('data-title-item', l);
        label.innerHTML = `Title (${langNameFor(l)}) <input type="text" data-lang="${l}" placeholder="Title for ${l.toUpperCase()}" />`;
        const inp = label.querySelector('input');
        inp.value = titlesStore[l] || '';
        inp.addEventListener('input', () => { titlesStore[l] = inp.value; });
        compTitlesWrap.appendChild(label);
      });
    }

    function getTitlesMap(){
      const out = Object.create(null);
      try {
        (compTitlesWrap?.querySelectorAll('input[data-lang]') || []).forEach(inp => {
          const l = inp.getAttribute('data-lang');
          if (l) out[l] = String(inp.value || '').trim();
        });
      } catch(_) {}
      return out;
    }
    const compLangEN = $('#compLangEN', wrap);
    const compLangZH = $('#compLangZH', wrap);
    const compLangJA = $('#compLangJA', wrap);
    const compGen = $('#compGen', wrap);
    const steps = $('#compSteps', wrap);
    const compDivider = $('#compDivider', wrap);
    const compFinish = $('#compFinish', wrap);
    const compHint = $('#compHint', wrap);

    // Enforce at least one language selected
    const langCheckboxes = [compLangEN, compLangZH, compLangJA];
    function enforceMinOneLang(e) {
      try {
        if (!langCheckboxes.some(cb => cb && cb.checked)) {
          // Re-check the toggled one back on
          const cb = e && e.target && e.target instanceof HTMLElement ? e.target : langCheckboxes[0];
          if (cb) cb.checked = true;
        }
      } catch (_) {}
    }
    langCheckboxes.forEach(cb => { try { cb.addEventListener('change', enforceMinOneLang); cb.addEventListener('change', updateTitlesUI); } catch(_){} });

    // Lock/unlock the top form after generating steps
    function setFormLocked(locked) {
      try {
        compKey.disabled = !!locked;
        compFilename.disabled = !!locked;
        if (compTitlesWrap) compTitlesWrap.querySelectorAll('input').forEach(inp => { try { inp.disabled = !!locked; } catch(_){} });
        compLangEN.disabled = !!locked;
        compLangZH.disabled = !!locked;
        compLangJA.disabled = !!locked;
        compGen.disabled = !!locked;
      } catch (_) {}
    }

    // Helper to flip top-right button label based on validation state
    function setCloseBtnReady(ready) {
      if (!btnClose) return;
      if (ready) { btnClose.textContent = 'Finish'; btnClose.setAttribute('aria-label', 'Finish'); }
      else { btnClose.textContent = 'Cancel'; btnClose.setAttribute('aria-label', 'Cancel'); }
    }

    // Show/hide Verify Setup button
    function setVerifyVisible(visible) {
      try {
        if (compFinish) {
          // Toggle both [hidden] and inline display to avoid being overridden by CSS
          compFinish.hidden = !visible;
          compFinish.style.display = visible ? '' : 'none';
        }
        if (compHint) {
          compHint.hidden = !visible;
          compHint.style.display = visible ? '' : 'none';
        }
      } catch (_) {}
    }
    // Hide Verify initially until steps are generated
    setVerifyVisible(false);

    // Show/hide steps and divider together
    function setStepsVisible(visible) {
      try {
        if (steps) steps.hidden = !visible;
        if (compDivider) compDivider.hidden = !visible;
      } catch(_) {}
    }

    // Reset wizard inputs and generated steps
    function resetWizard() {
      try {
        compKey.value = '';
        compFilename.value = 'main.md';
        // Clear stored titles and UI
        for (const k in titlesStore) { if (Object.prototype.hasOwnProperty.call(titlesStore, k)) delete titlesStore[k]; }
        if (compTitlesWrap) compTitlesWrap.innerHTML = '';
        compLangEN.checked = true;
        compLangZH.checked = false;
        compLangJA.checked = false;
        steps.innerHTML = '';
        steps.hidden = true;
        setFormLocked(false);
        setCloseBtnReady(false);
        setVerifyVisible(false);
        // Clear any bubble
        try { if (typeof hideKeyBubble === 'function') hideKeyBubble(); } catch(_) {}
        try { if (typeof hideTitleBubble === 'function') hideTitleBubble(); } catch(_) {}
      } catch (_) {}
    }

    // Close button: on Cancel -> reset, on Finish -> just close
    btnClose.addEventListener('click', () => {
      const label = (btnClose.textContent || '').trim().toLowerCase();
      if (label === 'cancel' || label === 'finish') {
        resetWizard();
      }
      closeModal();
    });

    // Read repo/contentRoot from previously loaded context
    const siteRepo = (window.__ns_site_repo) || {};
    const contentRoot = (window.__ns_content_root) || 'wwwroot';

    function buildGhNewLink(owner, repo, branch, folderPath, filename) {
      const enc = (s) => encodeURIComponent(String(s || ''));
      // GitHub new file page for a folder; user can type filename there
      const clean = String(folderPath || '').replace(/^\/+/, '');
      const base = `https://github.com/${enc(owner)}/${enc(repo)}/new/${enc(branch)}/${clean}`;
      if (filename) return `${base}?filename=${enc(filename)}`;
      return base;
    }
    function buildGhEditFileLink(owner, repo, branch, filePath) {
      const enc = (s) => encodeURIComponent(String(s || ''));
      const clean = String(filePath || '').replace(/^\/+/, '');
      return `https://github.com/${enc(owner)}/${enc(repo)}/edit/${enc(branch)}/${clean}`;
    }
    function buildGhBlobFileLink(owner, repo, branch, filePath) {
      const enc = (s) => encodeURIComponent(String(s || ''));
      const clean = String(filePath || '').replace(/^\/+/, '');
      return `https://github.com/${enc(owner)}/${enc(repo)}/blob/${enc(branch)}/${clean}`;
    }
    function buildGhTreeLink(owner, repo, branch, folderPath) {
      const enc = (s) => encodeURIComponent(String(s || ''));
      const clean = String(folderPath || '').replace(/^\/+/, '');
      return `https://github.com/${enc(owner)}/${enc(repo)}/tree/${enc(branch)}/${clean}`;
    }

    function getLangs() {
      const langs = [];
      if (compLangEN.checked) langs.push('en');
      if (compLangZH.checked) langs.push('zh');
      if (compLangJA.checked) langs.push('ja');
      // Unique and in preferred order if possible
      const set = Array.from(new Set(langs));
      return set.sort((a,b)=>{
        const ia = PREFERRED_LANG_ORDER.indexOf(a);
        const ib = PREFERRED_LANG_ORDER.indexOf(b);
        if (ia !== -1 || ib !== -1) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
        return a.localeCompare(b);
      });
    }

    function safeKey(v){
      const s = String(v || '').trim();
      // allow letters, numbers, dash, underscore; must start with letter/number
      const ok = /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(s);
      return ok ? s : '';
    }
    function safeFilename(v){
      let s = String(v || '').trim();
      if (!s) s = 'main.md';
      if (!/\.md$/i.test(s)) s = s + '.md';
      // collapse slashes, avoid leading slash
      s = s.replace(/\\+/g,'/').replace(/^\/+/, '');
      return s;
    }
    function withLangSuffix(fname, lang) {
      const s = safeFilename(fname);
      const i = s.lastIndexOf('.');
      if (i > 0) return s.slice(0, i) + '_' + String(lang || '').toLowerCase() + s.slice(i);
      return s + '_' + String(lang || '').toLowerCase() + '.md';
    }

    // use global helper

    function showKeyBubble(msg) {
      try {
        // Remove any existing bubble
        const existing = document.getElementById('compKeyBubble');
        if (existing && existing.parentElement) {
          try {
            dialog?.removeEventListener('scroll', existing.__reposition);
            window?.removeEventListener('resize', existing.__reposition);
          } catch(_) {}
          existing.remove();
        }
        const target = compKey;
        if (!target) return;
        const tip = document.createElement('div');
        tip.id = 'compKeyBubble';
        tip.className = 'comp-bubble is-floating';
        tip.role = 'alert';
        tip.textContent = msg || 'Please enter a valid key';
        // Attach to the modal overlay to avoid clipping by dialog overflow
        (modal || document.body).appendChild(tip);

        function position() {
          try {
            const rect = target.getBoundingClientRect();
            const bw = tip.offsetWidth;
            const bh = tip.offsetHeight;
            const vw = window.innerWidth || document.documentElement.clientWidth || 1280;
            const margin = 8;
            let left = rect.left;
            let top = rect.top - bh - 10;
            // Clamp within viewport horizontally
            if (left + bw > vw - margin) left = vw - margin - bw;
            if (left < margin) left = margin;
            // If not enough space above, place below input
            if (top < margin) top = rect.bottom + 10;
            tip.style.left = left + 'px';
            tip.style.top = top + 'px';
          } catch(_) {}
        }
        tip.style.position = 'fixed';
        tip.style.visibility = 'hidden';
        // Initial paint then position
        requestAnimationFrame(() => {
          position();
          tip.style.visibility = 'visible';
        });
        // Reposition on dialog scroll and window resize
        tip.__reposition = position;
        try { dialog?.addEventListener('scroll', position, { passive: true }); } catch(_) {}
        try { window?.addEventListener('resize', position, { passive: true }); } catch(_) {}
      } catch (_) {}
    }
    function hideKeyBubble() {
      try {
        const tip = document.getElementById('compKeyBubble');
        if (tip) {
          try {
            dialog?.removeEventListener('scroll', tip.__reposition);
            window?.removeEventListener('resize', tip.__reposition);
          } catch(_) {}
          tip.remove();
        }
      } catch(_) {}
    }

    // Floating bubble for missing tab titles, anchored to a specific input
    function showTitleBubble(targetInput, msg) {
      try {
        const existing = document.getElementById('compTitleBubble');
        if (existing && existing.parentElement) {
          try {
            dialog?.removeEventListener('scroll', existing.__reposition);
            window?.removeEventListener('resize', existing.__reposition);
          } catch(_) {}
          existing.remove();
        }
        if (!targetInput) return;
        const tip = document.createElement('div');
        tip.id = 'compTitleBubble';
        tip.className = 'comp-bubble is-floating';
        tip.role = 'alert';
        tip.textContent = msg || 'Please enter a title for this language';
        (modal || document.body).appendChild(tip);

        function position() {
          try {
            const rect = targetInput.getBoundingClientRect();
            const bw = tip.offsetWidth;
            const bh = tip.offsetHeight;
            const vw = window.innerWidth || document.documentElement.clientWidth || 1280;
            const margin = 8;
            let left = rect.left;
            let top = rect.top - bh - 10;
            if (left + bw > vw - margin) left = vw - margin - bw;
            if (left < margin) left = margin;
            if (top < margin) top = rect.bottom + 10;
            tip.style.left = left + 'px';
            tip.style.top = top + 'px';
          } catch(_) {}
        }
        tip.style.position = 'fixed';
        tip.style.visibility = 'hidden';
        requestAnimationFrame(() => { position(); tip.style.visibility = 'visible'; });
        tip.__reposition = position;
        try { dialog?.addEventListener('scroll', position, { passive: true }); } catch(_) {}
        try { window?.addEventListener('resize', position, { passive: true }); } catch(_) {}
      } catch(_) {}
    }
    function hideTitleBubble() {
      try {
        const tip = document.getElementById('compTitleBubble');
        if (tip) {
          try {
            dialog?.removeEventListener('scroll', tip.__reposition);
            window?.removeEventListener('resize', tip.__reposition);
          } catch(_) {}
          tip.remove();
        }
      } catch(_) {}
    }

  compKey.addEventListener('input', hideKeyBubble);
  try { compTitlesWrap?.addEventListener('input', hideTitleBubble); } catch(_) {}

    function renderSteps(){
      const key = safeKey(compKey.value);
      const fname = safeFilename(compFilename.value);
      const langs = getLangs();
      steps.innerHTML = '';
      if (!key) {
        // keep form interactive, do not lock; show floating bubble over the key input
        setStepsVisible(false);
        showKeyBubble('Please enter a valid key (letters/numbers/-/_).');
        setVerifyVisible(false);
        return;
      }
      const baseFolder = (compMode === 'tabs') ? 'tab' : 'post';
      const relFolder = `${baseFolder}/${key}`;
      const relFile = `${relFolder}/${fname}`;
      const fullFolder = `${contentRoot.replace(/\\+/g,'/').replace(/\/?$/, '')}/${relFolder}`;
      const ghOwner = siteRepo.owner || '';
      const ghName = siteRepo.name || '';
      const ghBranch = siteRepo.branch || 'main';
      const hasGh = !!(ghOwner && ghName);

      const frag = document.createDocumentFragment();
      const langMeta = (l) => {
        const code = String(l || '').toLowerCase();
        if (code === 'en') return { name: 'English', emoji: '🇺🇸' };
        if (code === 'zh') return { name: 'Chinese', emoji: '🇨🇳' };
        if (code === 'ja') return { name: 'Japanese', emoji: '🇯🇵' };
        return { name: code.toUpperCase(), emoji: '📝' };
      };
      const makeStep = (n, title, body) => {
        const div = document.createElement('div');
        div.className = 'comp-step';
        div.innerHTML = `<div class="num">${n}</div><div class="body"><div class="title">${title}</div></div>`;
        const bodyHost = div.querySelector('.body');
        if (body instanceof Node) bodyHost.appendChild(body);
        else if (typeof body === 'string') { const p = document.createElement('div'); p.className = 'desc'; p.textContent = body; bodyHost.appendChild(p); }
        frag.appendChild(div);
      };

      // Steps 1..N: per language, copy filename and open GitHub to create file
      let stepNum = 1;
      (langs.length ? langs : ['en']).forEach(lang => {
        const s = document.createElement('div'); s.className = 'kv';
        const p = document.createElement('p'); p.className = 'desc';
        p.textContent = 'Instructions: Click “Create File on GitHub” to open a new file with a pre-filled filename, paste your content, and commit the change.';
        const fnameLang = withLangSuffix(fname, lang);
        const actions = document.createElement('div'); actions.className = 'actions';
        const a1 = document.createElement('a'); a1.className = hasGh ? 'btn-secondary btn-github' : 'btn-secondary'; a1.target = '_blank'; a1.rel = 'noopener';
        if (hasGh) {
          // For index.yaml (posts) flow, prefill the editor with a front-matter template
          let href = buildGhNewLink(ghOwner, ghName, ghBranch, fullFolder, fnameLang);
          if (compMode !== 'tabs') {
            try { href += `&value=${encodeURIComponent(makeDefaultMdTemplate())}`; } catch(_) {}
          }
          a1.href = href;
        } else {
          a1.href = '#';
        }
        if (hasGh) {
          a1.innerHTML = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 98 96" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M48.854 0C21.839 0 0 22 0 49.217c0 21.756 13.993 40.172 33.405 46.69 2.427.49 3.316-1.059 3.316-2.362 0-1.141-.08-5.052-.08-9.127-13.59 2.934-16.42-5.867-16.42-5.867-2.184-5.704-5.42-7.17-5.42-7.17-4.448-3.015.324-3.015.324-3.015 4.934.326 7.523 5.052 7.523 5.052 4.367 7.496 11.404 5.378 14.235 4.074.404-3.178 1.699-5.378 3.074-6.6-10.839-1.141-22.243-5.378-22.243-24.283 0-5.378 1.94-9.778 5.014-13.2-.485-1.222-2.184-6.275.486-13.038 0 0 4.125-1.304 13.426 5.052a46.97 46.97 0 0 1 12.214-1.63c4.125 0 8.33.571 12.213 1.63 9.302-6.356 13.427-5.052 13.427-5.052 2.67 6.763.97 11.816.485 13.038 3.155 3.422 5.015 7.822 5.015 13.2 0 18.905-11.404 23.06-22.324 24.283 1.78 1.548 3.316 4.481 3.316 9.126 0 6.6-.08 11.897-.08 13.526 0 1.304.89 2.853 3.316 2.364 19.412-6.52 33.405-24.935 33.405-46.691C97.707 22 75.788 0 48.854 0z" fill="currentColor"/></svg><span class="btn-label">Create File</span>';
        } else {
          a1.textContent = 'No repo configured (site.yaml -> repo)';
        }
        actions.appendChild(a1);
        s.appendChild(p); s.appendChild(actions);
        const { name, emoji } = langMeta(lang);
        makeStep(stepNum, `Step ${stepNum} – Create ${name} File ${emoji}`, s);
        stepNum++;
      });
      // Final: Update index.yaml and commit on GitHub
      {
        const s = document.createElement('div'); s.className = 'kv';
        const p = document.createElement('p'); p.className = 'desc';
        const yamlName = (compMode === 'tabs') ? 'tabs.yaml' : 'index.yaml';
        p.textContent = `We will copy the YAML for you, then open ${yamlName} on GitHub. In the editor, select all and paste to replace, then commit.`;
        const actions = document.createElement('div'); actions.className = 'actions';
        const filePath = `${contentRoot.replace(/\\+/g,'/').replace(/\/?$/, '')}/${yamlName}`;
        const aEdit = document.createElement('a'); aEdit.className = hasGh ? 'btn-secondary btn-github' : 'btn-secondary'; aEdit.target = '_blank'; aEdit.rel = 'noopener';
        aEdit.href = hasGh ? buildGhEditFileLink(ghOwner, ghName, ghBranch, filePath) : '#';
        if (hasGh) {
          const label = (compMode === 'tabs') ? 'Edit tabs.yaml' : 'Edit index.yaml';
          aEdit.innerHTML = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 98 96" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M48.854 0C21.839 0 0 22 0 49.217c0 21.756 13.993 40.172 33.405 46.69 2.427.49 3.316-1.059 3.316-2.362 0-1.141-.08-5.052-.08-9.127-13.59 2.934-16.42-5.867-16.42-5.867-2.184-5.704-5.42-7.17-5.42-7.17-4.448-3.015.324-3.015.324-3.015 4.934.326 7.523 5.052 7.523 5.052 4.367 7.496 11.404 5.378 14.235 4.074.404-3.178 1.699-5.378 3.074-6.6-10.839-1.141-22.243-5.378-22.243-24.283 0-5.378 1.94-9.778 5.014-13.2-.485-1.222-2.184-6.275.486-13.038 0 0 4.125-1.304 13.426 5.052a46.97 46.97 0 0 1 12.214-1.63c4.125 0 8.33.571 12.213 1.63 9.302-6.356 13.427-5.052 13.427-5.052 2.67 6.763.97 11.816.485 13.038 3.155 3.422 5.015 7.822 5.015 13.2 0 18.905-11.404 23.06-22.324 24.283 1.78 1.548 3.316 4.481 3.316 9.126 0 6.6-.08 11.897-.08 13.526 0 1.304.89 2.853 3.316 2.364 19.412-6.52 33.405-24.935 33.405-46.691C97.707 22 75.788 0 48.854 0z" fill="currentColor"/></svg><span class="btn-label">' + label + '</span>';
        } else {
          aEdit.textContent = '—';
        }
        aEdit.title = 'We will copy YAML to your clipboard. On GitHub, select all and paste to replace, then commit.';
        // On click, auto-copy YAML draft to clipboard, then open GitHub edit page
        aEdit.addEventListener('click', async (e) => {
          if (!hasGh) return;
          try { e.preventDefault(); } catch(_) {}
          try {
            // Build a merged draft that includes current form entry even if not clicked "Add" button
            const keyDraft = safeKey(compKey.value);
            const fnameDraft = safeFilename(compFilename.value);
            const langsDraft = getLangs();
            const titlesMap = getTitlesMap();
            if (compMode === 'tabs') {
              const draft = {};
              Object.keys(state.tabs || {}).forEach(k => { if (k !== '__order') draft[k] = state.tabs[k]; });
              let order = Array.isArray(state.tabs.__order) ? state.tabs.__order.slice() : Object.keys(draft);
              if (keyDraft) {
                const entry = {};
                (langsDraft.length ? langsDraft : ['en']).forEach(l => {
                  const fLang = (typeof withLangSuffix === 'function') ? withLangSuffix(fnameDraft, l) : fnameDraft;
                  const t = String(titlesMap[l] || '').trim() || keyDraft;
                  entry[l] = { title: t, location: `tab/${keyDraft}/${fLang}` };
                });
                draft[keyDraft] = entry;
                const pos = order.indexOf(keyDraft);
                if (pos >= 0) order.splice(pos, 1);
                order.unshift(keyDraft);
              }
              draft.__order = order;
              const text = toTabsYaml(draft);
              try { nsCopyToClipboard(text); } catch(_) { /* ignore */ }
            } else {
              const draft = {};
              Object.keys(state.index || {}).forEach(k => { if (k !== '__order') draft[k] = state.index[k]; });
              let order = Array.isArray(state.index.__order) ? state.index.__order.slice() : Object.keys(draft);
              if (keyDraft) {
                const entry = {};
                (langsDraft.length ? langsDraft : ['en']).forEach(l => {
                  const fLang = (typeof withLangSuffix === 'function') ? withLangSuffix(fnameDraft, l) : fnameDraft;
                  entry[l] = `post/${keyDraft}/${fLang}`;
                });
                draft[keyDraft] = entry;
                const pos = order.indexOf(keyDraft);
                if (pos >= 0) order.splice(pos, 1);
                order.unshift(keyDraft);
              }
              draft.__order = order;
              const text = toIndexYaml(draft);
              try { nsCopyToClipboard(text); } catch(_) { /* ignore */ }
            }
          } catch(_) { /* ignore */ }
          try { window.open(aEdit.href, '_blank', 'noopener'); } catch(_) { location.href = aEdit.href; }
        });
        actions.appendChild(aEdit);
        s.appendChild(p);
        s.appendChild(actions);
        makeStep(stepNum, (compMode === 'tabs') ? `Step ${stepNum} – Update Tabs Index 📑` : `Step ${stepNum} – Update Post Index 📑`, s);
      }
      steps.appendChild(frag);
      setStepsVisible(true);
      setVerifyVisible(true);
      // steps generated

      // Bind copy buttons
      steps.querySelectorAll('button[data-copy]')?.forEach(btn => {
        btn.addEventListener('click', () => nsCopyToClipboard(btn.getAttribute('data-copy')));
      });
    }

    compGen.addEventListener('click', async () => {
      // Clear any previous bubble
      try { if (typeof hideKeyBubble === 'function') hideKeyBubble(); } catch(_) {}

      const key = safeKey(compKey.value);
      const fname = safeFilename(compFilename.value);
      const langs = getLangs();
      const mode = (function(){ try { return ($('#composerIndex').style.display !== 'none') ? 'index' : 'tabs'; } catch(_) { return 'index'; } })();
      const rootNorm = (contentRoot || 'wwwroot').replace(/\\+/g,'/').replace(/\/?$/, '');

      // Invalid or empty key -> show bubble and do not proceed
      if (!key) {
        steps.innerHTML = '';
        setStepsVisible(false);
        setVerifyVisible(false);
        setFormLocked(false);
        showKeyBubble('Please enter a valid key (letters/numbers/-/_).');
        try { wrap.querySelector('#compKey')?.focus(); } catch(_) {}
        return;
      }

      // Duplicate key in existing YAML -> show bubble and block
      try {
        const coll = (mode === 'tabs') ? state.tabs : state.index;
        if (coll && Object.prototype.hasOwnProperty.call(coll, key)) {
          steps.innerHTML = '';
          setStepsVisible(false);
          setVerifyVisible(false);
          setFormLocked(false);
          showKeyBubble(mode === 'tabs' ? 'This key already exists in tabs.yaml. Please choose a new key.' : 'This key already exists in index.yaml. Please choose a new key.');
          try { wrap.querySelector('#compKey')?.focus(); } catch(_) {}
          return;
        }
      } catch(_) {}

      // In tabs mode, require non-empty titles for all selected languages
      if (mode === 'tabs') {
        try {
          const langsList = (langs.length ? langs : ['en']);
          let missing = '';
          let target = null;
          for (const l of langsList) {
            const inp = compTitlesWrap?.querySelector(`input[data-lang="${l}"]`);
            const val = String((inp && inp.value) || '').trim();
            if (!val) { missing = l; target = inp; break; }
          }
          if (missing) {
            steps.innerHTML = '';
            setStepsVisible(false);
            setVerifyVisible(false);
            setFormLocked(false);
            showTitleBubble(target, `Please enter the title for ${missing.toUpperCase()}.`);
            try { target?.focus(); } catch(_) {}
            return;
          }
        } catch(_) {}
      }

      // Check if any target file already exists -> show bubble and block
      const baseFolder = (mode === 'tabs') ? 'tab' : 'post';
      const relFolder = `${baseFolder}/${key}`;
      let existingPath = '';
      try {
        const langList = (langs.length ? langs : ['en']);
        for (const lang of langList) {
          const fLang = withLangSuffix(fname, lang);
          const url = `${rootNorm}/${relFolder}/${fLang}`;
          try {
            const r = await fetch(url, { cache: 'no-store' });
            if (r && r.ok) { existingPath = `${relFolder}/${fLang}`; break; }
          } catch(_) { /* ignore fetch errors here */ }
        }
      } catch(_) {}
      if (existingPath) {
        steps.innerHTML = '';
        setStepsVisible(false);
        setVerifyVisible(false);
        setFormLocked(false);
        showKeyBubble(`File already exists: ${existingPath}. Choose a different key or filename.`);
        try { wrap.querySelector('#compKey')?.focus(); } catch(_) {}
        return;
      }

      // All good -> render steps and lock form
      renderSteps();
      if (safeKey(compKey.value)) setFormLocked(true); else setFormLocked(false);
    });
    // Validate created files and index.yaml before closing
    compFinish.addEventListener('click', async () => {
      if (compFinish.disabled) return;
      const prevText = compFinish.textContent;
      try {
        compFinish.disabled = true;
        compFinish.textContent = 'Verifying…';
        compFinish.setAttribute('aria-busy', 'true');
      } catch (_) {}
      // Ensure steps are rendered so we can annotate results
      if (!steps || steps.children.length === 0 || steps.hidden) {
        renderSteps();
      }

      const key = safeKey(compKey.value);
      const fname = safeFilename(compFilename.value);
      const langs = getLangs();
      const mode = (function(){ try { return ($('#composerIndex').style.display !== 'none') ? 'index' : 'tabs'; } catch(_) { return 'index'; } })();
      const relFolder = key ? `${mode === 'tabs' ? 'tab' : 'post'}/${key}` : '';
      const rootNorm = (contentRoot || 'wwwroot').replace(/\\+/g,'/').replace(/\/?$/, '');

      const stepEls = Array.from(steps.querySelectorAll('.comp-step'));

      function setStepStatus(el, ok, msg) {
        if (!el) return;
        el.classList.remove('ok', 'err');
        const host = el.querySelector('.body') || el;
        // remove any existing status areas inside this card
        const oldWarn = el.querySelector('.comp-warn'); if (oldWarn) oldWarn.remove();
        const oldOk = el.querySelector('.comp-ok'); if (oldOk) oldOk.remove();
        const s = el.querySelector('.comp-status'); if (s) s.remove();

        if (ok) {
          // create success note section inside the card at bottom
          const okBox = document.createElement('div');
          okBox.className = 'comp-ok';
          const p = document.createElement('div');
          p.className = 'comp-ok-text';
          p.textContent = msg || 'OK';
          okBox.appendChild(p);
          el.appendChild(okBox);
          el.classList.add('ok');
        } else {
          // create warning section inside the card at bottom
          const warn = document.createElement('div');
          warn.className = 'comp-warn';
          const p = document.createElement('div');
          p.className = 'comp-warn-text';
          p.textContent = msg || 'Validation failed';
          warn.appendChild(p);
          el.appendChild(warn);
          el.classList.add('err');
        }
      }

      // Clear previous statuses
      stepEls.forEach(el => {
        el.classList.remove('ok', 'err');
        const s = el.querySelector('.comp-status'); if (s) s.remove();
        const w = el.querySelector('.comp-warn'); if (w) w.remove();
        const o = el.querySelector('.comp-ok'); if (o) o.remove();
      });

      let hadError = false;

      // Check each language file existence
      const langList = (langs.length ? langs : ['en']);
      await Promise.all(langList.map(async (lang, idx) => {
        const fLang = withLangSuffix(fname, lang);
        const fileRel = `${relFolder}/${fLang}`;
        const url = `${rootNorm}/${fileRel}`;
        const stepEl = stepEls[idx];
        if (!key) {
          hadError = true;
          setStepStatus(stepEl, false, 'Invalid key. Please enter a valid key.');
          return;
        }
        try {
          const r = await fetch(url, { cache: 'no-store' });
          if (!r.ok) {
            hadError = true;
            setStepStatus(stepEl, false, `File not found: ${url}`);
          } else {
            setStepStatus(stepEl, true, `Found: ${fileRel}`);
          }
        } catch (e) {
          hadError = true;
          setStepStatus(stepEl, false, `Cannot access: ${url}`);
        }
      }));

      // Check index.yaml/tabs.yaml content
      const yamlStepEl = stepEls[langList.length];
      try {
        const baseName = (mode === 'tabs') ? 'tabs' : 'index';
        const idxObj = await fetchConfigWithYamlFallback([
          `${rootNorm}/${baseName}.yaml`, `${rootNorm}/${baseName}.yml`
        ]);
        let yamlOk = true;
        let msg = '';
        if (!key) {
          yamlOk = false; msg = 'Invalid key';
        } else if (!idxObj || typeof idxObj !== 'object' || !idxObj[key]) {
          yamlOk = false; msg = `${baseName}.yaml missing key: ${key}`;
        } else {
          if (mode === 'tabs') {
            for (const lang of langList) {
              const expected = `${relFolder}/${withLangSuffix(fname, lang)}`;
              const val = idxObj[key][lang];
              if (!val || typeof val !== 'object') { yamlOk = false; msg = `Language ${lang} entry missing`; break; }
              if (String(val.location || '') !== expected) { yamlOk = false; msg = `Language ${lang} location mismatch. Expected: ${expected}`; break; }
              const titleStr = String(val.title ?? '').trim();
              if (!titleStr) { yamlOk = false; msg = `Language ${lang} title missing`; break; }
            }
          } else {
            for (const lang of langList) {
              const expected = `${relFolder}/${withLangSuffix(fname, lang)}`;
              const val = idxObj[key][lang];
              if (Array.isArray(val)) {
                if (!val.includes(expected)) { yamlOk = false; msg = `Language ${lang} missing path: ${expected}`; break; }
              } else if (typeof val === 'string') {
                if (val !== expected) { yamlOk = false; msg = `Language ${lang} path mismatch. Expected: ${expected}`; break; }
              } else {
                yamlOk = false; msg = `Language ${lang} path not set`; break;
              }
            }
          }
        }
        if (!yamlOk) { hadError = true; setStepStatus(yamlStepEl, false, msg || `${baseName}.yaml validation failed`); }
        else { setStepStatus(yamlStepEl, true, `${baseName}.yaml validated`); }
      } catch (e) {
        hadError = true;
        const baseName = (mode === 'tabs') ? 'tabs' : 'index';
        setStepStatus(yamlStepEl, false, `${baseName}.yaml read failed`);
      }

      if (!hadError) {
        // Verification passed: flip close button to Finish
        setCloseBtnReady(true);
      } else {
        // Verification failed: keep close button as Cancel
        setCloseBtnReady(false);
        // Focus first error section for convenience
        const firstErr = steps.querySelector('.comp-warn');
        if (firstErr) firstErr.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      try {} finally {
        try {
          compFinish.disabled = false;
          compFinish.textContent = prevText || 'Verify Setup';
          compFinish.removeAttribute('aria-busy');
        } catch (_) {}
      }
    });
  })();

  // Add item (Post or Tab) -> open unified composer wizard
  $('#btnAddItem').addEventListener('click', () => {
    const modal = document.getElementById('compModal');
    if (modal && typeof modal.__open === 'function') modal.__open();
  });


  const btnDiscard = document.getElementById('btnDiscard');
  if (btnDiscard) btnDiscard.addEventListener('click', () => handleComposerDiscard(btnDiscard));

  const btnRefresh = document.getElementById('btnRefresh');
  if (btnRefresh) btnRefresh.addEventListener('click', () => handleComposerRefresh(btnRefresh));

  const btnReview = document.getElementById('btnReview');
  if (btnReview) {
    btnReview.addEventListener('click', () => {
      const datasetKind = btnReview.dataset && btnReview.dataset.kind;
      const preferred = datasetKind === 'tabs' ? 'tabs' : datasetKind === 'index' ? 'index' : null;
      if (preferred) {
        openComposerDiffModal(preferred);
        return;
      }
      const summaryEntries = computeUnsyncedSummary();
      const activeKind = getActiveComposerFile();
      const normalizedActive = activeKind === 'tabs' ? 'tabs' : 'index';
      const entry = summaryEntries.find(item => item && item.kind === normalizedActive);
      if (entry) openComposerDiffModal(entry.kind);
    });
  }

  // Verify Setup: check all referenced files exist; if ok, check YAML drift
  (function bindVerifySetup(){
    function attach(btn) {
      if (!btn || btn.__composerVerifyBound) return;
      btn.__composerVerifyBound = true;
      const btnLabel = btn.querySelector('.btn-label');

    // Helper: extract version segment like v1.2.3 from a path
    function extractVersion(p){
      try { const m = String(p||'').match(/(?:^|\/)v\d+(?:\.\d+)*(?=\/|$)/i); return m ? m[0].split('/').pop() : ''; } catch(_) { return ''; }
    }
    function dirname(p){ try { const s=String(p||''); const i=s.lastIndexOf('/'); return i>=0? s.slice(0,i) : ''; } catch(_) { return ''; } }
    function basename(p){ try { const s=String(p||''); const i=s.lastIndexOf('/'); return i>=0? s.slice(i+1) : s; } catch(_) { return String(p||''); } }
    function uniq(arr){ return Array.from(new Set(arr||[])); }

    function buildGhNewLink(owner, repo, branch, folderPath, filename) {
      const enc = (s) => encodeURIComponent(String(s || ''));
      const clean = String(folderPath || '').replace(/^\/+/, '');
      const base = `https://github.com/${enc(owner)}/${enc(repo)}/new/${enc(branch)}/${clean}`;
      if (filename) return `${base}?filename=${enc(filename)}`;
      return base;
    }
    function buildGhEditFileLink(owner, repo, branch, filePath) {
      const enc = (s) => encodeURIComponent(String(s || ''));
      const clean = String(filePath || '').replace(/^\/+/, '');
      return `https://github.com/${enc(owner)}/${enc(repo)}/edit/${enc(branch)}/${clean}`;
    }

    function normalizeTarget(value) {
      return value === 'tabs' ? 'tabs' : value === 'index' ? 'index' : null;
    }

    function resolveTargetKind(button) {
      const ds = button && button.dataset ? button.dataset.kind : null;
      const normalized = normalizeTarget(ds);
      if (normalized) return normalized;
      const attr = button && typeof button.getAttribute === 'function'
        ? normalizeTarget(button.getAttribute('data-kind'))
        : null;
      const fallback = getActiveComposerFile();
      return normalizeTarget(attr) || (fallback === 'tabs' ? 'tabs' : 'index');
    }

    async function computeMissingFiles(preferredKind){
      const contentRoot = (window.__ns_content_root || 'wwwroot').replace(/\\+/g,'/').replace(/\/?$/, '');
      const out = [];
      const normalizedPreferred = normalizeTarget(preferredKind);
      const fallback = getActiveComposerFile();
      const target = normalizedPreferred || (fallback === 'tabs' ? 'tabs' : 'index');
      // Fetch existence in parallel batches
      const tasks = [];
      if (target === 'tabs') {
        const tbs = state.tabs || {};
        const keys = Object.keys(tbs).filter(k => k !== '__order');
        for (const key of keys){
          const langsObj = tbs[key] || {};
          const langs = sortLangKeys(langsObj);
          for (const lang of langs){
            const obj = langsObj[lang];
            const rel = obj && typeof obj === 'object' ? obj.location : '';
            if (!rel) continue; // skip empty
            const url = `${contentRoot}/${String(rel||'')}`;
            tasks.push((async () => {
              try {
                const r = await fetch(url, { cache: 'no-store' });
                if (!r || !r.ok) {
                  out.push({ key, lang, path: rel, version: extractVersion(rel), folder: dirname(rel), filename: basename(rel) });
                }
              } catch(_) { out.push({ key, lang, path: rel, version: extractVersion(rel), folder: dirname(rel), filename: basename(rel) }); }
            })());
          }
        }
      } else {
        const idx = state.index || {};
        const keys = Object.keys(idx).filter(k => k !== '__order');
        for (const key of keys){
          const langsObj = idx[key] || {};
          const langs = sortLangKeys(langsObj);
          for (const lang of langs){
            const val = langsObj[lang];
            const paths = Array.isArray(val) ? val.slice() : (typeof val === 'string' ? [val] : []);
            for (const rel of paths){
              const url = `${contentRoot}/${String(rel||'')}`;
              tasks.push((async () => {
                try {
                  const r = await fetch(url, { cache: 'no-store' });
                  if (!r || !r.ok) {
                    out.push({ key, lang, path: rel, version: extractVersion(rel), folder: dirname(rel), filename: basename(rel) });
                  }
                } catch(_) { out.push({ key, lang, path: rel, version: extractVersion(rel), folder: dirname(rel), filename: basename(rel) }); }
              })());
            }
          }
        }
      }
      await Promise.all(tasks);
      return out;
    }

    function openVerifyModal(missing, targetKind){
      // Build modal
      const modal = document.createElement('div');
      modal.className = 'ns-modal'; modal.setAttribute('aria-hidden', 'true');
      const dialog = document.createElement('div'); dialog.className = 'ns-modal-dialog'; dialog.setAttribute('role','dialog'); dialog.setAttribute('aria-modal','true');
      const head = document.createElement('div'); head.className = 'comp-guide-head';
      const left = document.createElement('div'); left.className='comp-head-left';
      const title = document.createElement('strong'); title.textContent = 'Verify Setup – Missing Files'; title.id='verifyTitle';
      const sub = document.createElement('span'); sub.className='muted'; sub.textContent = 'Create missing files on GitHub, then Verify again';
      left.appendChild(title); left.appendChild(sub);
      const btnClose = document.createElement('button'); btnClose.className = 'ns-modal-close btn-secondary'; btnClose.type = 'button'; btnClose.textContent = 'Cancel'; btnClose.setAttribute('aria-label','Cancel');
      head.appendChild(left); head.appendChild(btnClose);
      dialog.appendChild(head);

      const body = document.createElement('div'); body.className = 'comp-guide';
      const listWrap = document.createElement('div'); listWrap.style.margin = '.4rem 0';

      function renderList(items){
        listWrap.innerHTML = '';
        if (!items || !items.length){
          const p = document.createElement('p'); p.textContent = 'All files are present.'; listWrap.appendChild(p); return;
        }
        // Group: key -> lang -> entries
        const byKey = new Map();
        for (const it of items){
          if (!byKey.has(it.key)) byKey.set(it.key, new Map());
          const g = byKey.get(it.key);
          if (!g.has(it.lang)) g.set(it.lang, []);
          g.get(it.lang).push(it);
        }
        // Render groups
        for (const [key, g] of byKey.entries()){
          const sec = document.createElement('section');
          sec.style.border='1px solid var(--border)';
          sec.style.borderRadius='8px';
          sec.style.padding='.5rem';
          sec.style.margin='.5rem 0';
          sec.style.background='var(--card)';
          // Emphasize error groups with a subtle red border
          sec.style.borderColor = '#fecaca';
          const h = document.createElement('div'); h.style.display='flex'; h.style.alignItems='center'; h.style.gap='.5rem';
          const title = document.createElement('strong'); title.textContent = key; h.appendChild(title);
          // Badges
          const meta = document.createElement('span'); meta.className='summary-badges';
          const langs = Array.from(g.keys()); if (langs.length){ const b=document.createElement('span'); b.className='badge badge-lang'; b.textContent = langs.map(x=>String(x).toUpperCase()).join(' '); meta.appendChild(b); }
          h.appendChild(meta);
          sec.appendChild(h);
          for (const [lang, arr] of g.entries()){
            const langBox = document.createElement('div'); langBox.className='ci-lang';
            const lh = document.createElement('div'); lh.className='ci-lang-head';
            const lab = document.createElement('span'); lab.textContent = `Language: ${String(lang).toUpperCase()}`; lh.appendChild(lab);
            langBox.appendChild(lh);
            arr.sort((a,b)=>{
              const av = a.version || ''; const bv = b.version || '';
              if (av && bv && av!==bv){
                // compare version desc
                const vp = (v)=>String(v||'').replace(/^v/i,'').split('.').map(x=>parseInt(x,10)||0);
                const aa=vp(av), bb=vp(bv); const L=Math.max(aa.length, bb.length);
                for (let i=0;i<L;i++){ const x=aa[i]||0, y=bb[i]||0; if (x!==y) return y-x; }
              }
              return String(a.path).localeCompare(String(b.path));
            });
            for (const it of arr){
              const row = document.createElement('div'); row.className='ci-ver-item';
              const badge = document.createElement('span'); badge.className='badge badge-ver'; badge.textContent = it.version ? it.version : '—'; row.appendChild(badge);
              const p = document.createElement('code'); p.textContent = it.path; p.style.flex='1 1 auto'; row.appendChild(p);
              const actions = document.createElement('div'); actions.className='ci-ver-actions'; actions.style.display='inline-flex'; actions.style.gap='.35rem';
              const siteRepo = window.__ns_site_repo || {}; const root = (window.__ns_content_root || 'wwwroot').replace(/\\+/g,'/').replace(/\/?$/, '');
              const aNew = document.createElement('a');
              const canGh = !!(siteRepo.owner && siteRepo.name);
              aNew.className = canGh ? 'btn-secondary btn-github' : 'btn-secondary'; aNew.target='_blank'; aNew.rel='noopener';
              if (canGh) {
                aNew.innerHTML = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 98 96" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M48.854 0C21.839 0 0 22 0 49.217c0 21.756 13.993 40.172 33.405 46.69 2.427.49 3.316-1.059 3.316-2.362 0-1.141-.08-5.052-.08-9.127-13.59 2.934-16.42-5.867-16.42-5.867-2.184-5.704-5.42-7.17-5.42-7.17-4.448-3.015.324-3.015.324-3.015 4.934.326 7.523 5.052 7.523 5.052 4.367 7.496 11.404 5.378 14.235 4.074.404-3.178 1.699-5.378 3.074-6.6-10.839-1.141-22.243-5.378-22.243-24.283 0-5.378 1.94-9.778 5.014-13.2-.485-1.222-2.184-6.275.486-13.038 0 0 4.125-1.304 13.426 5.052a46.97 46.97 0 0 1 12.214-1.63c4.125 0 8.33.571 12.213 1.63 9.302-6.356 13.427-5.052 13.427-5.052 2.67 6.763.97 11.816.485 13.038 3.155 3.422 5.015 7.822 5.015 13.2 0 18.905-11.404 23.06-22.324 24.283 1.78 1.548 3.316 4.481 3.316 9.126 0 6.6-.08 11.897-.08 13.526 0 1.304.89 2.853 3.316 2.364 19.412-6.52 33.405-24.935 33.405-46.691C97.707 22 75.788 0 48.854 0z" fill="currentColor"/></svg><span class="btn-label">Create File</span>';
              } else {
                aNew.textContent = 'Create File';
              }
              // For missing files under post/..., prefill with default front-matter
              if (canGh) {
                let href = buildGhNewLink(siteRepo.owner, siteRepo.name, siteRepo.branch||'main', `${root}/${it.folder}`, it.filename);
                try {
                  if (String(it.folder || '').replace(/^\/+/, '').startsWith('post/')) {
                    const ver = it && it.version ? String(it.version) : '';
                    href += `&value=${encodeURIComponent(makeDefaultMdTemplate(ver ? { version: ver } : undefined))}`;
                  }
                } catch(_) {}
                aNew.href = href;
              } else {
                aNew.href = '#';
              }
              aNew.title = 'Open GitHub new file page with prefilled filename';
              actions.appendChild(aNew);
              row.appendChild(actions);
              langBox.appendChild(row);
            }
            sec.appendChild(langBox);
          }
          // Card-bottom red banner like the new post wizard
          const groupCount = Array.from(g.values()).reduce((acc,arr)=>acc + (Array.isArray(arr)?arr.length:0), 0);
          const warn = document.createElement('div'); warn.className='comp-warn';
          const wt = document.createElement('div'); wt.className='comp-warn-text';
          wt.textContent = `${groupCount} missing item(s) remain for this key. Create the files above on GitHub, then Verify again.`;
          warn.appendChild(wt);
          sec.appendChild(warn);
          listWrap.appendChild(sec);
        }
      }

      renderList(missing);

      body.appendChild(listWrap);
      dialog.appendChild(body);
      const foot = document.createElement('div'); foot.style.display='flex'; foot.style.justifyContent='flex-end'; foot.style.gap='.5rem'; foot.style.marginTop='.5rem';
      const btnVerify = document.createElement('button'); btnVerify.className='btn-primary'; btnVerify.textContent='Verify';
      foot.appendChild(btnVerify);
      dialog.appendChild(foot);
      modal.appendChild(dialog);
      document.body.appendChild(modal);

      function open(){
        const reduce = (function(){ try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch(_) { return false; } })();
        try { modal.classList.remove('ns-anim-out'); } catch(_) {}
        modal.classList.add('is-open');
        modal.setAttribute('aria-hidden','false');
        document.body.classList.add('ns-modal-open');
        if (!reduce) {
          try {
            modal.classList.add('ns-anim-in');
            const onEnd = () => { try { modal.classList.remove('ns-anim-in'); } catch(_) {}; dialog.removeEventListener('animationend', onEnd); };
            dialog.addEventListener('animationend', onEnd, { once: true });
          } catch(_) {}
        }
      }
      function close(){
        const reduce = (function(){ try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch(_) { return false; } })();
        const done = () => { modal.classList.remove('is-open'); modal.setAttribute('aria-hidden','true'); document.body.classList.remove('ns-modal-open'); try { modal.remove(); } catch(_) {} };
        if (reduce) { done(); return; }
        try { modal.classList.remove('ns-anim-in'); } catch(_) {}
        try { modal.classList.add('ns-anim-out'); } catch(_) {}
        const onEnd = () => { dialog.removeEventListener('animationend', onEnd); try { modal.classList.remove('ns-anim-out'); } catch(_) {}; done(); };
        try {
          dialog.addEventListener('animationend', onEnd, { once: true });
          setTimeout(onEnd, 200);
        } catch(_) { onEnd(); }
      }

      btnClose.addEventListener('click', close);
      modal.addEventListener('mousedown', (e)=>{ if (e.target === modal) close(); });
      modal.addEventListener('keydown', (e)=>{ if ((e.key||'').toLowerCase()==='escape') close(); });
      btnVerify.addEventListener('click', async ()=>{
        btnVerify.disabled = true; btnVerify.textContent = 'Verifying…';
        try {
          const normalizedTarget = normalizeTarget(targetKind) || (getActiveComposerFile() === 'tabs' ? 'tabs' : 'index');
          // Also copy YAML snapshot here to leverage the user gesture
          try {
            const text = normalizedTarget === 'tabs' ? toTabsYaml(state.tabs || {}) : toIndexYaml(state.index || {});
            nsCopyToClipboard(text);
          } catch(_) {}
          const now = await computeMissingFiles(normalizedTarget);
          if (!now.length){ close(); await afterAllGood(normalizedTarget); }
          else { renderList(now); /* no toast: inline red banner shows status */ }
        } finally {
          try { btnVerify.disabled = false; btnVerify.textContent = 'Verify'; } catch(_) {}
        }
      });

      open();
    }

    async function afterAllGood(targetKind){
      // Compare current in-memory YAML vs remote file; open GitHub edit if differs
      const contentRoot = (window.__ns_content_root || 'wwwroot').replace(/\\+/g,'/').replace(/\/?$/, '');
      const fallback = getActiveComposerFile();
      const target = normalizeTarget(targetKind) || (fallback === 'tabs' ? 'tabs' : 'index');
      const desired = target === 'tabs' ? toTabsYaml(state.tabs || {}) : toIndexYaml(state.index || {});
      async function fetchText(url){ try { const r = await fetch(url, { cache: 'no-store' }); if (r && r.ok) return await r.text(); } catch(_){} return ''; }
      const baseName = target === 'tabs' ? 'tabs' : 'index';
      const url1 = `${contentRoot}/${baseName}.yaml`; const url2 = `${contentRoot}/${baseName}.yml`;
      const cur = (await fetchText(url1)) || (await fetchText(url2));
      const norm = (s)=>String(s||'').replace(/\r\n/g,'\n').trim();
      if (norm(cur) === norm(desired)) { showToast('success', `${baseName}.yaml is up to date`); return; }
      // Need update -> copy and open GitHub edit/new page
      try { nsCopyToClipboard(desired); } catch(_) {}
      const siteRepo = window.__ns_site_repo || {}; const owner = siteRepo.owner||''; const name = siteRepo.name||''; const branch = siteRepo.branch||'main';
      if (owner && name){
        let href = '';
        if (cur) href = buildGhEditFileLink(owner, name, branch, `${contentRoot}/${baseName}.yaml`);
        else href = buildGhNewLink(owner, name, branch, `${contentRoot}`, `${baseName}.yaml`);
        try { window.open(href, '_blank', 'noopener'); } catch(_) { location.href = href; }
      } else {
        showToast('info', 'YAML copied. Configure repo in site.yaml to open GitHub.');
      }
    }

      btn.addEventListener('click', async () => {
        // Perform first pass; if any missing, show modal list; otherwise go to YAML check
        try {
          btn.disabled = true;
          if (btnLabel) btnLabel.textContent = 'Verifying…'; else btn.textContent = 'Verifying…';
        } catch(_) {}
      try {
        const targetKind = resolveTargetKind(btn);
        const target = targetKind === 'tabs' ? 'tabs' : 'index';
        // Copy YAML snapshot up-front to retain user-activation for clipboard
        try {
          const text = target === 'tabs' ? toTabsYaml(state.tabs || {}) : toIndexYaml(state.index || {});
          nsCopyToClipboard(text);
        } catch(_) {}
        const missing = await computeMissingFiles(target);
        if (missing.length) openVerifyModal(missing, target);
        else await afterAllGood(target);
      } finally {
        try {
          btn.disabled = false;
          // Restore original label
          if (btnLabel) btnLabel.textContent = 'Synchronize'; else btn.textContent = 'Synchronize';
        } catch(_) {}
      }
      });
      }

      attach(document.getElementById('btnVerify'));
      document.addEventListener('composer:verify-button-ready', (event) => {
        const target = event && event.detail && event.detail.button;
        attach(target || document.getElementById('btnVerify'));
      });
    })();
  }

function showStatus(msg, kind = 'info') {
  const el = $('#composerStatus');
  if (!el) return;
  if (msg) {
    const type = typeof kind === 'string' ? kind : 'info';
    showToast(type, msg);
  }
  updateUnsyncedSummary();
}

document.addEventListener('DOMContentLoaded', async () => {
  const pushBtn = document.getElementById('btnPushMarkdown');
  if (pushBtn) {
    markdownPushButton = pushBtn;
    pushBtn.addEventListener('click', async (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      const active = getActiveDynamicTab();
      if (!active) {
        showToast('info', 'Open a markdown file before pushing to GitHub.');
        return;
      }

      const button = markdownPushButton;
      const originalLabel = getButtonLabel(button) || MARKDOWN_PUSH_LABELS.default;
      const setBusyState = (busy, text) => {
        if (!button) return;
        if (busy) {
          button.classList.add('is-busy');
          button.disabled = true;
          button.setAttribute('aria-busy', 'true');
          button.setAttribute('aria-disabled', 'true');
          if (text) setButtonLabel(button, text);
        } else {
          button.classList.remove('is-busy');
          button.disabled = false;
          button.removeAttribute('aria-busy');
          button.setAttribute('aria-disabled', 'false');
          if (text) setButtonLabel(button, text);
        }
      };

      setBusyState(true, 'Preparing…');
      try {
        await openMarkdownPushOnGitHub(active);
      } finally {
        setBusyState(false, originalLabel);
        updateMarkdownPushButton(active);
      }
    });
    updateMarkdownPushButton(getActiveDynamicTab());
  }

  const discardBtn = document.getElementById('btnDiscardMarkdown');
  if (discardBtn) {
    markdownDiscardButton = discardBtn;
    discardBtn.addEventListener('click', (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      discardMarkdownLocalChanges(null, discardBtn);
    });
    updateMarkdownDiscardButton(getActiveDynamicTab());
  }

  try {
    if (!window.__ns_site_repo || typeof window.__ns_site_repo !== 'object') {
      window.__ns_site_repo = { owner: '', name: '', branch: 'main' };
    }
  } catch (_) {}

  const state = { index: {}, tabs: {} };
  showStatus('Loading config…');
  try {
    const site = await fetchConfigWithYamlFallback(['site.yaml', 'site.yml']);
    const root = (site && site.contentRoot) ? String(site.contentRoot) : 'wwwroot';
    window.__ns_content_root = root; // hint for other utils
    try {
      const repo = (site && site.repo) || {};
      window.__ns_site_repo = { owner: String(repo.owner || ''), name: String(repo.name || ''), branch: String(repo.branch || 'main') };
    } catch(_) { window.__ns_site_repo = { owner: '', name: '', branch: 'main' }; }
    updateMarkdownPushButton(getActiveDynamicTab());
    const [idx, tbs] = await Promise.all([
      fetchConfigWithYamlFallback([`${root}/index.yaml`, `${root}/index.yml`]),
      fetchConfigWithYamlFallback([`${root}/tabs.yaml`, `${root}/tabs.yml`])
    ]);
    const remoteIndex = prepareIndexState(idx || {});
    const remoteTabs = prepareTabsState(tbs || {});
    remoteBaseline.index = deepClone(remoteIndex);
    remoteBaseline.tabs = deepClone(remoteTabs);
    state.index = deepClone(remoteIndex);
    state.tabs = deepClone(remoteTabs);
  } catch (e) {
    console.warn('Composer: failed to load configs', e);
    remoteBaseline.index = { __order: [] };
    remoteBaseline.tabs = { __order: [] };
    state.index = { __order: [] };
    state.tabs = { __order: [] };
    updateMarkdownPushButton(getActiveDynamicTab());
  }

  activeComposerState = state;
  const restoredDrafts = loadDraftSnapshotsIntoState(state);

  if (restoredDrafts.length) {
    const label = restoredDrafts.map(k => (k === 'tabs' ? 'tabs.yaml' : 'index.yaml')).join(' & ');
    showStatus(`Restored local draft for ${label}`);
    setTimeout(() => { showStatus(''); }, 1800);
  } else {
    showStatus('');
  }

  bindComposerUI(state);
  buildIndexUI($('#composerIndex'), state);
  buildTabsUI($('#composerTabs'), state);

  notifyComposerChange('index', { skipAutoSave: true });
  notifyComposerChange('tabs', { skipAutoSave: true });


  restoreDynamicEditorState();
  allowEditorStatePersist = true;
  persistDynamicEditorState();
});

// Minimal styles injected for composer behaviors
(function injectComposerStyles(){
  const css = `
  .ci-item,.ct-item{border:1px solid var(--border);border-radius:8px;background:var(--card);margin:.5rem 0;}
  .ci-head,.ct-head{display:flex;align-items:center;gap:.5rem;padding:.5rem .6rem;border-bottom:1px solid var(--border);}
  .ci-head,.ct-head{border-bottom:none;}
  .ci-item.is-open .ci-head,.ct-item.is-open .ct-head{border-bottom:1px solid var(--border);}
  .ci-key,.ct-key{transition:color .18s ease;}
  .ci-body,.ct-body{display:none;padding:.5rem .6rem;}
  .ci-body-inner,.ct-body-inner{overflow:visible;}
  .ci-grip,.ct-grip{cursor:grab;user-select:none;opacity:.7}
  .ci-actions,.ct-actions{margin-left:auto;display:inline-flex;gap:.35rem}
  .ci-meta,.ct-meta{color:var(--muted);font-size:.85rem}
  .ci-lang,.ct-lang{border:1px dashed var(--border);border-radius:8px;margin:.4rem 0;background:color-mix(in srgb, var(--text) 3%, transparent);}
  .ci-lang{padding:.5rem;}
  .ct-lang{padding:.0625rem;}
  .ci-lang-head{display:flex;align-items:center;gap:.5rem;margin-bottom:.4rem}
  .ci-lang-actions{margin-left:auto;display:inline-flex;gap:.35rem}
  .ct-lang{display:flex;align-items:stretch;gap:0;overflow:hidden;}
  .ct-lang-label{display:flex;align-items:center;justify-content:center;gap:.3rem;padding:.35rem .6rem;background:color-mix(in srgb, var(--text) 14%, var(--card));color:var(--text);min-width:78px;white-space:nowrap;font-weight:700;border-radius:6px 0 0 6px;}
  .ct-lang-label .ct-lang-flag{font-size:1.25rem;line-height:1;transform:translateY(-1px);}
  .ct-lang-label .ct-lang-code{font-size:.9rem;font-weight:700;letter-spacing:.045em;}
  .ci-item[data-child-draft="dirty"] .ci-key,.ct-item[data-child-draft="dirty"] .ct-key{color:#f97316;}
  .ci-item[data-child-draft="conflict"] .ci-key,.ct-item[data-child-draft="conflict"] .ct-key{color:#ef4444;}
  .ct-draft-indicator,.ci-draft-indicator{display:inline-flex;width:.55rem;height:.55rem;border-radius:999px;background:color-mix(in srgb,var(--muted) 48%, transparent);box-shadow:0 0 0 3px color-mix(in srgb,var(--muted) 14%, transparent);flex:0 0 auto;opacity:0;transform:scale(.6);transition:opacity .18s ease, transform .18s ease, background-color .18s ease, box-shadow .18s ease;}
  .ct-draft-indicator[hidden],.ci-draft-indicator[hidden]{display:none;}
  .ct-lang[data-draft-state] .ct-draft-indicator,.ci-ver-item[data-draft-state] .ci-draft-indicator{opacity:1;transform:scale(.95);}
  .ct-lang[data-draft-state="dirty"] .ct-draft-indicator,.ci-ver-item[data-draft-state="dirty"] .ci-draft-indicator{background:#f97316;box-shadow:0 0 0 3px color-mix(in srgb,#f97316 22%, transparent);}
  .ct-lang[data-draft-state="saved"] .ct-draft-indicator,.ci-ver-item[data-draft-state="saved"] .ci-draft-indicator{background:#22c55e;box-shadow:0 0 0 3px color-mix(in srgb,#22c55e 20%, transparent);}
  .ct-lang[data-draft-state="conflict"] .ct-draft-indicator,.ci-ver-item[data-draft-state="conflict"] .ci-draft-indicator{background:#ef4444;box-shadow:0 0 0 3px color-mix(in srgb,#ef4444 25%, transparent);}
  .ct-lang-main{flex:1 1 auto;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto;gap:.5rem;align-items:center;padding:.35rem .6rem .35rem .75rem;}
  .ct-field{display:flex;align-items:center;gap:.4rem;font-weight:600;color:color-mix(in srgb, var(--text) 65%, transparent);white-space:nowrap;}
  .ct-field input{flex:1 1 auto;min-width:0;height:2rem;border:1px solid var(--border);border-radius:6px;background:var(--card);color:var(--text);padding:.25rem .4rem;}
  .ct-lang-actions{display:flex;gap:.35rem;justify-content:flex-end;}
  .ct-lang-actions .btn-secondary{white-space:nowrap;}
  @media (max-width:720px){
    .ct-lang{flex-direction:column;gap:.4rem;}
    .ct-lang-label{justify-content:flex-start;border-radius:6px;}
    .ct-lang-main{grid-template-columns:1fr;padding:.25rem 0 0;}
    .ct-field{white-space:normal;}
    .ct-lang-actions{justify-content:flex-start;}
  }
  .ci-ver-item{display:flex;align-items:center;gap:.4rem;margin:.3rem 0}
  .ci-ver-item input.ci-path{flex:1 1 auto;min-width:0;height:2rem;border:1px solid var(--border);border-radius:6px;background:var(--card);color:var(--text);padding:.25rem .4rem;transition:border-color .18s ease, background-color .18s ease}
  .ci-ver-actions button:disabled{opacity:.5;cursor:not-allowed}
  /* Add Language row: compact button, keep menu aligned to trigger width */
  .ci-add-lang,.ct-add-lang{display:inline-flex;align-items:center;gap:.5rem;margin-top:.5rem;position:relative}
  .ci-add-lang .btn-secondary,.ct-add-lang .btn-secondary{justify-content:center;border-bottom:0 !important}
  .ci-add-lang input,.ct-add-lang input{height:2rem;border:1px solid var(--border);border-radius:6px;background:var(--card);color:var(--text);padding:.25rem .4rem}
  .ci-add-lang select,.ct-add-lang select{height:2rem;border:1px solid var(--border);border-radius:6px;background:var(--card);color:var(--text);padding:.25rem .4rem}
  .has-menu{overflow:visible}
  .has-menu.is-open{z-index:100}
  /* Button when open looks attached to menu */
  .ci-add-lang .btn-secondary.is-open,.ct-add-lang .btn-secondary.is-open{border-bottom-left-radius:0;border-bottom-right-radius:0;background:color-mix(in srgb, var(--text) 5%, var(--card));border-color:color-mix(in srgb, var(--primary) 45%, var(--border));border-bottom:0 !important}
  /* Custom menu popup */
  .ns-menu{position:absolute;top:calc(100% - 1px);left:0;right:auto;z-index:101;border:1px solid var(--border);background:var(--card);box-shadow:var(--shadow);width:100%;min-width:0;border-top:none;border-bottom-left-radius:8px;border-bottom-right-radius:8px;border-top-left-radius:0;border-top-right-radius:0;transform-origin: top left;}
  .has-menu.is-open > .ns-menu{animation: ns-menu-in 160ms ease-out both}
  @keyframes ns-menu-in{from{opacity:0; transform: translateY(-4px) scale(0.98);} to{opacity:1; transform: translateY(0) scale(1);} }
  /* Closing animation */
  .ns-menu.is-closing{animation: ns-menu-out 130ms ease-in both !important}
  @keyframes ns-menu-out{from{opacity:1; transform: translateY(0) scale(1);} to{opacity:0; transform: translateY(-4px) scale(0.98);} }
  .ns-menu .ns-menu-item{display:block;width:100%;text-align:left;background:transparent;color:var(--text);border:0 !important;border-bottom:0 !important;padding:.4rem .6rem;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  /* Only draw a single divider: use top border on following items */
  .ns-menu .ns-menu-item + .ns-menu-item{border-top:1px solid color-mix(in srgb, var(--text) 16%, var(--border))}
  .ns-menu .ns-menu-item:hover{background:color-mix(in srgb, var(--text) 6%, var(--card))}
  /* Make selects look like secondary buttons */
  .btn-like-select{appearance:none;-webkit-appearance:none;cursor:pointer;padding:.45rem .8rem;height:2.25rem;line-height:1}
  .btn-like-select:focus-visible{outline:2px solid color-mix(in srgb, var(--primary) 45%, transparent); outline-offset:2px}
  .dragging{opacity:.96}
  .drag-placeholder{border:1px dashed var(--border);border-radius:8px;background:transparent}
  .is-dragging-list{touch-action:none}
  body.ns-noselect{user-select:none;cursor:grabbing}
  /* Simple badges for verify modal */
  .badge{display:inline-flex;align-items:center;gap:.25rem;border:1px solid var(--border);background:var(--card);color:var(--muted);font-size:.72rem;padding:.05rem .4rem;border-radius:999px}
  .badge-ver{ color: var(--primary); border-color: color-mix(in srgb, var(--primary) 40%, var(--border)); }
  .badge-lang{}
  .ci-item.is-dirty{border-color:color-mix(in srgb,#f97316 42%, var(--border));box-shadow:0 0 0 2px color-mix(in srgb,#f97316 18%, transparent);}
  .ci-item[data-diff="added"]{border-color:color-mix(in srgb,#16a34a 60%, var(--border));}
  .ci-item[data-diff="removed"]{border-color:color-mix(in srgb,#dc2626 60%, var(--border));}
  .ci-diff{display:inline-flex;gap:.25rem;align-items:center;font-size:.78rem;color:color-mix(in srgb,var(--text) 68%, transparent);}
  .ci-diff-badge{display:inline-flex;align-items:center;gap:.2rem;border:1px solid color-mix(in srgb,var(--border) 70%, transparent);border-radius:999px;padding:.05rem .35rem;line-height:1;background:color-mix(in srgb,var(--text) 4%, transparent);font-size:.72rem;font-weight:600;text-transform:uppercase;color:color-mix(in srgb,var(--text) 80%, transparent);}
  .ci-diff-badge.ci-diff-badge-added{border-color:color-mix(in srgb,#16a34a 45%, var(--border));color:#166534;background:color-mix(in srgb,#16a34a 12%, transparent);}
  .ci-diff-badge.ci-diff-badge-removed{border-color:color-mix(in srgb,#dc2626 45%, var(--border));color:#b91c1c;background:color-mix(in srgb,#dc2626 12%, transparent);}
  .ci-diff-badge.ci-diff-badge-changed{border-color:color-mix(in srgb,#f59e0b 45%, var(--border));color:#b45309;background:color-mix(in srgb,#f59e0b 12%, transparent);}
  .ci-lang[data-diff="added"]{border-color:color-mix(in srgb,#16a34a 55%, var(--border));background:color-mix(in srgb,#16a34a 10%, var(--card));}
  .ci-lang[data-diff="removed"]{border-color:color-mix(in srgb,#dc2626 55%, var(--border));background:color-mix(in srgb,#dc2626 8%, var(--card));opacity:.9;}
  .ci-lang[data-diff="modified"]{border-color:color-mix(in srgb,#f59e0b 45%, var(--border));}
  .ci-ver-item[data-diff="added"] input{border-color:color-mix(in srgb,#16a34a 60%, var(--border));background:color-mix(in srgb,#16a34a 8%, transparent);}
  .ci-ver-item[data-diff="changed"] input{border-color:color-mix(in srgb,#f59e0b 60%, var(--border));background:color-mix(in srgb,#f59e0b 6%, transparent);}
  .ci-ver-item[data-diff="moved"] input{border-color:color-mix(in srgb,#2563eb 55%, var(--border));border-style:dashed;}
  .ci-ver-removed{margin-top:.2rem;font-size:.78rem;color:#b91c1c;}
  .ct-item.is-dirty{border-color:color-mix(in srgb,#2563eb 42%, var(--border));box-shadow:0 0 0 2px color-mix(in srgb,#2563eb 16%, transparent);}
  .ct-item[data-diff="added"]{border-color:color-mix(in srgb,#16a34a 55%, var(--border));}
  .ct-item[data-diff="removed"]{border-color:color-mix(in srgb,#dc2626 55%, var(--border));}
  .ct-diff{display:inline-flex;gap:.25rem;align-items:center;font-size:.78rem;color:color-mix(in srgb,var(--text) 68%, transparent);}
  .ct-diff-badge{display:inline-flex;align-items:center;gap:.2rem;border:1px solid color-mix(in srgb,var(--border) 70%, transparent);border-radius:999px;padding:.05rem .35rem;line-height:1;background:color-mix(in srgb,var(--text) 4%, transparent);font-size:.72rem;font-weight:600;text-transform:uppercase;color:color-mix(in srgb,var(--text) 80%, transparent);}
  .ct-diff-badge.ct-diff-badge-added{border-color:color-mix(in srgb,#16a34a 45%, var(--border));color:#166534;background:color-mix(in srgb,#16a34a 12%, transparent);}
  .ct-diff-badge.ct-diff-badge-removed{border-color:color-mix(in srgb,#dc2626 45%, var(--border));color:#b91c1c;background:color-mix(in srgb,#dc2626 12%, transparent);}
  .ct-diff-badge.ct-diff-badge-changed{border-color:color-mix(in srgb,#2563eb 45%, var(--border));color:#1d4ed8;background:color-mix(in srgb,#2563eb 10%, transparent);}
  .ct-lang[data-diff="added"]{border-color:color-mix(in srgb,#16a34a 55%, var(--border));background:color-mix(in srgb,#16a34a 8%, var(--card));}
  .ct-lang[data-diff="removed"]{border-color:color-mix(in srgb,#dc2626 55%, var(--border));background:color-mix(in srgb,#dc2626 6%, var(--card));opacity:.9;}
  .ct-lang[data-diff="modified"]{border-color:color-mix(in srgb,#2563eb 45%, var(--border));}
  .ct-field input[data-diff="changed"]{border-color:color-mix(in srgb,#2563eb 60%, var(--border));background:color-mix(in srgb,#2563eb 6%, transparent);}
  /* Caret arrow for Details buttons */
  .ci-expand .caret,.ct-expand .caret{display:inline-block;width:0;height:0;border-style:solid;border-width:5px 0 5px 7px;border-color:transparent transparent transparent currentColor;margin-right:.35rem;transform:rotate(0deg);transform-origin:50% 50%;transition:transform 480ms cubic-bezier(.45,0,.25,1)}
  .ci-expand[aria-expanded="true"] .caret,.ct-expand[aria-expanded="true"] .caret{transform:rotate(90deg)}
  @media (prefers-reduced-motion: reduce){
    .ci-expand .caret,.ct-expand .caret{transition:none}
  }
  /* Composer Guide */
  .comp-guide{border:1px dashed var(--border);border-radius:8px;background:color-mix(in srgb, var(--text) 3%, transparent);padding:.6rem .6rem .2rem;margin:.6rem 0 .8rem}
  .comp-guide-head{display:flex;align-items:center;gap:.5rem;margin-bottom:.4rem}
  .comp-guide-head .muted{color:var(--muted);font-size:.88rem}
  /* Titlebar-like header inside modal */
  .ns-modal-dialog .comp-guide-head{
    display:flex;align-items:center;justify-content:space-between;gap:.6rem;
    background: color-mix(in srgb, var(--text) 6%, var(--card));
    border-bottom: 1px solid color-mix(in srgb, var(--text) 12%, var(--border));
    /* Pull to dialog edges to resemble an app title bar */
    /* Remove top gap by not offsetting beyond dialog top */
    margin: 0 -.85rem .9rem;
    padding: .65rem .85rem;
    border-top-left-radius: 12px; border-top-right-radius: 12px;
    position: sticky; top: 0; z-index: 2;
  }
  .ns-modal-dialog .comp-head-left{display:flex;align-items:baseline;gap:.6rem;min-width:0}
  .ns-modal-dialog .comp-guide-head strong{font-weight:700}
  .ns-modal-dialog .comp-guide-head .muted{opacity:.9}
  .comp-form{display:grid;grid-template-columns:1fr 1fr;gap:.5rem;align-items:end;margin-bottom:.5rem}
  .comp-form label{display:flex;flex-direction:column;gap:.25rem;font-weight:600}
  .comp-form label{position:relative}
  .comp-form input[type=text]{height:2rem;border:1px solid var(--border);border-radius:6px;background:var(--card);color:var(--text);padding:.25rem .4rem}
  .comp-langs{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}
  .comp-langs .lab{font-weight:600; margin-right:.25rem}
  .comp-langs label{display:inline-flex;align-items:center;gap:.35rem;border:1px solid var(--border);border-radius:999px;padding:.18rem .5rem;background:var(--card);color:var(--text);cursor:pointer;user-select:none}
  .comp-langs label:hover{background:color-mix(in srgb, var(--text) 5%, transparent)}
  .comp-langs label input{display:none}
  .comp-langs label:has(input:checked){background:color-mix(in srgb, var(--primary) 16%, var(--card));border-color:color-mix(in srgb, var(--primary) 45%, var(--border))}
  .comp-langs label span{font-weight:400;font-size:.85rem}
  /* Disabled states for form + language chips */
  .comp-form input[disabled]{opacity:.6;cursor:not-allowed;background:color-mix(in srgb, var(--text) 4%, var(--card))}
  .comp-langs label:has(input[disabled]){opacity:.5;cursor:not-allowed;pointer-events:none}
  .comp-langs label:has(input[disabled]):hover{background:var(--card)}
  /* Floating bubble over inputs */
  .comp-bubble{position:absolute;bottom:calc(100% + 6px);left:0;z-index:3;padding:.28rem .5rem;border-radius:6px;border:1px solid #fecaca;background:#fee2e2;color:#7f1d1d;font-size:.88rem;line-height:1.2;box-shadow:0 1px 2px rgba(0,0,0,.05);max-width:min(72vw,560px);pointer-events:none}
  .comp-bubble::after{content:'';position:absolute;top:100%;left:14px;border-width:6px;border-style:solid;border-color:#fee2e2 transparent transparent transparent}
  /* Floating variant appended to modal to avoid clipping */
  .comp-bubble.is-floating{position:fixed;z-index:100000;bottom:auto;left:auto}
  .comp-actions{display:flex;gap:.5rem;}
  .comp-steps{margin-top:.25rem}
  /* Divider between form and steps */
  .comp-divider{height:1px;background:var(--border);opacity:.8;margin:1.5rem 0}
  .comp-step{display:grid;grid-template-columns:1.6rem 1fr;column-gap:.6rem;align-items:start;margin:.4rem 0;padding:.4rem;border:1px solid var(--border);border-radius:8px;background:var(--card)}
  .comp-step > .num{grid-column:1}
  .comp-step > .body{grid-column:2}
  .comp-step > .comp-warn{grid-column:1 / -1}
  .comp-step > .comp-ok{grid-column:1 / -1}
  .comp-step .num{flex:0 0 auto;width:1.6rem;height:1.6rem;border-radius:999px;background:color-mix(in srgb, var(--primary) 14%, var(--card));border:1px solid color-mix(in srgb, var(--primary) 36%, var(--border));display:grid;place-items:center;font-weight:700;color:var(--text)}
  .comp-step .title{font-weight:700;margin-bottom:.15rem}
  .comp-step .desc{color:var(--muted);font-size:.92rem;margin:.1rem 0}
  .comp-step .actions{display:flex;gap:.4rem;margin-top:.25rem}
  .comp-step code{font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Ubuntu Mono', monospace; background: color-mix(in srgb, var(--text) 10%, transparent); padding: .08rem .35rem; border-radius: 6px; font-size: .9em;}
  /* Footer hint next to Verify */
  .comp-footer .comp-hint{color:var(--muted);font-size:.9rem;align-self:center}
  /* Validation status */
  .comp-step.ok{border-color: color-mix(in srgb, #16a34a 60%, var(--border));}
  .comp-step.err{border-color: color-mix(in srgb, #dc2626 60%, var(--border));}
  .comp-status{margin-top:.2rem;font-size:.9rem;color:var(--muted)}
  .comp-status[data-state="ok"]{color:#16a34a}
  /* Warning area at card bottom */
  .comp-warn{margin:.5rem -.4rem -.4rem -.4rem; padding:.45rem .6rem; border-top:1px solid #fecaca; background:#fee2e2; border-bottom-left-radius:8px; border-bottom-right-radius:8px; color:#7f1d1d}
  .comp-warn .comp-warn-text{font-size:.92rem; line-height:1.35}
  /* Success note at card bottom */
  .comp-ok{margin:.5rem -.4rem -.4rem -.4rem; padding:.45rem .6rem; border-top:1px solid #bbf7d0; background:#dcfce7; border-bottom-left-radius:8px; border-bottom-right-radius:8px; color:#065f46}
  .comp-ok .comp-ok-text{font-size:.92rem; line-height:1.35}
  .btn-compact{height:1.9rem;padding:.2rem .55rem;font-size:.9rem}
  /* Unify button styles inside modal (anchors and buttons) */
  .ns-modal-dialog .btn-secondary,
  .ns-modal-dialog a.btn-secondary,
  .ns-modal-dialog button.btn-secondary {
    display:inline-flex; align-items:center; justify-content:center; gap:.35rem;
    height:2.25rem; padding:.45rem .8rem; border-radius:8px; font-size:.93rem; line-height:1;
    text-decoration:none; border:1px solid var(--border); background:var(--card); color:var(--text);
  }
  .ns-modal-dialog a.btn-secondary:visited { color: var(--text); }
  .ns-modal-dialog .btn-secondary:hover { background: color-mix(in srgb, var(--text) 5%, var(--card)); }
  /* GitHub green button variant (overrides theme packs) */
  .ns-modal-dialog .btn-github,
  .ns-modal-dialog a.btn-github,
  .ns-modal-dialog button.btn-github {
    background:#428646 !important; color:#ffffff !important; border:1px solid #3d7741 !important; border-radius:8px !important;
  }
  .ns-modal-dialog a.btn-github:visited { color:#ffffff !important; }
  .ns-modal-dialog .btn-github:hover { background:#3d7741 !important; }
  .ns-modal-dialog .btn-github:active { background:#298e46 !important; }
  .ns-modal-dialog .btn-secondary[disabled],
  .ns-modal-dialog button.btn-secondary[disabled]{opacity:.5;cursor:not-allowed;pointer-events:none;filter:grayscale(25%)}
  .ns-modal-dialog .btn-primary,
  .ns-modal-dialog a.btn-primary,
  .ns-modal-dialog button.btn-primary {
    display:inline-flex; align-items:center; justify-content:center; gap:.35rem;
    height:2.25rem; padding:.45rem .8rem; border-radius:8px; font-size:.93rem; line-height:1;
    text-decoration:none;
  }
  .ns-modal-dialog .btn-primary[disabled],
  .ns-modal-dialog button.btn-primary[disabled]{opacity:.6;cursor:not-allowed;pointer-events:none;filter:grayscale(25%)}
  .ns-modal-dialog a.btn-primary:visited { color: white; }

  /* Simple modal for the Composer wizard */
  .ns-modal{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(15,23,42,0.45);backdrop-filter:blur(3px);z-index:9999;padding:1rem}
  .ns-modal.is-open{display:flex}
  /* Nudge modal upward on short viewports */
  @media (max-height: 820px){
    .ns-modal{align-items:flex-start;padding-top:calc(max(12px, env(safe-area-inset-top)) + 24px)}
  }
  /* Remove top padding so sticky header can sit flush */
  .ns-modal-dialog{position:relative;background:var(--card);color:var(--text);border:1px solid color-mix(in srgb, var(--primary) 28%, var(--border));border-radius:12px;box-shadow:0 14px 36px rgba(0,0,0,0.18),0 6px 18px rgba(0,0,0,0.12),0 1px 2px rgba(0,0,0,0.06);width:min(92vw, 760px);max-height:min(90vh, 720px);overflow:auto;padding:0 .85rem .85rem}
  .ns-modal-close{position:absolute;top:.5rem;right:.6rem;z-index:3}
  /* When close button is inside the header, make it part of the flow */
  .ns-modal-dialog .comp-guide-head .ns-modal-close{position:static;top:auto;right:auto;margin-left:auto}
  body.ns-modal-open{overflow:hidden}
  .ns-modal-dialog .comp-guide{border:none;background:transparent;padding:0;margin:0}

  #composerStatus .composer-summary-prefix{font-weight:600;color:color-mix(in srgb,var(--text) 74%, transparent)}
  #composerStatus .composer-summary-link{border:0;background:none;padding:.1rem .4rem;font-weight:600;font-size:.92rem;color:color-mix(in srgb,var(--primary) 82%, var(--text));cursor:pointer;display:inline-flex;align-items:center;gap:.3rem;border-radius:999px;transition:color 150ms ease, background-color 150ms ease}
  #composerStatus .composer-summary-link:hover{color:color-mix(in srgb,var(--primary) 88%, var(--text));background:color-mix(in srgb,var(--primary) 14%, transparent)}
  #composerStatus .composer-summary-link:focus-visible{outline:2px solid color-mix(in srgb,var(--primary) 55%, transparent);outline-offset:2px}
  #composerStatus .composer-summary-link[data-order="1"]::after{content:'';width:6px;height:6px;border-radius:999px;background:color-mix(in srgb,var(--primary) 70%, var(--text));box-shadow:0 0 0 1px color-mix(in srgb,var(--card) 80%, transparent)}

  .composer-diff-tabs{display:flex;flex-wrap:wrap;gap:.35rem;margin:0 -.85rem;padding:0 .85rem .6rem;border-bottom:1px solid color-mix(in srgb,var(--text) 14%, var(--border));background:transparent}
  .composer-diff-tab{position:relative;border:0;background:none;padding:.48rem .92rem;border-radius:999px;font-weight:600;font-size:.93rem;color:color-mix(in srgb,var(--text) 68%, transparent);cursor:pointer;transition:color 160ms ease, background-color 160ms ease, transform 160ms ease}
  .composer-diff-tab.is-active{background:color-mix(in srgb,var(--primary) 18%, transparent);color:color-mix(in srgb,var(--primary) 92%, var(--text));box-shadow:0 6px 16px rgba(37,99,235,0.18)}
  .composer-diff-tab.is-active::after{content:'';position:absolute;left:50%;bottom:-6px;transform:translateX(-50%);width:36%;min-width:24px;height:3px;border-radius:999px;background:color-mix(in srgb,var(--primary) 80%, var(--text));}
  .composer-diff-tab:hover{color:color-mix(in srgb,var(--primary) 94%, var(--text));background:color-mix(in srgb,var(--primary) 12%, transparent)}
  .composer-diff-tab:focus-visible{outline:2px solid color-mix(in srgb,var(--primary) 55%, transparent);outline-offset:2px}
  .composer-diff-views{padding:.85rem .15rem .35rem}
  .composer-diff-view{display:block}
  .composer-diff-empty{margin:.65rem 0;font-size:.95rem;color:var(--muted)}
  .composer-diff-actions{display:flex;justify-content:flex-end;gap:.6rem;padding:.75rem .85rem .85rem;margin:0;border-top:1px solid color-mix(in srgb,var(--text) 12%, var(--border));background:color-mix(in srgb,var(--text) 2%, var(--card))}
  .composer-diff-actions .btn-secondary{min-width:140px;font-weight:600}
  .composer-diff-overview-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:.65rem;margin-bottom:1rem}
  .composer-diff-stat{border:1px solid color-mix(in srgb,var(--text) 14%, var(--border));border-radius:12px;padding:.65rem .75rem;background:color-mix(in srgb,var(--text) 4%, var(--card));display:flex;flex-direction:column;gap:.12rem;min-height:74px}
  .composer-diff-stat-value{font-size:1.6rem;font-weight:700;color:color-mix(in srgb,var(--text) 88%, transparent)}
  .composer-diff-stat[data-id="order"] .composer-diff-stat-value{font-size:1.08rem}
  .composer-diff-stat-label{font-size:.85rem;color:color-mix(in srgb,var(--text) 60%, transparent)}
  .composer-diff-overview-blocks{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:.85rem;margin:.6rem 0 1rem}
  .composer-diff-overview-block{border:1px solid var(--border);border-radius:10px;padding:.65rem .75rem;background:color-mix(in srgb,var(--text) 3%, var(--card))}
  .composer-diff-overview-block h3{margin:0 0 .45rem;font-size:.92rem;color:color-mix(in srgb,var(--text) 80%, transparent)}
  .composer-diff-key-list{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:.28rem}
  .composer-diff-key-list code{font-family:var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace);font-size:.86rem;color:color-mix(in srgb,var(--text) 82%, transparent)}
  .composer-diff-key-more{font-size:.86rem;color:var(--muted)}
  .composer-diff-overview-langs{margin:.4rem 0 0;font-size:.9rem;color:color-mix(in srgb,var(--text) 62%, transparent)}
  .composer-diff-section{margin-bottom:1.05rem}
  .composer-diff-section h3{margin:0 0 .5rem;font-size:.98rem}
  .composer-diff-entry-list{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:.55rem}
  .composer-diff-entry{border:1px solid color-mix(in srgb,var(--text) 14%, var(--border));border-radius:10px;padding:.55rem .75rem;background:color-mix(in srgb,var(--text) 3%, var(--card));display:flex;flex-direction:column;gap:.35rem}
  .composer-diff-entry-key{font-family:var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace);font-weight:600;font-size:.95rem;color:var(--text)}
  .composer-diff-entry-badges{display:flex;flex-wrap:wrap;gap:.3rem;font-size:.8rem}
  .composer-diff-field-list{list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:.2rem;font-size:.88rem;color:color-mix(in srgb,var(--text) 70%, transparent)}
  .composer-diff-field-list li{display:flex;align-items:flex-start;gap:.35rem}
  .composer-diff-field-list li::before{content:'•';color:color-mix(in srgb,var(--primary) 62%, var(--text));line-height:1.1}
  @media (max-width:640px){
    .composer-diff-tabs{margin:0 0 .6rem;padding:0 0 .6rem}
    .composer-diff-overview-stats{grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}
    .composer-diff-overview-blocks{grid-template-columns:1fr}
  }
  .composer-order-dialog{width:min(96vw, 880px);max-height:min(90vh, 720px);padding-bottom:1rem}
  .composer-order-head{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;margin:0 -.85rem .85rem;background:color-mix(in srgb,var(--text) 5%, var(--card));border-bottom:1px solid color-mix(in srgb,var(--text) 14%, var(--border));padding:.75rem .85rem;position:sticky;top:0;z-index:3}
  .composer-order-head h2{margin:0;font-size:1.15rem;font-weight:700;flex:1 1 auto}
  .composer-order-subtitle{margin:0;font-size:.9rem;color:var(--muted);flex-basis:100%;order:3}
  .composer-order-close{margin-left:auto}
  .composer-order-stats{display:flex;flex-wrap:wrap;gap:.4rem;margin:0 0 .85rem;font-size:.85rem;color:var(--muted)}
  .composer-order-chip{display:inline-flex;align-items:center;gap:.3rem;border-radius:999px;padding:.18rem .55rem;border:1px solid color-mix(in srgb,var(--text) 16%, var(--border));background:color-mix(in srgb,var(--text) 4%, var(--card));font-weight:600;color:color-mix(in srgb,var(--text) 70%, transparent)}
  .composer-order-chip[data-status="moved"]{border-color:color-mix(in srgb,#2563eb 55%, var(--border));background:color-mix(in srgb,#2563eb 14%, transparent);color:#1d4ed8}
  .composer-order-chip[data-status="added"]{border-color:color-mix(in srgb,#16a34a 55%, var(--border));background:color-mix(in srgb,#16a34a 12%, transparent);color:#166534}
  .composer-order-chip[data-status="removed"]{border-color:color-mix(in srgb,#dc2626 55%, var(--border));background:color-mix(in srgb,#dc2626 12%, transparent);color:#b91c1c}
  .composer-order-chip[data-status="neutral"]{border-style:dashed}
  .composer-order-body{padding:0 0 0}
  .composer-order-visual{position:relative;padding:.4rem 3.4rem 1.9rem}
  .composer-order-columns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:clamp(3.2rem, 8vw, 6.8rem);position:relative;z-index:1}
  .composer-order-column-title{text-transform:uppercase;letter-spacing:.08em;font-weight:700;font-size:.8rem;color:color-mix(in srgb,var(--text) 60%, transparent);margin-bottom:.4rem}
  .composer-order-list{display:flex;flex-direction:column;gap:.45rem;min-height:1.5rem}
  .composer-order-item{display:flex;align-items:center;gap:.55rem;padding:.38rem .6rem;border:1px solid var(--border);border-radius:8px;background:color-mix(in srgb,var(--text) 3%, var(--card));position:relative;box-shadow:0 1px 2px rgba(15,23,42,0.05)}
  .composer-order-item[data-status="moved"]{border-color:color-mix(in srgb,#2563eb 55%, var(--border));background:color-mix(in srgb,#2563eb 11%, transparent)}
  .composer-order-item[data-status="added"]{border-color:color-mix(in srgb,#16a34a 55%, var(--border));background:color-mix(in srgb,#16a34a 10%, transparent)}
  .composer-order-item[data-status="removed"]{border-color:color-mix(in srgb,#dc2626 55%, var(--border));background:color-mix(in srgb,#dc2626 10%, transparent)}
  .composer-order-index{font-weight:700;font-size:.84rem;color:color-mix(in srgb,var(--text) 70%, transparent);min-width:2.3rem}
  .composer-order-key{flex:1 1 auto;min-width:0;font-family:var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace);font-size:.9rem;color:var(--text);word-break:break-word}
  .composer-order-badge{margin-left:auto;font-size:.78rem;color:color-mix(in srgb,var(--text) 62%, transparent);font-weight:600}
  .composer-order-badge.is-hidden{display:none}
  .composer-order-lines{position:absolute;inset:0;pointer-events:none;overflow:visible;z-index:0}
  .composer-order-path{fill:none;stroke-width:2.6;opacity:.78;stroke-linecap:round;stroke-linejoin:round}
  .composer-order-path[data-status="same"]{stroke:#94a3b8;stroke-dasharray:6 6;opacity:.35}
  .composer-order-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;font-size:.95rem;color:var(--muted);pointer-events:none;padding:1rem}
  .composer-order-visual.is-empty .composer-order-lines{display:none}
  .composer-order-visual.is-empty .composer-order-columns{opacity:.15}
  @media (max-width:860px){
    .composer-order-columns{grid-template-columns:1fr;gap:1.8rem}
    .composer-order-lines{display:none}
    .composer-order-visual{padding:.4rem 1.2rem 1.4rem}
    .composer-order-item{padding:.32rem .55rem}
  }

  /* Modal animations */
  @keyframes nsModalFadeIn { from { opacity: 0 } to { opacity: 1 } }
  @keyframes nsModalFadeOut { from { opacity: 1 } to { opacity: 0 } }
  @keyframes nsModalSlideIn { from { transform: translateY(10px) scale(.98); opacity: 0 } to { transform: translateY(0) scale(1); opacity: 1 } }
  @keyframes nsModalSlideOut { from { transform: translateY(0) scale(1); opacity: 1 } to { transform: translateY(8px) scale(.98); opacity: 0 } }
  .ns-modal.ns-anim-in { animation: nsModalFadeIn 160ms ease both; }
  .ns-modal.ns-anim-out { animation: nsModalFadeOut 160ms ease both; }
  .ns-modal.ns-anim-in .ns-modal-dialog { animation: nsModalSlideIn 200ms cubic-bezier(.2,.95,.4,1) both; }
  .ns-modal.ns-anim-out .ns-modal-dialog { animation: nsModalSlideOut 160ms ease both; }
  @media (prefers-reduced-motion: reduce){
    .ns-modal.ns-anim-in,
    .ns-modal.ns-anim-out,
    .ns-modal.ns-anim-in .ns-modal-dialog,
    .ns-modal.ns-anim-out .ns-modal-dialog { animation: none !important; }
  }
  `;
  const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s);
})();
