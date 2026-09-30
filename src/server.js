const express = require('express');
const path = require('path');
const { db, getBasisVersion } = require('./db');
const { verify, wouldCreateCycle } = require('./verify');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- 通用 ----------

const bad = (res, code, errors) => res.status(code).json({ ok: false, errors: Array.isArray(errors) ? errors : [errors] });

function materialBody(b) {
  return {
    name: String(b.name || '').trim(),
    kind: String(b.kind || '').trim(),
    note: String(b.note || '').trim(),
  };
}

function authBody(b) {
  return {
    material_id: parseInt(b.material_id, 10),
    medium: String(b.medium || '').trim(),
    territory: String(b.territory || '').trim(),
    start_date: String(b.start_date || '').trim(),
    end_date: String(b.end_date || '').trim(),
    revoked: b.revoked ? 1 : 0,
    licensor: String(b.licensor || '').trim(),
    note: String(b.note || '').trim(),
  };
}

// ---------- 素材 ----------

app.get('/api/materials', (req, res) => {
  const rows = db.prepare(`
    SELECT m.*,
      (SELECT GROUP_CONCAT(source_id) FROM source_edges WHERE derived_id=m.id) AS source_ids
    FROM materials m ORDER BY m.id
  `).all().map((r) => ({ ...r, source_ids: r.source_ids ? r.source_ids.split(',').map(Number) : [] }));
  res.json({ ok: true, materials: rows });
});

app.post('/api/materials', (req, res) => {
  const b = materialBody(req.body || {});
  if (!b.name) return bad(res, 400, '素材名称不能为空');
  const info = db.prepare('INSERT INTO materials (name, kind, note) VALUES (?,?,?)').run(b.name, b.kind, b.note);
  res.json({ ok: true, id: info.lastInsertRowid });
});

app.put('/api/materials/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!db.prepare('SELECT 1 FROM materials WHERE id=?').get(id)) return bad(res, 404, '素材不存在');
  const b = materialBody(req.body || {});
  if (!b.name) return bad(res, 400, '素材名称不能为空');
  db.prepare('UPDATE materials SET name=?, kind=?, note=? WHERE id=?').run(b.name, b.kind, b.note, id);
  res.json({ ok: true });
});

// 素材 / 来源 / 授权发生变更后，按当前数据重算已发布包资格。
// 仅更新 packages 表，不改动核验依据版本与任何快照。
function afterBasisChange() {
  recomputeAll();
}

app.delete('/api/materials/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const used = db.prepare('SELECT 1 FROM package_materials WHERE material_id=? LIMIT 1').get(id);
  if (used) return bad(res, 409, '该素材已纳入展览包，不能删除（可改名或撤销其授权）');
  db.prepare('DELETE FROM materials WHERE id=?').run(id);
  afterBasisChange();
  res.json({ ok: true });
});

// ---------- 来源关系 ----------

app.get('/api/edges', (req, res) => {
  res.json({ ok: true, edges: db.prepare('SELECT * FROM source_edges ORDER BY id').all() });
});

app.post('/api/edges', (req, res) => {
  const derivedId = parseInt(req.body?.derived_id, 10);
  const sourceId = parseInt(req.body?.source_id, 10);
  const note = String(req.body?.note || '').trim();
  if (!Number.isInteger(derivedId) || !Number.isInteger(sourceId)) return bad(res, 400, '请指定派生素材与来源素材');
  if (derivedId === sourceId) return bad(res, 400, '素材不能以自身为来源');
  const exists = (id) => db.prepare('SELECT 1 FROM materials WHERE id=?').get(id);
  if (!exists(derivedId) || !exists(sourceId)) return bad(res, 400, '素材不存在');
  const dup = db.prepare('SELECT 1 FROM source_edges WHERE derived_id=? AND source_id=?').get(derivedId, sourceId);
  if (dup) return bad(res, 409, '该来源关系已存在');
  // 成环检测：source 向上游能到达 derived 时拒绝
  if (wouldCreateCycle(derivedId, sourceId)) {
    return bad(res, 409, '拒绝：添加该来源关系将使来源链成环');
  }
  const info = db.prepare('INSERT INTO source_edges (derived_id, source_id, note) VALUES (?,?,?)')
    .run(derivedId, sourceId, note);
  afterBasisChange();
  res.json({ ok: true, id: info.lastInsertRowid });
});

app.delete('/api/edges/:id', (req, res) => {
  db.prepare('DELETE FROM source_edges WHERE id=?').run(parseInt(req.params.id, 10));
  afterBasisChange();
  res.json({ ok: true });
});

// ---------- 授权 ----------

app.get('/api/authorizations', (req, res) => {
  const rows = db.prepare(`
    SELECT a.*, m.name AS material_name
    FROM authorizations a JOIN materials m ON m.id=a.material_id
    ORDER BY a.material_id, a.id
  `).all();
  res.json({ ok: true, authorizations: rows });
});

function validateAuth(b) {
  const errors = [];
  if (!Number.isInteger(b.material_id) ||
      !db.prepare('SELECT 1 FROM materials WHERE id=?').get(b.material_id)) {
    errors.push('请选择有效素材');
  }
  if (!b.medium) errors.push('媒介不能为空');
  if (!b.territory) errors.push('地区不能为空（可用 * 表示全球）');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.start_date)) errors.push('开始日期不合法（YYYY-MM-DD）');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.end_date)) errors.push('结束日期不合法（YYYY-MM-DD）');
  if (/^\d{4}-\d{2}-\d{2}$/.test(b.start_date) && /^\d{4}-\d{2}-\d{2}$/.test(b.end_date)
      && b.start_date > b.end_date) {
    errors.push('开始日期不能晚于结束日期');
  }
  return errors;
}

app.post('/api/authorizations', (req, res) => {
  const b = authBody(req.body || {});
  const errors = validateAuth(b);
  if (errors.length) return bad(res, 400, errors);
  const info = db.prepare(`
    INSERT INTO authorizations (material_id, medium, territory, start_date, end_date, revoked, licensor, note)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(b.material_id, b.medium, b.territory, b.start_date, b.end_date, b.revoked, b.licensor, b.note);
  afterBasisChange();
  res.json({ ok: true, id: info.lastInsertRowid });
});

app.put('/api/authorizations/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!db.prepare('SELECT 1 FROM authorizations WHERE id=?').get(id)) return bad(res, 404, '授权不存在');
  const b = authBody(req.body || {});
  const errors = validateAuth(b);
  if (errors.length) return bad(res, 400, errors);
  db.prepare(`
    UPDATE authorizations SET material_id=?, medium=?, territory=?, start_date=?, end_date=?,
      revoked=?, licensor=?, note=? WHERE id=?
  `).run(b.material_id, b.medium, b.territory, b.start_date, b.end_date, b.revoked, b.licensor, b.note, id);
  afterBasisChange();
  res.json({ ok: true });
});

app.delete('/api/authorizations/:id', (req, res) => {
  db.prepare('DELETE FROM authorizations WHERE id=?').run(parseInt(req.params.id, 10));
  afterBasisChange();
  res.json({ ok: true });
});

// ---------- 核验预览 ----------

app.post('/api/verify', (req, res) => {
  const { material_ids, medium, territory, start_date, end_date } = req.body || {};
  const result = verify({
    materialIds: (material_ids || []).map(Number).filter(Number.isInteger),
    medium, territory, startDate: start_date, endDate: end_date,
  });
  if (!result.ok) return res.status(400).json(result);
  res.json({ ok: true, ...result, basisVersion: getBasisVersion() });
});

// ---------- 展览包 ----------

function loadPackage(id) {
  const p = db.prepare('SELECT * FROM packages WHERE id=?').get(id);
  if (!p) return null;
  p.material_ids = db.prepare('SELECT material_id FROM package_materials WHERE package_id=? ORDER BY material_id')
    .all(id).map((r) => r.material_id);
  p.snapshot = db.prepare('SELECT * FROM snapshots WHERE id=?').get(p.snapshot_id) || null;
  if (p.snapshot) {
    p.snapshot.results = JSON.parse(p.snapshot.results_json);
    p.snapshot.payload = JSON.parse(p.snapshot.payload_json);
    delete p.snapshot.results_json;
    delete p.snapshot.payload_json;
  }
  return p;
}

app.get('/api/packages', (req, res) => {
  const rows = db.prepare('SELECT id,name,status,medium,territory,start_date,end_date,current_eligible,snapshot_id,created_at,updated_at FROM packages ORDER BY id').all();
  res.json({ ok: true, packages: rows });
});

app.get('/api/packages/:id', (req, res) => {
  const p = loadPackage(parseInt(req.params.id, 10));
  if (!p) return bad(res, 404, '展览包不存在');
  res.json({ ok: true, package: p, basisVersion: getBasisVersion() });
});

function validatePackagePayload(body) {
  const errors = [];
  const ids = [...new Set((body.material_ids || []).map(Number))].filter(Number.isInteger);
  if (!String(body.name || '').trim()) errors.push('展览包名称不能为空');
  if (ids.length === 0) errors.push('请至少选择一个素材');
  const missing = ids.filter((id) => !db.prepare('SELECT 1 FROM materials WHERE id=?').get(id));
  if (missing.length) errors.push(`素材不存在: ${missing.join(', ')}`);
  if (!String(body.medium || '').trim()) errors.push('展示媒介不能为空');
  if (!String(body.territory || '').trim()) errors.push('地区不能为空');
  for (const f of ['start_date', 'end_date']) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body[f] || ''))) errors.push(f === 'start_date' ? '开始日期不合法' : '结束日期不合法');
  }
  const sd = String(body.start_date || ''), ed = String(body.end_date || '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(sd) && /^\d{4}-\d{2}-\d{2}$/.test(ed) && sd > ed) {
    errors.push('开始日期不能晚于结束日期');
  }
  return { errors, ids };
}

// 创建 / 更新待发布包（草稿）
app.post('/api/packages', (req, res) => {
  const { errors, ids } = validatePackagePayload(req.body || {});
  if (errors.length) return bad(res, 400, errors);
  const b = req.body;
  const tx = db.transaction(() => {
    const info = db.prepare(`INSERT INTO packages (name,status,medium,territory,start_date,end_date)
      VALUES (?,?,?,?,?,?)`).run(String(b.name).trim(), 'draft',
      String(b.medium).trim(), String(b.territory).trim(), b.start_date, b.end_date);
    const id = info.lastInsertRowid;
    const ins = db.prepare('INSERT INTO package_materials (package_id, material_id) VALUES (?,?)');
    ids.forEach((mid) => ins.run(id, mid));
    return id;
  });
  res.json({ ok: true, id: tx() });
});

app.put('/api/packages/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const pkg = db.prepare('SELECT * FROM packages WHERE id=?').get(id);
  if (!pkg) return bad(res, 404, '展览包不存在');
  if (pkg.status !== 'draft') {
    return bad(res, 409, '已发布包（含需复核）不可编辑，原核验快照须保留；请克隆为新包或新建包');
  }
  const { errors, ids } = validatePackagePayload(req.body || {});
  if (errors.length) return bad(res, 400, errors);
  const b = req.body;
  const tx = db.transaction(() => {
    db.prepare(`UPDATE packages SET name=?, medium=?, territory=?, start_date=?, end_date=?,
      updated_at=datetime('now') WHERE id=?`).run(
      String(b.name).trim(), String(b.medium).trim(), String(b.territory).trim(),
      b.start_date, b.end_date, id);
    db.prepare('DELETE FROM package_materials WHERE package_id=?').run(id);
    const ins = db.prepare('INSERT INTO package_materials (package_id, material_id) VALUES (?,?)');
    ids.forEach((mid) => ins.run(id, mid));
  });
  tx();
  res.json({ ok: true });
});

// 删除包（只允许草稿；已发布记录不可删除，以保留审计轨迹）
app.delete('/api/packages/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const pkg = db.prepare('SELECT * FROM packages WHERE id=?').get(id);
  if (!pkg) return bad(res, 404, '展览包不存在');
  if (pkg.status !== 'draft') return bad(res, 409, '已发布包及其快照不可删除');
  db.prepare('DELETE FROM packages WHERE id=?').run(id);
  res.json({ ok: true });
});

// 克隆为草稿（便于复核后调整）
app.post('/api/packages/:id/clone', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const pkg = loadPackage(id);
  if (!pkg) return bad(res, 404, '展览包不存在');
  const tx = db.transaction(() => {
    const info = db.prepare(`INSERT INTO packages (name,status,medium,territory,start_date,end_date)
      VALUES (?,?,?,?,?,?)`).run(pkg.name + '（副本）', 'draft',
      pkg.medium, pkg.territory, pkg.start_date, pkg.end_date);
    const nid = info.lastInsertRowid;
    const ins = db.prepare('INSERT INTO package_materials (package_id, material_id) VALUES (?,?)');
    pkg.material_ids.forEach((mid) => {
      if (db.prepare('SELECT 1 FROM materials WHERE id=?').get(mid)) ins.run(nid, mid);
    });
    return nid;
  });
  res.json({ ok: true, id: tx() });
});

// 发布：原子保存不可变核验快照 + 素材清单
// expected_version 为乐观并发依据；并发编辑使依据过期则拒绝发布并提示重试
app.post('/api/packages/:id/publish', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const expectedVersion = req.body?.basis_version === undefined
    ? null
    : parseInt(req.body.basis_version, 10);

  const publish = db.transaction(() => {
    const pkg = db.prepare('SELECT * FROM packages WHERE id=?').get(id);
    if (!pkg) throw httpError(404, '展览包不存在');
    if (pkg.status === 'published') throw httpError(409, '该包已发布，无需重复发布');

    const versionAtStart = getBasisVersion();
    if (expectedVersion !== null && Number.isInteger(expectedVersion)
        && versionAtStart !== expectedVersion) {
      throw httpError(409, {
        code: 'STALE_BASIS',
        message: `核验依据已过期（你看到的是版本 ${expectedVersion}，当前为版本 ${versionAtStart}）。授权或素材刚被他人修改，请重新核验后重试发布。`,
        currentVersion: versionAtStart,
      });
    }

    const mids = db.prepare('SELECT material_id FROM package_materials WHERE package_id=?')
      .all(id).map((r) => r.material_id);
    const result = verify({
      materialIds: mids,
      medium: pkg.medium, territory: pkg.territory,
      startDate: pkg.start_date, endDate: pkg.end_date,
    });
    if (!result.ok) throw httpError(400, result.errors);
    if (!result.eligible) {
      throw httpError(422, {
        code: 'NOT_ELIGIBLE',
        message: '存在不合格来源节点，不能发布',
        result,
      });
    }
    if (getBasisVersion() !== versionAtStart) {
      throw httpError(409, {
        code: 'STALE_BASIS',
        message: '并发修改导致核验依据在核验期间发生变化，请重新核验后重试发布。',
        currentVersion: getBasisVersion(),
      });
    }

    // 素材清单（名称按发布时点固化）与来源图快照
    const materials = db.prepare('SELECT id,name,kind,note FROM materials WHERE id IN ('
      + mids.map(() => '?').join(',') + ')').all(...mids);
    const allNodeIds = [...new Set(result.results.map((r) => r.materialId))];
    const nodeRows = allNodeIds.length
      ? db.prepare(`SELECT id,name,kind,note FROM materials WHERE id IN (${allNodeIds.map(() => '?').join(',')})`).all(...allNodeIds)
      : [];
    const edges = db.prepare(`
      SELECT derived_id, source_id, note FROM source_edges
      WHERE derived_id IN (SELECT id FROM materials)
    `).all();
    const auths = db.prepare(`
      SELECT id,material_id,medium,territory,start_date,end_date,revoked,licensor,note
      FROM authorizations WHERE material_id IN (${allNodeIds.map(() => '?').join(',')})
    `).all(...allNodeIds);
    const payload = {
      package: {
        id, name: pkg.name, medium: pkg.medium, territory: pkg.territory,
        start_date: pkg.start_date, end_date: pkg.end_date,
      },
      selectedMaterials: materials,
      nodes: nodeRows,
      sourceEdges: edges,
      authorizations: auths,
    };

    const snapInfo = db.prepare(`
      INSERT INTO snapshots
        (package_id, package_name, basis_version, medium, territory, start_date, end_date,
         eligible, results_json, payload_json)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(id, pkg.name, versionAtStart, pkg.medium, pkg.territory,
      pkg.start_date, pkg.end_date, 1,
      JSON.stringify(result.results), JSON.stringify(payload));

    db.prepare(`UPDATE packages SET status='published', snapshot_id=?, current_eligible=1,
      updated_at=datetime('now') WHERE id=?`).run(snapInfo.lastInsertRowid, id);

    return { snapshotId: snapInfo.lastInsertRowid, basisVersion: versionAtStart };
  });

  try {
    const out = publish();
    res.json({ ok: true, ...out });
  } catch (e) {
    if (e && e.httpCode) return res.status(e.httpCode).json({ ok: false, ...(typeof e.body === 'string' ? { errors: [e.body] } : e.body) });
    throw e;
  }
});

function httpError(code, body) {
  const e = new Error(typeof body === 'string' ? body : body.message);
  e.httpCode = code;
  e.body = body;
  return e;
}

// 重新计算所有已发布包（published / needs_review）的当前资格：
// 仅由合格转为不合格的包标为 needs_review；快照保持不变、永不回退。
function recomputeAll() {
  const pkgs = db.prepare(`SELECT * FROM packages WHERE status IN ('published','needs_review')`).all();
  for (const p of pkgs) {
    const mids = db.prepare('SELECT material_id FROM package_materials WHERE package_id=?')
      .all(p.id).map((r) => r.material_id);
    const result = verify({
      materialIds: mids, medium: p.medium, territory: p.territory,
      startDate: p.start_date, endDate: p.end_date,
    });
    if (!result.ok) continue; // 数据结构问题不改变状态
    if (result.eligible) {
      db.prepare(`UPDATE packages SET current_eligible=1, updated_at=datetime('now') WHERE id=?`).run(p.id);
      // 当前合格的 needs_review 包保留需复核状态，供策展人工确认后处理（快照审计需要）
    } else if (p.status === 'published') {
      // 仅「不再合格」的已发布包被标为需复核
      db.prepare(`UPDATE packages SET status='needs_review', current_eligible=0,
        updated_at=datetime('now') WHERE id=?`).run(p.id);
    } else {
      db.prepare(`UPDATE packages SET current_eligible=0, updated_at=datetime('now') WHERE id=?`).run(p.id);
    }
  }
}

app.get('/api/state', (req, res) => {
  res.json({ ok: true, basisVersion: getBasisVersion() });
});

app.post('/api/recompute', (req, res) => {
  recomputeAll();
  res.json({ ok: true, basisVersion: getBasisVersion() });
});

// 每次服务启动时重算一次资格（授权数据可能在停机期间被直接改过库）
recomputeAll();

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`展品授权核验应用已启动: http://localhost:${PORT}`);
  });
}

module.exports = { app, recomputeAll };
