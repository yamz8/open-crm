export type DomainEvent = {
  id: string;
  type: string; // e.g. "contact.created", "deal.stage_changed"
  at: string;
  actor: { type: string; id: string | null; label: string };
  source: string;
  entity_type: string;
  entity_id: string;
  data: Record<string, unknown>;
};

export type EventHandler = (event: DomainEvent) => void;

const handlers = new Set<EventHandler>();

export function onDomainEvent(handler: EventHandler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

/**
 * Handlers are intentionally fire-and-forget and never throw into the caller: a
 * broken webhook subscriber must not roll back a legitimate CRM write.
 */
export function emitDomainEvent(event: DomainEvent): void {
  for (const handler of handlers) {
    try {
      handler(event);
    } catch {
      // Swallowed on purpose; delivery failures are recorded by the webhook worker.
    }
  }
}

export function resetDomainEventHandlers(): void {
  handlers.clear();
}
