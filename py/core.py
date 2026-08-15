# viasual core — analysis + plotly-figure builders ported from sag-stream's
# sag_stream_3d.ipynb. Runs in the browser under Pyodide (numpy only; no astropy/
# gala/scipy — coordinate frames are precomputed rotation matrices in meta.json).
# Every function returns plain dicts; numpy arrays are base64-encoded by _A()/_A2()
# and decoded to TypedArrays in js/app.js before Plotly.react().
import json
import base64
import numpy as np

D = {}          # data store filled by init()
_TRACK = {}     # along-stream track state
_DIST_STREAM = [None]
_MOLL_CACHE = {}

# --- styling constants (verbatim from the notebook) ---------------------------
_PANE = "#f2f2f2"
_HIST_COLOR = "#800000"
_ARROW = "#8b0000"
_CAM_BASE = np.array([1.12, 1.12, 0.72]); _CAM_BASE = _CAM_BASE / np.linalg.norm(_CAM_BASE)
_HEMI_SCALE = [[0.0, "#1f77b4"], [0.333, "#1f77b4"], [0.333, "#2ca02c"],
               [0.667, "#2ca02c"], [0.667, "#d62728"], [1.0, "#d62728"]]
_PALETTE = ["#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd", "#8c564b", "#e377c2",
            "#7f7f7f", "#bcbd22", "#17becf", "#393b79", "#637939", "#8c6d31", "#843c39",
            "#7b4173", "#5254a3", "#8ca252", "#bd9e39", "#ad494a", "#a55194"]
_ALL = "— all —"; _GREY = "#cbcbcb"; _FIELD_RED = "#ff2020"
_KEP_GREEN = "#4caf50"; _EQ_GREY = "#9a9a9a"
_QSO_YELLOW = "#f2c200"; _GC_COLOR = "#7b3fbf"; _DG_COLOR = "#0d7d5a"
_MEM_COLOR = "#1a7fd4"
_KIND_COL = {0: "#800000", 1: _QSO_YELLOW, 2: _MEM_COLOR}
_KIND_LBL = {0: "stream stars", 1: "quasars", 2: "dwarf members"}
_STAR_SYM = "star"

# --- binary array encoding ----------------------------------------------------
def _A(a, dtype="f4"):
    a = np.ascontiguousarray(np.asarray(a), dtype=dtype)
    return {"__nd__": 1, "dtype": dtype, "shape": list(a.shape),
            "b64": base64.b64encode(a.tobytes()).decode()}

def _A2(a):                       # 2D grid (heatmap z / surfacecolor) — NaN-safe
    return _A(a, "f4")

# --- spherical helpers ----------------------------------------------------------
def _unit_vectors(lon, lat):
    lr, br = np.radians(lon), np.radians(lat)
    return np.column_stack([np.cos(br) * np.cos(lr), np.cos(br) * np.sin(lr), np.sin(br)])

def _wrap180(x):
    return (np.asarray(x) + 180.0) % 360.0 - 180.0

def _lonlat_of(v):
    v = np.atleast_2d(v)
    return (np.degrees(np.arctan2(v[:, 1], v[:, 0])),
            np.degrees(np.arcsin(np.clip(v[:, 2], -1, 1))))

def _conv(M_from, M_to, lon, lat):
    """frame A (lon,lat) -> frame B via v_icrs = M_from.T @ v ; v_B = M_to @ v_icrs."""
    v = _unit_vectors(np.atleast_1d(lon), np.atleast_1d(lat))
    w = (M_to @ (M_from.T @ v.T)).T
    lo, la = _lonlat_of(w)
    return _wrap180(lo), la

def sgr_to_gal(lam0, bet0):
    lo, la = _conv(D["M_SGR"], D["M_GAL"], lam0, bet0)
    return float(lo[0]), float(la[0])

def gal_to_sgr(l0, b0):
    lo, la = _conv(D["M_GAL"], D["M_SGR"], l0, b0)
    return float(lo[0]), float(la[0])

def sgr_to_icrs(lam0, bet0):
    v = _unit_vectors(np.atleast_1d(lam0), np.atleast_1d(bet0))
    w = (D["M_SGR"].T @ v.T).T
    lo, la = _lonlat_of(w)
    return float(lo[0] % 360.0), float(la[0])

def field_indices(lon0, lat0, UG, radius):
    b0r, l0r = np.radians(lat0), np.radians(lon0)
    uc = np.array([np.cos(b0r) * np.cos(l0r), np.cos(b0r) * np.sin(l0r), np.sin(b0r)])
    return np.where(np.degrees(np.arccos(np.clip(UG @ uc, -1, 1))) <= radius)[0]

def gnomonic(lon, lat, lon0, lat0):
    lr, br, l0r, b0r = np.radians(lon), np.radians(lat), np.radians(lon0), np.radians(lat0)
    cosc = np.sin(b0r) * np.sin(br) + np.cos(b0r) * np.cos(br) * np.cos(lr - l0r)
    xi = np.cos(br) * np.sin(lr - l0r) / cosc
    eta = (np.cos(b0r) * np.sin(br) - np.sin(b0r) * np.cos(br) * np.cos(lr - l0r)) / cosc
    return np.degrees(xi) * 60, np.degrees(eta) * 60

def gnomonic_inv(xi_am, eta_am, lon0, lat0):
    xi, eta = np.radians(np.asarray(xi_am, float) / 60), np.radians(np.asarray(eta_am, float) / 60)
    rho = np.hypot(xi, eta); c = np.arctan(rho)
    b0 = np.radians(lat0)
    with np.errstate(invalid="ignore", divide="ignore"):
        lat = np.degrees(np.arcsin(np.clip(np.cos(c) * np.sin(b0) + eta * np.sin(c) * np.cos(b0) / rho, -1, 1)))
        lon = lon0 + np.degrees(np.arctan2(xi * np.sin(c),
                                           rho * np.cos(b0) * np.cos(c) - eta * np.sin(b0) * np.sin(c)))
    lat = np.where(rho == 0, lat0, lat); lon = np.where(rho == 0, lon0, lon)
    return lon, lat

def _nn_brute(uv):
    """Nearest neighbour by chunked brute force (no scipy in the browser)."""
    n = len(uv)
    if n < 2:
        return None, None
    nn = np.empty(n, int); best = np.empty(n)
    step = max(16, int(4e6 / n))
    for s in range(0, n, step):
        dcos = uv[s:s + step] @ uv.T
        m = dcos.shape[0]
        dcos[np.arange(m), s + np.arange(m)] = -2.0
        j = dcos.argmax(1)
        nn[s:s + m] = j; best[s:s + m] = dcos[np.arange(m), j]
    sep = np.degrees(2 * np.arcsin(np.clip(np.sqrt(np.maximum(0, 2 - 2 * best)) / 2, 0, 1))) * 60
    return nn, sep

def nearest_neighbors(idx):
    return _nn_brute(D["UG_SGR"][idx])

def visible_from(lat, dec, alt_min=None):
    return (90.0 - np.abs(lat - dec)) > (D["ALT_MIN"] if alt_min is None else alt_min)

# --- init -----------------------------------------------------------------------
def init(data_dir="data"):
    meta = json.loads(open(f"{data_dir}/meta.json").read())
    for k in ("M_GAL", "M_SGR", "R_ICRS2GC", "RG_GAL2GC", "SUN_GC"):
        D[k] = np.array(meta[k])
    for k in ("STREAM_NAMES", "VIA_STREAMS", "VIA_AGE", "DIST_MIN", "DIST_MAX", "DENS_CMAX",
              "GMIN", "GMAX", "SITES", "ALT_MIN", "LAM0_DEFAULT", "BET0_DEFAULT", "MAXR",
              "KEPLER_LB", "KEPLER_R", "CMAP_DIST", "CMAP_MAG", "CMAP_DENS", "CANDIDATES"):
        D[k] = meta[k]

    s = np.load(f"{data_dir}/stars.npz")
    for k in s.files:
        D["s_" + k] = s[k]
    D["s_dist_known"] = D["s_dist_known"].astype(bool)
    D["UG_SGR"] = _unit_vectors(D["s_lam"], D["s_bet"])
    D["N"] = len(D["s_X"])
    D["P_GC"] = np.column_stack([D["s_X"], D["s_Y"], D["s_Z"]])

    D["name_by_code"] = list(D["STREAM_NAMES"])
    D["VIA_MASK"] = np.isin(np.array(D["name_by_code"])[D["s_name_code"]], D["VIA_STREAMS"])

    rng = np.random.default_rng(0)
    D["BG"] = rng.choice(D["N"], size=min(8000, D["N"]), replace=False)
    D["MOLL_SUB"] = np.arange(0, D["N"], 3)
    D["MAP_SUB"] = np.arange(0, D["N"], 2)

    kd = D["RG_GAL2GC"] @ _unit_vectors(np.array([D["KEPLER_LB"][0]]), np.array([D["KEPLER_LB"][1]]))[0]
    D["KEP_DIR"] = kd / np.linalg.norm(kd)

    def _cat_from_json(path):
        try:
            raw = json.loads(open(path).read())
        except OSError:
            return None
        cat = {}
        for k, v in raw.items():
            if isinstance(v[0], str) or v and isinstance(next((x for x in v if x is not None), None), str):
                cat[k] = np.array([x if x is not None else "" for x in v])
            else:
                cat[k] = np.array([np.nan if x is None else float(x) for x in v])
        cat["absb"] = np.abs(cat["b"])
        return _cat_geom(cat)

    D["GCC"] = _cat_from_json(f"{data_dir}/gcs.json")
    D["DWF"] = _cat_from_json(f"{data_dir}/dwarfs.json")

    try:
        m = np.load(f"{data_dir}/members.npz")
        gal_names = [str(x) for x in m["gal_names"]]
        D["MEM"] = _cat_geom(dict(
            name=np.array([gal_names[i] for i in m["gal_code"]]),
            lam=m["lam"].astype(float), bet=m["bet"].astype(float),
            l=m["l"].astype(float), b=m["b"].astype(float),
            dist=m["dist"].astype(float), G=m["G"].astype(float), pmem=m["pmem"].astype(float)))
    except OSError:
        D["MEM"] = None
    D["QSO"] = None    # lazy — load_quaia() after first paint

    hi = np.load(f"{data_dir}/hi.npz")
    D["HI_LOG_TOTAL"] = hi["log_total"].astype("f4")
    D["HI_LIN_TOTAL"] = (10.0 ** D["HI_LOG_TOTAL"]).astype("f4")
    D["HI_STEP"] = float(hi["hi_step"])
    D["HI_SGR_TOTAL"] = hi["sgr_total"].astype("f4")
    D["HI_SGR_LAM"] = hi["sgr_lam"].astype(float); D["HI_SGR_BET"] = hi["sgr_bet"].astype(float)
    if "log_hvc" in hi.files:
        D["HI_LOG_HVC"] = hi["log_hvc"].astype("f4")
        D["HI_LIN_HVC"] = (10.0 ** D["HI_LOG_HVC"]).astype("f4")
        D["HI_SGR_HVC"] = hi["sgr_hvc"].astype("f4")
    else:
        D["HI_LOG_HVC"] = D["HI_LIN_HVC"] = D["HI_SGR_HVC"] = None
    ny, nx = D["HI_LOG_TOTAL"].shape
    gl = -180 + D["HI_STEP"] * np.arange(nx); gb = -90 + D["HI_STEP"] * np.arange(ny)
    LL, BB = np.meshgrid(gl, gb)
    D["HI_UG"] = None        # built lazily (12 MB) for hi_stats_in_field
    D["_HI_LB"] = (LL, BB)

    D["GC_OPTS"] = _obj_options(D["GCC"], "absb", lambda cat, i: f"|b|={abs(cat['b'][i]):.0f}°")
    D["DG_OPTS"] = _obj_options(D["DWF"], "mass", lambda cat, i: f"{cat['mass'][i]:.1e} M☉")
    _g0 = sgr_to_gal(D["LAM0_DEFAULT"], D["BET0_DEFAULT"])
    return json.dumps(dict(
        streams=(["Sagittarius"] if "Sagittarius" in D["STREAM_NAMES"] else []) +
                [x for x in D["VIA_STREAMS"] if x != "Sagittarius"],
        gc_opts=D["GC_OPTS"], dg_opts=D["DG_OPTS"],
        gc_pos={} if D["GCC"] is None else
                {int(i): [float(D["GCC"]["lam"][i]), float(D["GCC"]["bet"][i])]
                 for i in range(len(D["GCC"]["lam"]))},
        dg_pos={} if D["DWF"] is None else
                {int(i): [float(D["DWF"]["lam"][i]), float(D["DWF"]["bet"][i])]
                 for i in range(len(D["DWF"]["lam"]))},
        candidates=D["CANDIDATES"],
        lam0=D["LAM0_DEFAULT"], bet0=D["BET0_DEFAULT"], l0=_g0[0], b0=_g0[1],
        gmin=D["GMIN"], gmax=D["GMAX"], g_hi_default=min(20.0, D["GMAX"]),
        hvc=D["HI_LOG_HVC"] is not None,
        n_stars=D["N"], n_gc=0 if D["GCC"] is None else len(D["GCC"]["lam"]),
        n_dwarf=0 if D["DWF"] is None else len(D["DWF"]["lam"]),
        n_mem=0 if D["MEM"] is None else len(D["MEM"]["lam"])))

def load_quaia(data_dir="data"):
    q = np.load(f"{data_dir}/quaia.npz")
    D["QSO"] = dict(lam=q["lam"].astype(float), bet=q["bet"].astype(float),
                    G=q["G"].astype(float), z=q["z"].astype(float))
    D["QSO"]["UG"] = _unit_vectors(D["QSO"]["lam"], D["QSO"]["bet"])
    return len(D["QSO"]["lam"])

def _cat_geom(cat):
    cat["UG"] = _unit_vectors(cat["lam"], cat["bet"])
    if "dist" in cat:
        ug = _unit_vectors(cat["l"], cat["b"])
        P = D["SUN_GC"] + (D["RG_GAL2GC"] @ ug.T).T * np.asarray(cat["dist"], float)[:, None]
        cat["X"], cat["Y"], cat["Z"] = P[:, 0], P[:, 1], P[:, 2]
    return cat

def _obj_options(cat, key, extra):
    if cat is None:
        return []
    v = np.asarray(cat[key], float)
    o = np.argsort(np.where(np.isfinite(v), v, -np.inf))[::-1]
    return [[f"{cat['name'][i]} · {cat['dist'][i]:.1f} kpc · {extra(cat, i)}", int(i)] for i in o]

# --- HI sampling -----------------------------------------------------------------
def _hi_active(st):
    """(base log grid, base linear grid, sgr log grid, cmap, overlay?) for the state."""
    himap = st.get("himap", "total")
    if himap == "hvc" and D["HI_LOG_HVC"] is not None:
        base_log = np.maximum(D["HI_LOG_HVC"], 18.0)      # match notebook clip at 1e18
        return base_log, D["HI_LIN_HVC"], D["HI_SGR_HVC"], "Reds", False
    overlay = himap == "overlay" and D["HI_LOG_HVC"] is not None
    return D["HI_LOG_TOTAL"], D["HI_LIN_TOTAL"], D["HI_SGR_TOTAL"], "Blues", overlay

def _hi_sample(grid, lg, bg):
    li = np.clip(((np.asarray(lg) + 180) / D["HI_STEP"]).round().astype(int), 0, grid.shape[1] - 1)
    bi = np.clip(((np.asarray(bg) + 90) / D["HI_STEP"]).round().astype(int), 0, grid.shape[0] - 1)
    return grid[bi, li]

def hi_stats_in_field(lin_grid, lg0, bg0, radius):
    if D["HI_UG"] is None:
        LL, BB = D["_HI_LB"]
        D["HI_UG"] = _unit_vectors(LL.ravel(), BB.ravel()).astype("f4")
    uc = _unit_vectors(np.array([lg0]), np.array([bg0]))[0].astype("f4")
    m = (D["HI_UG"] @ uc) >= np.cos(np.radians(radius))
    if not m.any():
        return None, None
    v = lin_grid.ravel()[m]; v = v[np.isfinite(v)]
    if not len(v):
        return None, None
    return float(v.max()), float(v.mean())

# --- object helpers (verbatim ports) -----------------------------------------------
def obj_nstars(cat, i):
    m = cat.get("mass")
    if m is None or not np.isfinite(m[i]) or m[i] <= 0:
        return np.nan
    return m[i] / 0.4

def obj_size(cat, ii, base=11.0, span=10.0):
    m = cat.get("mass")
    if m is None:
        return base
    mm = np.asarray(m, float)[np.asarray(ii)]
    mm = np.where(np.isfinite(mm) & (mm > 0), mm, 1e2)
    lm = np.log10(np.clip(mm, 1e2, None))
    return base + span * np.clip((lm - 3.0) / 6.0, 0.0, 1.0)

def obj_hover(cat, ii):
    out = []
    for i in np.atleast_1d(ii):
        t = f"<b>{cat['name'][i]}</b><br>{cat['dist'][i]:.1f} kpc"
        n = obj_nstars(cat, i)
        if np.isfinite(n):
            t += f"<br>~{n:.2g} stars ({cat['mass'][i]:.2g} M<sub>&#9737;</sub>)"
        r = cat.get("rh_am")
        if r is not None and np.isfinite(r[i]):
            t += f"<br>r<sub>h</sub> = {r[i]:.1f}&#8242;"
        out.append(t)
    return out

def objects_in_field(cat, lam0, bet0, radius):
    if cat is None:
        return np.array([], int)
    return field_indices(lam0, bet0, cat["UG"], radius)

def _obj_layers(st):
    return [(D["GCC"], st["gc_on"], _GC_COLOR, "globular clusters", "GC"),
            (D["DWF"], st["dg_on"], _DG_COLOR, "dwarf galaxies", "dwarf")]

# --- colour specs ------------------------------------------------------------------
def _star_hover(ii):
    nm = D["name_by_code"]
    return [f"<b>{nm[D['s_name_code'][i]]}</b><br>{D['s_dist_use'][i]:.1f} kpc"
            f"{'' if D['s_dist_known'][i] else ' (geom.)'}<br>G = {D['s_G'][i]:.2f}" for i in ii]

def _color_spec(ii, mode, lo, hi, bar=True, crange=None):
    if mode == "Distance [kpc]":
        cmin, cmax = crange if crange else (D["DIST_MIN"], D["DIST_MAX"])
        m = dict(color=_A(D["s_dist_use"][ii]), colorscale=D["CMAP_DIST"], cmin=cmin, cmax=cmax, showscale=bar)
        if bar: m["colorbar"] = dict(title=dict(text="dist"), thickness=12)
        return m
    if mode == "Gaia G magnitude":
        cmin, cmax = crange if crange else (lo, hi)
        m = dict(color=_A(D["s_G"][ii]), colorscale=D["CMAP_MAG"], cmin=cmin, cmax=cmax, showscale=bar)
        if bar: m["colorbar"] = dict(title=dict(text="G"), thickness=12)
        return m
    if mode == "On-sky density (1° FOV)":
        cmin, cmax = crange if crange else (0.0, D["DENS_CMAX"])
        m = dict(color=_A(D["s_density"][ii]), colorscale=D["CMAP_DENS"], cmin=cmin, cmax=cmax, showscale=bar)
        if bar: m["colorbar"] = dict(title=dict(
            text=f"N∈[{int(cmin)},{int(cmax)}]" if crange else f"N<{int(D['DENS_CMAX'])}"), thickness=12)
        return m
    if mode == "Hemisphere visibility":
        m = dict(color=_A(D["s_hemi"][ii]), colorscale=_HEMI_SCALE, cmin=-0.5, cmax=2.5, showscale=bar)
        if bar: m["colorbar"] = dict(title=dict(text="vis"), tickmode="array", tickvals=[0, 1, 2],
                                     ticktext=["S", "Both", "N"], thickness=12)
        return m
    return dict(color=[_PALETTE[cc % len(_PALETTE)] for cc in D["s_name_code"][ii]], showscale=False)

_RESCALE_KEYS = {"Distance [kpc]": "s_dist_use", "Gaia G magnitude": "s_G",
                 "On-sky density (1° FOV)": "s_density"}

def _field_crange(sub, mode):
    k = _RESCALE_KEYS.get(mode)
    if k is None or not len(sub):
        return None
    vv = np.asarray(D[k], float)[sub]; vv = vv[np.isfinite(vv)]
    if not len(vv):
        return None
    a, b = float(vv.min()), float(vv.max())
    return (a - 0.5, b + 0.5) if a == b else (a, b)

# --- geometry for the 3D view ---------------------------------------------------
def _perp_basis(v):
    v = v / np.linalg.norm(v)
    t = np.array([1.0, 0, 0]) if abs(v[0]) < 0.9 else np.array([0, 1.0, 0])
    uu = np.cross(v, t); uu /= np.linalg.norm(uu)
    return uu, np.cross(v, uu)

def _field_dir(lam0, bet0):
    ra0, dec0 = sgr_to_icrs(lam0, bet0)
    r0, d0 = np.radians(ra0), np.radians(dec0)
    v = D["R_ICRS2GC"] @ np.array([np.cos(d0) * np.cos(r0), np.cos(d0) * np.sin(r0), np.sin(d0)])
    return v / np.linalg.norm(v)

def _sky_circle_lb(lg0, bg0, radius_deg, n=180):
    cvec = _unit_vectors(np.array([lg0]), np.array([bg0]))[0]
    uu, w = _perp_basis(cvec); th = np.linspace(0, 2 * np.pi, n); r = np.radians(radius_deg)
    d = np.cos(r) * cvec[:, None] + np.sin(r) * (np.cos(th) * uu[:, None] + np.sin(th) * w[:, None])
    return np.degrees(np.arctan2(d[1], d[0])), np.degrees(np.arcsin(np.clip(d[2], -1, 1)))

def galactic_disk_surface(radius=10.0, thickness=1.0, n=72, z=0.0):
    th = np.linspace(0, 2 * np.pi, n, endpoint=False)
    xr, yr = radius * np.cos(th), radius * np.sin(th)
    zb, zt = z - thickness / 2, z + thickness / 2
    xx = np.concatenate([xr, xr, [0.0, 0.0]])
    yy = np.concatenate([yr, yr, [0.0, 0.0]])
    zz = np.concatenate([np.full(n, zb), np.full(n, zt), [zb, zt]])
    cb, ct = 2 * n, 2 * n + 1
    ii, jj, kk = [], [], []
    for a in range(n):
        b = (a + 1) % n
        ii += [a, b];  jj += [b, b + n];  kk += [a + n, a + n]
        ii += [cb];    jj += [a];         kk += [b]
        ii += [ct];    jj += [b + n];     kk += [a + n]
    return dict(type="mesh3d", x=_A(xx), y=_A(yy), z=_A(zz), i=ii, j=jj, k=kk,
                color="#6a5acd", opacity=0.35, flatshading=True, hoverinfo="skip", showlegend=False)

def _pointer_traces(dirv, fov, dtip):
    # NB: scatter3d mode="lines" fails to render on some GPU/ANGLE stacks (macOS
    # Metal), so the shaft and FOV circle are dense marker dots instead of lines.
    S = D["SUN_GC"]
    shaft_t = np.linspace(0.05, 0.95, 60)[:, None]
    P = S + dirv * shaft_t * dtip
    tip = S + dirv * dtip
    rad = dtip * np.tan(np.radians(fov / 2))
    uu, w = _perp_basis(dirv); th = np.linspace(0, 2 * np.pi, 100)
    cx = tip[0] + rad * (np.cos(th) * uu[0] + np.sin(th) * w[0])
    cy = tip[1] + rad * (np.cos(th) * uu[1] + np.sin(th) * w[1])
    cz = tip[2] + rad * (np.cos(th) * uu[2] + np.sin(th) * w[2])
    shaft = S + dirv * 0.95 * dtip
    return [
        dict(type="scatter3d", x=_A(P[:, 0]), y=_A(P[:, 1]), z=_A(P[:, 2]), mode="markers",
             marker=dict(size=2.5, color=_ARROW, opacity=1.0), hoverinfo="skip", showlegend=False),
        dict(type="cone", x=[shaft[0]], y=[shaft[1]], z=[shaft[2]],
             u=[dirv[0]], v=[dirv[1]], w=[dirv[2]], sizemode="absolute", sizeref=1.4,
             anchor="tip", showscale=False, colorscale=[[0, _ARROW], [1, _ARROW]], hoverinfo="skip"),
        dict(type="scatter3d", x=_A(cx), y=_A(cy), z=_A(cz), mode="markers",
             marker=dict(size=2, color=_FIELD_RED, opacity=1.0), hoverinfo="skip", showlegend=False),
    ]

def _kepler_cone(length=15.0, alpha_deg=8.0, n=48):
    a = np.radians(alpha_deg); uu, w = _perp_basis(D["KEP_DIR"])
    phi = np.linspace(0, 2 * np.pi, n); s = np.array([0.0, length / np.cos(a)])
    dv = np.cos(a) * D["KEP_DIR"][:, None] + np.sin(a) * (np.cos(phi) * uu[:, None] + np.sin(phi) * w[:, None])
    S = D["SUN_GC"]
    return dict(type="surface", x=_A2(S[0] + np.outer(s, dv[0])), y=_A2(S[1] + np.outer(s, dv[1])),
                z=_A2(S[2] + np.outer(s, dv[2])), colorscale=[[0, _KEP_GREEN], [1, _KEP_GREEN]],
                opacity=0.3, showscale=False, hoverinfo="skip", name="Kepler")

def _hi_sphere_trace(st, radius=10.0):
    base_log, _, _, cmap, _ = _hi_active(st)
    ll = np.linspace(-180, 180, 121); bb = np.linspace(-90, 90, 61)
    LL, BB = np.meshgrid(ll, bb)
    d = (D["RG_GAL2GC"] @ _unit_vectors(LL.ravel(), BB.ravel()).T).T
    P = D["SUN_GC"] + radius * d
    C = _hi_sample(base_log, LL.ravel(), BB.ravel()).reshape(LL.shape)
    vmin, vmax = np.nanpercentile(C, [5, 99])
    if not np.isfinite(vmin):
        vmin, vmax = 18.0, 20.0
    Zs = np.where(np.abs(BB) < 15, np.nan, P[:, 2].reshape(LL.shape))
    return dict(type="surface", x=_A2(P[:, 0].reshape(LL.shape)), y=_A2(P[:, 1].reshape(LL.shape)),
                z=_A2(Zs), surfacecolor=_A2(C), colorscale=cmap, cmin=float(vmin), cmax=float(vmax),
                opacity=0.6, showscale=False, hoverinfo="skip")

# --- state -----------------------------------------------------------------------
def _state(st):
    lam0, bet0 = st["lam0"], st["bet0"]
    sel = st["stream"]; fov = st["fov"]
    nm = np.array(D["name_by_code"])[D["s_name_code"]]
    keep = np.ones(D["N"], bool)
    if st["via"]:
        keep &= D["VIA_MASK"]
    if st["isolate"] and sel != _ALL:
        keep &= (nm == sel)
    col_mask = (nm == sel) if sel != _ALL else np.ones(D["N"], bool)
    idx = field_indices(lam0, bet0, D["UG_SGR"], fov / 2); idx = idx[keep[idx]]
    if st["hide"] and len(idx):
        idx = idx[(D["s_G"][idx] >= st["glo"]) & (D["s_G"][idx] <= st["ghi"])]
    fall = field_indices(lam0, bet0, D["UG_SGR"], fov / 2)
    dstream = _DIST_STREAM[0] or "Sagittarius"
    smem = fall[nm[fall] == dstream]
    if len(smem):
        dnear = float(np.linalg.norm(D["P_GC"][smem] - D["SUN_GC"], axis=1).min())
    else:
        dnear = 10.0
    return lam0, bet0, keep, col_mask, idx, max(dnear, 10.0)

# --- 3D figure ---------------------------------------------------------------------
def _fig_3d(st):
    lam0, bet0, keep, col_mask, idx, dtip = _state(st)
    mode, lo, hi = st["mode"], st["glo"], st["ghi"]
    inr = (D["s_G"] >= lo) & (D["s_G"] <= hi)
    base = (keep & inr) if st["hide"] else keep
    grey = np.where(base & ~col_mask)[0]; col = np.where(base & col_mask)[0]
    dirv = _field_dir(lam0, bet0)
    data = [galactic_disk_surface(10.0)]
    if st["kepler"]:
        data.append(_kepler_cone())
    if st["hi_sphere"]:
        data.append(_hi_sphere_trace(st))
    if keep.all():
        bg = D["BG"]
        data.append(dict(type="scatter3d", x=_A(D["s_X"][bg]), y=_A(D["s_Y"][bg]), z=_A(D["s_Z"][bg]),
                         mode="markers", hoverinfo="skip", showlegend=False,
                         marker=dict(size=0.9, color="#e0e0e0", opacity=0.3)))
    if len(grey):
        data.append(dict(type="scatter3d", x=_A(D["s_X"][grey]), y=_A(D["s_Y"][grey]), z=_A(D["s_Z"][grey]),
                         mode="markers", hoverinfo="skip", showlegend=False,
                         customdata=_A(np.column_stack([D["s_lam"][grey], D["s_bet"][grey]])),
                         marker=dict(size=1.4, color=_GREY, opacity=0.5)))
    if len(col):
        data.append(dict(type="scatter3d", x=_A(D["s_X"][col]), y=_A(D["s_Y"][col]), z=_A(D["s_Z"][col]),
                         mode="markers", hovertext=_star_hover(col), hoverinfo="text", showlegend=False,
                         customdata=_A(np.column_stack([D["s_lam"][col], D["s_bet"][col]])),
                         marker=dict(size=1.4, opacity=0.8, **_color_spec(col, mode, lo, hi))))
    layers = _obj_layers(st) + [(D["MEM"], st["mem_on"], _MEM_COLOR, "dwarf members", "member")]
    for cat, on, ccol, lbl, tag in layers:
        if cat is None or not on:
            continue
        V = np.column_stack([cat["X"], cat["Y"], cat["Z"]]) - D["SUN_GC"]
        r = np.linalg.norm(V, axis=1)
        ok = np.isfinite(r) & (r > 0)
        if not ok.any():
            continue
        wi = np.where(ok)[0]
        far = r[wi] > D["MAXR"]
        P = D["SUN_GC"] + V[wi] * np.minimum(1.0, D["MAXR"] / r[wi])[:, None]
        if tag == "member":
            hov = [f"<b>{cat['name'][k]}</b> member<br>{cat['dist'][k]:.0f} kpc (galaxy)"
                   f"<br>G = {cat['G'][k]:.2f}" for k in wi]
        else:
            hov = obj_hover(cat, wi)
        hov = [h + ("<br><i>beyond view — shown at box edge</i>" if fr else "") for h, fr in zip(hov, far)]
        sz = np.full(len(wi), 1.8) if tag == "member" else obj_size(cat, wi, 3.0, 6.0)
        data.append(dict(type="scatter3d", x=_A(P[:, 0]), y=_A(P[:, 1]), z=_A(P[:, 2]),
                         mode="markers", showlegend=False, hovertext=hov, hoverinfo="text",
                         customdata=_A(np.column_stack([cat["lam"][wi], cat["bet"][wi]])),
                         marker=dict(size=_A(np.atleast_1d(sz)) if np.ndim(sz) else sz, color=ccol,
                                     opacity=0.9, symbol={"GC": "circle", "dwarf": "diamond"}.get(tag, "circle"))))
    S = D["SUN_GC"]
    data.append(dict(type="scatter3d", x=[S[0]], y=[S[1]], z=[S[2]], mode="markers",
                     marker=dict(size=5, color="gold"), hoverinfo="skip", showlegend=False))
    data += _pointer_traces(dirv, st["fov"], dtip)   # last 3 traces — spliced by the move fast-path
    eye = _CAM_BASE * (1.5 * st["zoom"] / D["MAXR"])
    clean = st["clean"]; R = D["MAXR"]
    if clean:
        ax = lambda t, rng: dict(title=dict(text=""), range=rng, backgroundcolor="white", showbackground=False,
                                 showgrid=False, zeroline=False, showticklabels=False, showspikes=False)
    else:
        ax = lambda t, rng: dict(title=dict(text=t), range=rng, backgroundcolor=_PANE)
    layout = dict(height=600, margin=dict(l=0, r=0, t=6, b=0), showlegend=False,
                  paper_bgcolor="white", plot_bgcolor="white",
                  scene=dict(uirevision=f"zoom{st['zoom']}",
                             xaxis=ax("X", [S[0] - R, S[0] + R]),
                             yaxis=ax("Y", [S[1] - R, S[1] + R]),
                             zaxis=ax("Z", [S[2] - R, S[2] + R]),
                             aspectmode="cube", camera=dict(eye=dict(x=eye[0], y=eye[1], z=eye[2]))))
    return dict(data=data, layout=layout)

# --- Mollweide all-sky (plotly port of the matplotlib original) --------------------
_SQ2 = np.sqrt(2.0)

def _moll_theta(phi):
    th = np.asarray(phi, float).copy()
    for _ in range(7):
        f = 2 * th + np.sin(2 * th) - np.pi * np.sin(phi)
        df = 2 + 2 * np.cos(2 * th)
        with np.errstate(divide="ignore", invalid="ignore"):
            step = np.where(df > 1e-9, f / df, 0.0)
        th = th - step
    return np.where(np.abs(phi) >= np.pi / 2 - 1e-9, np.sign(phi) * np.pi / 2, th)

def _moll_xy(l_deg, b_deg):
    """Forward Mollweide of Galactic (l,b) with the map's -l flip; returns (x, y)."""
    lam = np.radians(-_wrap180(np.asarray(l_deg, float)))
    phi = np.radians(np.asarray(b_deg, float))
    th = _moll_theta(phi)
    return (2 * _SQ2 / np.pi) * lam * np.cos(th), _SQ2 * np.sin(th)

def _moll_grid(base_log, nx=560, ny=280):
    key = id(base_log)
    if key in _MOLL_CACHE:
        return _MOLL_CACHE[key]
    gx = np.linspace(-2 * _SQ2, 2 * _SQ2, nx); gy = np.linspace(-_SQ2, _SQ2, ny)
    GX, GY = np.meshgrid(gx, gy)
    sth = np.clip(GY / _SQ2, -1, 1); th = np.arcsin(sth)
    phi = np.arcsin(np.clip((2 * th + np.sin(2 * th)) / np.pi, -1, 1))
    with np.errstate(divide="ignore", invalid="ignore"):
        lam = np.pi * GX / (2 * _SQ2 * np.cos(th))
    bad = ~np.isfinite(lam) | (np.abs(lam) > np.pi)
    lmap = -np.degrees(lam); bmap = np.degrees(phi)
    z = _hi_sample(base_log, np.where(bad, 0, lmap), np.where(bad, 0, bmap))
    z = np.where(bad, np.nan, z).astype("f4")
    _MOLL_CACHE[key] = (gx, gy, z)
    return gx, gy, z

def _seam_break(x, y, gap=1.0):
    j = np.where(np.abs(np.diff(x)) > gap)[0]
    return np.insert(x, j + 1, np.nan), np.insert(y, j + 1, np.nan)

def _path_of(x, y):
    """SVG path string with M-breaks at NaN seams (for layout shapes)."""
    seg = []
    pen = "M"
    for xi, yi in zip(x, y):
        if not (np.isfinite(xi) and np.isfinite(yi)):
            pen = "M"
            continue
        seg.append(f"{pen}{xi:.4f},{yi:.4f}")
        pen = "L"
    return " ".join(seg)

def _moll_circle(lg0, bg0, rad, ccol, lw):
    """Field/Kepler circle as a layout SHAPE — updating a shape never re-ingests
    the plot's traces, so field moves cost ~ms instead of a full replot."""
    cl, cb = _sky_circle_lb(lg0, bg0, rad)
    mx, my = _moll_xy(cl, cb)
    mx, my = _seam_break(mx, my)
    return dict(type="path", path=_path_of(mx, my), xref="x", yref="y",
                line=dict(color=ccol, width=lw))

def _skymap_circle(lam0, bet0, fov):
    cosb = max(np.cos(np.radians(bet0)), 0.1)
    rr = fov / 2 * 0.95
    return dict(type="circle", xref="x", yref="y",
                x0=bet0 - rr, x1=bet0 + rr, y0=lam0 - rr / cosb, y1=lam0 + rr / cosb,
                line=dict(color=_FIELD_RED, width=1.8))

def _fig_moll(st):
    lam0, bet0, keep, col_mask, idx, _ = _state(st)
    lg0, bg0 = sgr_to_gal(lam0, bet0)
    base_log, _, _, cmap, overlay = _hi_active(st)
    data = []
    gx, gy, z = _moll_grid(base_log)
    vmin, vmax = np.nanpercentile(z, [5, 99])
    data.append(dict(type="heatmap", x=_A(gx), y=_A(gy), z=_A2(z), colorscale=cmap,
                     zmin=float(vmin), zmax=float(vmax), hoverinfo="skip",
                     colorbar=dict(title=dict(text="log N(HI)" + (" total" if overlay else ""),
                                              side="right"), thickness=10, len=0.8, x=1.0)))
    if overlay:
        gx2, gy2, z2 = _moll_grid(np.maximum(D["HI_LOG_HVC"], 17.0))
        vn, vx = np.nanpercentile(z2, [5, 99])
        data.append(dict(type="heatmap", x=_A(gx2), y=_A(gy2), z=_A2(z2), colorscale="Reds",
                         zmin=float(vn), zmax=float(vx), opacity=0.5, hoverinfo="skip",
                         colorbar=dict(title=dict(text="log N(HI) HVC", side="right"),
                                       thickness=10, len=0.8, x=1.08)))
    sub = D["MOLL_SUB"]
    gk = sub[keep[sub] & ~col_mask[sub]]; ck = sub[keep[sub] & col_mask[sub]]
    for ii, cc, ss, aa in ((gk, "#888888", 2.0, 0.5), (ck, "#111111", 2.5, 0.7)):
        if len(ii):
            mx, my = _moll_xy(D["s_l"][ii], D["s_b"][ii])
            data.append(dict(type="scattergl", x=_A(mx), y=_A(my), mode="markers", hoverinfo="skip",
                             showlegend=False, marker=dict(size=ss, color=cc, opacity=aa),
                             customdata=_A(np.column_stack([D["s_lam"][ii], D["s_bet"][ii]]))))
    ex, ey = _moll_xy(D["s_eq_l"], D["s_eq_b"])
    data.append(dict(type="scattergl", x=_A(ex), y=_A(ey), mode="markers", hoverinfo="skip",
                     showlegend=False, marker=dict(size=1.5, color=_EQ_GREY)))
    if D["MEM"] is not None and st["mem_on"]:
        mx, my = _moll_xy(D["MEM"]["l"], D["MEM"]["b"])
        data.append(dict(type="scattergl", x=_A(mx), y=_A(my), mode="markers", hoverinfo="skip",
                         showlegend=False, marker=dict(size=2, color=_MEM_COLOR, opacity=0.7)))
    for cat, on, ccol, lbl, tag in _obj_layers(st):
        if cat is None or not on:
            continue
        ii = np.arange(len(cat["l"]))
        ox, oy = _moll_xy(cat["l"], cat["b"])
        data.append(dict(type="scattergl", x=_A(ox), y=_A(oy), mode="markers",
                         hovertext=obj_hover(cat, ii), hoverinfo="text", showlegend=False,
                         customdata=_A(np.column_stack([cat["lam"], cat["bet"]])),
                         marker=dict(size=_A(obj_size(cat, ii, 5.0, 9.0)), color=ccol,
                                     symbol="star" if tag == "GC" else "diamond",
                                     line=dict(width=0.5, color="white"))))
    lons = np.arange(-150, 151, 30)
    tx, ty = _moll_xy(lons.astype(float), np.zeros(len(lons)))
    data.append(dict(type="scattergl", x=_A(tx), y=_A(ty), mode="text",
                     text=[str(v) for v in lons], hoverinfo="skip", showlegend=False,
                     textfont=dict(size=9, color="white", family="sans-serif")))
    shapes = [_moll_circle(D["KEPLER_LB"][0], D["KEPLER_LB"][1], D["KEPLER_R"], _KEP_GREEN, 1.6),
              _moll_circle(lg0, bg0, st["fov"] / 2, _FIELD_RED, 1.4)]   # field last — move fast-path
    layout = dict(shapes=shapes, height=330, margin=dict(l=6, r=6, t=6, b=6),
                  paper_bgcolor="white", plot_bgcolor="white", showlegend=False, dragmode=False,
                  xaxis=dict(visible=False, range=[-2 * _SQ2 * 1.02, 2 * _SQ2 * 1.02], fixedrange=True),
                  yaxis=dict(visible=False, range=[-_SQ2 * 1.05, _SQ2 * 1.05], fixedrange=True,
                             scaleanchor="x", scaleratio=1))
    return dict(data=data, layout=layout)

def moll_invert(x, y):
    """Inverse Mollweide for click-to-recenter (returns Galactic [l, b] or null)."""
    sth = np.clip(y / _SQ2, -1, 1); th = float(np.arcsin(sth))
    phi = float(np.arcsin(np.clip((2 * th + np.sin(2 * th)) / np.pi, -1, 1)))
    denom = 2 * _SQ2 * np.cos(th)
    if abs(denom) < 1e-9:
        return None
    lam = np.pi * x / denom
    if abs(lam) > np.pi:
        return None
    return json.dumps([float(_wrap180(-np.degrees(lam))), float(np.degrees(phi))])

# --- Λ–B (Sgr) map ------------------------------------------------------------------
def _fig_skymap(st):
    lam0, bet0, keep, col_mask, idx, _ = _state(st)
    mode, lo, hi = st["mode"], st["glo"], st["ghi"]
    _, _, sgr_grid, cmap, overlay = _hi_active(st)
    data = []
    if sgr_grid is not None:
        zmn, zmx = np.nanpercentile(sgr_grid, [25, 99])
        data.append(dict(type="heatmap", x=_A(D["HI_SGR_BET"]), y=_A(D["HI_SGR_LAM"]),
                         z=_A2(np.asarray(sgr_grid).T), colorscale=cmap, zmin=float(zmn), zmax=float(zmx),
                         showscale=False, opacity=0.6, hoverinfo="skip", zsmooth="best"))
    if overlay and D["HI_SGR_HVC"] is not None:
        zh0, zh1 = np.nanpercentile(D["HI_SGR_HVC"], [5, 99])
        data.append(dict(type="heatmap", x=_A(D["HI_SGR_BET"]), y=_A(D["HI_SGR_LAM"]),
                         z=_A2(np.asarray(D["HI_SGR_HVC"]).T), colorscale="Reds",
                         zmin=float(zh0), zmax=float(zh1),
                         showscale=False, opacity=0.55, hoverinfo="skip", zsmooth="best"))
    sub = D["MAP_SUB"]
    gsub = sub[keep[sub] & ~col_mask[sub]]; ck = np.where(keep & col_mask)[0]
    data.append(dict(type="scattergl", x=_A(D["s_bet"][gsub]), y=_A(D["s_lam"][gsub]), mode="markers",
                     hoverinfo="skip", showlegend=False, marker=dict(size=2, color=_GREY)))
    data.append(dict(type="scattergl", x=_A(D["s_bet"][ck]), y=_A(D["s_lam"][ck]), mode="markers",
                     hoverinfo="skip", showlegend=False,
                     marker=dict(size=2.5, **_color_spec(ck, mode, lo, hi, bar=False))))
    for cat, on, ccol, lbl, tag in _obj_layers(st):
        if cat is None or not on:
            continue
        vis = np.abs(cat["bet"]) <= 32
        if not vis.any():
            continue
        vi = np.where(vis)[0]
        data.append(dict(type="scattergl", x=_A(cat["bet"][vis]), y=_A(cat["lam"][vis]), mode="markers",
                         hoverinfo="text", hovertext=obj_hover(cat, vi), showlegend=False,
                         customdata=_A(np.column_stack([cat["lam"][vi], cat["bet"][vi]])),
                         marker=dict(size=_A(obj_size(cat, vi, 5.0, 6.0)), color=ccol,
                                     symbol="hexagram" if tag == "GC" else "diamond",
                                     line=dict(width=0.5, color="white"))))
    layout = dict(shapes=[_skymap_circle(lam0, bet0, st["fov"])],
                  height=440, margin=dict(l=26, r=4, t=44, b=14),
                  title=dict(text="Λ–B (Sgr)", x=0.5, y=0.97, font=dict(size=12)),
                  xaxis=dict(title=dict(text=""), range=[-30, 30], tickfont=dict(size=8), fixedrange=True),
                  yaxis=dict(title=dict(text=""), range=[180, -180], tickfont=dict(size=8), fixedrange=True),
                  plot_bgcolor="white", paper_bgcolor="white", showlegend=False)
    return dict(data=data, layout=layout)

# --- finder chart --------------------------------------------------------------------
def _finder_hi(st, lam0, bet0, fov, n=32, hvc=False):
    grid = np.maximum(D["HI_LOG_HVC"], 17.0) if hvc else _hi_active(st)[0]
    if hvc and D["HI_LOG_HVC"] is None:
        return None
    R = fov / 2 * 60; g = np.linspace(-R, R, n)
    XI, ETA = np.meshgrid(g, g)
    lo_, la_ = gnomonic_inv(XI.ravel(), ETA.ravel(), lam0, bet0)
    lg, bg = _conv(D["M_SGR"], D["M_GAL"], lo_, la_)
    Zg = _hi_sample(grid, lg, bg).reshape(XI.shape)
    return g, np.where(np.hypot(XI, ETA) <= R, Zg, np.nan)

def _cover_pointings(xi, eta, r=30.0, min_cov=2, cap=300):
    P = np.column_stack([xi, eta]); n = len(P)
    if n < min_cov:
        return []
    ci = np.arange(n) if n <= 1500 else np.random.default_rng(0).choice(n, 1500, replace=False)
    C = P[ci]
    Dm = np.hypot(C[:, 0][:, None] - P[:, 0][None, :], C[:, 1][:, None] - P[:, 1][None, :]) <= r
    uncov = np.ones(n, bool); chosen = []
    while uncov.sum() >= min_cov and len(chosen) < cap:
        cnt = (Dm & uncov).sum(1); bi = int(cnt.argmax())
        if cnt[bi] < min_cov:
            break
        chosen.append((float(C[bi, 0]), float(C[bi, 1]))); uncov &= ~Dm[bi]
    return chosen

def _obj_marker(cat, ii, mode, lo, hi, sym, size, fixed):
    m = dict(symbol=sym, line=dict(width=1, color="#333333"))
    m["size"] = _A(np.atleast_1d(size)) if np.ndim(size) else size
    if mode == "Distance [kpc]" and "dist" in cat:
        m.update(color=_A(np.asarray(cat["dist"])[ii]), colorscale=D["CMAP_DIST"],
                 cmin=D["DIST_MIN"], cmax=D["DIST_MAX"], showscale=False)
    elif mode == "Gaia G magnitude" and "G" in cat:
        m.update(color=_A(np.asarray(cat["G"])[ii]), colorscale=D["CMAP_MAG"],
                 cmin=lo, cmax=hi, showscale=False)
    else:
        m.update(color=fixed)
    return m

def _qso_in_field(st, lam0, bet0, fov):
    if D["QSO"] is None or not st["qso_on"]:
        return np.array([], int)
    q = objects_in_field(D["QSO"], lam0, bet0, fov / 2)
    if st["hide"] and len(q):
        q = q[(D["QSO"]["G"][q] >= st["glo"]) & (D["QSO"]["G"][q] <= st["ghi"])]
    return q

def _mem_in_field(st, lam0, bet0, fov):
    if D["MEM"] is None or not st["mem_on"]:
        return np.array([], int)
    m = objects_in_field(D["MEM"], lam0, bet0, fov / 2)
    if st["hide"] and len(m):
        g = D["MEM"]["G"][m]
        m = m[~np.isfinite(g) | ((g >= st["glo"]) & (g <= st["ghi"]))]
    return m

def _fig_finder(st):
    lam0, bet0, keep, col_mask, idx, _ = _state(st)
    mode, lo, hi, fov = st["mode"], st["glo"], st["ghi"], st["fov"]
    R = fov / 2 * 60; th = np.linspace(0, 2 * np.pi, 160)
    xi, eta = gnomonic(D["s_lam"][idx], D["s_bet"][idx], lam0, bet0)
    lg0, bg0 = sgr_to_gal(lam0, bet0)
    data = []
    hib = _finder_hi(st, lam0, bet0, fov)
    if hib is not None:
        gg, Zg = hib
        data.append(dict(type="heatmap", x=_A(gg), y=_A(gg), z=_A2(Zg), colorscale=_hi_active(st)[3],
                         showscale=False, opacity=0.35, zsmooth="best", hoverinfo="skip"))
    if _hi_active(st)[4]:
        hh = _finder_hi(st, lam0, bet0, fov, hvc=True)
        if hh is not None:
            gg2, Zh = hh
            data.append(dict(type="heatmap", x=_A(gg2), y=_A(gg2), z=_A2(Zh), colorscale="Reds",
                             showscale=False, opacity=0.5, zsmooth="best", hoverinfo="skip"))
    npoint = 0
    if fov > 1.0 and len(idx):
        ch = _cover_pointings(xi, eta); npoint = len(ch)
        for (cxc, cyc) in ch:
            data.append(dict(type="scatter", x=_A(cxc + 30 * np.cos(th)), y=_A(cyc + 30 * np.sin(th)),
                             mode="lines", line=dict(color="#c8c8c8", width=1),
                             hoverinfo="skip", showlegend=False))
    data.append(dict(type="scatter", x=_A(R * np.cos(th)), y=_A(R * np.sin(th)), mode="lines",
                     hoverinfo="skip", line=dict(color=_ARROW, width=2.5), showlegend=False))
    nn = None
    if len(idx) >= 2:
        nn, _sep = nearest_neighbors(idx)
    if st["connect"] and nn is not None and len(idx) > 1:
        xs, ys = [], []
        for i in range(len(idx)):
            j = nn[i]; xs += [xi[i], xi[j], np.nan]; ys += [eta[i], eta[j], np.nan]
        data.append(dict(type="scattergl", x=_A(np.array(xs)), y=_A(np.array(ys)), mode="lines",
                         hoverinfo="skip", showlegend=False, line=dict(color="#800000", width=0.5)))
    ms = 11 if len(idx) < 100 else 6; cm = col_mask[idx]
    crange = _field_crange(idx[cm], mode) if st["rescale"] else None
    if (~cm).any():
        data.append(dict(type="scatter", x=_A(xi[~cm]), y=_A(eta[~cm]), mode="markers", hoverinfo="text",
                         hovertext=_star_hover(idx[~cm]), showlegend=False,
                         marker=dict(size=ms, color=_GREY, symbol=_STAR_SYM)))
    if cm.any():
        data.append(dict(type="scatter", x=_A(xi[cm]), y=_A(eta[cm]), mode="markers",
                         hovertext=_star_hover(idx[cm]), hoverinfo="text", showlegend=False,
                         marker=dict(size=ms, symbol=_STAR_SYM,
                                     **_color_spec(idx[cm], mode, lo, hi, crange=crange))))
    obj_txt = []
    for cat, on, ccol, lbl, tag in _obj_layers(st):
        if cat is None or not on:
            continue
        oo = objects_in_field(cat, lam0, bet0, fov / 2)
        if not len(oo):
            continue
        ox, oy = gnomonic(cat["lam"][oo], cat["bet"][oo], lam0, bet0)
        r = cat.get("rh_am")
        if r is not None:
            th60 = np.linspace(0, 2 * np.pi, 60)
            for k, i0 in enumerate(oo):
                if np.isfinite(r[i0]) and r[i0] > 0.3:
                    data.append(dict(type="scatter", x=_A(ox[k] + r[i0] * np.cos(th60)),
                                     y=_A(oy[k] + r[i0] * np.sin(th60)), mode="lines",
                                     line=dict(color=ccol, width=1, dash="dot"),
                                     hoverinfo="skip", showlegend=False))
        data.append(dict(type="scatter", x=_A(ox), y=_A(oy), mode="markers", hoverinfo="text",
                         showlegend=False, hovertext=obj_hover(cat, oo),
                         marker=_obj_marker(cat, oo, mode, lo, hi,
                                            "hexagram" if tag == "GC" else "diamond",
                                            obj_size(cat, oo, 13.0, 12.0), ccol)))
        obj_txt.append(f"{len(oo)} {tag}")
    mm = _mem_in_field(st, lam0, bet0, fov)
    if len(mm):
        mx, my = gnomonic(D["MEM"]["lam"][mm], D["MEM"]["bet"][mm], lam0, bet0)
        M = D["MEM"]
        data.append(dict(type="scattergl", x=_A(mx), y=_A(my), mode="markers", hoverinfo="text",
                         showlegend=False,
                         hovertext=[f"<b>{M['name'][k]}</b> member<br>{M['dist'][k]:.0f} kpc (galaxy)"
                                    f"<br>G = {M['G'][k]:.2f}<br>P = {M['pmem'][k]:.2f}" for k in mm],
                         marker=_obj_marker(M, mm, mode, lo, hi, _STAR_SYM, 9, _MEM_COLOR)))
        obj_txt.append(f"{len(mm)} dwarf★")
    qq = _qso_in_field(st, lam0, bet0, fov)
    if len(qq):
        Q = D["QSO"]
        qx, qy = gnomonic(Q["lam"][qq], Q["bet"][qq], lam0, bet0)
        data.append(dict(type="scattergl", x=_A(qx), y=_A(qy), mode="markers", hoverinfo="text",
                         showlegend=False,
                         hovertext=[f"QSO z={zz:.2f} G={gg:.1f}" for zz, gg in zip(Q["z"][qq], Q["G"][qq])],
                         marker=_obj_marker(Q, qq, mode, lo, hi, "circle", 9, _QSO_YELLOW)))
    if D["QSO"] is not None and st["qso_on"]:
        obj_txt.insert(0, f"{len(qq)} QSO")
    tiled = f"{fov:.2g}° field" + (f", {npoint} pointings" if npoint else "")
    rtxt = " · rescaled" if (st["rescale"] and crange) else ""
    otxt = ("  +  " + " · ".join(obj_txt)) if obj_txt else ""
    ann = [dict(x=0, y=1, xref="paper", yref="paper", xanchor="left", yanchor="top",
                text=f"<b>{len(idx)} stars</b>{rtxt}{otxt}", showarrow=False,
                font=dict(size=12), bgcolor="rgba(255,255,255,0.65)"),
           dict(x=0, y=0.945, xref="paper", yref="paper", xanchor="left", yanchor="top",
                text=tiled, showarrow=False, font=dict(size=11, color="#555"),
                bgcolor="rgba(255,255,255,0.65)"),
           dict(x=0, y=0, xref="paper", yref="paper", xanchor="left", yanchor="bottom",
                text=f"<i>ℓ</i> {lg0:.1f}, <i>b</i> {bg0:.1f}", showarrow=False,
                font=dict(size=11, color="#555"), bgcolor="rgba(255,255,255,0.65)")]
    layout = dict(height=460, margin=dict(l=4, r=4, t=4, b=4), annotations=ann,
                  plot_bgcolor="white", paper_bgcolor="white", showlegend=False,
                  xaxis=dict(range=[-R, R], visible=False),
                  yaxis=dict(range=[-R, R], visible=False, scaleanchor="x", scaleratio=1))
    return dict(data=data, layout=layout)

# --- histograms / pair plots ----------------------------------------------------------
def _msg_fig(text, h):
    return dict(data=[], layout=dict(height=h, margin=dict(l=40, r=12, t=24, b=28),
                plot_bgcolor="white", paper_bgcolor="white",
                xaxis=dict(visible=False), yaxis=dict(visible=False),
                annotations=[dict(text=text, showarrow=False, x=0.5, y=0.5, xref="paper",
                                  yref="paper", font=dict(size=12, color="#888"))]))

def _hist_layout(fig, xlab, h=150):
    fig["layout"].update(height=h, margin=dict(l=36, r=14, t=26, b=30), bargap=0.03,
                         xaxis=dict(title=dict(text=xlab, font=dict(size=9))),
                         yaxis=dict(title=None), plot_bgcolor="white", paper_bgcolor="white")
    return fig

def _nn_hist(sep):
    fig = dict(data=[dict(type="histogram", x=_A(sep), nbinsx=40, marker=dict(color=_HIST_COLOR))],
               layout=dict(title=dict(text=f"NN separation, all sources (median {np.median(sep):.2f}′)",
                                      font=dict(size=11))))
    return _hist_layout(fig, "NN sep [arcmin]")

def _field_sources(st, lam0, bet0, fov, idx):
    lamv = [D["s_lam"][idx]]; betv = [D["s_bet"][idx]]; dv = [D["s_dist_use"][idx]]
    gv = [D["s_G"][idx]]; vv = [D["s_Vr"][idx]]; kv = [np.zeros(len(idx), int)]
    mm = _mem_in_field(st, lam0, bet0, fov)
    if len(mm):
        M = D["MEM"]
        lamv.append(M["lam"][mm]); betv.append(M["bet"][mm]); dv.append(M["dist"][mm])
        gv.append(M["G"][mm]); vv.append(np.full(len(mm), np.nan)); kv.append(np.full(len(mm), 2))
    qq = _qso_in_field(st, lam0, bet0, fov)
    if len(qq):
        Q = D["QSO"]
        lamv.append(Q["lam"][qq]); betv.append(Q["bet"][qq])
        dv.append(np.full(len(qq), np.inf)); gv.append(Q["G"][qq])
        vv.append(np.full(len(qq), np.nan)); kv.append(np.full(len(qq), 1))
    cat_ = lambda a: np.concatenate([np.asarray(x, float) for x in a]) if a else np.array([])
    return dict(lam=cat_(lamv), bet=cat_(betv), dist=cat_(dv), G=cat_(gv), Vr=cat_(vv),
                kind=np.concatenate(kv).astype(int) if kv else np.array([], int))

def _nn_of(src):
    uv = _unit_vectors(src["lam"], src["bet"])
    return _nn_brute(uv)

def _src_sub(src, cap=700):
    n = len(src["lam"])
    if n <= cap:
        return src
    k = np.random.default_rng(1).choice(n, cap, replace=False)
    return {a: v[k] for a, v in src.items()}

def _pairs_of(src, key):
    uv = _unit_vectors(src["lam"], src["bet"])
    n = len(uv)
    if n < 2:
        return np.array([]), np.array([])
    sep = np.degrees(np.arccos(np.clip(uv @ uv.T, -1, 1))) * 60
    q = src[key]
    with np.errstate(invalid="ignore"):
        dq = np.abs(q[:, None] - q[None, :])
    iu = np.triu_indices(n, k=1)
    s, dd = sep[iu], dq[iu]
    m = np.isfinite(s) & ~np.isnan(dd)
    return s[m], dd[m]

def _hist2d_trace(s, dd, nx=45, ny=45):
    """Pre-binned 2D pair histogram (sent as a heatmap — far smaller than raw pairs)."""
    H, xe, ye = np.histogram2d(s, dd, bins=[nx, ny])
    cx, cy = 0.5 * (xe[:-1] + xe[1:]), 0.5 * (ye[:-1] + ye[1:])
    return dict(type="heatmap", x=_A(cx), y=_A(cy), z=_A2(H.T), colorscale="Blues",
                zmin=0.0, colorbar=dict(title=dict(text="pairs"), thickness=12))

def _inf_axis(vals, pad=1.14):
    fin = np.isfinite(vals)
    top = float(vals[fin].max()) if fin.any() else 1.0
    return top * pad if top > 0 else 1.0, top

def _kind_hist(src, key, title, xlab, note=None, nb=28, inf_bin=True):
    data = []; ann = []
    v = np.asarray(src[key], float); k = np.asarray(src["kind"])
    fin = np.isfinite(v); ninf = int(np.isposinf(v).sum())
    if not fin.any() and not ninf:
        ann.append(dict(text="no sources", showarrow=False, x=0.5, y=0.5, xref="paper",
                        yref="paper", font=dict(size=12, color="#888")))
    if fin.any():
        a, b = float(v[fin].min()), float(v[fin].max())
        if b <= a:
            b = a + 1.0
        edges = np.linspace(a, b, nb + 1); w = float(edges[1] - edges[0])
        cen = 0.5 * (edges[:-1] + edges[1:])
        for kk in (0, 2, 1):
            m = fin & (k == kk)
            if m.any():
                data.append(dict(type="bar", x=_A(cen), y=_A(np.histogram(v[m], bins=edges)[0]),
                                 width=w, marker=dict(color=_KIND_COL[kk]), name=_KIND_LBL[kk],
                                 hovertemplate="%{y}<extra></extra>"))
        xinf = b + 1.8 * w
    else:
        w, xinf = 1.0, 1.0
    if ninf and inf_bin:
        data.append(dict(type="bar", x=[xinf], y=[ninf], width=w, marker=dict(color=_KIND_COL[1]),
                         name="quasars (∞)", hovertemplate=f"{ninf} at ∞<extra></extra>"))
        ann.append(dict(x=xinf, y=0, yref="paper", text="∞", showarrow=False, yshift=-11,
                        font=dict(size=15, color=_KIND_COL[1])))
    if note:
        ann.append(dict(x=1, y=1, xref="paper", yref="paper", xanchor="right", yanchor="bottom",
                        text=note, showarrow=False, font=dict(size=10, color="#555")))
    fig = dict(data=data, layout=dict(barmode="stack", showlegend=False, annotations=ann,
                                      title=dict(text=title, font=dict(size=11))))
    return _hist_layout(fig, xlab)

def _pair_plot(st, src, nn, sep):
    kind = st["pair_kind"]
    data = []; ann = []
    layout = dict(height=250, margin=dict(l=52, r=12, t=24, b=38),
                  plot_bgcolor="white", paper_bgcolor="white", title=dict(font=dict(size=12)))
    if kind == "sky-sep vs Δdist (pairs)":
        s, dd = _pairs_of(_src_sub(src), "dist")
        fin = np.isfinite(dd)
        if fin.any():
            data.append(_hist2d_trace(s[fin], dd[fin]))
        if (~fin).any():
            yinf, _ = _inf_axis(dd)
            data.append(dict(type="scattergl", x=_A(s[~fin]), y=_A(np.full(int((~fin).sum()), yinf)),
                             mode="markers", name="Δd = ∞",
                             marker=dict(size=5, color=_QSO_YELLOW, line=dict(width=0.4, color="#333")),
                             hovertemplate="sep %{x:.1f}′, Δd = ∞<extra></extra>"))
            ann.append(dict(x=0, y=yinf, xanchor="right", text="∞", showarrow=False,
                            font=dict(size=15, color=_QSO_YELLOW)))
        layout.update(xaxis=dict(title=dict(text="on-sky sep [arcmin]")),
                      yaxis=dict(title=dict(text="|Δdist| [kpc]")),
                      title=dict(text="pair sep vs Δdistance (∞ = pair with a quasar)",
                                 font=dict(size=12)), showlegend=False)
    elif kind == "sky-sep vs Δv (pairs)":
        s, dd = _pairs_of(_src_sub(src), "Vr")
        if len(s):
            data.append(_hist2d_trace(s, dd))
        else:
            ann.append(dict(text="no radial velocities in field", showarrow=False, x=0.5, y=0.5,
                            xref="paper", yref="paper"))
        layout.update(xaxis=dict(title=dict(text="on-sky sep [arcmin]")),
                      yaxis=dict(title=dict(text="|ΔVr| [km/s]")),
                      title=dict(text="pair sep vs Δvelocity", font=dict(size=12)))
    elif kind == "d_i vs d_nn (NN)":
        di, dj = src["dist"], src["dist"][nn]
        both = np.concatenate([di, dj])
        einf, top = _inf_axis(both, 1.10)
        pi_, pj_ = np.where(np.isfinite(di), di, einf), np.where(np.isfinite(dj), dj, einf)
        lo_ = float(both[np.isfinite(both)].min()) if np.isfinite(both).any() else 0.0
        data.append(dict(type="scatter", x=[lo_, einf if not np.isfinite(top) else top],
                         y=[lo_, einf if not np.isfinite(top) else top], mode="lines",
                         line=dict(color="#888", dash="dash"), hoverinfo="skip", showlegend=False))
        data.append(dict(type="scattergl", x=_A(pi_), y=_A(pj_), mode="markers", showlegend=False,
                         marker=dict(size=5, color=_A(sep), colorscale=D["CMAP_DENS"],
                                     colorbar=dict(title=dict(text="sep′"), thickness=12))))
        if (~np.isfinite(both)).any():
            ann.append(dict(x=einf, y=0, yref="paper", xref="x", text="∞", showarrow=False,
                            yshift=-11, font=dict(size=14, color=_QSO_YELLOW)))
            ann.append(dict(y=einf, x=0, xref="paper", yref="y", text="∞", showarrow=False,
                            xshift=-11, font=dict(size=14, color=_QSO_YELLOW)))
        layout.update(xaxis=dict(title=dict(text="d_i [kpc]")),
                      yaxis=dict(title=dict(text="d_nn [kpc]"), scaleanchor="x", scaleratio=1),
                      title=dict(text="NN pair distances (∞ = quasar)", font=dict(size=12)))
    else:
        di, dj = src["dist"], src["dist"][nn]
        with np.errstate(invalid="ignore"):
            dd = np.abs(di - dj)
        fig = _kind_hist(dict(dist=dd, kind=src["kind"]), "dist", "NN Δdistance",
                         "|d_i − d_nn| [kpc]", nb=34)
        fig["layout"]["height"] = 250
        return fig
    layout["annotations"] = ann
    return dict(data=data, layout=layout)

# --- stats -----------------------------------------------------------------------------
def _field_stats_html(st, idx, lam0, bet0, fov):
    lg0, bg0 = sgr_to_gal(lam0, bet0); ra0, dec0 = sgr_to_icrs(lam0, bet0)
    vm = visible_from(D["SITES"]["MMT (Arizona)"], dec0)
    vg = visible_from(D["SITES"]["Magellan (Chile)"], dec0)
    if vm and vg: vtxt = "<b>Visible from MMT &amp; Magellan</b>"
    elif vg:      vtxt = "<b>Visible from Magellan</b>"
    elif vm:      vtxt = "<b>Visible from MMT</b>"
    else:         vtxt = "<b>Not visible from MMT/Magellan</b>"
    _, lin, _, _, _ = _hi_active(st)
    pk, mn = hi_stats_in_field(lin, lg0, bg0, fov / 2)
    L = [f"<b>{fov:.2g}° field</b> at <i>ℓ</i>={lg0:.2f} <i>b</i>={bg0:.2f} &nbsp;(Sgr Λ {lam0:.2f} B {bet0:.2f})"]
    nm = np.array(D["name_by_code"])[D["s_name_code"]]
    if len(idx):
        un, ct = np.unique(nm[idx], return_counts=True); o = np.argsort(ct)[::-1]
        L.append(f"<b>{len(idx)} stars</b> from " + ", ".join(f"{un[k]} ({ct[k]})" for k in o))
    else:
        L.append("<b>0 stars</b>")
    if pk is not None:
        L.append(f"<b>HI column</b>: peak {pk:.2e}, mean {mn:.2e} cm⁻²")
    for cat, on, ccol, lbl, tag in _obj_layers(st):
        if cat is None or not on:
            continue
        oo = objects_in_field(cat, lam0, bet0, fov / 2)
        if len(oo):
            nm_ = lbl if len(oo) != 1 else {"globular clusters": "globular cluster",
                                            "dwarf galaxies": "dwarf galaxy"}[lbl]
            L.append(f"<b>{len(oo)} {nm_}</b>: " + ", ".join(
                f"{cat['name'][k]} ({cat['dist'][k]:.1f} kpc)" for k in oo[:4]))
    mm = _mem_in_field(st, lam0, bet0, fov)
    if len(mm):
        M = D["MEM"]
        un, ct = np.unique(M["name"][mm], return_counts=True)
        L.append(f"<b>{len(mm)} dwarf member stars</b> at G {np.nanmin(M['G'][mm]):.1f}–"
                 f"{np.nanmax(M['G'][mm]):.1f} — " + ", ".join(f"{a} ({b})" for a, b in zip(un, ct)))
    if D["QSO"] is not None and st["qso_on"]:
        qq = _qso_in_field(st, lam0, bet0, fov)
        gtxt = f" at G {D['QSO']['G'][qq].min():.1f}–{D['QSO']['G'][qq].max():.1f}" if len(qq) else ""
        L.append(f"<b>{len(qq)} quasars</b>{gtxt}")
    L.append(f"{vtxt} (ra={ra0:.1f}, dec={dec0:+.1f})")
    return "<div class='stats-inner'>" + "<br>".join(L) + "</div>"

# --- along-stream track -------------------------------------------------------------
def _build_track(sel, nbin=40):
    nm = np.array(D["name_by_code"])[D["s_name_code"]]
    uv = D["UG_SGR"][nm == sel]
    if len(uv) < 5:
        v = uv.mean(0); v /= np.linalg.norm(v); return [(0.0, v)]
    cvec = uv.mean(0); cvec /= np.linalg.norm(cvec)
    tp = uv - np.outer(uv @ cvec, cvec)
    _, V = np.linalg.eigh(tp.T @ tp); axis = V[:, -1]
    s = np.degrees(tp @ axis)
    edges = np.linspace(s.min(), s.max(), nbin + 1); tr = []
    for a, b in zip(edges[:-1], edges[1:]):
        m = (s >= a) & (s <= b)
        if m.sum():
            v = uv[m].mean(0); v /= np.linalg.norm(v); tr.append((0.5 * (a + b), v))
    return tr

def goto_stream(sel):
    _DIST_STREAM[0] = sel
    tr = _build_track(sel); _TRACK["t"] = tr
    ph = np.array([t[0] for t in tr])
    phi0 = float(ph[len(ph) // 2])
    lam, bet = _track_pos(phi0)
    return json.dumps(dict(lam=lam, bet=bet, phi_min=float(ph.min()), phi_max=float(ph.max()), phi=phi0))

def _track_pos(phi):
    tr = _TRACK.get("t")
    arr = np.array([t[0] for t in tr]); v = tr[int(np.argmin(np.abs(arr - phi)))][1]
    lo, la = _lonlat_of(v)
    return float(lo[0]), float(la[0])

def along(phi):
    if not _TRACK.get("t"):
        return json.dumps(None)
    lam, bet = _track_pos(float(phi))
    return json.dumps([lam, bet])

def set_dist_stream(sel):
    _DIST_STREAM[0] = sel or None

def clear_dist_stream():
    _DIST_STREAM[0] = None

def finder_click_to_sgr(xi_am, eta_am, lam0, bet0):
    lo, la = gnomonic_inv(np.array([xi_am]), np.array([eta_am]), lam0, bet0)
    return json.dumps([float(_wrap180(lo[0])), float(la[0])])

def convert(kind, a, b):
    if kind == "sgr2gal":
        return json.dumps(list(sgr_to_gal(a, b)))
    if kind == "gal2sgr":
        return json.dumps(list(gal_to_sgr(a, b)))
    return json.dumps(None)

# --- render entry point -----------------------------------------------------------------
def render(state_json, which="all"):
    st = json.loads(state_json)
    out = {}
    if which == "move":
        # Fast path when only (lam0, bet0, fov) changed: everything static stays cached
        # in JS; we resend only the traces that depend on the field position.
        lam0, bet0, keep, col_mask, idx, dtip = _state(st)
        lg0, bg0 = sgr_to_gal(lam0, bet0)
        src = _field_sources(st, lam0, bet0, st["fov"], idx)
        nn_s, sep_s = _nn_of(src)
        out["pointer"] = _pointer_traces(_field_dir(lam0, bet0), st["fov"], dtip)
        out["moll_circle"] = _moll_circle(lg0, bg0, st["fov"] / 2, _FIELD_RED, 1.4)
        out["skymap_circle"] = _skymap_circle(lam0, bet0, st["fov"])
        out["finder"] = _fig_finder(st)
        nk = int(D["s_dist_known"][idx].sum()) if len(idx) else 0
        out["dist"] = _kind_hist(src, "dist", "field distances", "dist [kpc]",
                                 note=f"{nk} meas · {len(idx) - nk} geom")
        out["mag"] = _kind_hist(src, "G", "field magnitudes", "Gaia G", inf_bin=False)
        out["nn"] = _nn_hist(sep_s) if sep_s is not None else _msg_fig("fewer than 2 sources", 150)
        out["stats"] = _field_stats_html(st, idx, lam0, bet0, st["fov"])
        out["pair"] = (_pair_plot(st, src, nn_s, sep_s) if nn_s is not None
                       else _msg_fig("fewer than 2 sources", 250))
        return json.dumps(out)
    if which in ("all", "3d"):
        out["fig3d"] = _fig_3d(st)
    if which in ("all", "field", "pair"):
        lam0, bet0, keep, col_mask, idx, _ = _state(st)
        src = _field_sources(st, lam0, bet0, st["fov"], idx)
        nn_s, sep_s = _nn_of(src)
        if which in ("all", "field"):
            out["moll"] = _fig_moll(st)
            out["skymap"] = _fig_skymap(st)
            out["finder"] = _fig_finder(st)
            nk = int(D["s_dist_known"][idx].sum()) if len(idx) else 0
            out["dist"] = _kind_hist(src, "dist", "field distances", "dist [kpc]",
                                     note=f"{nk} meas · {len(idx) - nk} geom")
            out["mag"] = _kind_hist(src, "G", "field magnitudes", "Gaia G", inf_bin=False)
            out["nn"] = _nn_hist(sep_s) if sep_s is not None else _msg_fig("fewer than 2 sources", 150)
            out["stats"] = _field_stats_html(st, idx, lam0, bet0, st["fov"])
        out["pair"] = (_pair_plot(st, src, nn_s, sep_s) if nn_s is not None
                       else _msg_fig("fewer than 2 sources", 250))
    return json.dumps(out)
