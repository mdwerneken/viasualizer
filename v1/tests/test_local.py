# Local validation of py/core.py with CPython + numpy (no browser needed).
# Run from the repo root:  python tests/test_local.py
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "py"))
import core


def _default_state(**over):
    st = dict(mode="Distance [kpc]", stream="— all —", isolate=False, via=False,
              lam0=core.D["LAM0_DEFAULT"], bet0=core.D["BET0_DEFAULT"], fov=1.0,
              glo=core.D["GMIN"], ghi=20.0, hide=True, zoom=40, hi_sphere=False,
              kepler=True, clean=False, himap="total", qso_on=True, gc_on=True,
              dg_on=True, mem_on=True, rescale=False, connect=False,
              pair_kind="sky-sep vs Δdist (pairs)")
    st.update(over)
    return st


def _check_fig(tag, fig):
    assert isinstance(fig, dict) and "data" in fig and "layout" in fig, f"{tag}: not a figure"
    s = json.dumps(fig, allow_nan=False)   # raises if a bare NaN/inf leaked into JSON
    return len(s)


def run():
    t0 = time.time()
    meta = json.loads(core.init("data"))
    print(f"init {time.time()-t0:.2f}s — {meta['n_stars']} stars, {meta['n_gc']} GCs, "
          f"{meta['n_dwarf']} dwarfs, {meta['n_mem']} members, hvc={meta['hvc']}, "
          f"{len(meta['candidates'])} candidate fields")

    # frame round-trips
    lg, bg = core.sgr_to_gal(12.3, -4.5)
    lam, bet = core.gal_to_sgr(lg, bg)
    assert abs(lam - 12.3) < 1e-8 and abs(bet + 4.5) < 1e-8, "sgr<->gal round trip"
    ra, dec = core.sgr_to_icrs(0.0, 0.0)
    assert 0 <= ra < 360 and -90 <= dec <= 90

    t0 = time.time()
    n = core.load_quaia("data")
    print(f"quaia {time.time()-t0:.2f}s — {n} quasars")

    states = [
        ("default", _default_state()),
        ("G-mode 3° hvc", _default_state(mode="Gaia G magnitude", fov=3.0, himap="hvc")),
        ("density overlay clean", _default_state(mode="On-sky density (1° FOV)", himap="overlay",
                                                 clean=True, hi_sphere=True)),
        ("hemi stream-isolate", _default_state(mode="Hemisphere visibility", stream="Sagittarius",
                                               isolate=True, via=True, connect=True, rescale=True)),
        ("stream-colour 5°", _default_state(mode="Stream (name)", fov=5.0,
                                            pair_kind="d_i vs d_nn (NN)")),
        ("sculptor members", _default_state(lam0=-96.0, bet0=-36.0, fov=3.0,
                                            pair_kind="Δdistance histogram (NN)")),
        ("empty field", _default_state(lam0=100.0, bet0=80.0,
                                       pair_kind="sky-sep vs Δv (pairs)")),
        ("no catalogs", _default_state(qso_on=False, gc_on=False, dg_on=False, mem_on=False,
                                       hide=False)),
    ]
    for tag, st in states:
        t0 = time.time()
        out = json.loads(core.render(json.dumps(st), "all"))
        dt = time.time() - t0
        sizes = {}
        for k, v in out.items():
            if k == "stats":
                assert isinstance(v, str) and "field" in v
                continue
            sizes[k] = _check_fig(f"{tag}/{k}", v)
        tot = sum(sizes.values()) / 1e6
        print(f"[{tag:24s}] render {dt:5.2f}s  payload {tot:5.2f} MB  "
              + " ".join(f"{k}:{s//1024}k" for k, s in sorted(sizes.items())))

    # partial renders
    st = json.dumps(_default_state())
    for which in ("3d", "field", "pair"):
        out = json.loads(core.render(st, which))
        assert out, which
    # goto stream / along / clicks
    g = json.loads(core.goto_stream("GD-1"))
    assert g["phi_min"] < g["phi"] < g["phi_max"]
    a = json.loads(core.along(g["phi_min"]))
    assert a and len(a) == 2
    core.clear_dist_stream()
    mi = json.loads(core.moll_invert(0.5, 0.5))
    assert mi and -180 <= mi[0] <= 180
    fc = json.loads(core.finder_click_to_sgr(10.0, -5.0, 0.0, 0.0))
    assert abs(fc[0] - 10 / 60) < 0.01 and abs(fc[1] + 5 / 60) < 0.01
    cv = json.loads(core.convert("sgr2gal", 0.0, 0.0))
    assert len(cv) == 2
    print("ALL LOCAL TESTS OK")


if __name__ == "__main__":
    run()
