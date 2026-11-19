import steps from './priority-steps.json' with { type: 'json' };

const windows = Object.keys(steps);
const savedWindows = new Set([...windows, 'every']);

function selectedWindows(value) {
  if (!Array.isArray(value) || value.length > savedWindows.size ||
      !value.every(step => savedWindows.has(step)) || new Set(value).size !== value.length) {
    throw new Error('Invalid priority stop.');
  }
  // Older accounts and replay positions may still request every window on either side.
  return value.includes('every') ? [...windows] : windows.filter(step => value.includes(step));
}

export function encodePriority(value) {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 2) throw new Error('Invalid priority stop.');
  return 'v2:' + [value.own, value.opponent].map(list => selectedWindows(list).join(',')).join(':');
}

export function decodePriority(token) {
  if (typeof token !== 'string') throw new Error('Invalid priority stop.');
  if (token.startsWith('v2:')) {
    const parts = token.split(':');
    if (parts.length !== 3) throw new Error('Invalid priority stop.');
    const list = value => selectedWindows(value ? value.split(',') : []);
    return {own:list(parts[1]),opponent:list(parts[2])};
  }
  if (token === 'auto' || token === 'next') return {own:[],opponent:[]};
  const selected = selectedWindows([token === 'full' ? 'every' : token]);
  return {own:selected,opponent:[...selected]};
}

export function validPriorityToken(token) {
  try { decodePriority(token); return true; } catch { return false; }
}
