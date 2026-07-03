// 冒烟测试：oms-state store 函数（write/read/list/delete）
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

const tmpRoot = join(process.cwd(), '.smoke-tmp-oms-state-' + randomUUID().slice(0,8));
mkdirSync(tmpRoot, { recursive: true });
process.env.OMS_STATE_DIR = tmpRoot;

// 命名导入（必须在设置 env 之后）
const { writeOmsState, readOmsState, deleteOmsState, listOmsModes } =
  await import('file://' + join(process.cwd(), 'dist/state/store.js'));

let failures = 0;
function check(name, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name);
  if (!cond) failures++;
}

// 1. write + read
writeOmsState('interview', { interview_id: 'abc', rounds: [], current_ambiguity: 0.5 });
const r1 = readOmsState('interview');
check('write then read returns the object', r1 && r1.interview_id === 'abc' && r1.current_ambiguity === 0.5);

// 2. overwrite semantics (not merge)
writeOmsState('interview', { interview_id: 'def', rounds: ['r1'] });
const r2 = readOmsState('interview');
check('write overwrites (not merge)', r2 && r2.interview_id === 'def' && r2.rounds.length === 1);

// 3. list (multiple modes)
writeOmsState('deep-dive', { source: 'deep-dive', slug: 'x' });
writeOmsState('trace', { observation: 'y' });
const modes = listOmsModes();
check('list returns sorted modes', JSON.stringify(modes) === JSON.stringify(['deep-dive','interview','trace']));

// 4. delete existing
const del1 = deleteOmsState('interview');
check('delete existing returns true', del1 === true);
check('deleted mode no longer readable', readOmsState('interview') === null);

// 5. delete non-existent
const del2 = deleteOmsState('interview');
check('delete non-existent returns false', del2 === false);

// 6. read non-existent
check('read non-existent returns null', readOmsState('nonexistent') === null);

// 7. invalid mode name (path traversal guard)
let threw = false;
try { writeOmsState('../escape', {x:1}); } catch { threw = true; }
check('invalid mode name throws (path traversal guard)', threw);

let threw2 = false;
try { writeOmsState('bad name with space', {x:1}); } catch { threw2 = true; }
check('mode name with space throws', threw2);

// 7b. invalid mode name also throws on read/delete (safety path full coverage)
let threwRead = false;
try { readOmsState('../escape'); } catch { threwRead = true; }
check('read invalid mode name throws (path traversal guard)', threwRead);

let threwDelete = false;
try { deleteOmsState('../escape'); } catch { threwDelete = true; }
check('delete invalid mode name throws (path traversal guard)', threwDelete);

// 8. corrupted JSON returns null on read (not throw)
mkdirSync(join(tmpRoot, 'store'), { recursive: true });
writeFileSync(join(tmpRoot, 'store', 'corrupt.json'), '{ this is not valid json');
const r3 = readOmsState('corrupt');
check('corrupted JSON returns null (not throw)', r3 === null);

// 9. list empty directory (store dir exists but no modes)
const emptyTmp = join(process.cwd(), '.smoke-tmp-oms-empty-' + randomUUID().slice(0,8));
mkdirSync(join(emptyTmp, 'store'), { recursive: true });
process.env.OMS_STATE_DIR = emptyTmp;
// 重新 import 拿新的 getStateDir 绑定（OMS_STATE_DIR 已变）
delete await import('file://' + join(process.cwd(), 'dist/state/store.js'));
const { listOmsModes: listEmpty } = await import('file://' + join(process.cwd(), 'dist/state/store.js'));
const emptyModes = listEmpty();
check('list returns [] when store dir is empty', Array.isArray(emptyModes) && emptyModes.length === 0);

// 10. concurrent writes don't produce corrupted JSON
process.env.OMS_STATE_DIR = tmpRoot;
delete await import('file://' + join(process.cwd(), 'dist/state/store.js'));
const { writeOmsState: writeConcurrent, readOmsState: readConcurrent } = await import('file://' + join(process.cwd(), 'dist/state/store.js'));
// 串行快速写同一 mode 多次（模拟并发 read-modify-write 顺序）
let lastErr = null;
try {
  for (let i = 0; i < 20; i++) {
    writeConcurrent('concurrent-test', { round: i, data: `iter-${i}` });
  }
} catch (e) { lastErr = e; }
const finalRead = readConcurrent('concurrent-test');
check('20 sequential writes produce valid readable JSON', finalRead && finalRead.round === 19);
check('no throw during sequential writes', lastErr === null);

// 11. undefined data throws (prevents corrupted file — JSON.stringify(undefined) === undefined)
let threwUndef = false;
try { writeConcurrent('undef-test', undefined); } catch { threwUndef = true; }
check('write undefined data throws (corruption guard)', threwUndef);

// 12. over-long mode name throws (> 128 chars, filesystem safety)
let threwLong = false;
try { writeConcurrent('a'.repeat(129), {x:1}); } catch { threwLong = true; }
check('mode name > 128 chars throws (filesystem safety)', threwLong);

// 13. mode name exactly 128 chars is accepted (boundary)
let threwBoundary = false;
try { writeConcurrent('a'.repeat(128), {ok:true}); } catch { threwBoundary = true; }
check('mode name exactly 128 chars accepted (boundary)', !threwBoundary && readConcurrent('a'.repeat(128)).ok === true);

// cleanup
rmSync(tmpRoot, { recursive: true, force: true });
rmSync(emptyTmp, { recursive: true, force: true });

console.log('\n' + (failures === 0 ? 'ALL PASS' : failures + ' FAILURES'));
process.exit(failures === 0 ? 0 : 1);
