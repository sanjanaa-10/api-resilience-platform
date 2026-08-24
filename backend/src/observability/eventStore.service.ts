import type { EventSeverity, EventType, ResilienceEvent } from './events';

export interface EventQuery {
  service?: string;
  eventType?: EventType;
  severity?: EventSeverity;
  limit?: number;
}

/**
 * Bounded in-memory ring of resilience events.
 *
 * Retention policy: the NEWEST events are always kept — when capacity is
 * exceeded the oldest are evicted (splice from the front). Reads return
 * newest-first so dashboards can simply take the head of the list.
 */
export class ResilienceEventStore {
  private events: ResilienceEvent[] = [];

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`EventStore capacity must be a positive integer, got ${capacity}.`);
    }
  }

  get size(): number {
    return this.events.length;
  }

  append(event: ResilienceEvent): void {
    this.events.push(event);
    if (this.events.length > this.capacity) {
      this.events.splice(0, this.events.length - this.capacity);
    }
  }

  /** Newest-first filtered view. limit defaults to 100 and is capacity-capped. */
  list(query: EventQuery = {}): ResilienceEvent[] {
    const filtered = this.events.filter(
      (event) =>
        (query.service === undefined || event.service === query.service) &&
        (query.eventType === undefined || event.eventType === query.eventType) &&
        (query.severity === undefined || event.severity === query.severity),
    );
    const limit = Math.min(Math.max(query.limit ?? 100, 1), this.capacity);
    return filtered.slice(-limit).reverse();
  }
}
