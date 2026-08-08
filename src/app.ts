import { loadConfig, type AppConfig } from './core/config.ts';
import { migrate, openDatabase, type Db } from './db/index.ts';
import {
  createContext,
  SYSTEM_ACTOR,
  type Actor,
  type Ctx,
  type Source,
} from './domain/context.ts';
import { onDomainEvent } from './domain/events.ts';
import { enqueueEvent, flushDeliveries } from './domain/webhooks.ts';
import { purgeExpiredSessions } from './domain/auth.ts';
import { purgeIdempotencyKeys } from './domain/idempotency.ts';
import { ensureDefaultPipeline } from './domain/pipelines.ts';

export type App = {
  config: AppConfig;
  db: Db;
  /** Build a request-scoped context. Every entry point (HTTP, MCP, CLI) uses this. */
  context: (
    actor: Actor,
    source: Source,
    options?: { requestId?: string; idempotencyKey?: string },
  ) => Ctx;
  systemContext: (source?: Source) => Ctx;
  /** Runs webhook delivery and housekeeping once. Exposed so tests can drive it. */
  tick: () => Promise<void>;
  startBackgroundWork: () => void;
  close: () => void;
};

export type CreateAppOptions = {
  config?: Partial<AppConfig>;
  /** Skip installing the default pipeline (tests that assert on an empty instance). */
  skipBootstrap?: boolean;
};

export function createApp(options: CreateAppOptions = {}): App {
  const config = loadConfig(options.config);
  const db = openDatabase(config.databaseUrl);
  migrate(db);

  const context: App['context'] = (actor, source, opts = {}) =>
    createContext(db, actor, source, opts);
  const systemContext: App['systemContext'] = (source = 'system') =>
    createContext(db, SYSTEM_ACTOR, source);

  if (!options.skipBootstrap) {
    ensureDefaultPipeline(systemContext());
  }

  // Domain events fan out to webhook delivery rows synchronously (cheap insert),
  // then the worker below does the network I/O out of band.
  const unsubscribe = onDomainEvent((event) => {
    enqueueEvent(db, event);
  });

  let timer: NodeJS.Timeout | undefined;
  let housekeepingCounter = 0;

  const tick = async (): Promise<void> => {
    await flushDeliveries(db, { timeoutMs: config.webhookTimeoutMs });
    housekeepingCounter++;
    if (housekeepingCounter % 60 === 0) {
      purgeExpiredSessions(db);
      purgeIdempotencyKeys(systemContext());
    }
  };

  const startBackgroundWork = (): void => {
    if (timer) return;
    timer = setInterval(() => {
      void tick().catch(() => {
        // Delivery failures are recorded per row; a crashed tick must not kill the process.
      });
    }, 5_000);
    timer.unref();
  };

  return {
    config,
    db,
    context,
    systemContext,
    tick,
    startBackgroundWork,
    close: () => {
      if (timer) clearInterval(timer);
      unsubscribe();
      db.close();
    },
  };
}
