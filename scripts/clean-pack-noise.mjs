#!/usr/bin/env node
/**
 * Remove local agent runtime state (.omc/) under assets/ before packing.
 * These directories appear when agents run against skill/command trees and
 * must never ship inside the npm tarball.
 */
import { existsSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';

function walk(dir) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (!entry.isDirectory()) continue;
		if (entry.name === '.omc') {
			rmSync(full, { recursive: true, force: true });
			continue;
		}
		walk(full);
	}
}

for (const root of ['assets']) {
	if (existsSync(root)) walk(root);
}
