// ============ API ============
const api = async (method, url, body) => {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (_) { /* no body */ }
  if (!res.ok || (data && data.ok === false)) {
    const err = new Error('request failed');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg, isError) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' error' : '');
  setTimeout(() => t.classList.add('hidden'), 3500);
}
function errMsg(e) {
  const d = e.data;
  if (!d) return e.message || '请求失败';
  if (Array.isArray(d.errors)) return d.errors.join('；');
  return d.message || d.code || '请求失败';
}

// ============ 全局状态 ============
const state = {
  materials: [], edges: [], auths: [],
  packages: [], basisVersion: 0,
  currentPkgId: null,
  lastVerify: null,
};

const matName = (id) => {
  const m = state.materials.find((x) => x.id === id);
  return m ? m.name : `#${id}`;
};

// ============ Tabs ============
$$('.tab').forEach((btn) => btn.addEventListener('click', () => {
  $$('.tab').forEach((b) => b.classList.toggle('active', b === btn));
  $$('.tabpane').forEach((p) => p.classList.add('hidden'));
  $(`#tab-${btn.dataset.tab}`).classList.remove('hidden');
}));

// ============ 素材 ============
async function loadMaterials() {
  const d = await api('GET', '/api/materials');
  state.materials = d.materials;
  renderMaterials();
  renderMaterialOptions();
}

function renderMaterials() {
  $('#material-list').innerHTML = state.materials.map((m) => `
    <div class="item-card">
      <h3>#${m.id} ${esc(m.name)} ${m.kind ? `<span class="badge draft">${esc(m.kind)}</span>` : ''}</h3>
      <div class="meta">${esc(m.note || '')}</div>
      <div class="sources">
        ${m.source_ids.length
          ? '来源：' + m.source_ids.map((s) => `#${s} ${esc(matName(s))}`).join('，')
          : '<span class="muted">无上游来源（原始素材）</span>'}
      </div>
      <div class="actions">
        <button class="tiny ghost" onclick="editMaterial(${m.id})">编辑</button>
        <button class="tiny danger" onclick="deleteMaterial(${m.id})">删除</button>
      </div>
    </div>`).join('') || '<p class="muted">尚无素材</p>';
}

function renderMaterialOptions() {
  const opts = state.materials.map((m) => `<option value="${m.id}">#${m.id} ${esc(m.name)}</option>`).join('');
  $('#edge-derived').innerHTML = opts;
  $('#edge-source').innerHTML = opts;
  $('#auth-material').innerHTML = opts;
}

window.editMaterial = (id) => {
  const m = state.materials.find((x) => x.id === id);
  const f = $('#form-material');
  f.id.value = m.id; f.name.value = m.name; f.kind.value = m.kind || ''; f.note.value = m.note || '';
};

window.deleteMaterial = async (id) => {
  if (!confirm(`删除素材 #${id} 及其来源关系和授权？`)) return;
  try { await api('DELETE', `/api/materials/${id}`); await refreshAll(); toast('已删除'); }
  catch (e) { toast(errMsg(e), true); }
};

$('#material-reset').addEventListener('click', () => $('#form-material').reset());
$('#form-material').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { name: f.name.value, kind: f.kind.value, note: f.note.value };
  try {
    if (f.id.value) await api('PUT', `/api/materials/${f.id.value}`, body);
    else await api('POST', '/api/materials', body);
    f.reset();
    await refreshAll();
    toast('素材已保存');
  } catch (err) { toast(errMsg(err), true); }
});

// ============ 来源关系 ============
async function loadEdges() {
  const d = await api('GET', '/api/edges');
  state.edges = d.edges;
  $('#edge-list').innerHTML = state.edges.map((x) => `
    <tr>
      <td>${x.id}</td>
      <td>#${x.derived_id} ${esc(matName(x.derived_id))}</td>
      <td>←</td>
      <td>#${x.source_id} ${esc(matName(x.source_id))}</td>
      <td><button class="tiny danger" onclick="deleteEdge(${x.id})">删除</button></td>
    </tr>`).join('');
}
window.deleteEdge = async (id) => {
  await api('DELETE', `/api/edges/${id}`);
  await refreshAll();
};
$('#form-edge').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('POST', '/api/edges', {
      derived_id: Number(f.derived_id.value),
      source_id: Number(f.source_id.value),
      note: f.note.value,
    });
    f.note.value = '';
    await refreshAll();
    toast('来源关系已添加');
  } catch (err) { toast(errMsg(err), true); }
});

// ============ 授权 ============
async function loadAuths() {
  const d = await api('GET', '/api/authorizations');
  state.auths = d.authorizations;
  $('#auth-list').innerHTML = state.auths.map((a) => `
    <tr>
      <td>${a.id}</td>
      <td>#${a.material_id} ${esc(a.material_name)}</td>
      <td>${esc(a.medium)}</td>
      <td>${esc(a.territory)}</td>
      <td>${a.start_date} ~ ${a.end_date}</td>
      <td>${esc(a.licensor || '')}</td>
      <td>${a.revoked ? '<span class="badge revoked">已撤销</span>' : '<span class="badge active">有效</span>'}</td>
      <td>
        <button class="tiny ghost" onclick='editAuth(${a.id})'>编辑</button>
        <button class="tiny danger" onclick="deleteAuth(${a.id})">删除</button>
      </td>
    </tr>`).join('');
}

window.editAuth = (id) => {
  const a = state.auths.find((x) => x.id === id);
  const f = $('#form-auth');
  f.id.value = a.id;
  f.material_id.value = a.material_id;
  f.medium.value = a.medium;
  f.territory.value = a.territory;
  f.start_date.value = a.start_date;
  f.end_date.value = a.end_date;
  f.licensor.value = a.licensor || '';
  f.note.value = a.note || '';
  f.revoked.checked = !!a.revoked;
  window.scrollTo(0, 0);
};
window.deleteAuth = async (id) => {
  if (!confirm('删除该授权？')) return;
  await api('DELETE', `/api/authorizations/${id}`);
  await refreshAll();
  toast('已删除');
};
$('#auth-reset').addEventListener('click', () => $('#form-auth').reset());
$('#form-auth').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {
    material_id: Number(f.material_id.value),
    medium: f.medium.value,
    territory: f.territory.value,
    start_date: f.start_date.value,
    end_date: f.end_date.value,
    revoked: f.revoked.checked,
    licensor: f.licensor.value,
    note: f.note.value,
  };
  try {
    if (f.id.value) await api('PUT', `/api/authorizations/${f.id.value}`, body);
    else await api('POST', '/api/authorizations', body);
    f.reset();
    await refreshAll();
    toast('授权已保存');
  } catch (err) { toast(errMsg(err), true); }
});

// ============ 展览包 ============
async function loadPackages() {
  const d = await api('GET', '/api/packages');
  state.packages = d.packages;
  renderPackageList();
}

const STATUS_TEXT = { draft: '待发布', published: '已发布', needs_review: '需复核' };

function renderPackageList() {
  $('#package-list').innerHTML = state.packages.map((p) => `
    <div class="item-card${state.currentPkgId === p.id ? '" style="border-color:#12615d;box-shadow:0 0 0 2px #12615d22' : ''}">
      <h3>#${p.id} ${esc(p.name)}
        <span class="badge ${p.status}">${STATUS_TEXT[p.status]}</span>
        ${p.status !== 'draft'
          ? (p.current_eligible
              ? '<span class="badge ok">当前合格</span>'
              : '<span class="badge bad">当前不合格</span>')
          : ''}
      </h3>
      <div class="meta">
        ${esc(p.medium)} · ${esc(p.territory)} · ${p.start_date || ''} ~ ${p.end_date || ''}
      </div>
      <div class="actions">
        <button class="tiny primary" onclick="openPackage(${p.id})">打开</button>
        ${p.status !== 'draft' ? `<button class="tiny ghost" onclick="clonePkg(${p.id})">克隆为新包</button>` : ''}
      </div>
    </div>`).join('') || '<p class="muted">尚无展览包，点击上方按钮新建</p>';
}

window.openPackage = async (id) => {
  state.currentPkgId = id;
  state.lastVerify = null;
  renderPackageList();
  await renderPackageEditor();
};

$('#pkg-new').addEventListener('click', () => {
  state.currentPkgId = null;
  state.lastVerify = null;
  renderPackageList();
  renderPackageEditor();
});

function draftFormHtml(pkg) {
  const selected = new Set(pkg ? pkg.material_ids : []);
  return `
  <form id="form-pkg" class="card">
    <input type="hidden" name="id" value="${pkg ? pkg.id : ''}">
    <label>名称 <input name="name" required value="${pkg ? esc(pkg.name) : ''}" placeholder="如：2026 春季数字展厅"></label>
    <div class="gridform">
      <label>展示媒介 <input name="medium" required value="${pkg ? esc(pkg.medium) : ''}" placeholder="展馆大屏 / 网页 / *"></label>
      <label>地区 <input name="territory" required value="${pkg ? esc(pkg.territory) : ''}" placeholder="中国大陆 / *"></label>
      <label>开始日期 <input type="date" name="start_date" required value="${pkg ? pkg.start_date : ''}"></label>
      <label>结束日期 <input type="date" name="end_date" required value="${pkg ? pkg.end_date : ''}"></label>
    </div>
    <label>素材清单
      <div class="checklist">
        ${state.materials.map((m) => `
          <label><input type="checkbox" name="mids" value="${m.id}" ${selected.has(m.id) ? 'checked' : ''}>
          #${m.id} ${esc(m.name)}</label>`).join('') || '<span class="muted">请先登记素材</span>'}
      </div>
    </label>
    <div class="row">
      <button type="submit" class="primary">${pkg ? '保存待发布包' : '创建待发布包'}</button>
      <button type="button" class="ghost" id="btn-verify">核验（不发布）</button>
      ${pkg ? `<button type="button" class="danger" id="btn-publish">核验并发布</button>
               <button type="button" class="ghost" id="btn-delete">删除草稿</button>` : ''}
    </div>
  </form>
  <div id="verify-result"></div>`;
}

function renderVerifyResult(v) {
  const bad = v.results.filter((r) => !r.eligible);
  const head = v.eligible
    ? `<div class="verdict pass">✅ 核验通过：来源链共 ${v.nodeCount} 个节点，每个节点均有未撤销且覆盖整段使用（${esc(v.params.medium)} · ${esc(v.params.territory)} · ${v.params.start_date} ~ ${v.params.end_date}）的授权。<br>
        <span class="muted">核验依据版本 ${state.basisVersion}，发布将以该版本固化快照。</span></div>`
    : `<div class="verdict fail">❌ 核验不通过：${bad.length}/${v.nodeCount} 个来源节点不合格，不得发布。</div>`;

  const nodeHtml = (r) => `
    <div style="margin:8px 0;padding:8px 10px;border-radius:8px;background:${r.eligible ? '#f3faf6' : '#fdf1f1'}">
      <strong>#${r.materialId} ${esc(r.name)}</strong>
      ${r.selected ? '<span class="badge draft">所选素材</span>' : '<span class="badge draft">上游来源</span>'}
      ${r.eligible
        ? `<span class="badge ok">合格</span> <span class="muted">满足授权：#${r.coveringAuthIds.join(', #')}</span>`
        : `<span class="badge bad">不合格</span> <span class="reason">${r.reasons.map(esc).join('；')}</span>`}
      <div class="muted" style="margin-top:4px">出现于来源路径（自所选素材向上游）：</div>
      <ul class="paths">
        ${r.paths.map((p) => `<li>${p.pathNames.map((n, i) =>
          (i === p.path.length - 1 ? '◁ ' : '') + esc(n) + (i === 0 ? '（所选）' : '')
        ).join(' → ')}${p.path.length > 1 && p.root !== p.path[0] ? '' : ''}</li>`).join('')}
      </ul>
    </div>`;

  const sorted = [...v.results].sort((a, b) => (a.eligible - b.eligible) || a.materialId - b.materialId);
  return head + sorted.map(nodeHtml).join('');
}

async function renderPackageEditor() {
  const root = $('#pkg-editor');
  if (!state.currentPkgId) {
    $('#pkg-editor-title').textContent = '新建展览包';
    root.innerHTML = draftFormHtml(null);
    bindDraftForm();
    return;
  }
  let pkg;
  try {
    const d = await api('GET', `/api/packages/${state.currentPkgId}`);
    pkg = d.package;
    state.basisVersion = d.basisVersion;
    updateBasisBanner();
  } catch (e) {
    root.innerHTML = '<p class="muted">无法加载展览包</p>';
    return;
  }
  $('#pkg-editor-title').textContent = `展览包 #${pkg.id}`;

  if (pkg.status === 'draft') {
    root.innerHTML = draftFormHtml(pkg);
    bindDraftForm();
    return;
  }

  // published / needs_review：只读 + 不可变快照
  const snap = pkg.snapshot;
  root.innerHTML = `
    <div class="card">
      <div class="row" style="margin-bottom:8px">
        <span class="badge ${pkg.status}">${STATUS_TEXT[pkg.status]}</span>
        ${pkg.current_eligible ? '<span class="badge ok">按当前授权：合格</span>' : '<span class="badge bad">按当前授权：不再合格</span>'}
      </div>
      <div class="meta muted" style="font-size:13px">
        ${esc(pkg.name)}<br>
        使用条件：${esc(pkg.medium)} · ${esc(pkg.territory)} · ${pkg.start_date} ~ ${pkg.end_date}<br>
        发布时间：${snap ? snap.created_at : ''}
      </div>
      <div class="actions">
        <button class="primary tiny" id="btn-recompute">按当前授权重新计算资格</button>
        <button class="ghost tiny" onclick="clonePkg(${pkg.id})">克隆为待发布包</button>
      </div>
      <div id="recompute-msg"></div>
    </div>
    ${snap ? renderSnapshot(snap) : '<p class="muted">缺少快照（异常）</p>'}
  `;
  $('#btn-recompute').addEventListener('click', async () => {
    try {
      await api('POST', '/api/recompute');
      await refreshAll();
      await renderPackageEditor();
      toast('已按当前授权重新计算资格');
    } catch (e) { toast(errMsg(e), true); }
  });
}

function renderSnapshot(snap) {
  const payload = snap.payload;
  const fails = snap.results.filter((r) => !r.eligible);
  return `
  <div class="snapshot">
    <h4>🔒 不可变核验快照 #${snap.id}</h4>
    <div>快照依据版本：<b>${snap.basis_version}</b> · 固化时间：${snap.created_at} ·
      发布时结论：${snap.eligible ? '<span class="badge ok">全部合格</span>' : '<span class="badge bad">不合格</span>'}
      （${snap.results.length - fails.length}/${snap.results.length} 节点合格）</div>
    <details>
      <summary>发布时素材清单（${payload.selectedMaterials.length} 项）</summary>
      <ul class="paths">
        ${payload.selectedMaterials.map((m) => `<li>#${m.id} ${esc(m.name)}${m.kind ? ' · ' + esc(m.kind) : ''}</li>`).join('')}
      </ul>
    </details>
    <details>
      <summary>发布时逐节点核验结论与来源路径（${snap.results.length} 个节点）</summary>
      ${snap.results.map((r) => `
        <div style="margin:6px 0">
          #${r.materialId} ${esc(r.name)}
          ${r.eligible ? '<span class="badge ok">合格</span>' : '<span class="badge bad">不合格</span>'}
          ${!r.eligible ? `<span class="reason">${r.reasons.map(esc).join('；')}</span>` : ''}
          <ul class="paths">
            ${r.paths.map((p) => `<li>${p.pathNames.map((n) => esc(n)).join(' → ')}</li>`).join('')}
          </ul>
        </div>`).join('')}
    </details>
    <details>
      <summary>快照固化的授权与来源图数据（原始载荷）</summary>
      <pre style="white-space:pre-wrap;font-size:11px;max-height:280px;overflow:auto">${esc(JSON.stringify({ sourceEdges: payload.sourceEdges, authorizations: payload.authorizations }, null, 2))}</pre>
    </details>
  </div>`;
}

function bindDraftForm() {
  const f = $('#form-pkg');
  if (!f) return;
  const collect = () => ({
    name: f.name.value,
    medium: f.medium.value,
    territory: f.territory.value,
    start_date: f.start_date.value,
    end_date: f.end_date.value,
    material_ids: $$('input[name=mids]:checked', f).map((c) => Number(c.value)),
  });

  $('#btn-verify')?.addEventListener('click', async () => {
    try {
      const v = await api('POST', '/api/verify', collect());
      state.basisVersion = v.basisVersion;
      state.lastVerify = { ...collect(), ...v };
      updateBasisBanner();
      $('#verify-result').innerHTML = renderVerifyResult(v);
    } catch (e) {
      $('#verify-result').innerHTML =
        `<div class="error-box"><b>无法核验：</b>${esc(errMsg(e))}</div>`;
    }
  });

  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      if (f.id.value) await api('PUT', `/api/packages/${f.id.value}`, collect());
      else {
        const d = await api('POST', '/api/packages', collect());
        state.currentPkgId = d.id;
      }
      state.lastVerify = null;
      await refreshAll();
      await renderPackageEditor();
      toast('待发布包已保存');
    } catch (err) { toast(errMsg(err), true); }
  });

  $('#btn-delete')?.addEventListener('click', async () => {
    if (!confirm('删除该草稿？')) return;
    await api('DELETE', `/api/packages/${f.id.value}`);
    state.currentPkgId = null;
    await refreshAll();
    renderPackageEditor();
  });

  $('#btn-publish')?.addEventListener('click', async () => {
    const id = Number(f.id.value);
    // 发布前先做一次最新核验，拿到当前依据版本
    let v;
    try {
      v = await api('POST', '/api/verify', collect());
    } catch (e) {
      $('#verify-result').innerHTML =
        `<div class="error-box"><b>无法核验，已阻止发布：</b>${esc(errMsg(e))}</div>`;
      return;
    }
    state.basisVersion = v.basisVersion;
    $('#verify-result').innerHTML = renderVerifyResult(v);
    if (!v.eligible) {
      toast('存在不合格来源节点，不得发布', true);
      return;
    }
    try {
      const d = await api('POST', `/api/packages/${id}/publish`, { basis_version: v.basisVersion });
      state.lastVerify = null;
      await refreshAll();
      await renderPackageEditor();
      toast(`发布成功，已固化不可变快照 #${d.snapshotId}`);
    } catch (e) {
      if (e.data && (e.data.code === 'STALE_BASIS' || e.status === 409)) {
        // 并发编辑导致依据过期：提示重试并自动重新核验
        state.basisVersion = e.data.currentVersion || state.basisVersion;
        updateBasisBanner();
        $('#verify-result').innerHTML =
          `<div class="warn-box"><b>⚠ ${esc(errMsg(e))}</b><br>请确认最新核验结果后再次点击「核验并发布」。</div>`
          + $('#verify-result').innerHTML;
      } else if (e.data && e.data.code === 'NOT_ELIGIBLE') {
        $('#verify-result').innerHTML = renderVerifyResult(e.data.result);
      } else {
        toast(errMsg(e), true);
      }
    }
  });
}

window.clonePkg = async (id) => {
  try {
    const d = await api('POST', `/api/packages/${id}/clone`);
    state.currentPkgId = d.id;
    await refreshAll();
    await renderPackageEditor();
    toast('已克隆为待发布包');
  } catch (e) { toast(errMsg(e), true); }
};

// ============ 依据版本横幅 ============
function updateBasisBanner() {
  const el = $('#basis-banner');
  el.textContent = `核验依据版本：${state.basisVersion}（素材 / 来源 / 授权每变更一次即递增；发布时若版本已过期将被拒绝并提示重试）`;
  el.classList.remove('hidden');
}

// ============ 总刷新 ============
async function refreshAll() {
  await Promise.all([loadMaterials(), loadAuths(), loadPackages()]);
  await loadEdges();
  const d = await api('GET', '/api/state');
  state.basisVersion = d.basisVersion;
  updateBasisBanner();
}

(async function init() {
  await Promise.all([loadMaterials(), loadEdges(), loadAuths(), loadPackages()]);
  const d = await api('GET', '/api/state');
  state.basisVersion = d.basisVersion;
  updateBasisBanner();
  renderPackageEditor();
})();
