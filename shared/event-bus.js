/**
 * IES Hub v3 — Event Bus
 * Pub/sub for cross-tool communication.
 * Replaces v2's tight coupling between modules.
 *
 * Usage:
 *   import { bus } from './event-bus.js?v=20260417-mG';
 *   const off = bus.on('cm:model-saved', (data) => { ... });
 *   bus.emit('cm:model-saved', { modelId: 7 });
 *   off(); // unsubscribe
 *
 * Conventions:
 *   Event names use "source:action" format:
 *     cm:model-saved, wsc:facility-updated, deal:stage-changed
 *   Wildcard listeners:
 *     bus.on('cm:*', handler)  — catches all cm: events
 *
 * @module shared/event-bus
 */

/** @typedef {(data: any) => void} EventHandler */

class EventBus {
  constructor() {
    /** @type {Map<string, Set<EventHandler>>} */
    this._listeners = new Map();
    /** @type {Map<string, Set<EventHandler>>} */
    this._wildcards = new Map();
  }

  /**
   * Subscribe to an event.
   * @param {string} event — event name or "prefix:*" wildcard
   * @param {EventHandler} handler
   * @returns {() => void} unsubscribe function
   */
  on(event, handler) {
    if (typeof handler !== 'function') {
      throw new TypeError('Event handler must be a function');
    }

    if (event.endsWith(':*')) {
      const prefix = event.slice(0, -1); // keep the colon: "cm:"
      if (!this._wildcards.has(prefix)) {
        this._wildcards.set(prefix, new Set());
      }
      this._wildcards.get(prefix).add(handler);
      return () => this._wildcards.get(prefix)?.delete(handler);
    }

    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(handler);
    return () => this._listeners.get(event)?.delete(handler);
  }

  /**
   * Subscribe to an event, auto-unsubscribe after first call.
   * @param {string} event
   * @param {EventHandler} handler
   * @returns {() => void} unsubscribe function
   */
  once(event, handler) {
    const off = this.on(event, (data) => {
      off();
      handler(data);
    });
    return off;
  }

  /**
   * Emit an event to all listeners.
   * @param {string} event
   * @param {*} [data]
   */
  emit(event, data) {
    // Exact match listeners
    const handlers = this._listeners.get(event);
    if (handlers) {
      for (const fn of handlers) {
        try { fn(data); }
        catch (err) { console.error(`[EventBus] Error in handler for "${event}":`, err); }
      }
    }

    // Wildcard listeners — match "cm:" prefix against "cm:model-saved"
    const colonIdx = event.indexOf(':');
    if (colonIdx > 0) {
      const prefix = event.slice(0, colonIdx + 1);
      const wildcardHandlers = this._wildcards.get(prefix);
      if (wildcardHandlers) {
        for (const fn of wildcardHandlers) {
          try { fn({ event, data }); }
          catch (err) { console.error(`[EventBus] Error in wildcard handler for "${prefix}*":`, err); }
        }
      }
    }
  }

  /**
   * Remove all listeners (useful for testing/teardown).
   */
  clear() {
    this._listeners.clear();
    this._wildcards.clear();
  }

  /**
   * Debug: list all registered events and their listener counts.
   * @returns {Object<string, number>}
   */
  debug() {
    const result = {};
    for (const [event, handlers] of this._listeners) {
      result[event] = handlers.size;
    }
    for (const [prefix, handlers] of this._wildcards) {
      result[prefix + '*'] = handlers.size;
    }
    return result;
  }
}

/** Singleton event bus instance */
export const bus = new EventBus();

export { EventBus };
