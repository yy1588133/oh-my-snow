#!/usr/bin/env node

/**
 * OMS afterToolCall Hook
 *
 * Triggered after a tool execution completes.
 * If the tool was a filesystem write tool and the stage allows editing,
 * writes a .pending-verify marker file. The actual build/test verification
 * is deferred to the onStop hook (which runs at end of turn).
 *
 * Exit code 0 = preserve original tool result (marker written if applicable)
 *
 * Context passed via stdin (JSON):
 * { toolName: string, args: Record<string, any>, result: any, error: Error | null }
 *
 * Matcher (in hook config JSON):
 *   "filesystem-create,filesystem-edit,filesystem-replaceedit"
 */

import { writeFileSync } from 'fs';
import { join } from 'path';
import { getStateDir, loadState, readStdin, appendErrorLog } from './lib/oms-state.mjs';

// ── File write tools ──

const FILE_WRITE_TOOLS = new Set([
	'filesystem-create',
	'filesystem-edit',
	'filesystem-replaceedit',
]);

// Stages that should trigger auto-verification after file edits
// Note: 'verifying' is NOT in this set — verifying stage runs verification
// unconditionally in on-stop.mjs (runVerification), not via the marker.
const VERIFY_STAGES = new Set(['executing']);

// ── Main ──

async function main() {
	const stdinData = await readStdin();

	// Parse context
	let context = {};
	try {
		if (stdinData.trim()) {
			context = JSON.parse(stdinData);
		}
	} catch {
		// Can't parse context — fail-open
		process.exit(0);
	}

	const toolName = context.toolName || '';

	// Only verify after filesystem write tools
	if (!FILE_WRITE_TOOLS.has(toolName)) {
		process.exit(0);
	}

	// Check if we have an active OMS session
	const state = loadState();
	if (!state) {
		// No active session — don't auto-verify
		process.exit(0);
	}

	// Only auto-verify in appropriate stages
	if (!VERIFY_STAGES.has(state.stage)) {
		process.exit(0);
	}

	// Write a pending-verify marker file (actual verification runs in onStop)
	const markerPath = join(getStateDir(), '.pending-verify');
	try {
		writeFileSync(markerPath, '', 'utf-8');
	} catch {
		// If we can't write the marker, fail-open
	}

	// Marker written (or failed silently) — preserve original tool result
	process.exit(0);
}

main().catch((error) => {
	appendErrorLog(`afterToolCall error: ${error.message}`);
	process.exit(0); // fail-open
});
