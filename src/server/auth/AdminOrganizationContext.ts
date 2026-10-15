import { AsyncLocalStorage } from 'node:async_hooks';

export interface AdminOrganizationContext {
  actorId: string;
  organizationId: string;
}

/** Request-local scope, never an impersonated identity or a durable membership. */
export const adminOrganizationContext = new AsyncLocalStorage<
  AdminOrganizationContext | undefined
>();

export function readAdminOrganizationId(actorId: string): string | null {
  const context = adminOrganizationContext.getStore();
  return context?.actorId === actorId ? context.organizationId : null;
}
