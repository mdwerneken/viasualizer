/* VIAsual front-end glue.
 * All analysis and figure-building happens in Python (py/core.py) running in
 * Pyodide; this file only wires controls, decodes figures, and calls Plotly.
 */
"use strict";

const DATA_VERSION = "v1";                  // bump when files in data/ change
const CODE_VERSION = "v7";                  // bump when py/core.py changes
const CACHE = "viasual-cache";
const DATA_FILES = ["meta.json", "stars.npz", "hi.npz", "members.npz", "gcs.json", "dwarfs.json"];
const PLOT_CONFIG = { responsive: true, displaylogo: false, scrollZoom: true,
                      modeBarButtonsToRemove: ["select2d", "lasso2d", "autoScale2d"] };

let py = null;                              // python function proxies
let META = null;
const FIGS = {};                            // last decoded figure per div id
const state = {
  mode: "Distance [kpc]", stream: "— all —", isolate: false, via: false,
  lam0: 0, bet0: 0, fov: 1.0, glo: 11, ghi: 20, hide: true,
  zoom: 40, hi_sphere: false, kepler: true, clean: false, himap: "total",
  qso_on: true, gc_on: true, dg_on: true, mem_on: true,
  rescale: false, connect: false, pair_kind: "sky-sep vs Δdist (pairs)",
};

const $ = (id) => document.getElementById(id);

/* ---------- binary figure decoding ---------- */
function b64bytes(b64) {
  if (Uint8Array.fromBase64) return Uint8Array.fromBase64(b64);
  const bin = atob(b64), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const CTOR = { f4: Float32Array, f8: Float64Array, i4: Int32Array, u2: Uint16Array, u1: Uint8Array };
function decode(o) {
  if (o && typeof o === "object") {
    if (o.__nd__) {
      const arr = new (CTOR[o.dtype])(b64bytes(o.b64).buffer);
      if (o.shape.length === 2) {
        const [r, c] = o.shape, rows = [];
        for (let i = 0; i < r; i++) rows.push(arr.subarray(i * c, (i + 1) * c));
        return rows;
      }
      return arr;
    }
    if (Array.isArray(o)) return o.map(decode);
    const r = {};
    for (const k in o) r[k] = decode(o[k]);
    return r;
  }
  return o;
}

/* ---------- cached fetch with progress ---------- */
async function fetchCached(vurl, onBytes) {
  let resp = null;
  const canCache = typeof caches !== "undefined";
  if (canCache) {
    try { resp = await (await caches.open(CACHE)).match(vurl); } catch (e) { /* ignore */ }
  }
  if (!resp) {
    resp = await fetch(vurl);
    if (!resp.ok) throw new Error(`fetch ${vurl}: ${resp.status}`);
    if (canCache) {
      try { await (await caches.open(CACHE)).put(vurl, resp.clone()); } catch (e) { /* ignore */ }
    }
  }
  const reader = resp.body.getReader(), chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    if (onBytes) onBytes(value.length);
  }
  const buf = new Uint8Array(got);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.length; }
  return buf;
}

/* ---------- render queue ---------- */
let busy = false;
const pending = new Set();
async function rerender(kind) {
  pending.add(kind);
  if (busy) return;
  busy = true;
  document.body.style.cursor = "progress";
  try {
    while (pending.size) {
      let k;
      if (pending.has("all")) { k = "all"; pending.clear(); }
      else if (pending.has("3d")) { k = "3d"; pending.delete("3d"); }
      else if (pending.has("move")) { k = "move"; pending.delete("move"); pending.delete("pair"); }
      else { k = pending.values().next().value; pending.delete(k); }
      const t0 = performance.now();
      const raw = py.render(JSON.stringify(state), k);
      const t1 = performance.now();
      const out = decode(JSON.parse(raw));
      const t2 = performance.now();
      applyOut(out);
      const t3 = performance.now();
      console.debug(`[viasual] ${k}: py ${Math.round(t1 - t0)}ms, decode ${Math.round(t2 - t1)}ms, plotly ${Math.round(t3 - t2)}ms`);
      await new Promise((r) => setTimeout(r, 0));
    }
  } finally {
    busy = false;
    document.body.style.cursor = "";
  }
}

function react(id) {
  const f = FIGS[id];
  const t0 = performance.now();
  Plotly.react(id, f.data, f.layout, PLOT_CONFIG);
  const dt = performance.now() - t0;
  if (dt > 120) console.debug(`[viasual] react ${id}: ${Math.round(dt)}ms`);
}

function ptrLayout(mainLayout) {
  // transparent twin of the 3D scene that holds only the pointer traces —
  // updating it never re-ingests the 80k-star traces (the whole speed trick)
  const lay = JSON.parse(JSON.stringify(mainLayout));
  lay.paper_bgcolor = "rgba(0,0,0,0)";
  lay.plot_bgcolor = "rgba(0,0,0,0)";
  for (const ax of ["xaxis", "yaxis", "zaxis"]) {
    lay.scene[ax] = { visible: false, range: lay.scene[ax].range, showspikes: false };
  }
  if (FIGS.fig3dptr && FIGS.fig3dptr.layout.scene.camera) {
    lay.scene.camera = FIGS.fig3dptr.layout.scene.camera;   // keep user's rotation
  }
  return lay;
}

function applyOut(out) {
  if (out.fig3d) {
    const ptr = out.fig3d.data.slice(-3);
    FIGS.fig3d = { data: out.fig3d.data.slice(0, -3), layout: out.fig3d.layout };
    FIGS.fig3dptr = { data: ptr, layout: ptrLayout(out.fig3d.layout) };
    react("fig3d");
    Plotly.react("fig3dptr", FIGS.fig3dptr.data, FIGS.fig3dptr.layout,
                 { responsive: true, displayModeBar: false });
    syncPtrCamera();
  }
  for (const id of ["moll", "skymap", "finder", "nn", "pair", "dist", "mag"]) {
    if (out[id]) { FIGS[id] = out[id]; react(id); }
  }
  if (out.pointer && FIGS.fig3dptr) {
    FIGS.fig3dptr.data = out.pointer;
    Plotly.react("fig3dptr", FIGS.fig3dptr.data, FIGS.fig3dptr.layout,
                 { responsive: true, displayModeBar: false });
    syncPtrCamera();
  }
  if (out.moll_circle && FIGS.moll) {
    FIGS.moll.layout.shapes[1] = out.moll_circle;
    Plotly.relayout("moll", { shapes: FIGS.moll.layout.shapes });
  }
  if (out.skymap_circle && FIGS.skymap) {
    FIGS.skymap.layout.shapes = [out.skymap_circle];
    Plotly.relayout("skymap", { shapes: FIGS.skymap.layout.shapes });
  }
  if (out.stats) $("stats").innerHTML = out.stats;
}

let camSyncQueued = false;
function syncPtrCamera() {
  // copy the star scene's live camera onto the pointer overlay (rAF-throttled)
  if (camSyncQueued) return;
  camSyncQueued = true;
  requestAnimationFrame(() => {
    camSyncQueued = false;
    const m = $("fig3d");
    if (!m || !m._fullLayout || !FIGS.fig3dptr) return;
    const cam = m._fullLayout.scene.camera;
    const c = { eye: { ...cam.eye }, center: { ...cam.center }, up: { ...cam.up } };
    FIGS.fig3dptr.layout.scene.camera = c;
    Plotly.relayout("fig3dptr", { "scene.camera": c });
  });
}

/* ---------- field position plumbing ---------- */
let syncing = false;
function setPosInputs(lam, bet, l, b) {
  syncing = true;
  $("lam").value = lam; $("lam_n").value = lam.toFixed(2);
  $("bet").value = bet; $("bet_n").value = bet.toFixed(2);
  $("l").value = l; $("l_n").value = l.toFixed(2);
  $("b").value = b; $("b_n").value = b.toFixed(2);
  syncing = false;
}
function setField(lam, bet, opts = {}) {
  lam = Math.max(-180, Math.min(180, lam));
  bet = Math.max(-90, Math.min(90, bet));
  state.lam0 = Math.round(lam * 100) / 100;
  state.bet0 = Math.round(bet * 100) / 100;
  const [l, b] = JSON.parse(py.convert("sgr2gal", state.lam0, state.bet0));
  setPosInputs(state.lam0, state.bet0, l, b);
  if (!opts.track) py.clear_dist_stream();
  pushRecent(state.lam0, state.bet0, l, b);
  rerender(opts.which || "move");
}
function setFieldGal(l, b, opts = {}) {
  const [lam, bet] = JSON.parse(py.convert("gal2sgr", l, b));
  setField(lam, bet, opts);
}

/* ---------- saved + recent fields ---------- */
const LS_KEY = "viasual_saved_fields";
let recents = [];
function loadSaved() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || []; } catch (e) { return []; }
}
function storeSaved(list) { localStorage.setItem(LS_KEY, JSON.stringify(list)); }
function chipEl(f, saved, i) {
  const chip = document.createElement("span");
  chip.className = "chip" + (saved ? "" : " recent");
  const lbl = document.createElement("span");
  lbl.className = "lbl";
  lbl.textContent = f.label || `ℓ${f.l.toFixed(1)} b${f.b.toFixed(1)}`;
  chip.title = `ℓ=${f.l.toFixed(2)} b=${f.b.toFixed(2)} · Λ=${f.lam.toFixed(2)} B=${f.bet.toFixed(2)}` +
               (f.fov ? ` · ${f.fov}°` : "") + (saved ? "  (click name to rename)" : "");
  chip.appendChild(lbl);
  if (saved) {
    lbl.contentEditable = "true";
    lbl.addEventListener("click", (e) => e.stopPropagation());
    lbl.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); lbl.blur(); } });
    lbl.addEventListener("blur", () => {
      const list = loadSaved();
      if (list[i]) { list[i].label = lbl.textContent.trim(); storeSaved(list); }
    });
    const del = document.createElement("span");
    del.className = "del"; del.textContent = "×"; del.title = "remove";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      const list = loadSaved(); list.splice(i, 1); storeSaved(list); renderSaved();
    });
    chip.appendChild(del);
  }
  chip.addEventListener("click", () => {
    if (f.fov) { state.fov = f.fov; $("fov").value = f.fov; $("fov-v").textContent = f.fov; }
    setField(f.lam, f.bet);
  });
  return chip;
}
function renderSaved() {
  const box = $("saved-list");
  box.innerHTML = "";
  const list = loadSaved();
  list.forEach((f, i) => box.appendChild(chipEl(f, true, i)));
  if (!list.length) box.innerHTML = "<span class='tiny'>none yet — ☆ saves the current field (label editable in place)</span>";
}
function renderRecent() {
  const box = $("recent-list");
  box.innerHTML = "";
  recents.slice(0, 6).forEach((f) => box.appendChild(chipEl(f, false, -1)));
}
function pushRecent(lam, bet, l, b) {
  const key = lam.toFixed(2) + "," + bet.toFixed(2);
  recents = recents.filter((r) => r.key !== key);
  recents.unshift({ key, lam, bet, l, b });
  recents = recents.slice(0, 6);
  renderRecent();
}

/* ---------- controls wiring ---------- */
function bindCheckbox(id, key, kind) {
  $(id).addEventListener("change", (e) => { state[key] = e.target.checked; rerender(kind); });
}
function wireControls() {
  $("mode").addEventListener("change", (e) => { state.mode = e.target.value; rerender("all"); });
  $("himap").addEventListener("change", (e) => { state.himap = e.target.value; rerender("all"); });
  $("stream").addEventListener("change", (e) => { state.stream = e.target.value; rerender("all"); });
  bindCheckbox("isolate", "isolate", "all");
  bindCheckbox("via", "via", "all");
  bindCheckbox("hide", "hide", "all");
  bindCheckbox("hi_sphere", "hi_sphere", "3d");
  bindCheckbox("kepler", "kepler", "3d");
  bindCheckbox("clean", "clean", "3d");
  bindCheckbox("qso_on", "qso_on", "move");
  bindCheckbox("gc_on", "gc_on", "all");
  bindCheckbox("dg_on", "dg_on", "all");
  bindCheckbox("mem_on", "mem_on", "all");
  bindCheckbox("rescale", "rescale", "move");
  bindCheckbox("connect", "connect", "move");
  $("pair_kind").addEventListener("change", (e) => { state.pair_kind = e.target.value; rerender("pair"); });

  // magnitude limit
  const glo = $("glo"), ghi = $("ghi");
  glo.min = ghi.min = META.gmin.toFixed(1);
  glo.max = ghi.max = META.gmax.toFixed(1);
  glo.value = META.gmin; ghi.value = META.g_hi_default;
  state.glo = META.gmin; state.ghi = META.g_hi_default;
  const magLbl = () => { $("glo-v").textContent = (+glo.value).toFixed(1); $("ghi-v").textContent = (+ghi.value).toFixed(1); };
  magLbl();
  glo.addEventListener("input", () => { if (+glo.value > +ghi.value) glo.value = ghi.value; magLbl(); });
  ghi.addEventListener("input", () => { if (+ghi.value < +glo.value) ghi.value = glo.value; magLbl(); });
  glo.addEventListener("change", () => { state.glo = +glo.value; rerender("all"); });
  ghi.addEventListener("change", () => { state.ghi = +ghi.value; rerender("all"); });

  $("zoom").addEventListener("input", () => { $("zoom-v").textContent = $("zoom").value; });
  $("zoom").addEventListener("change", (e) => { state.zoom = +e.target.value; rerender("3d"); });

  $("fov").addEventListener("input", () => { $("fov-v").textContent = $("fov").value; });
  $("fov").addEventListener("change", (e) => { state.fov = +e.target.value; rerender("move"); });

  // position sliders + number boxes (Sgr pair drives; Galactic pair converts back)
  const live = (rid, nid) => $(rid).addEventListener("input", () => { $(nid).value = (+$(rid).value).toFixed(1); });
  live("lam", "lam_n"); live("bet", "bet_n"); live("l", "l_n"); live("b", "b_n");
  const sgrChanged = () => { if (!syncing) setField(+$("lam").value, +$("bet").value); };
  const galChanged = () => { if (!syncing) setFieldGal(+$("l").value, +$("b").value); };
  $("lam").addEventListener("change", sgrChanged);
  $("bet").addEventListener("change", sgrChanged);
  $("l").addEventListener("change", galChanged);
  $("b").addEventListener("change", galChanged);
  $("lam_n").addEventListener("change", () => { if (!syncing) setField(+$("lam_n").value, +$("bet_n").value); });
  $("bet_n").addEventListener("change", () => { if (!syncing) setField(+$("lam_n").value, +$("bet_n").value); });
  $("l_n").addEventListener("change", () => { if (!syncing) setFieldGal(+$("l_n").value, +$("b_n").value); });
  $("b_n").addEventListener("change", () => { if (!syncing) setFieldGal(+$("l_n").value, +$("b_n").value); });

  document.querySelectorAll(".nudge").forEach((btn) => {
    btn.addEventListener("click", () => {
      const d = +btn.dataset.d;
      let l = +$("l_n").value, b = +$("b_n").value;
      if (btn.dataset.ax === "l") l += d; else b = Math.max(-90, Math.min(90, b + d));
      setFieldGal(l, b);
    });
  });

  // stream go-to + along-stream scan
  $("goto_stream").addEventListener("click", () => {
    const sel = $("stream").value;
    if (sel === "— all —") return;
    const g = JSON.parse(py.goto_stream(sel));
    const al = $("along");
    al.min = g.phi_min; al.max = g.phi_max; al.step = 0.5; al.value = g.phi; al.disabled = false;
    $("along-v").textContent = (+g.phi).toFixed(0);
    setField(g.lam, g.bet, { track: true });
  });
  $("along").addEventListener("input", () => { $("along-v").textContent = (+$("along").value).toFixed(0); });
  $("along").addEventListener("change", (e) => {
    const r = JSON.parse(py.along(+e.target.value));
    if (r) setField(r[0], r[1], { track: true });
  });

  // GC / dwarf go-to
  $("goto_gc").addEventListener("click", () => {
    const c = META.gc_pos[$("gc").value];
    if (c) setField(c[0], c[1]);
  });
  $("goto_dg").addEventListener("click", () => {
    const c = META.dg_pos[$("dg").value];
    if (c) setField(c[0], c[1]);
  });

  // promising fields
  $("candidates").addEventListener("change", (e) => {
    const c = META.candidates[+e.target.value];
    if (!c) { $("cand-info").textContent = ""; return; }
    $("cand-info").innerHTML = `<b>${c.combo}</b> · log N(HI) ${c.log_nhi} · ${c.site}<br>` +
      c.rungs.replaceAll(" | ", "<br>");
    state.fov = c.fov; $("fov").value = c.fov; $("fov-v").textContent = c.fov;
    setField(c.lam, c.bet);
  });

  // saved fields
  $("save_field").addEventListener("click", () => {
    const list = loadSaved();
    const [l, b] = JSON.parse(py.convert("sgr2gal", state.lam0, state.bet0));
    list.unshift({ lam: state.lam0, bet: state.bet0, l, b, fov: state.fov, label: "" });
    storeSaved(list); renderSaved();
  });
  $("export_saved").addEventListener("click", async () => {
    const txt = JSON.stringify(loadSaved(), null, 1);
    try { await navigator.clipboard.writeText(txt); $("export_saved").textContent = "copied ✓"; }
    catch (e) { window.prompt("copy this:", txt); }
    setTimeout(() => { $("export_saved").textContent = "copy saved list (JSON)"; }, 1500);
  });
  $("import_saved").addEventListener("click", () => {
    const txt = window.prompt("paste a saved-fields JSON list:");
    if (!txt) return;
    try {
      const inc = JSON.parse(txt);
      if (Array.isArray(inc)) { storeSaved(inc.concat(loadSaved())); renderSaved(); }
    } catch (e) { alert("could not parse that JSON"); }
  });
}

/* ---------- click-to-recenter ---------- */
function wireClicks() {
  $("fig3d").on("plotly_relayout", syncPtrCamera);
  $("fig3d").on("plotly_relayouting", syncPtrCamera);
  $("fig3d").on("plotly_click", (ev) => {
    const pt = ev.points && ev.points[0];
    if (pt && pt.customdata && pt.customdata.length === 2) setField(pt.customdata[0], pt.customdata[1]);
  });
  $("moll").on("plotly_click", (ev) => {
    const pt = ev.points && ev.points[0];
    if (!pt) return;
    if (pt.customdata && pt.customdata.length === 2) { setField(pt.customdata[0], pt.customdata[1]); return; }
    const r = JSON.parse(py.moll_invert(pt.x, pt.y));
    if (r) setFieldGal(r[0], r[1]);
  });
  $("skymap").on("plotly_click", (ev) => {
    const pt = ev.points && ev.points[0];
    if (!pt) return;
    if (pt.customdata && pt.customdata.length === 2) { setField(pt.customdata[0], pt.customdata[1]); return; }
    setField(pt.y, pt.x);
  });
  $("finder").on("plotly_click", (ev) => {
    const pt = ev.points && ev.points[0];
    if (!pt || typeof pt.x !== "number") return;
    const r = JSON.parse(py.finder_click_to_sgr(pt.x, pt.y, state.lam0, state.bet0));
    if (r) setField(r[0], r[1]);
  });
}

/* ---------- boot ---------- */
const setLoad = (msg, frac) => {
  $("load-msg").textContent = msg;
  if (frac != null) $("load-fill").style.width = Math.round(frac * 100) + "%";
};

async function boot() {
  try {
    setLoad("loading Python runtime…", 0.05);
    const pyodidePromise = loadPyodide();
    // data fetches run concurrently with the runtime download
    const EXPECT = 7.5e6;                       // rough core-data byte total for the bar
    let got = 0;
    const bump = (n) => { got += n; setLoad("downloading catalogs…", 0.1 + 0.35 * Math.min(1, got / EXPECT)); };
    const dataPromise = Promise.all(DATA_FILES.map((f) => fetchCached("../data/" + f + "?" + DATA_VERSION, bump)));
    const corePromise = fetchCached("py/core.py?" + CODE_VERSION);

    const pyodide = await pyodidePromise;
    setLoad("loading numpy…", 0.5);
    await pyodide.loadPackage("numpy");
    setLoad("writing data…", 0.62);
    const bufs = await dataPromise;
    pyodide.FS.mkdirTree("/data");
    DATA_FILES.forEach((f, i) => pyodide.FS.writeFile("/data/" + f, bufs[i]));
    pyodide.runPython(new TextDecoder().decode(await corePromise));
    py = {
      render: pyodide.globals.get("render"),
      convert: pyodide.globals.get("convert"),
      goto_stream: pyodide.globals.get("goto_stream"),
      along: pyodide.globals.get("along"),
      clear_dist_stream: pyodide.globals.get("clear_dist_stream"),
      moll_invert: pyodide.globals.get("moll_invert"),
      finder_click_to_sgr: pyodide.globals.get("finder_click_to_sgr"),
      init: pyodide.globals.get("init"),
      load_quaia: pyodide.globals.get("load_quaia"),
    };
    setLoad("initialising catalogs…", 0.72);
    META = JSON.parse(py.init("/data"));
    state.lam0 = Math.round(META.lam0 * 10) / 10;
    state.bet0 = Math.round(META.bet0 * 10) / 10;

    // populate selects
    const streamSel = $("stream");
    streamSel.append(new Option("— all —"));
    META.streams.forEach((s) => streamSel.append(new Option(s)));
    META.gc_opts.forEach(([label, idx]) => $("gc").append(new Option(label, idx)));
    META.dg_opts.forEach(([label, idx]) => $("dg").append(new Option(label, idx)));
    // candidate fields (grouped by FOV)
    const cs = $("candidates");
    let g3 = document.createElement("optgroup"); g3.label = "3° fields (top 10)";
    let g1 = document.createElement("optgroup"); g1.label = "1° fields (top 10)";
    META.candidates.forEach((c, i) => {
      const o = new Option(`#${c.rank} · ${c.n_rungs} rungs · ℓ ${c.l.toFixed(1)}, b ${c.b.toFixed(1)} · ${c.site}`, i);
      (c.fov === 3 ? g3 : g1).append(o);
    });
    cs.append(g3, g1);

    wireControls();
    renderSaved(); renderRecent();

    setLoad("first render…", 0.82);
    $("app").hidden = false;
    const [l0, b0] = JSON.parse(py.convert("sgr2gal", state.lam0, state.bet0));
    setPosInputs(state.lam0, state.bet0, l0, b0);
    const out = decode(JSON.parse(py.render(JSON.stringify(state), "all")));
    applyOut(out);
    wireClicks();
    setLoad("done", 1);
    $("loading").remove();
    window.dispatchEvent(new Event("resize"));

    // quasars stream in after first paint (17 MB)
    $("qso-status").textContent = "loading 1.3M quasars…";
    try {
      const qb = await fetchCached("../data/quaia.npz?" + DATA_VERSION);
      pyodide.FS.writeFile("/data/quaia.npz", qb);
      const n = py.load_quaia("/data");
      $("qso-status").textContent = `${(n / 1e6).toFixed(2)}M quasars ready`;
      rerender("move");
      setTimeout(() => { $("qso-status").textContent = ""; }, 6000);
    } catch (e) {
      $("qso-status").textContent = "quasars unavailable";
    }
  } catch (err) {
    setLoad("failed: " + (err.message || err.name || err), 0);
    console.log("BOOTFAIL", err.name, err.errno, err.message, (err.stack || "").slice(0, 1200));
    console.error(err);
  }
}

boot();
