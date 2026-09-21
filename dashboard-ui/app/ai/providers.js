import { AiInputError } from './tasks.js';

/** Trusted, locally installed adapters only. No vendor SDK, endpoint or key is built in. */
export function createProviderRegistry() {
  const providers = new Map(), listeners = new Set();
  const list = () => [...providers.values()].map(({ id, label }) => ({ id, label }));
  const emit = () => { for (const listener of listeners) listener(list()); };
  return {
    register({ id, label, generate } = {}) {
      if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(id) || id === 'manual' || providers.has(id) || typeof label !== 'string' || !label.trim() || label.length > 100 || typeof generate !== 'function') throw new AiInputError('Invalid or duplicate AI provider registration.');
      const adapter = Object.freeze({ id, label, generate }); providers.set(id, adapter); emit();
      return () => { if (providers.get(id) === adapter) { providers.delete(id); emit(); } };
    },
    list, get: id => providers.get(id) ?? null,
    subscribe(listener) { listeners.add(listener); listener(list()); return () => listeners.delete(listener); },
  };
}
export const aiProviders = createProviderRegistry();
