// US-007: Phase 3 request-id 防伪层测试
// Covers (per plan Step 3.8):
//  1. 正常 story 流程: request → reviewer → submit-approval → mark-passes ✓
//  2. 伪造令牌: 乱填 requestId → submit-approval 返回 mismatch
//  3. 重复使用: 同一 requestId approved 后再 submit → 返回 used
//  4. 过期令牌: mock 时间前进 >30min → submit-approval 返回 expired
//  5. max-attempts: 超 maxAttempts(3) 次 reject → 返回 max-attempts
//  6. no-approval gate: 无 approved 调 mark-passes → 返回 no-approval
//  7. auto-lift 被拦 (R8): 无 approved 时 verify 最后一条 criterion → passes 不自动 true
//  8. auto-lift 过渡期豁免: 无 verification-state.json → auto-lift 保持原行为
//  9. reject 后 approval 被清 (R9): story reject 后 verification approval 字段清空
// 10. completion-scope 流程 (R11): request(null,'completion') → submit-approval → oms-set-stage:done 成功
// 11. completion gate 拦截 (R11 CRITICAL): 无 completion approval 调 set-stage:done 被拒
// 12. forceSetStage 不受 gate 影响: done→executing 回退正常
// 13. 调用者归属 (AC1.12): submit-approval 记录 reviewerAgentId 可查
// 14. scope==='story' 校验 (R6): story-scope approval 不能用于 completion gate
import {mkdtempSync, writeFileSync, readFileSync, existsSync, unlinkSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

let pass = 0, fail = 0;
const ok = (n, c) => { console.log((c ? '✅' : '❌') + ' ' + n); c ? pass++ : fail++; };

// 每个用例独立 dir (verification-state.json 在 dir 间隔离)
function freshDir(label) {
	const dir = mkdtempSync(join(tmpdir(), `oms-verify-${label}-`));
	process.env.OMS_STATE_DIR = dir;
	return dir;
}

// ── helper: 在指定 dir 建一个全 verified 的 story, 供 mark-passes/auto-lift 测试 ──
async function setupVerifiedStory(dir) {
	const store = await import('../dist/state/store.js');
	store.initPrd('verify test');
	store.refinePrd('verify test', [
		{title: 'Story A', acceptanceCriteria: ['crit 1', 'crit 2'], priority: 1},
	]);
	// verify both criteria so the story is eligible for mark-passes
	store.setCriterionVerified('US-001', 0, true);
	store.setCriterionVerified('US-001', 1, true);
	return store;
}

// ══════════════════════════════════════════════════════════════
// 1. 正常 story 流程: request → submit-approval(approved) → mark-passes ✓
// ══════════════════════════════════════════════════════════════
{
	const dir = freshDir('happy');
	const store = await setupVerifiedStory(dir);
	const v = store.requestVerification('US-001', 'story');
	ok('1. request-verification 生成 UUID requestId', typeof v.requestId === 'string' && v.requestId.length > 10);
	ok('1. request-verification scope=story', v.scope === 'story' && v.status === 'pending');

	const approved = store.submitApproval(v.requestId, 'approved', 'looks good', 'architect-001');
	ok('1. submit-approval(approved) 返回 ok=true', approved.ok === true);
	ok('1. submit-approval 记录 reviewerAgentId (AC1.12)', approved.verification.reviewerAgentId === 'architect-001');

	// mark-passes now allowed (hasMatchingApproval passes)
	const mp = store.setPrdStoryPasses('US-001', true);
	ok('1. mark-passes 在有 approved 后成功 (ok=true)', mp.ok === true);
	ok('1. story passes=true', store.getPrdStory('US-001').passes === true);
}

// ══════════════════════════════════════════════════════════════
// 2. 伪造令牌: 乱填 requestId → mismatch
// ══════════════════════════════════════════════════════════════
{
	const dir = freshDir('forge');
	const store = await setupVerifiedStory(dir);
	store.requestVerification('US-001', 'story');
	const forged = store.submitApproval('not-a-real-token', 'approved', 'fake', 'evil-ai');
	ok('2. 伪造 requestId → ok=false', forged.ok === false);
	ok('2. 伪造 requestId → reason=mismatch', forged.reason === 'mismatch');
	// mark-passes should still be blocked (no approved)
	const mp = store.setPrdStoryPasses('US-001', true);
	ok('2. 伪造后 mark-passes 被 no-approval gate 拦 (reason=no-approval)', mp.ok === false && mp.reason === 'no-approval');
}

// ══════════════════════════════════════════════════════════════
// 3. 重复使用: approved 后再 submit → used
// ══════════════════════════════════════════════════════════════
{
	const dir = freshDir('reuse');
	const store = await setupVerifiedStory(dir);
	const v = store.requestVerification('US-001', 'story');
	store.submitApproval(v.requestId, 'approved', 'ok', 'architect-001');
	const reuse = store.submitApproval(v.requestId, 'approved', 'again', 'architect-001');
	ok('3. 已 approved 的 requestId 再 submit → ok=false', reuse.ok === false);
	ok('3. 已 approved 的 requestId 再 submit → reason=used', reuse.reason === 'used');
}

// ══════════════════════════════════════════════════════════════
// 4. 过期令牌: 手动改 requestedAt 到 >30min 前 → expired
// ══════════════════════════════════════════════════════════════
{
	const dir = freshDir('expired');
	const store = await setupVerifiedStory(dir);
	const v = store.requestVerification('US-001', 'story');
	// 手动改 verification-state.json 的 requestedAt 到 3 小时前 (绕过 TTL=2h)
	const vPath = join(dir, 'verification-state.json');
	const vData = JSON.parse(readFileSync(vPath, 'utf8'));
	vData.requestedAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
	writeFileSync(vPath, JSON.stringify(vData, null, 2), 'utf8');

	const expired = store.submitApproval(v.requestId, 'approved', 'late', 'architect-001');
	ok('4. 过期令牌 (>2h TTL) → ok=false', expired.ok === false);
	ok('4. 过期令牌 → reason=expired', expired.reason === 'expired');
}

// ══════════════════════════════════════════════════════════════
// 5. max-attempts: 3 次 reject 后第 4 次 submit → max-attempts
// ══════════════════════════════════════════════════════════════
{
	const dir = freshDir('maxatt');
	const store = await setupVerifiedStory(dir);
	const v = store.requestVerification('US-001', 'story');
	// maxAttempts=3, 允许 3 次 reject (attempts 0→1→2→3), 第 4 次 submit 拦
	store.submitApproval(v.requestId, 'rejected', 'bad1', 'critic-001');
	store.submitApproval(v.requestId, 'rejected', 'bad2', 'critic-001');
	store.submitApproval(v.requestId, 'rejected', 'bad3', 'critic-001');
	const blocked = store.submitApproval(v.requestId, 'rejected', 'bad4', 'critic-001');
	ok('5. 3 次 reject 后第 4 次 submit → ok=false', blocked.ok === false);
	ok('5. 3 次 reject 后第 4 次 submit → reason=max-attempts', blocked.reason === 'max-attempts');
	// status 仍 pending (reject 不 resolve)
	const pend = store.getPendingVerification();
	ok('5. reject 累加 attempts 后 status 仍 pending', pend.status === 'pending');
	ok('5. attempts 累加到 3', pend.attempts === 3);
}

// ══════════════════════════════════════════════════════════════
// 6. no-approval gate: 无 approved 调 mark-passes → no-approval
//    (verification-state.json 存在但无匹配 approved → gate 触发)
// ══════════════════════════════════════════════════════════════
{
	const dir = freshDir('nogate');
	const store = await setupVerifiedStory(dir);
	// request 但不 submit (pending, 无 approved)
	store.requestVerification('US-001', 'story');
	const mp = store.setPrdStoryPasses('US-001', true);
	ok('6. 有 verification-state.json 但无 approved → mark-passes 拦', mp.ok === false);
	ok('6. → reason=no-approval', mp.reason === 'no-approval');
}

// ══════════════════════════════════════════════════════════════
// 7. auto-lift 被拦 (R8): 无 approved 时 verify 最后 criterion → passes 不自动 true
//    (先建 pending verification 但不 approve, 再 verify → auto-lift 应被 gate 拦)
// ══════════════════════════════════════════════════════════════
{
	const dir = freshDir('autolift-blocked');
	const store = await import('../dist/state/store.js');
	store.initPrd('autolift test');
	store.refinePrd('autolift test', [
		{title: 'Story A', acceptanceCriteria: ['crit 1', 'crit 2'], priority: 1},
	]);
	// 建 verification-state.json (pending, 未 approve) → gate 会触发 (不豁免)
	store.requestVerification('US-001', 'story');
	// verify both criteria — auto-lift should NOT fire (no matching approval)
	store.setCriterionVerified('US-001', 0, true);
	store.setCriterionVerified('US-001', 1, true);
	const s = store.getPrdStory('US-001');
	ok('7. R8: 无 approved 时全 verify → passes 不自动 true', s.passes === false);
	ok('7. R8: criteria 仍 verified (gate 不影响 verified, 只拦 passes)', s.acceptanceCriteria.every(c => c.verified));
}

// ══════════════════════════════════════════════════════════════
// 8. auto-lift 过渡期豁免: 无 verification-state.json → auto-lift 保持原行为
// ══════════════════════════════════════════════════════════════
{
	const dir = freshDir('autolift-exempt');
	// 不调 requestVerification → verification-state.json 不存在 → 豁免
	const store = await import('../dist/state/store.js');
	store.initPrd('exempt test');
	store.refinePrd('exempt test', [
		{title: 'Story A', acceptanceCriteria: ['crit 1', 'crit 2'], priority: 1},
	]);
	store.setCriterionVerified('US-001', 0, true);
	store.setCriterionVerified('US-001', 1, true);
	const s = store.getPrdStory('US-001');
	ok('8. 过渡期豁免: 无 verification-state.json → auto-lift 正常 (passes=true)', s.passes === true);
	// mark-passes 也应放行 (豁免)
	const mp = store.setPrdStoryPasses('US-001', false);
	ok('8. 过渡期豁免: mark-passes 不受 gate 拦 (可 unmark)', mp.ok === true);
}

// ══════════════════════════════════════════════════════════════
// 9. reject 后 approval 被清 (R9): story reject (mark-passes=false) 后
//    verification-state.json 的 approval 字段清空 (status 复位, reviewerAgentId 清)
// ══════════════════════════════════════════════════════════════
{
	const dir = freshDir('reject-clear');
	const store = await setupVerifiedStory(dir);
	const v = store.requestVerification('US-001', 'story');
	store.submitApproval(v.requestId, 'approved', 'ok', 'architect-001');
	// approval now recorded. Now reject the story (mark-passes=false).
	store.setPrdStoryPasses('US-001', false);
	const vAfter = store.getPendingVerification();
	ok('9. R9: story reject 后 verification status 复位 pending', vAfter.status === 'pending');
	ok('9. R9: reviewerAgentId 被清', vAfter.reviewerAgentId === null);
	ok('9. R9: reviewerFeedback 被清', vAfter.reviewerFeedback === null);
	// 现在 mark-passes(true) 应被拦 (approval 被清, 无匹配 approved)
	const mp = store.setPrdStoryPasses('US-001', true);
	// 但 criteria 被 reject 清了, 先得 guard 拦 (criteria 未 verified)
	// 实际: reject 清了 verified, 所以先撞 guard. 重新 verify 后才撞 no-approval.
	ok('9. R9: reject 后重新 mark-passes(true) 撞 guard (criteria 被清)', mp.ok === false && mp.reason === 'guard');
}

// ══════════════════════════════════════════════════════════════
// 10. completion-scope 流程 (R11): request(null,'completion') → submit-approval →
//     hasMatchingApproval(null,'completion') 放行
// ══════════════════════════════════════════════════════════════
{
	const dir = freshDir('completion');
	const store = await import('../dist/state/store.js');
	store.initPrd('completion test');
	store.refinePrd('completion test', [
		{title: 'Story A', acceptanceCriteria: ['c1'], priority: 1},
	]);
	const v = store.requestVerification(null, 'completion');
	ok('10. request(null, completion) → storyId=null', v.storyId === null && v.scope === 'completion');
	// Strict scope needs allowlisted reviewer + scorecard
	const card = {
		pass: true,
		summary: 'whole session ok',
		evidence: ['criteria met'],
	};
	store.submitApproval(
		v.requestId,
		'approved',
		'whole session ok',
		'oms_architect',
		null,
		card,
	);
	const allowed = store.hasMatchingApproval(null, 'completion');
	ok('10. completion approved → hasMatchingApproval(null,completion)=true', allowed === true);
}

// ══════════════════════════════════════════════════════════════
// 11. completion gate 拦截 (R11 CRITICAL): 无 completion approval →
//     hasMatchingApproval(null,'completion')=false (gate 在 mcp-server 层, 这里测 store 层语义)
// ══════════════════════════════════════════════════════════════
{
	const dir = freshDir('completion-block');
	const store = await import('../dist/state/store.js');
	store.initPrd('block test');
	store.refinePrd('block test', [
		{title: 'Story A', acceptanceCriteria: ['c1'], priority: 1},
	]);
	// 建一个 story-scope approval (非 completion) → completion gate 仍应拦
	const vs = store.requestVerification('US-001', 'story');
	store.submitApproval(vs.requestId, 'approved', 'story ok', 'architect-001');
	const blocked = store.hasMatchingApproval(null, 'completion');
	ok('11. R11: story-scope approved 不放行 completion gate', blocked === false);
}

// ══════════════════════════════════════════════════════════════
// 12. forceSetStage 不受 gate 影响 (AC1.11a):
//     forceSetStage 在 oms-state.mjs (hook 层), 不经 oms-set-stage 工具层.
//     这里验证 store 层 setStage (非 force) 不加 gate (gate 在 mcp-server 工具层).
//     即: store.setStage(state, 'done') 不校验 completion approval (gate 在工具层)
// ══════════════════════════════════════════════════════════════
{
	const dir = freshDir('forcestage');
	const store = await import('../dist/state/store.js');
	// 建一个 done-stage state
	store.createState('forcestage test', '');
	const state = store.loadState();
	// 手动 setStage 到 verifying 再到 done (store 层, 不经 mcp 工具层 gate)
	store.setStage(state, 'executing');
	store.setStage(state, 'verifying');
	// store.setStage 不校验 completion approval (gate 在 mcp-server oms-set-stage 工具层)
	// 所以这里能转到 done (验证 forceSetStage/setStage 路径不被 gate 拦)
	const doneState = store.setStage(state, 'done');
	ok('12. AC1.11a: store.setStage 转 done 不被 completion gate 拦 (gate 在工具层)', doneState.stage === 'done');
}

// ══════════════════════════════════════════════════════════════
// 13. 调用者归属 (AC1.12): submit-approval 记录 reviewerAgentId, getPendingVerification 可查
// ══════════════════════════════════════════════════════════════
{
	const dir = freshDir('attribution');
	const store = await import('../dist/state/store.js');
	store.initPrd('attribution test');
	store.refinePrd('attribution test', [
		{title: 'Story A', acceptanceCriteria: ['c1'], priority: 1},
	]);
	const v = store.requestVerification('US-001', 'story');
	store.submitApproval(v.requestId, 'approved', 'signed off by architect-medium', 'architect-medium-002', 'architect');
	const pend = store.getPendingVerification();
	ok('13. AC1.12: reviewerAgentId 记录可查', pend.reviewerAgentId === 'architect-medium-002');
	ok('13. AC1.12: criticTier 记录可查', pend.criticTier === 'architect');
	ok('13. AC1.12: reviewerFeedback 记录可查', pend.reviewerFeedback.includes('architect-medium'));
}

// ══════════════════════════════════════════════════════════════
// 14. scope==='story' 校验 (R6): story-scope approval 不能用于 completion gate
//     (已在 #11 覆盖, 这里补反向: completion-scope 不能用于 story auto-lift)
// ══════════════════════════════════════════════════════════════
{
	const dir = freshDir('scope-isolation');
	const store = await import('../dist/state/store.js');
	store.initPrd('scope test');
	store.refinePrd('scope test', [
		{title: 'Story A', acceptanceCriteria: ['c1'], priority: 1},
	]);
	// completion-scope approved
	const vc = store.requestVerification(null, 'completion');
	store.submitApproval(
		vc.requestId,
		'approved',
		'session ok',
		'oms_architect',
		null,
		{pass: true, summary: 'session ok', evidence: ['ok']},
	);
	// story auto-lift/mark-passes 应被拦 (scope 不匹配: completion 不能用于 story)
	const storyAllowed = store.hasMatchingApproval('US-001', 'story');
	ok('14. R6: completion-scope approved 不放行 story gate', storyAllowed === false);
	// 反向: completion gate 放行
	const completionAllowed = store.hasMatchingApproval(null, 'completion');
	ok('14. R6: completion-scope approved 放行 completion gate', completionAllowed === true);
}

// ══════════════════════════════════════════════════════════════
// 15. deleteState 清 verification-state.json (US-007 AC: deleteState 清理)
// ══════════════════════════════════════════════════════════════
{
	const dir = freshDir('delete');
	const store = await import('../dist/state/store.js');
	store.createState('delete test', '');
	store.requestVerification('US-001', 'story');
	const vPath = join(dir, 'verification-state.json');
	ok('15. verification-state.json 建后存在', existsSync(vPath));
	store.deleteState();
	ok('15. deleteState 清掉 verification-state.json', !existsSync(vPath));
}

// ══════════════════════════════════════════════════════════════
// 16. 损坏的 verification-state.json → fail-closed (reviewer CRITICAL 修复)
//    文件存在但 JSON 损坏时, hasMatchingApproval 必须返回 false (不放行),
//    不能误当"过渡期豁免"放行. 否则 torn write/手动编辑损坏会静默禁用整个防伪层.
// ══════════════════════════════════════════════════════════════
{
	const dir = freshDir('corrupt');
	const store = await import('../dist/state/store.js');
	store.initPrd('corrupt test');
	store.refinePrd('corrupt test', [
		{title: 'Story A', acceptanceCriteria: ['c1'], priority: 1},
	]);
	// 先建文件 (让它存在), 再写坏它
	store.requestVerification('US-001', 'story');
	const vPath = join(dir, 'verification-state.json');
	ok('16. 损坏前文件存在', existsSync(vPath));
	writeFileSync(vPath, '{ this is not valid json,,,', 'utf8');
	// 损坏文件 → hasMatchingApproval 必须 fail-closed (false), 不能豁免放行
	const corrupt = store.hasMatchingApproval('US-001', 'story');
	ok('16. CRITICAL: 损坏 verification-state.json → hasMatchingApproval=false (fail-closed)', corrupt === false);
	// mark-passes 也应被拦 (无匹配 approved — 损坏文件不算 approved)
	store.setCriterionVerified('US-001', 0, true);
	const mp = store.setPrdStoryPasses('US-001', true);
	ok('16. CRITICAL: 损坏文件下 mark-passes 被 no-approval gate 拦', mp.ok === false && mp.reason === 'no-approval');
	// completion gate 同理 fail-closed
	const comp = store.hasMatchingApproval(null, 'completion');
	ok('16. CRITICAL: 损坏文件下 completion gate fail-closed', comp === false);
}

// ══════════════════════════════════════════════════════════════
// 17. 无文件 vs 损坏文件语义区分 (豁免 vs fail-closed)
//    无文件 → 豁免放行 (老会话); 损坏文件 → fail-closed (拒). 两者必须区分.
// ══════════════════════════════════════════════════════════════
{
	const dir = freshDir('absent-vs-corrupt');
	const store = await import('../dist/state/store.js');
	store.initPrd('absent vs corrupt');
	store.refinePrd('absent vs corrupt', [
		{title: 'Story A', acceptanceCriteria: ['c1'], priority: 1},
	]);
	// 无 verification-state.json → 豁免放行
	const absent = store.hasMatchingApproval('US-001', 'story');
	ok('17. 无文件 → 豁免放行 (true)', absent === true);
	// 建文件后损坏
	const vPath = join(dir, 'verification-state.json');
	store.requestVerification('US-001', 'story');
	writeFileSync(vPath, 'corrupt{{{', 'utf8');
	const corrupt = store.hasMatchingApproval('US-001', 'story');
	ok('17. 损坏文件 → fail-closed (false), 与无文件语义区分', corrupt === false);
}

console.log(`\n==================================================`);
console.log(`PRD verification: ${pass} passed, ${fail} failed`);
console.log(`==================================================`);
process.exit(fail > 0 ? 1 : 0);
