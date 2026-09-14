import { api } from '../api.js';

export const rules = () => api('/haul/rules');
export const current = () => api('/haul');
export const start = () => api('/haul/start', { method: 'POST' });
export const end = (abandon = false) => api('/haul/end', { method: 'POST', body: { abandon } });
export const buy = (good, qty) => api('/haul/buy', { method: 'POST', body: { good, qty } });
export const sell = (good, qty) => api('/haul/sell', { method: 'POST', body: { good, qty } });
export const travel = (to) => api('/haul/travel', { method: 'POST', body: { to } });
export const repay = (amount) => api('/haul/repay', { method: 'POST', body: { amount } });
export const upgrade = () => api('/haul/upgrade', { method: 'POST' });
export const board = () => api('/haul/board');
export const history = () => api('/haul/history');
