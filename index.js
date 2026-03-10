const path = require('path');
const { app } = require('electron');
const url = require('url');

let pluginApi = null;

function fileUrl(p) { return url.pathToFileURL(p).href; }

function emitUpdate(channel, target, value) { try { pluginApi.emit(channel, { type: 'update', target, value }); } catch (e) {} }

const EVENT_CHANNEL = 'duty-easy-channel';
let state = { mode: 'preview', paths: {} };

function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function dow(date) { const d = new Date(date); return d.getDay(); }

function ensureDefaults() {
  if (!pluginApi) return;
  const defaults = {
    roles: ['清洁', '黑板', '值日生'],
    groups: [
      { name: '一组', roles: { '清洁': [], '黑板': [], '值日生': [] } },
      { name: '二组', roles: { '清洁': [], '黑板': [], '值日生': [] } }
    ],
    rule: {
      mode: 'list',
      currentGroupIndex: 0,
      weekdayMap: { 0: 0, 1: 0, 2: 1, 3: 1, 4: 2, 5: 2, 6: 0 },
      mainMode: 'group',
      singleRoleIndices: {},
      dynamicIndices: {},
      dynamicActiveRole: {},
      dynamicDailyCount: { '值日生': 2 }
    },
    dynamicRoles: [],
    singleRoles: ['清洁', '黑板', '值日生'],
    singleRoleLists: {},
    singleRoleConditions: {},
    lastStartupDate: ''
  };
  try {
    const current = pluginApi.store.getAll() || {};
    let changed = false;
    Object.keys(defaults).forEach((k) => {
      if (!(k in current)) {
        current[k] = defaults[k];
        changed = true;
      }
    });
    if (changed) pluginApi.store.setAll(current);
  } catch (e) {}
}

function advanceOnStartup() {
  ensureDefaults();
  if (!pluginApi) return;
  const cfg = pluginApi.store.getAll();
  const today = todayISO();
  const last = cfg.lastStartupDate || '';
  if (last !== today) {
    const groups = Array.isArray(cfg.groups) ? cfg.groups : [];
    const rule = cfg.rule || {};
    let nextRule = { ...rule };
    let gi = Number.isFinite(rule.currentGroupIndex) ? rule.currentGroupIndex : 0;
    if ((rule.mode || 'list') === 'list') {
      gi = groups.length ? (gi + 1) % groups.length : 0;
    } else {
      const map = rule.weekdayMap || {};
      const idx = map[dow(today)];
      gi = Number.isFinite(idx) ? idx : 0;
    }
    const dynRoles = Array.isArray(cfg.dynamicRoles) ? cfg.dynamicRoles : [];
    const dynActive = typeof rule.dynamicActiveRole === 'object' && rule.dynamicActiveRole ? rule.dynamicActiveRole : {};
    const dynIdx = typeof rule.dynamicIndices === 'object' && rule.dynamicIndices ? { ...rule.dynamicIndices } : {};
    const dynamicMode = rule.dynamicMode || 'multi';
    
    if (dynamicMode === 'single') {
      dynRoles.forEach((rDyn) => {
        groups.forEach((groupObj, groupIndex) => {
          const giKey = String(groupIndex);
          const perIdx = typeof dynIdx[giKey] === 'object' && dynIdx[giKey] ? { ...dynIdx[giKey] } : {};
          const perGroupActive = typeof dynActive[giKey] === 'object' && dynActive[giKey] ? dynActive[giKey] : {};
          const activeRole = String(perGroupActive[rDyn] || '');
          if (!activeRole) return;
          const arr = Array.isArray(groupObj.roles?.[activeRole]) ? groupObj.roles[activeRole] : [];
          if (!arr.length) return;
          const base = Number.isFinite(perIdx[rDyn]) ? perIdx[rDyn] : 0;
          perIdx[rDyn] = (base + 1) % arr.length;
          dynIdx[giKey] = perIdx;
        });
      });
    } else {
      const giKey = String(gi);
      const perIdx = typeof dynIdx[giKey] === 'object' && dynIdx[giKey] ? { ...dynIdx[giKey] } : {};
      const groupObj = groups[gi] || { roles: {} };
      dynRoles.forEach((rDyn) => {
        const perGroupActive = typeof dynActive[giKey] === 'object' && dynActive[giKey] ? dynActive[giKey] : {};
        const activeRole = String(perGroupActive[rDyn] || '');
        if (!activeRole) return;
        const arr = Array.isArray(groupObj.roles?.[activeRole]) ? groupObj.roles[activeRole] : [];
        if (!arr.length) return;
        const base = Number.isFinite(perIdx[rDyn]) ? perIdx[rDyn] : 0;
        perIdx[rDyn] = (base + 1) % arr.length;
      });
      dynIdx[giKey] = perIdx;
    }
    
    nextRule = { ...nextRule, currentGroupIndex: gi, dynamicIndices: dynIdx };
    const roles = Array.isArray(cfg.singleRoles) ? cfg.singleRoles : (Array.isArray(cfg.roles) ? cfg.roles : []);
    const indices = typeof rule.singleRoleIndices === 'object' && rule.singleRoleIndices ? { ...rule.singleRoleIndices } : {};
    roles.forEach(r => {
      const arr = Array.isArray(cfg.singleRoleLists?.[r]) ? cfg.singleRoleLists[r] : [];
      const cur = Number.isFinite(indices[r]) ? indices[r] : 0;
      indices[r] = arr.length ? (cur + 1) % arr.length : 0;
    });
    nextRule = { ...nextRule, currentGroupIndex: gi, singleRoleIndices: indices };
    pluginApi.store.set('rule', nextRule);
    pluginApi.store.set('lastStartupDate', today);
  }
}

function predict(startOffset, nextDays) {
  ensureDefaults();
  if (!pluginApi) return [];
  const cfg = pluginApi.store.getAll();
  const groups = Array.isArray(cfg.groups) ? cfg.groups : [];
  const rolesAll = Array.isArray(cfg.roles) ? cfg.roles : [];
  const dynRoles = Array.isArray(cfg.dynamicRoles) ? cfg.dynamicRoles : [];
  const singleRoles = Array.isArray(cfg.singleRoles) ? cfg.singleRoles : rolesAll;
  const rule = cfg.rule || {};
  const baseDate = new Date(todayISO());
  baseDate.setDate(baseDate.getDate() + startOffset);
  const out = [];
  function weekNumberISO(dateStr){ const d=new Date(dateStr); const dd=new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())); const day=(dd.getUTCDay()+6)%7; dd.setUTCDate(dd.getUTCDate()-day+3); const firstThursday=new Date(Date.UTC(dd.getUTCFullYear(),0,4)); const diff=dd-firstThursday; return 1+Math.round(diff/604800000); }
  function matchCond(dateStr, cond){ if(!cond||typeof cond!=='object') return true; const wk=weekNumberISO(dateStr); const isOdd=(wk%2)===1; if(cond.mode==='odd' && !isOdd) return false; if(cond.mode==='even' && isOdd) return false; const d=new Date(dateStr).getDay(); const d17=d===0?7:d; const arr=Array.isArray(cond.weekdays)?cond.weekdays:[]; if(arr.length){ return arr.includes(d17); } return true; }
  const dynActive = typeof rule.dynamicActiveRole === 'object' && rule.dynamicActiveRole ? rule.dynamicActiveRole : {};
  const dynIdx = typeof rule.dynamicIndices === 'object' && rule.dynamicIndices ? rule.dynamicIndices : {};
  const dynamicMode = rule.dynamicMode || 'multi';
  
  for (let i = 0; i < nextDays; i++) {
    const d = new Date(baseDate.getTime() + i * 24 * 60 * 60 * 1000);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const dateISO = `${yyyy}-${mm}-${dd}`;
    let gi = Number.isFinite(rule.currentGroupIndex) ? rule.currentGroupIndex : 0;
    
    // 单组连续轮值模式下，预览直接显示当前组
    if (dynamicMode !== 'single') {
      if ((rule.mode || 'list') === 'list') {
        gi = groups.length ? (gi + i) % groups.length : 0;
      } else {
        const map = rule.weekdayMap || {};
        const idx = map[d.getDay()];
        gi = Number.isFinite(idx) ? idx : 0;
      }
    }
    
    const group = groups[gi] || { name: '', roles: {} };
    const groupMembers = {};
    const dynStatus = {};
    
    rolesAll.forEach((rDyn) => {
      const isDyn = dynRoles.includes(rDyn);
      if (!isDyn) {
        groupMembers[rDyn] = Array.isArray(group.roles?.[rDyn]) ? group.roles[rDyn] : [];
        return;
      }
      const giKey = String(gi);
      const perGroup = typeof dynActive[giKey] === 'object' && dynActive[giKey] ? dynActive[giKey] : {};
      const activeRole = String(perGroup[rDyn] || '');
      if (!activeRole) {
        groupMembers[rDyn] = [];
        dynStatus[rDyn] = 'none';
        return;
      }
      const arr = Array.isArray(group.roles?.[activeRole]) ? group.roles[activeRole] : [];
      if (!arr.length) { groupMembers[rDyn] = []; dynStatus[rDyn] = 'empty'; return; }
      dynStatus[rDyn] = 'active';
      
      if (dynamicMode === 'single') {
        const base = Number.isFinite(dynIdx[giKey]?.[rDyn]) ? dynIdx[giKey][rDyn] : 0;
        groupMembers[rDyn] = [arr[base]];
      } else {
        groupMembers[rDyn] = arr.slice();
      }
    });
    
    const lists = typeof cfg.singleRoleLists === 'object' && cfg.singleRoleLists ? cfg.singleRoleLists : {};
    const indices = typeof rule.singleRoleIndices === 'object' && rule.singleRoleIndices ? rule.singleRoleIndices : {};
    const conds = typeof cfg.singleRoleConditions === 'object' && cfg.singleRoleConditions ? cfg.singleRoleConditions : {};
    const singleMembers = {};
    singleRoles.forEach((r) => {
      const arr = Array.isArray(lists[r]) ? lists[r] : [];
      const base = Number.isFinite(indices[r]) ? indices[r] : 0;
      const cond = conds[r] || null;
      const canShow = matchCond(dateISO, cond);
      const pick = arr.length && canShow ? arr[(base + i) % arr.length] : undefined;
      singleMembers[r] = pick ? [pick] : [];
    });
    out.push({ dateISO, groupIndex: gi, groupName: group.name || '', rolesGroup: rolesAll, groupMembers, dynStatus, rolesSingle: singleRoles, singleMembers });
  }
  return out;
}

const functions = {
  openDuty: async () => {
    state.paths.preview = fileUrl(path.join(__dirname, 'pages', 'preview.html')) + `?channel=${encodeURIComponent(EVENT_CHANNEL)}&caller=${encodeURIComponent('duty-easy')}`;
    state.paths.roles = fileUrl(path.join(__dirname, 'pages', 'roles-list.html')) + `?channel=${encodeURIComponent(EVENT_CHANNEL)}&caller=${encodeURIComponent('duty-easy')}`;
    state.paths.groups = fileUrl(path.join(__dirname, 'pages', 'groups-list.html')) + `?channel=${encodeURIComponent(EVENT_CHANNEL)}&caller=${encodeURIComponent('duty-easy')}`;
    state.paths.rules = fileUrl(path.join(__dirname, 'pages', 'rules.html')) + `?channel=${encodeURIComponent(EVENT_CHANNEL)}&caller=${encodeURIComponent('duty-easy')}`;
    state.paths.grid = fileUrl(path.join(__dirname, 'pages', 'grid.html')) + `?channel=${encodeURIComponent(EVENT_CHANNEL)}&caller=${encodeURIComponent('duty-easy')}`;
    state.paths.rotation = fileUrl(path.join(__dirname, 'pages', 'rotation.html')) + `?channel=${encodeURIComponent(EVENT_CHANNEL)}&caller=${encodeURIComponent('duty-easy')}`;
    const bg = state.paths.preview;
    const params = {
      title: '轻松值日',
      eventChannel: EVENT_CHANNEL,
      subscribeTopics: [EVENT_CHANNEL, 'profiles-selector-channel'],
      callerPluginId: 'duty-easy',
      backgroundUrl: bg,
      floatingUrl: null,
      leftItems: [
        { id: 'save', text: '保存设置', icon: 'ri-save-3-line' }
      ],
      centerItems: [
        { id: 'view-preview', text: '预览', icon: 'ri-calendar-check-line', active: true },
        { id: 'view-grid', text: '组别分工', icon: 'ri-team-line', active: false },
        { id: 'view-rotation', text: '轮值', icon: 'ri-user-star-line', active: false }
      ]
    };
    await pluginApi.call('ui-lowbar', 'openTemplate', [params]);
    return true;
  },
  showDutyOverlay: async () => {
    ensureDefaults();
    const list = predict(0, 1);
    const today = Array.isArray(list) && list.length ? list[0] : null;
    if (!today) return false;
    const members = [];
    const rs = Array.isArray(today.rolesSingle) ? today.rolesSingle : [];
    rs.forEach((r) => {
      const arr = Array.isArray(today.singleMembers && today.singleMembers[r]) ? today.singleMembers[r] : [];
      if (arr.length) { members.push(`${r}: ${arr.join('、')}`); }
    });
    const rg = Array.isArray(today.rolesGroup) ? today.rolesGroup : [];
    rg.forEach((r) => {
      const arr = Array.isArray(today.groupMembers && today.groupMembers[r]) ? today.groupMembers[r] : [];
      if (arr.length) { members.push(`${r}: ${arr.join('、')}`); }
    });
    const title = '今日值日生提醒';
    const subText = `日期：${today.dateISO}\n组别：${today.groupName}\n${members.join('\n')}`;
    await pluginApi.call('notify-plugin', 'overlay', [title, subText, true, 120000, true, 3000]);
    return true;
  },
  onLowbarEvent: async (payload = {}) => {
    try {
      if (payload?.type === 'left.click') {
        if (payload.id === 'save') emitUpdate(EVENT_CHANNEL, 'duty.save', true);
      } else if (payload?.type === 'click') {
        if (payload.id === 'view-preview') { state.mode = 'preview'; emitUpdate(EVENT_CHANNEL, 'centerItems', [
          { id: 'view-preview', text: '预览', icon: 'ri-calendar-check-line', active: true },
          { id: 'view-grid', text: '组别分工', icon: 'ri-team-line', active: false },
          { id: 'view-rotation', text: '轮值', icon: 'ri-user-star-line', active: false }
        ]); emitUpdate(EVENT_CHANNEL, 'backgroundUrl', state.paths.preview); }
        if (payload.id === 'view-rules') { state.mode = 'rules'; emitUpdate(EVENT_CHANNEL, 'centerItems', [
          { id: 'view-preview', text: '预览', icon: 'ri-calendar-check-line', active: false },
          { id: 'view-rules', text: '分工规则', icon: 'ri-settings-3-line', active: true },
          { id: 'view-grid', text: '组别分工', icon: 'ri-team-line', active: false }
        ]); emitUpdate(EVENT_CHANNEL, 'backgroundUrl', state.paths.rules); }
        if (payload.id === 'view-grid') { state.mode = 'grid'; emitUpdate(EVENT_CHANNEL, 'centerItems', [
          { id: 'view-preview', text: '预览', icon: 'ri-calendar-check-line', active: false },
          { id: 'view-grid', text: '组别分工', icon: 'ri-team-line', active: true },
          { id: 'view-rotation', text: '轮值', icon: 'ri-user-star-line', active: false }
        ]); emitUpdate(EVENT_CHANNEL, 'backgroundUrl', state.paths.grid); }
        if (payload.id === 'view-rotation') { state.mode = 'rotation'; emitUpdate(EVENT_CHANNEL, 'centerItems', [
          { id: 'view-preview', text: '预览', icon: 'ri-calendar-check-line', active: false },
          { id: 'view-grid', text: '组别分工', icon: 'ri-team-line', active: false },
          { id: 'view-rotation', text: '轮值', icon: 'ri-user-star-line', active: true }
        ]); emitUpdate(EVENT_CHANNEL, 'backgroundUrl', state.paths.rotation); }
      }
      return true;
    } catch (e) { return { ok: false, error: e?.message || String(e) }; }
  },
  getConfig: async () => {
    try { ensureDefaults(); return { ok: true, config: pluginApi.store.getAll() }; } catch (e) { return { ok: false, error: e?.message || String(e) }; }
  },
  saveConfig: async (payload = {}) => {
    try {
      ensureDefaults();
      if (Array.isArray(payload.roles)) pluginApi.store.set('roles', payload.roles);
      if (Array.isArray(payload.groups)) pluginApi.store.set('groups', payload.groups);
      if (payload.rule && typeof payload.rule === 'object') pluginApi.store.set('rule', payload.rule);
      if (Array.isArray(payload.dynamicRoles)) pluginApi.store.set('dynamicRoles', payload.dynamicRoles);
      if (payload.singleRoleLists && typeof payload.singleRoleLists === 'object') pluginApi.store.set('singleRoleLists', payload.singleRoleLists);
      if (Array.isArray(payload.singleRoles)) pluginApi.store.set('singleRoles', payload.singleRoles);
      if (payload.singleRoleConditions && typeof payload.singleRoleConditions === 'object') pluginApi.store.set('singleRoleConditions', payload.singleRoleConditions);
      return { ok: true };
    } catch (e) { return { ok: false, error: e?.message || String(e) }; }
  },
  getPreview: async () => {
    try { return { ok: true, list: predict(-2, 8) }; } catch (e) { return { ok: false, error: e?.message || String(e) }; }
  },
  offsetGroup: async (payload = {}) => {
    try {
      ensureDefaults();
      const cfg = pluginApi.store.getAll();
      const groups = Array.isArray(cfg.groups) ? cfg.groups : [];
      const rule = cfg.rule || {};
      const delta = payload.delta || 1;
      const dynRoles = Array.isArray(cfg.dynamicRoles) ? cfg.dynamicRoles : [];
      const dynActive = typeof rule.dynamicActiveRole === 'object' && rule.dynamicActiveRole ? rule.dynamicActiveRole : {};
      const dynIdx = typeof rule.dynamicIndices === 'object' && rule.dynamicIndices ? { ...rule.dynamicIndices } : {};
      const dynamicMode = rule.dynamicMode || 'multi';
      
      if (dynamicMode === 'single') {
        let gi = Number.isFinite(rule.currentGroupIndex) ? rule.currentGroupIndex : 0;
        const giKey = String(gi);
        const perIdx = typeof dynIdx[giKey] === 'object' && dynIdx[giKey] ? { ...dynIdx[giKey] } : {};
        const groupObj = groups[gi] || { roles: {} };
        
        let canMoveInGroup = false;
        dynRoles.forEach((rDyn) => {
          const perGroupActive = typeof dynActive[giKey] === 'object' && dynActive[giKey] ? dynActive[giKey] : {};
          const activeRole = String(perGroupActive[rDyn] || '');
          if (!activeRole) return;
          const arr = Array.isArray(groupObj.roles?.[activeRole]) ? groupObj.roles[activeRole] : [];
          if (!arr.length) return;
          const cur = Number.isFinite(perIdx[rDyn]) ? perIdx[rDyn] : 0;
          const nextIdx = cur + delta;
          if (nextIdx >= 0 && nextIdx < arr.length) {
            canMoveInGroup = true;
          }
        });
        
        if (canMoveInGroup) {
          dynRoles.forEach((rDyn) => {
            const perGroupActive = typeof dynActive[giKey] === 'object' && dynActive[giKey] ? dynActive[giKey] : {};
            const activeRole = String(perGroupActive[rDyn] || '');
            if (!activeRole) return;
            const arr = Array.isArray(groupObj.roles?.[activeRole]) ? groupObj.roles[activeRole] : [];
            if (!arr.length) return;
            const cur = Number.isFinite(perIdx[rDyn]) ? perIdx[rDyn] : 0;
            const nextIdx = cur + delta;
            if (nextIdx >= 0 && nextIdx < arr.length) {
              perIdx[rDyn] = nextIdx;
            }
          });
          dynIdx[giKey] = perIdx;
          const newRule = { ...rule, dynamicIndices: dynIdx };
          pluginApi.store.set('rule', newRule);
        } else {
          const len = groups.length || 1;
          const newGi = ((gi + delta) % len + len) % len;
          const newGiKey = String(newGi);
          const newPerIdx = typeof dynIdx[newGiKey] === 'object' && dynIdx[newGiKey] ? { ...dynIdx[newGiKey] } : {};
          
          dynRoles.forEach((rDyn) => {
            const perGroupActive = typeof dynActive[newGiKey] === 'object' && dynActive[newGiKey] ? dynActive[newGiKey] : {};
            const activeRole = String(perGroupActive[rDyn] || '');
            if (!activeRole) return;
            const newGroupObj = groups[newGi] || { roles: {} };
            const arr = Array.isArray(newGroupObj.roles?.[activeRole]) ? newGroupObj.roles[activeRole] : [];
            if (!arr.length) return;
            newPerIdx[rDyn] = delta > 0 ? 0 : arr.length - 1;
          });
          
          dynIdx[newGiKey] = newPerIdx;
          const newRule = { ...rule, currentGroupIndex: newGi, dynamicIndices: dynIdx };
          pluginApi.store.set('rule', newRule);
        }
      } else {
        let gi = Number.isFinite(rule.currentGroupIndex) ? rule.currentGroupIndex : 0;
        const len = groups.length || 1;
        gi = ((gi + delta) % len + len) % len;
        const newRule = { ...rule, currentGroupIndex: gi };
        pluginApi.store.set('rule', newRule);
      }
      return { ok: true };
    } catch (e) { return { ok: false, error: e?.message || String(e) }; }
  },
  offsetSingle: async (payload = {}) => {
    try {
      ensureDefaults();
      const cfg = pluginApi.store.getAll();
      const rule = cfg.rule || {};
      const roles = Array.isArray(cfg.singleRoles) ? cfg.singleRoles : (Array.isArray(cfg.roles) ? cfg.roles : []);
      const lists = typeof cfg.singleRoleLists === 'object' && cfg.singleRoleLists ? cfg.singleRoleLists : {};
      const indices = typeof rule.singleRoleIndices === 'object' && rule.singleRoleIndices ? { ...rule.singleRoleIndices } : {};
      const delta = payload.delta || 1;
      roles.forEach(r => {
        const arr = Array.isArray(lists[r]) ? lists[r] : [];
        if (!arr.length) return;
        const cur = Number.isFinite(indices[r]) ? indices[r] : 0;
        indices[r] = ((cur + delta) % arr.length + arr.length) % arr.length;
      });
      const newRule = { ...rule, singleRoleIndices: indices };
      pluginApi.store.set('rule', newRule);
      return { ok: true };
    } catch (e) { return { ok: false, error: e?.message || String(e) }; }
  },
  offsetAll: async (payload = {}) => {
    try {
      await functions.offsetGroup(payload);
      await functions.offsetSingle(payload);
      return { ok: true };
    } catch (e) { return { ok: false, error: e?.message || String(e) }; }
  }
};

const init = async (api) => {
  pluginApi = api;
  api.splash.setStatus('plugin:init', '初始化 轻松值日');
  ensureDefaults();
  advanceOnStartup();
  api.splash.progress('plugin:init', '轻松值日就绪');
};

module.exports = {
  name: 'duty-easy',
  version: '1.0.0',
  description: '轻松值日（底栏模板）',
  init,
  functions: {
    ...functions,
    getVariable: async (name) => { const k=String(name||''); if (k==='timeISO') return new Date().toISOString(); if (k==='pluginName') return '轻松值日'; return ''; },
    listVariables: () => ['timeISO','pluginName']
  }
}
