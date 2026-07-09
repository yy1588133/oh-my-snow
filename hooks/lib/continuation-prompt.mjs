/**
 * Stage continuation instructions for onStop.
 * When STATUS panel is prepended (onStop full path), omit Goal/task tables/turn
 * triplets already shown there — instructions focus on actions only.
 */

export function buildPrdSection(prd) {
	if (!prd || !prd.refined) {
		return prd
			? '\nPRD: scaffold created but NOT refined — call oms-prd action "refine" with task-specific stories before looping.\n'
			: '';
	}
	if (!Array.isArray(prd.stories)) {
		return '\nPRD: malformed prd.json (stories is not an array). Run oms-prd action "status" via the MCP tool to inspect.\n';
	}
	const passed = prd.stories.filter((s) => s && s.passes).length;
	const total = prd.stories.length;
	if (total === 0) {
		return '\nPRD: no stories defined. Call oms-prd action "refine" with task-specific stories.\n';
	}
	const sorted = [...prd.stories].sort((a, b) => a.priority - b.priority);
	const next = sorted.filter((s) => !s.passes)[0];
	const storyLines = sorted
		.map((s) => `  [${s.passes ? '✓' : '○'}] ${s.id} [P${s.priority}]: ${s.title}`)
		.join('\n');
	const nextBlock = next
		? `\nNext story: ${next.id} — ${next.title}\n  Call oms-prd action "next-story" for full acceptance criteria.\n`
		: '\nAll stories pass — proceed to reviewer verification (call #oms_reviewer or #oms_architect).\n';
	return `\nPRD Progress (${passed}/${total} stories passed):\n${storyLines}\n${nextBlock}`;
}

function formatDiffSection(gitDiff) {
	if (gitDiff == null) {
		return '\n(git not available — cannot detect changes)\n';
	}
	if (gitDiff.length === 0) {
		return '\n(No git changes detected)\n';
	}
	const truncated =
		gitDiff.length > 1000 ? '... ' + gitDiff.slice(-1000) : gitDiff;
	return `\nChanges detected:\n${truncated}\n`;
}

/**
 * Build stage action instructions (no full Goal/task table — see STATUS).
 * @param {object} state
 * @param {string|null} gitDiff
 * @param {object|null} prd
 * @param {{ withStatusPanel?: boolean }} [opts] - when true (default), slim header
 */
export function buildContinuationPrompt(state, gitDiff, prd, opts = {}) {
	const withStatus = opts.withStatusPanel !== false;
	const stage = state.stage;
	const inTeamMode = !!state.teamName;
	const diffSection = formatDiffSection(gitDiff);
	// Short ref when panel already carries goal/tasks/turns
	const seeStatus = withStatus
		? ' (goal / tasks / turns / gates: see [OMS:STATUS] above)'
		: '';

	switch (stage) {
		case 'planning': {
			if (inTeamMode) {
				return `[OMS:CONTINUE] Planning (Team Lead)${seeStatus}
${diffSection}
You are the TEAM LEAD in the planning stage. Delayed spawn is in effect.

Do NOT spawn teammates yet — planning stage blocks team-spawn_teammate.
1. Analyze the task and split it into N independent work items
2. Use \`oms-add-task\` to record the task list (OMS local tasks — for your own tracking; teammates cannot see these yet)
   - Do NOT call team-create_task in planning — it requires an active team (created by the first spawn), which doesn't exist yet
3. When the plan is complete, call oms-set-stage { stage: "executing" }

In executing stage you will: spawn the FIRST teammate (creates the team) → use team-create_task to publish the planned tasks → spawn the remaining N-1 teammates (each claims a task and works in its own worktree).`;
			}
			return `[OMS:CONTINUE] Planning${seeStatus}
${diffSection}
Continue planning. Add more tasks with oms-add-task if needed.
When the plan is complete, call oms-set-stage { stage: "executing" } to start implementation.`;
		}

		case 'executing': {
			if (inTeamMode) {
				return `[OMS:CONTINUE] Executing (Team Lead)${seeStatus}
${diffSection}
You are the TEAM LEAD in the executing stage. Spawn teammates now.

1. Call \`team-spawn_teammate\` N times (one per work item) — each gets a name, role, prompt
2. Each teammate will claim a task and work in its own isolated git worktree
3. Teammates that finish their work enter STANDBY (blocked on wait_for_messages)
   - To give them more work: \`team-message_teammate\` with a new task
   - To end them: \`team-shutdown_teammate\` (the ONLY way to terminate a teammate)
4. When all teammates are done, call oms-set-stage { stage: "verifying" }

Note: teammates do NOT trigger onStop — they run on a message-pump loop, not the turn loop.
Drive standby teammates yourself via message_teammate.`;
			}
			const prdSection = buildPrdSection(prd);
			const ralphHint = prd
				? `\nRalph mode active. Use oms-prd to manage stories; verify EACH acceptance criterion with fresh evidence before mark-passes.\n`
				: '';
			return `[OMS:CONTINUE] Executing${seeStatus}
${diffSection}${prdSection}${ralphHint}
Continue implementing remaining tasks (task ids in STATUS OpenTasks).
Use oms-complete-task to mark tasks as done.
When all tasks are complete, submit task-complete gate then oms-set-stage { stage: "verifying" }.`;
		}

		case 'verifying': {
			if (inTeamMode) {
				return `[OMS:CONTINUE] Verifying (Team Lead)${seeStatus}
${diffSection}
You are the TEAM LEAD in the verifying stage. Merge teammate work.

1. Call \`team-merge_all_teammate_work\` to serially merge all teammate branches
   - On conflict: snow-cli AI resolves it (manual/theirs/ours/auto)
2. Verification (build/test) runs AUTOMATICALLY after this turn (see build result below)
   - If build failed: call oms-set-stage { stage: "executing" } to fix (lead self-fix or re-spawn)
   - If build passed: complete task-reconcile + code-quality + completion gates, then oms-set-stage { stage: "done" } (oral done blocked)
3. Before re-spawning teammates after a failed verify: check worktree state
   - If cleanup_team already ran: re-spawn creates fresh worktrees
   - If not: createTeamWorktree reuses old worktree — clean dirty changes with git checkout first

Note: teammate-side verification is ineffective (teammates don't run onStop).
Lead-side onStop is the single source of verification truth.`;
			}
			return `[OMS:CONTINUE] Verifying${seeStatus}
${diffSection}
Review the changes above.
- If issues are found, call oms-set-stage { stage: "executing" } to fix them
- If everything looks good, complete gates before done:
  1) oms-prd submit-gate task-reconcile
  2) request-verification code-quality + independent #oms_reviewer approval (scorecard needs diffStat)
  3) request-verification completion + independent #oms_critic approval
  4) oms-set-stage { stage: "done" }
- Oral "done" without ledger approvals is blocked. Check STATUS / oms-get-state for Gate ledger / Last gate failure.`;
		}

		case 'done':
			if (inTeamMode) {
				return `[OMS:CONTINUE] Done (Team Lead)${seeStatus}
Team work complete. Call \`team-cleanup_team\` to reclaim all worktrees + branches.`;
			}
			return null;

		default:
			return null;
	}
}
