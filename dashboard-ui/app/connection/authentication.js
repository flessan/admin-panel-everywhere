import { requireValue } from './errors.js';

/** Runtime-only session. No storage, environment reads, logging, or serializable secret. */
export function createBearerAuthentication(initialCredential) {
  requireValue(typeof initialCredential === 'string' && /^[\x21-\x7e]+$/.test(initialCredential), 'invalid_configuration');
  let credential = initialCredential;
  return {
    getCredential: () => credential,
    public: Object.freeze({
      type: 'bearer',
      // Configured does NOT mean the server has verified project access or scopes.
      get configured() { return credential !== null; },
      clear() { credential = null; },
    }),
  };
}
