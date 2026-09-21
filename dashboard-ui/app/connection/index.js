// Public, browser-compatible entry point. A host application supplies runtime config
// and selects a connector; view modules depend only on the Connection contract.
export { defineConnection } from './contract.js';
export { ConnectionError } from './errors.js';
export { getActiveConnection, setActiveConnection, onConnectionChange } from './active.js';
