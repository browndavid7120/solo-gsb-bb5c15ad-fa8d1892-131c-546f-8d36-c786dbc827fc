/* eslint-disable */
// 端到端冒烟测试：以独立临时数据库启动真实 HTTP 服务，验证核心业务规则。
// 运行：node test/smoke.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3199;
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exhibit-smoke-'));
const dbPath = path.join(tmpDir, 'test.db');

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${extra ? ' :: ' + JSON.stringify(extra) : ''}`); }
}

async function req(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
}

const server = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DB_PATH: dbPath, DATA_DIR: tmpDir },
  stdio: ['ignore', 'pipe', 'inherit'],
});

async function waitReady(deadline = Date.now() + 15000) {
  while (Date.now() < deadline) {
    try {
      const r = await fetch(BASE + '/api/state');
      if (r.ok) return;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not start');
}

const U = {
  medium: '展馆大屏', territory: '中国大陆',
  s: '2026-03-01', e: '2026-06-01',
};

async function addMaterial(name) {
  const r = await req('POST', '/api/materials', { name, kind: 'test' });
  return r.data.id;
}
const addEdge = (derived, source, note) => req('POST', '/api/edges', { derived_id: derived, source_id: source, note });
const addAuth = (material_id, extra) => req('POST', '/api/authorizations', {
  material_id, medium: U.medium, territory: U.territory,
  start_date: '2026-01-01', end_date: '2026-12-31',
  revoked: false, licensor: 'L', note: '', ...extra,
});
const verify = (ids, extra = {}) => req('POST', '/api/verify', {
  material_ids: ids, medium: U.medium, territory: U.territory,
  start_date: U.s, end_date: U.e, ...extra,
});

async function main() {
  await waitReady();
  console.log('服务已就绪');

  // 1. 素材登记 + 来源链 B←A, C←B, D←A
  const [A, B, C, D] = await Promise.all([
    addMaterial('原始素材A'), addMaterial('派生B'), addMaterial('派生C'), addMaterial('派生D'),
  ]);
  check('素材创建', A && B && C && D, { A, B, C, D });
  const e1 = await addEdge(B, A);
  const e2 = await addEdge(C, B);
  const e3 = await addEdge(D, A);
  check('来源关系添加', e1.status === 200 && e2.status === 200 && e3.status === 200);

  // 2. 成环 / 自环必须拒绝
  const cyc = await addEdge(A, C); // A 以 C 为来源 => A→C→B→A 成环
  check('成环被拒绝', cyc.status === 409, cyc.data);
  const self = await addEdge(A, A);
  check('自环被拒绝', self.status === 400);

  // 3. 授权：A、B 有效；C 无；D 仅撤销
  const aA = (await addAuth(A)).data.id;
  await addAuth(B);
  await addAuth(D, { revoked: true });

  // 4. 沿来源链核验：C→B→A，C 缺授权
  let v = await verify([C]);
  check('核验请求成功', v.status === 200, v.data);
  check('C 缺授权判定不合格', v.data.eligible === false);
  const cnode = v.data.results.find((r) => r.materialId === C);
  check('不合格节点含原因“缺少授权”', cnode && cnode.eligible === 0 && cnode.reasons.includes('缺少授权'));
  check('列出 C→B→A 来源路径', cnode.paths[0].pathNames.join(',') === ['派生C', '派生B', '原始素材A'].join(','));
  const anode = v.data.results.find((r) => r.materialId === A);
  check('上游 A/B 判定合格', anode.eligible === 1 && v.data.results.find((r) => r.materialId === B).eligible === 1);
  check('D 不在 C 的来源链中', !v.data.results.some((r) => r.materialId === D));

  // 5. 媒介不匹配
  const vWeb = await verify([C], { medium: '网页端' });
  const bNode = vWeb.data.results.find((r) => r.materialId === B);
  check('媒介不匹配判不合格', bNode.eligible === 0 && bNode.reasons.some((x) => x.includes('媒介不匹配')));
  // 通配授权
  await addAuth(B, { medium: '*' });
  const vWeb2 = await verify([C], { medium: '网页端' });
  const bNode2 = vWeb2.data.results.find((r) => r.materialId === B);
  check('通配媒介 * 匹配任意媒介', bNode2.eligible === 1);

  // 6. 非法日期 / 参数
  check('非法日期拒绝', (await verify([C], { start_date: '2026-13-40' })).status === 400);
  check('起>止日期拒绝', (await verify([C], { start_date: '2026-07-01', end_date: '2026-06-01' })).status === 400);
  check('空素材拒绝', (await verify([])).status === 400);
  check('授权起止颠倒拒绝', (await req('POST', '/api/authorizations', {
    material_id: A, medium: 'x', territory: 'x', start_date: '2026-12-31', end_date: '2026-01-01',
  })).status === 400);

  // 7. 不合格不得发布
  let pkg = (await req('POST', '/api/packages', {
    name: '春季展', medium: U.medium, territory: U.territory,
    start_date: U.s, end_date: U.e, material_ids: [C],
  })).data;
  const pubFail = await req('POST', `/api/packages/${pkg.id}/publish`, {});
  check('缺授权时发布被拒绝（422）', pubFail.status === 422 && pubFail.data.code === 'NOT_ELIGIBLE', pubFail.data);

  // 8. C 授权有效期不覆盖 => 仍不合格
  await addAuth(C, { start_date: '2026-05-01', end_date: '2026-06-01' });
  const vShort = await verify([C]);
  const cShort = vShort.data.results.find((r) => r.materialId === C);
  check('有效期不覆盖判不合格', cShort.eligible === 0 && cShort.reasons.some((x) => x.includes('有效期不覆盖')));
  const pubFail2 = await req('POST', `/api/packages/${pkg.id}/publish`, {});
  check('日期不覆盖时发布仍被拒绝', pubFail2.status === 422);

  // 9. 覆盖整段后发布成功，快照固化
  const aC = (await addAuth(C)).data.id;
  v = await verify([C]);
  check('全部节点合格', v.data.eligible === true && v.data.failCount === 0);
  const basisAtPublish = v.data.basisVersion;
  const pub = await req('POST', `/api/packages/${pkg.id}/publish`, { basis_version: basisAtPublish });
  check('发布成功并返回快照号', pub.status === 200 && pub.data.snapshotId > 0, pub.data);

  // 10. 并发编辑使依据过期 => 拒绝发布并提示重试
  let pkg2 = (await req('POST', '/api/packages', {
    name: '秋季展', medium: U.medium, territory: U.territory,
    start_date: U.s, end_date: U.e, material_ids: [D],
  })).data;
  let v2 = await verify([D]);
  const staleVer = v2.data.basisVersion;
  await addMaterial('无关新素材-改变依据版本'); // basis_version +1
  const stalePub = await req('POST', `/api/packages/${pkg2.id}/publish`, { basis_version: staleVer });
  check('依据过期发布被拒绝并带 STALE_BASIS', stalePub.status === 409 && stalePub.data.code === 'STALE_BASIS', stalePub.data);
  check('提示重试', /重试/.test(stalePub.data.message || ''));
  // D 目前只有撤销授权，补一份有效授权后用新版本发布成功
  await addAuth(D);
  v2 = await verify([D]);
  const pub2 = await req('POST', `/api/packages/${pkg2.id}/publish`, { basis_version: v2.data.basisVersion });
  check('重新核验后发布成功', pub2.status === 200, pub2.data);

  // 11. 已发布包不可编辑/删除；快照内容保留
  const editPub = await req('PUT', `/api/packages/${pkg.id}`, {
    name: 'x', medium: 'm', territory: 't', start_date: U.s, end_date: U.e, material_ids: [C],
  });
  check('已发布包不可编辑', editPub.status === 409);
  const delPub = await req('DELETE', `/api/packages/${pkg.id}`);
  check('已发布包不可删除', delPub.status === 409);

  const before = await req('GET', `/api/packages/${pkg.id}`);
  const snapBefore = before.data.package.snapshot;
  check('快照记录发布时结论', snapBefore.eligible === 1 && snapBefore.results.every((r) => r.eligible === 1));
  const snapAuthA = snapBefore.payload.authorizations.find((x) => x.id === aA);
  check('快照固化当时授权数据(未撤销)', snapAuthA && snapAuthA.revoked === 0);

  // 12. 授权撤销后重算：仅不再合格的已发布包标记需复核，快照保留
  await req('PUT', `/api/authorizations/${aA}`, {
    material_id: A, medium: U.medium, territory: U.territory,
    start_date: '2026-01-01', end_date: '2026-12-31', revoked: true, licensor: 'L', note: '',
  });
  const list = (await req('GET', '/api/packages')).data.packages;
  const p1 = list.find((x) => x.id === pkg.id);
  const p2 = list.find((x) => x.id === pkg2.id);
  check('pkg1 标为需复核、当前不合格', p1.status === 'needs_review' && p1.current_eligible === 0, p1);
  check('pkg2(D→A) 同样需复核', p2.status === 'needs_review' && p2.current_eligible === 0);

  const after = await req('GET', `/api/packages/${pkg.id}`);
  const snapAfter = after.data.package.snapshot;
  check('原快照保持不变（编号与结论）', snapAfter.id === snapBefore.id && snapAfter.eligible === 1);
  check('快照载荷仍为发布时数据（A 未撤销）',
    snapAfter.payload.authorizations.find((x) => x.id === aA).revoked === 0);
  check('快照素材清单仍为 C',
    snapAfter.payload.selectedMaterials.map((x) => x.id).join() === String(C));

  // 13. 恢复授权后当前资格恢复合格，但需复核状态由策展人处理（克隆新包）
  await req('PUT', `/api/authorizations/${aA}`, {
    material_id: A, medium: U.medium, territory: U.territory,
    start_date: '2026-01-01', end_date: '2026-12-31', revoked: false, licensor: 'L', note: '',
  });
  const list2 = (await req('GET', '/api/packages')).data.packages;
  const p1b = list2.find((x) => x.id === pkg.id);
  check('恢复后当前资格为合格', p1b.current_eligible === 1 && p1b.status === 'needs_review');

  const cloned = await req('POST', `/api/packages/${pkg.id}/clone`);
  check('克隆产生待发布包', cloned.status === 200);
  const cpkg = (await req('GET', `/api/packages/${cloned.data.id}`)).data.package;
  check('克隆包为 draft 且带相同清单/条件',
    cpkg.status === 'draft' && cpkg.material_ids.join() === String(C) &&
    cpkg.medium === U.medium && cpkg.start_date === U.s);
  const cv = await verify(cpkg.material_ids, {
    medium: cpkg.medium, territory: cpkg.territory,
    start_date: cpkg.start_date, end_date: cpkg.end_date,
  });
  check('克隆包按当前数据重新核验通过', cv.data.eligible === true);

  // 14. 多路径节点：新增 E←C 且 E←B，核验 E 应列出两条路径
  const E = await addMaterial('合成E');
  await addEdge(E, C);
  await addEdge(E, B);
  const vE = await verify([E]);
  const eNode = vE.data.results.find((r) => r.materialId === E);
  const pathsFromE = eNode.paths.filter((p) => p.root === E);
  check('枚举全部来源路径（两条）', pathsFromE.length === 2, pathsFromE.map((p) => p.pathNames.join('>')));
}

main().then(() => {
  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  server.kill();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}).catch((e) => {
  console.error('测试异常:', e);
  server.kill();
  process.exit(1);
});
