const { db } = require('./db');

// ---------- 工具 ----------

// 严格校验 YYYY-MM-DD（拒绝 2026-2-3、2026-13-40 等）
function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return null;
  if (d.toISOString().slice(0, 10) !== s) return null;
  return s;
}

const WILDCARDS = new Set(['*', 'ANY', 'ALL', '全球', '全部', '任意']);

// 维度匹配：精确匹配（去空格、忽略大小写）或通配
function dimMatch(granted, requested) {
  const g = String(granted).trim();
  const r = String(requested).trim();
  if (WILDCARDS.has(g.toUpperCase()) || WILDCARDS.has(r.toUpperCase())) return true;
  return g.toLowerCase() === r.toLowerCase();
}

// ---------- 图加载与成环检测 ----------

function loadEdges() {
  return db.prepare('SELECT derived_id, source_id FROM source_edges').all();
}

// 检查加入 derived->source 是否成环：
// 若 source 能（沿 derived->source 方向）到达 derived，则闭环。
function wouldCreateCycle(derivedId, sourceId) {
  if (derivedId === sourceId) return true;
  const rows = db.prepare(
    'SELECT derived_id, source_id FROM source_edges WHERE NOT (derived_id=? AND source_id=?)'
  ).all(derivedId, sourceId);
  const fwd = new Map();
  for (const e of rows) {
    if (!fwd.has(e.derived_id)) fwd.set(e.derived_id, []);
    fwd.get(e.derived_id).push(e.source_id);
  }
  const stack = [sourceId];
  const seen = new Set();
  while (stack.length) {
    const cur = stack.pop();
    if (cur === derivedId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const s of fwd.get(cur) || []) stack.push(s);
  }
  return false;
}

// ---------- 来源路径枚举 ----------
//
// 对每个被选素材，沿 source 边向上游 DFS，枚举出全部去重节点路径。
// 边构成有向无环图（写入时保证），这里再以 visited 栈防御成环。

const MAX_PATHS = 50; // 每个被选素材最多保留的路径数，防止极端图爆炸
const MAX_STEPS = 200;

function reachablePaths(rootIds) {
  const edges = loadEdges();
  const sourcesOf = new Map();
  for (const e of edges) {
    if (!sourcesOf.has(e.derived_id)) sourcesOf.set(e.derived_id, []);
    sourcesOf.get(e.derived_id).push(e.source_id);
  }

  const result = new Map(); // nodeId -> [{path:[ids...]}]
  for (const root of rootIds) {
    const paths = [];
    let steps = 0;
    const dfs = (node, path, onPath) => {
      if (paths.length >= MAX_PATHS || steps++ > MAX_STEPS) return;
      const sources = sourcesOf.get(node) || [];
      if (sources.length === 0) {
        paths.push({ path: path.slice() });
        return;
      }
      for (const src of sources) {
        if (onPath.has(src)) continue; // 防御：跳过回边
        path.push(src);
        onPath.add(src);
        dfs(src, path, onPath);
        onPath.delete(src);
        path.pop();
        if (paths.length >= MAX_PATHS) return;
      }
    };
    dfs(root, [root], new Set([root]));
    if (paths.length === 0) paths.push({ path: [root] });

    for (const { path } of paths) {
      for (const nodeId of path) {
        if (!result.has(nodeId)) result.set(nodeId, []);
        const list = result.get(nodeId);
        if (!list.some((p) => p.path.length === path.length && p.path.every((v, i) => v === path[i]))) {
          list.push({ root, path: path.slice() });
        }
      }
    }
  }
  return result;
}

// ---------- 授权核验 ----------

function evaluateAuth(auth, medium, territory, startDate, endDate) {
  if (auth.revoked) return { ok: false, reason: '已撤销' };
  if (!dimMatch(auth.medium, medium)) return { ok: false, reason: `媒介不匹配（授权：${auth.medium}）` };
  if (!dimMatch(auth.territory, territory)) return { ok: false, reason: `地区不匹配（授权：${auth.territory}）` };
  if (auth.start_date > startDate || auth.end_date < endDate) {
    return { ok: false, reason: `有效期不覆盖（授权：${auth.start_date} ~ ${auth.end_date}）` };
  }
  return { ok: true };
}

function getMaterialMap() {
  const rows = db.prepare('SELECT id, name, kind FROM materials').all();
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * 核验一组被选素材在指定使用条件下，沿全部来源链的每个节点
 * 是否至少存在一份「未撤销 + 媒介/地区匹配 + 覆盖整段时间」的授权。
 *
 * 参数: { materialIds:[], medium, territory, startDate, endDate }
 * 返回: { ok, eligible, params, materials, results:[{...node}], failCount, nodeCount }
 */
function verify({ materialIds, medium, territory, startDate, endDate }) {
  const errors = [];
  const ids = [...new Set(materialIds || [])].filter((n) => Number.isInteger(n));
  if (ids.length === 0) errors.push('请至少选择一个素材');
  if (!medium || !String(medium).trim()) errors.push('展示媒介不能为空');
  if (!territory || !String(territory).trim()) errors.push('地区不能为空');
  if (!parseDate(startDate)) errors.push('开始日期不合法（应为 YYYY-MM-DD）');
  if (!parseDate(endDate)) errors.push('结束日期不合法（应为 YYYY-MM-DD）');
  if (parseDate(startDate) && parseDate(endDate) && startDate > endDate) {
    errors.push('开始日期不能晚于结束日期');
  }
  const names = getMaterialMap();
  for (const id of ids) {
    if (!names.has(id)) errors.push(`素材 #${id} 不存在`);
  }
  if (errors.length) return { ok: false, errors };

  const reach = reachablePaths(ids);
  const authStmt = db.prepare(
    'SELECT * FROM authorizations WHERE material_id = ? ORDER BY id'
  );

  const results = [];
  for (const [nodeId, paths] of [...reach.entries()].sort((a, b) => a[0] - b[0])) {
    const mat = names.get(nodeId) || { id: nodeId, name: `#${nodeId}`, kind: '' };
    const auths = authStmt.all(nodeId);
    const evaluations = auths.map((a) => ({ auth: a, ...evaluateAuth(a, medium, territory, startDate, endDate) }));
    const covering = evaluations.filter((e) => e.ok);
    const isSelected = ids.includes(nodeId);
    const reasons = evaluations.length
      ? [...new Set(evaluations.filter((e) => !e.ok).map((e) => e.reason))]
      : ['缺少授权'];
    results.push({
      materialId: nodeId,
      name: mat.name,
      kind: mat.kind || '',
      selected: isSelected ? 1 : 0,
      eligible: covering.length ? 1 : 0,
      coveringAuthIds: covering.map((e) => e.auth.id),
      reasons: covering.length ? [] : reasons,
      paths: paths.map((p) => ({
        root: p.root,
        rootName: (names.get(p.root) || {}).name || `#${p.root}`,
        path: p.path,
        pathNames: p.path.map((id) => ((names.get(id) || {}).name || `#${id}`)),
      })),
    });
  }

  const failCount = results.filter((r) => !r.eligible).length;
  return {
    ok: true,
    eligible: failCount === 0,
    params: { medium, territory, startDate: startDate, endDate: endDate },
    selectedIds: ids,
    results,
    nodeCount: results.length,
    failCount,
  };
}

module.exports = { verify, wouldCreateCycle, parseDate, dimMatch };
