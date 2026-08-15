# VIAsual

**Live app: https://mdwerneken.github.io/viasual/**

Interactive Milky-Way halo sightline planner — a web port of the `sag-stream`
project's `sag_stream_3d.ipynb` field explorer. Pick observing fields for
MMT/Magellan halo cold-gas absorption work: stellar streams, globular clusters,
dwarf galaxies and their member stars provide distance rungs, Quaia quasars
provide infinite-distance backlights, and HI4PI total/HVC maps show the gas.

## How it works

Everything runs client-side on GitHub Pages — there is no server.

| Piece | Role |
|---|---|
| `py/core.py` | **All analysis + figure building, in Python** (numpy), run in the browser via [Pyodide](https://pyodide.org). A direct port of the notebook's cells 7–10. Figures are returned as plotly JSON with base64-packed arrays. |
| `js/app.js` | Display glue only: fetches data, boots Pyodide, wires the controls, decodes figures, calls `Plotly.react`. |
| `index.html` / `css/style.css` | Layout. |
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
| `data/meta.json` | frame matrices, colormaps (cmcrameri), defaults, top-10 candidate fields per FOV from `tools/scan_fields.py` | — |

## Regenerating the data

From the companion research repo (`sag-stream`, private analysis notebook):

```bash
cd ~/research/sag-stream
conda run -n sag-stream-env python tools/run_cells.py 9 \
    "exec(open('tools/build_web_data.py').read())"
```

writes fresh exports into `../viasual/data/`. Then bump `DATA_VERSION` in
`js/app.js` (and `CODE_VERSION` if `py/core.py` changed), commit, push —
GitHub Pages redeploys automatically in ~1 min.

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
