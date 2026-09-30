'use strict';

// 端到端业务规则测试（针对运行中的 http://localhost:3000）
const BASE = process.env.BASE || 'http://localhost:3000';

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗ FAIL:', msg); }
}
async function call(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

(async () => {
  console.log('1) 成环检测');
  {
    // 演示数据: 1 film -> 2 music, 3 footage, 4 font ; footage(3) -> 5 photo
    // 尝试给 music(2) 加来源 film(1)：1->2->1 成环
    const r = await call('POST', '/api/materials/2/sources', { sourceMaterialId: 1, relation: 'x' });
    ok(r.status === 409 && r.data.details && r.data.details.cyclePath.join() === '1,2',
      '加边 2->1 被拒且返回成环路径 [1,2]，实际: ' + r.status + ' ' + JSON.stringify(r.data.details));
    // 自环
    const r2 = await call('POST', '/api/materials/1/sources', { sourceMaterialId: 1 });
    ok(r2.status === 400, '自环被拒绝');
    // 合法加边
    const r3 = await call('POST', '/api/materials/5/sources', { sourceMaterialId: 4, relation: '字体' });
    ok(r3.status === 201, '合法边 5->4 添加成功（photo 也用到字体）');
  }

  console.log('2) 不合格包：缺授权节点 + 来源路径列出');
  {
    // 创建含 film(1) 的秋季包：photo(5)/font(4) 只有春季授权，使用期不覆盖
    const r = await call('POST', '/api/packages', {
      name: '测试不合格包', medium: '屏幕放映', region: '中国大陆',
      useFrom: '2026-10-01', useTo: '2026-11-30', materialIds: [1],
    });
    ok(r.status === 201, '包已创建为 draft');
    const pid = r.data.id;
    const v = await call('POST', '/api/verify', { packageId: pid });
    ok(v.status === 200 && v.data.eligible === false, '核验不合格');
    const photo = v.data.failingNodes.find((n) => n.materialId === 5);
    ok(!!photo, '列出不合格节点 photo(5)');
    ok(photo.paths.some((p) => p.map((x) => x.materialId).join() === '1,3,5'),
      '给出不合格来源路径 1->3->5');
    ok(photo.reasonText.join().includes('有效期'), '原因：授权有效期不覆盖（照片仅有春季授权）');
    // 字体在秋季也不覆盖
    const fontNode = v.data.failingNodes.find((n) => n.materialId === 4);
    ok(!!fontNode && fontNode.reasonText.join().includes('有效期'), '字体节点同样因有效期不合格');
    global.pidBad = pid;
  }

  console.log('2b) 完全无授权的独立节点 -> no_auth');
  {
    const m = await call('POST', '/api/materials', { title: '孤立未授权素材', kind: 'image' });
    ok(m.status === 201, '创建无授权素材');
    const p = await call('POST', '/api/packages', {
      name: '无授权包', medium: '屏幕放映', region: '中国大陆',
      useFrom: '2026-10-01', useTo: '2026-11-30', materialIds: [m.data.id],
    });
    const v = await call('POST', '/api/verify', { packageId: p.data.id });
    ok(v.data.eligible === false &&
      v.data.failingNodes[0].reasons.includes('no_auth') &&
      v.data.failingNodes[0].reasonText.join().includes('未登记任何授权'),
      '无授权节点报 no_auth 并列出根路径');
  }

  console.log('3) 日期不合法 / 缺字段 -> 400 或核验 globalErrors，禁止发布');
  {
    const r = await call('POST', '/api/packages', {
      name: '坏日期', medium: '屏幕放映', region: '中国大陆',
      useFrom: '2026-12-01', useTo: '2026-11-01', materialIds: [1],
    });
    ok(r.status === 400, '起>止日期在保存时被拒（400）');
    const r2 = await call('POST', '/api/packages', {
      name: '坏格式', medium: '屏幕放映', region: '中国大陆',
      useFrom: '2026-02-30', useTo: '2026-11-01', materialIds: [1],
    });
    ok(r2.status === 400, '非法日历日期 2026-02-30 被拒');
    // 直接核验缺媒介
    const v = await call('POST', '/api/verify', { materialIds: [1], medium: '', region: '中国大陆', useFrom: '2026-10-01', useTo: '2026-11-30' });
    ok(v.data.eligible === false && v.data.globalErrors.some((e) => e.includes('媒介')), '缺媒介导致不可发布');
    // 发布不合格包 -> 422
    const state = await call('GET', '/api/state');
    const pub = await call('POST', `/api/packages/${global.pidBad}/publish`, { basisVersion: state.data.basisVersion });
    ok(pub.status === 422, '发布不合格包被拒 422');
    const after = await call('GET', `/api/packages/${global.pidBad}`);
    ok(after.data.status === 'draft', '包仍为 draft（未被发布）');
    const snaps = after.data.snapshots;
    ok(snaps.length === 1 && snaps[0].kind === 'publish' && snaps[0].eligible === false,
      '失败发布也留下不可变核验记录');
  }

  console.log('4) 合格包发布 + 原子快照 + 清单冻结');
  {
    // 演示数据里的已发布包 1（常设展）；另建一个全新的可发布包：film 链需在 03-01~05-31 全合格
    // font(4) 授权 2026-03-01~2026-05-31 恰好覆盖；步骤1加了 5->4 边但只含 font 自身时不受影响
    const r = await call('POST', '/api/packages', {
      name: '测试合格包', medium: '屏幕放映', region: '中国大陆',
      useFrom: '2026-03-01', useTo: '2026-05-31', materialIds: [4],
    });
    const pid = r.data.id;
    const v = await call('POST', '/api/verify', { packageId: pid });
    ok(v.data.eligible === true, '只含 font(4) 的包核验合格');
    const pub = await call('POST', `/api/packages/${pid}/publish`, { basisVersion: v.data.basisVersion });
    ok(pub.status === 201 && pub.data.package.status === 'published', '发布成功 201');
    ok(pub.data.snapshotId && pub.data.result.eligible, '返回不可变快照 id');
    // 发布后不可改
    const patch = await call('PATCH', `/api/packages/${pid}`, {
      name: 'x', medium: '屏幕放映', region: '中国大陆', useFrom: '2026-03-01', useTo: '2026-05-31', materialIds: [4],
    });
    ok(patch.status === 409, '已发布包参数/清单不可修改');
    // 快照内容核对
    const snap = await call('GET', `/api/snapshots/${pub.data.snapshotId}`);
    ok(snap.data.immutable && snap.data.payload.nodes.length === 1 && snap.data.payload.request.materialIds.join() === '4',
      '快照冻结素材清单与逐节点结果');
    global.pidGood = pid;
    global.goodSnap = pub.data.snapshotId;
  }

  console.log('5) 快照不可变（SQLite 触发器）');
  {
    const Database = require('better-sqlite3');
    const db = new Database(process.env.DB_PATH || '/workspace/data/app.db');
    let blockedUpdate = false, blockedDelete = false;
    try { db.prepare('UPDATE verification_snapshots SET eligible=0 WHERE id=?').run(global.goodSnap); }
    catch { blockedUpdate = true; }
    try { db.prepare('DELETE FROM verification_snapshots WHERE id=?').run(global.goodSnap); }
    catch { blockedDelete = true; }
    ok(blockedUpdate && blockedDelete, '快照 UPDATE/DELETE 均被触发器拒绝');
    db.close();
  }

  console.log('6) 依据过期（核验后授权/来源被改）-> 发布 409 STALE_BASIS');
  {
    // 新待发布合格包
    const r = await call('POST', '/api/packages', {
      name: '并发包', medium: '屏幕放映', region: '中国大陆',
      useFrom: '2026-03-02', useTo: '2026-05-01', materialIds: [4],
    });
    const pid = r.data.id;
    const v1 = await call('POST', '/api/verify', { packageId: pid });
    ok(v1.data.eligible === true, '核验合格，拿到 basisVersion=' + v1.data.basisVersion);
    // 期间他人改了授权（给 font 增加一条无关授权，版本号也会递增）
    const add = await call('POST', '/api/materials/4/authorizations', {
      media: '网络', region: '中国大陆', validFrom: '2030-01-01', validTo: '2030-12-31', licensor: 'x',
    });
    ok(add.status === 201, '并发：新增了一条授权');
    const pub = await call('POST', `/api/packages/${pid}/publish`, { basisVersion: v1.data.basisVersion });
    ok(pub.status === 409 && pub.data.details.code === 'STALE_BASIS', '依据过期发布被拒 409 STALE_BASIS');
    const v2 = await call('POST', '/api/verify', { packageId: pid });
    const pub2 = await call('POST', `/api/packages/${pid}/publish`, { basisVersion: v2.data.basisVersion });
    ok(pub2.status === 201, '重新核验后发布成功');
    global.pidConcurrent = pid;
  }

  console.log('7) 授权撤销 -> 仅“由合格变不合格”的已发布包标 needs_review，原快照保留');
  {
    const before = (await call('GET', `/api/packages/${global.pidGood}`)).data;
    ok(before.status === 'published', '前置：合格包处于 published');
    // font 授权只有一条主授权（id 从数据查）；撤销它
    const mats = (await call('GET', '/api/materials')).data;
    const fontAuth = mats.find((m) => m.id === 4).authorizations.filter((a) => !a.revoked && a.media !== '网络');
    const target = fontAuth.find((a) => a.validFrom === '2026-03-01');
    const rev = await call('POST', `/api/authorizations/${target.id}/revoke`);
    ok(rev.status === 200, '授权已撤销');
    const after = (await call('GET', `/api/packages/${global.pidGood}`)).data;
    ok(after.status === 'needs_review', '原合格包被标记为 needs_review');
    const publishSnapStillThere = after.snapshots.some((s) => s.id === global.goodSnap && s.kind === 'publish' && s.eligible === true);
    ok(publishSnapStillThere, '原发布快照原样保留（合格、未被改写）');
    ok(after.latestSnapshot.kind === 'review' && after.latestSnapshot.eligible === false,
      '自动追加了 review 不合格快照');
    // 演示数据里的已发布“常设展”包（含 film，font 在其链上）也应被标记
    const pkgList = (await call('GET', '/api/packages')).data;
    const demo = pkgList.find((p) => p.name.includes('常设展'));
    ok(demo.status === 'needs_review', '演示已发布包同样被标记需复核');

    // 已经 needs_review 的包，再改一次授权（仍不合格）不应产生重复状态翻转之外问题；
    // 且“合格→仍不合格”规则：review 包不会自动恢复
    global.reviewPid = global.pidGood;
  }

  console.log('8) 人工复核：恢复授权后重新核验 -> 恢复 published，所有历史快照保留');
  {
    // 重新登记一条覆盖授权（不能解撤，模拟补授权）
    const add = await call('POST', '/api/materials/4/authorizations', {
      media: '*', region: '*', validFrom: '2026-01-01', validTo: '2028-12-31', licensor: '补授权',
    });
    ok(add.status === 201, '补登记覆盖授权');
    // needs_review 不会自动恢复
    const still = (await call('GET', `/api/packages/${global.reviewPid}`)).data;
    ok(still.status === 'needs_review', '不会自动恢复发布状态');
    const rc = await call('POST', `/api/packages/${global.reviewPid}/recheck`);
    ok(rc.status === 200 && rc.data.restored === true && rc.data.package.status === 'published',
      '人工复核通过，恢复 published');
    const final = (await call('GET', `/api/packages/${global.reviewPid}`)).data;
    const kinds = final.snapshots.map((s) => s.kind).join(',');
    ok(kinds.includes('publish') && kinds.includes('review') && kinds.includes('recheck'),
      '三类快照按时间顺序全部保留: ' + kinds);
  }

  console.log('9) 媒介/地区通配符与有效期边界');
  {
    // music(2) 授权 * / * 2026-01-01~2027-12-31
    const r = await call('POST', '/api/packages', {
      name: '边界包', medium: '沉浸式投影', region: '中国香港',
      useFrom: '2026-01-01', useTo: '2027-12-31', materialIds: [2],
    });
    const v = await call('POST', '/api/verify', { packageId: r.data.id });
    ok(v.data.eligible === true, '* / * 授权覆盖任意媒介地区，起止日按闭区间边界合格');
    const v2 = await call('POST', '/api/verify', {
      materialIds: [2], medium: '沉浸式投影', region: '中国香港',
      useFrom: '2025-12-31', useTo: '2027-12-31',
    });
    ok(v2.data.eligible === false && v2.data.failingNodes[0].reasonText.join().includes('有效期'),
      '早一天即不覆盖整段使用期');
  }

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
