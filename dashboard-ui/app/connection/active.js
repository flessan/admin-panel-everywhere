import { ConnectionError } from './errors.js';
import { defineConnection } from './contract.js';

let active = null;
const listeners = new Set();

export function setActiveConnection(connection) {
  if (connection !== null) defineConnection(connection);
  if (active === connection) return;
  active?.disconnect();
  active = connection;
  for (const listener of listeners) listener(active);
}

export function getActiveConnection() {
  if (!active) throw new ConnectionError('not_connected');
  return active;
}

export function onConnectionChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
