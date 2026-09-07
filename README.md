# VIAsual

Interactive Milky-Way halo sightline planner for the [Via Project](https://via-project.org)
Cold Gas Survey — pick observing fields for MMT/Magellan halo cold-gas absorption work:
stellar streams, globular clusters, dwarf galaxies and their member stars provide distance
rungs, halo RR Lyrae and Quaia quasars provide backlights, and HI4PI total/HVC maps +
HVC cloud catalogs show the gas. Ported from the `field-exploration` project's
`sag_stream_3d.ipynb` field explorer.

Two apps share this repo and the same `data/` exports (v2 promoted to the base URL 8-19-26;
`/v2/` keeps a redirect so old shared links still work):

| App | URL | Stack |
|---|---|---|
| **v2** (current) | **https://mdwerneken.github.io/viasual/** | vanilla JS + three.js + Canvas 2D at the repo root; all analysis in typed-array JS (`js/compute.js`) |
| v1 (original) | https://mdwerneken.github.io/viasual/v1/ | Pyodide/numpy (`v1/py/core.py`) + plotly.js, self-contained under `v1/` |

v1 stays live as the numerical cross-reference: the same field gives the same numbers
in both apps and in the notebook (verified star-for-star on test fields). v2 adds:
dark sidebar UI, a circular finder cutout, a draggable field arrow in 3D and draggable
field circles on the sky maps, a live distance-rung ladder (the `scan_fields.py`
ranking rules computed per field), a Via fiber budget (576 positioners / 540 Viaspec
fibers), halo RR Lyrae + HVC cloud catalogs, survey cones (Kepler · M31 · M82),
a full-halo statistics tab, and shareable URL links that encode the exact field.
Matt's 8-19-26 review round added: a continuous 1–5° FOV slider, a promising-fields
grid (top-10 per FOV × G-limit from `scan_fields.py`), field history (back/forward),
animated field slides, object go-to locks (arrow shortens to ~0.8× the object
distance), pinned object labels, per-cone toggles (Kepler 15° · M31 6° · M82 2°) with
double-click-to-open, telescope visibility cones, light/dark 3D theme, a 100 kpc
reference box, full-screen panel enlarging with whole-structure hover, drag-to-pan +
double-click recentring on the finder, halo-RRL pair-rule rungs (≥2 stars within
1 kpc + 1°; 10% rung tolerance), and a visibility-following ladder/fiber budget.
Performance: cold boot ~2 s (v1: 15–20 s), field moves 10–60 ms (v1: 0.5–1 s),
color/mag changes ~150 ms (v1: 3–7 s).

## v1 — how it works

Everything runs client-side on GitHub Pages — there is no server.

| Piece | Role |
|---|---|
| `v1/py/core.py` | **All analysis + figure building, in Python** (numpy), run in the browser via [Pyodide](https://pyodide.org). A direct port of the notebook's cells 7–10. Figures are returned as plotly JSON with base64-packed arrays. |
| `v1/js/app.js` | Display glue only: fetches data, boots Pyodide, wires the controls, decodes figures, calls `Plotly.react`. |
| `v1/index.html` / `v1/css/style.css` | Layout. |
| `data/` | Compact binary/JSON exports of the catalogs (see below). |

Astropy/gala are **not** needed at runtime: the ICRS↔Galactic↔Sgr(Law10)
transforms are precomputed rotation matrices stored in `data/meta.json`
(verified against gala to <1e-6 deg at export time).

### Performance design (why it feels fast)

* Moving the field re-renders **only** what depends on the field: the finder
  chart, histograms, pair plot, stats, the field circles (plotly layout
  *shapes*, ~ms to update) and the 3D pointer.
* The 3D pointer lives in a **separate transparent WebGL scene** overlaid on
  the star scene with camera sync, so the 80k-star plot is never re-ingested
  on a move. Field moves cost ~0.5–1 s; heavy re-renders (colour mode, mag
  limit, catalog toggles) take a few seconds.
* Quasars (17 MB) stream in after the first paint.
* All downloads are cached in the browser (Cache Storage); repeat visits load
  from disk.

## Data (all public catalogs)

| File | Contents | Source |
|---|---|---|
| `data/stars.npz` | 80,162 stars / 92 streams: XYZ, distance, G, Vr, Sgr+Galactic coords, hemisphere, density, stream id | compilation of published streams, Bonaca & Price-Whelan 2025 (NewAR 100, 101713) |
| `data/quaia.npz` | 1,295,502 quasars (Λ, B, G, z) | Quaia, Storey-Fisher et al. 2024, ApJ 964, 69 — https://zenodo.org/records/8060755 |
| `data/gcs.json` | 167 MW globular clusters | Baumgardt & Vasiliev 2021, MNRAS 505, 5957 — https://people.smp.uq.edu.au/HolgerBaumgardt/globular/combined_table.txt |
| `data/dwarfs.json` | 101 Local Group dwarfs | McConnachie 2012, AJ 144, 4 (VizieR J/AJ/144/4) |
| `data/members.npz` | 11,755 dwarf member stars (P>0.9, <100 kpc) | Battaglia et al. 2022, A&A 657, A54 (VizieR J/A+A/657/A54) |
| `data/hi.npz` | HI4PI total N(HI) 0.25° grid + HVC map + Λ–B projections | HI4PI: Ben Bekhti et al. 2016, A&A 594, A116; HVC: Westmeier 2018, MNRAS 474, 289 |
| `data/meta.json` | frame matrices, colormaps (cmcrameri), defaults, top-10 candidate fields per (FOV × G-limit) gridpoint from `tools/scan_fields.py` (FOV 1/2/3/5° × G ≤ 16…20.5, 10% rung rule) | — |
| `data/halo.npz` | 150,943 halo RR Lyrae, \|Z\|>3 kpc, ~10% distances (v2 only; pair-rule rungs when shown, off by default) | Gaia DR3 vari_rrlyrae via VizieR I/358, Clementini et al. 2023; distances calibrated in `tools/build_halo.py` |
| `data/clouds.json` | 1,931 HIPASS HVCs (179 CHVC) + 59 ALFALFA UCHVCs (v2 only; sky positions + velocities, no distances) | Putman et al. 2002, AJ 123, 873 (VizieR J/AJ/123/873); Adams et al. 2013, ApJ 768, 77 (VizieR J/ApJ/768/77) |

## Regenerating the data

From the parent research repo (`field-exploration`, private analysis notebook —
this repo lives nested inside it at `field-exploration/viasual-app/`, gitignored by
the parent, with its own git history and GitHub Pages remote):

```bash
cd ~/research/field-exploration
conda run -n field-exploration-env python tools/run_cells.py 9 \
    "exec(open('tools/build_web_data.py').read())"
```

writes fresh exports into `viasual-app/data/` (including `halo.npz`); HVC cloud
catalogs are rebuilt with `conda run -n field-exploration-env python
tools/build_clouds.py`. Then bump `DATA_VERSION` in `js/data.js` (v2) and `v1/js/app.js` (v1) and the `?v=`
constants in `index.html`, commit, push — GitHub Pages redeploys in ~1 min.

## Differences from the notebook

Same analysis code paths, same numbers. Interaction differences:

* **Added:** click any map/finder/3D star to recenter; saved-fields list with
  inline labels (stored in your browser; export/import via JSON); "promising
  fields" quick-select (top-10 of the 1° and 3° `scan_fields` shortlists);
  quasars load in the background; camera no longer resets on re-render.
* **Changed:** the 3D pointer shaft/FOV ring are dotted (marker points) —
  scatter3d *lines* don't render on macOS/ANGLE WebGL; recent fields are
  session-only chips; the Galactic-ℓ slider is visually flipped (true ℓ value,
  rtl direction) instead of the notebook's −ℓ trick; pair-plot 2D histograms
  are binned in Python (identical bins, far less data shipped).
* **Not ported:** nothing — all notebook controls and panels are present.
