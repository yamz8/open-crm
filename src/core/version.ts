import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT_DIR } from './config.ts';

/**
 * One source of truth for the version. It was previously hard-coded in the
 * OpenAPI document, the discovery payload, and the MCP server info, which is
 * three places to forget on a release.
 */
function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(ROOT_DIR, 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const VERSION = readPackageVersion();
export const USER_AGENT = `open-crm/${VERSION}`;
