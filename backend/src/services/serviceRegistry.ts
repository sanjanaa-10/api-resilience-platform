import type { ServiceName, ServiceRegistration } from '../types';

/**
 * Typed runtime access layer over the static registrations.
 * Guarantees uniqueness and gives the rest of the system a single
 * read-only view of upstream topology.
 */
export class ServiceRegistry {
  private readonly services = new Map<ServiceName, ServiceRegistration>();

  constructor(registrations: readonly ServiceRegistration[]) {
    for (const registration of registrations) {
      if (this.services.has(registration.name)) {
        throw new Error(`Duplicate service registration: ${registration.name}`);
      }
      this.services.set(registration.name, registration);
    }
  }

  list(): ServiceRegistration[] {
    return [...this.services.values()];
  }

  get(name: ServiceName): ServiceRegistration | undefined {
    return this.services.get(name);
  }

  get size(): number {
    return this.services.size;
  }
}
