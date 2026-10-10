import type { Database } from 'bun:sqlite';
import { homedir } from 'node:os';
import { defaultDbPath, openDb } from './core/db';
import { repriceUnpriced, runIngest, type AdapterReport } from './core/ingest';
import { createPricingService } from './core/pricing';
import { discoverAdapters } from './core/registry';
import type { Adapter, PricingService } from './core/types';

export type PriceRefreshResult = Awaited<ReturnType<PricingService['refreshIfStale']>>;

export interface IngestAllResult {
  reports: AdapterReport[];
  /** Previously unpriced events that now have a cost. */
  repriced: number;
  priceRefresh: PriceRefreshResult;
}

export interface AppOptions {
  dbPath?: string;
  home?: string;
  adapterDir?: string;
  pricing?: PricingService;
  log?: (msg: string) => void;
}

export interface App {
  db: Database;
  dbPath: string;
  pricing: PricingService;
  adapters: readonly Adapter[];
  /** Adapter modules that failed to load; the rest still run. */
  problems: readonly string[];
  /** refresh prices -> ingest every installed agent -> price what was unpriced. Concurrent calls share one run. */
  ingestAll(): Promise<IngestAllResult>;
  close(): void;
}

export async function createApp(opts: AppOptions = {}): Promise<App> {
  const dbPath = opts.dbPath ?? defaultDbPath();
  const home = opts.home ?? homedir();
  const log = opts.log ?? (() => {});
  const db = openDb(dbPath);
  const pricing = opts.pricing ?? createPricingService(db);
  const { adapters, problems } = await discoverAdapters(opts.adapterDir);

  let inflight: Promise<IngestAllResult> | undefined;
  const run = async (): Promise<IngestAllResult> => {
    const priceRefresh = await pricing.refreshIfStale();
    const reports = await runIngest(db, adapters, pricing, { home, log });
    const repriced = await repriceUnpriced(db, pricing);
    return { reports, repriced, priceRefresh };
  };

  return {
    db,
    dbPath,
    pricing,
    adapters,
    problems,
    ingestAll() {
      if (!inflight) {
        const p = run().finally(() => {
          inflight = undefined;
        });
        inflight = p;
      }
      return inflight;
    },
    close() {
      db.close();
    },
  };
}
