# VIAsual

Interactive Milky-Way halo sightline planner for the [Via Project](https://via-project.org)
Cold Gas Survey — pick 1° Via pointings whose backlights (stream stars, cluster and dwarf
members, halo tracers, quasars) sit at several distinct distances, so absorption against them
locates the Galaxy's cold gas in 3D. Built from the `field-exploration` research project
(`sag_stream_3d.ipynb`), which nests this repo at `field-exploration/viasual-app/`.

| App | URL | Notes |
|---|---|---|
| **v3** (current, 9-7-26) | **https://mdwerneken.github.io/viasual-app/** | vanilla JS + three.js + Canvas 2D at the repo root; all analysis in typed-array JS |
| v2.6 (frozen 9-6-26) | https://mdwerneken.github.io/viasual-app/v2/ | own data snapshot in `v2/data/` |
| v1 (original oracle) | https://mdwerneken.github.io/viasual-app/v1/ | Pyodide/numpy + plotly.js; reads `../v2/data` |

The repo was `mdwerneken/viasual` until 9-6-26; a stub repo at that name redirects every old
link (path and hash preserved) to `/viasual-app/`.

## What v3 adds (over v2.6)

- **Field lists + player.** Via's planned pointings (Cold Gas · Dwarf Galaxy · Kepler · Rubin ·
  Stream Perturber surveys, plus an approximate transient list), the scan-grid shortlists, saved
  and recently visited fields are all browsable lists: step with ← →, auto-play with space, sort by
  distance rungs / targets / quasars / HI column / declination (ranked live with the same rules as
  the field panel), filter to fields visible from MMT or Magellan.
- **New catalogs and maps** (default off unless noted): Chandra distant K giants, Xue+11 BHB stars,
  Kepler-field Gaia stars, Geha+26 dwarf and cluster members, 37 post-2012 dwarfs from the Local
  Volume Database (on), GASS HVC clouds (with HIPASS/ALFALFA), SFD E(B−V), Edenhofer+24 3D dust
  (integrated sky slices to 300/600/1250 pc and a local 3D point cloud), Bish+19 Na I / Ca II
  sightlines (a custom field list), Via planned pointings as toggleable field lists (off by default).
- **UI (v3.1, 9-7-26).** Warm charcoal chrome around v2's deep-navy 3D scene (light mode retired),
  VIAsualizer wordmark + Tutorial button, collapsible control sidebar, labeled right-hand panels,
  FOV slider under the field view, one **Field lists** section that drives the player, the sky-map
  overlay and the 3D shell (Planned Via fields · Promising cold-gas fields · Custom, plus an
  "add a list" dropdown seeded with Bish+19), gas & dust controls on the Sky tab with an automatic
  legend, a 6-step interactive tour that flies out of / back into the Tutorial button, ⌘Z / ⌘⇧Z
  undo/redo of field moves, scroll-wheel FOV on the field view (small or enlarged),
  importance-scaled finder glyphs, a "backlights behind distance d" plot, camera flights to the
  local volume.

## Layout

```
index.html  css/style.css  img/            v3 shell, theme tokens, logo assets
js/app.js                                  boot, sidebar (field-list chips), keyboard, tabs, tour hooks
js/state.js  js/data.js  js/compute.js     state + history + hash; loaders + band queries; math core
js/fieldmodel.js  js/rungs.js  js/lists.js pure field computation; ladder rules; field lists + ranking
js/colors.js  js/tour.js  js/scene3d.js    theme/identity colors; tour; three.js scene (+ tour camera, list shell)
js/panels/*.js                             finder, allsky, sgrmap, hists, ladder, stats, player, skylayers, expand
data/                                      exports (49 MB; quaia/dust3d/kgiants lazy-loaded)
v2/  v1/                                   frozen earlier versions (self-contained)
```

## Data files (`data/`)

| File | Contents | Source |
|---|---|---|
| `meta.json` | frame matrices, constants, stream names, scan-grid shortlists | notebook export |
| `stars.npz` | 80,162 stream stars (Bonaca & PW 2025; identical to Via's `bonaca25` table) | notebook export |
| `gcs.json` · `dwarfs.json` | 167 GCs (Baumgardt & Vasiliev 2021); 101 McConnachie 2012 dwarfs + 37 LVDB v1.0.6 additions (`src` field) | notebook export + `build_v3_data.py` |
| `members.npz` · `members_geha.npz` | Battaglia+22 members (11,755); Geha+26 members (14,351; predicted G; 36 GCs matched to Baumgardt) | notebook export; `build_v3_data.py` |
| `quaia.npz` | 1,295,502 Quaia quasars | notebook export |
| `halo.npz` | 150,943 halo RR Lyrae (\|Z\| > 3 kpc) | `tools/build_halo.py` |
| `kgiants.npz` · `bhb.npz` · `kepler.npz` | Chandra K giants (352,758; priv. comm.); Xue+11 BHBs (4,985); Kepler-field Gaia stars (97,704, plx > 0.2 mas) | `build_v3_data.py` |
| `via_fields.json` | 1,995 unique planned Via pointings (centre, survey, subsurvey, tile, target, priority, visits) + 100 approximate transient fields | `build_v3_data.py` |
| `clouds.json` | HIPASS (Putman+02) + UCHVC (Adams+13) + GASS (Moss+13) HVCs | `build_clouds.py` + `build_v3_data.py` |
| `hi.npz` · `dust.npz` · `dust3d.npz` | HI4PI total + HVC N(HI); SFD E(B−V); Edenhofer+24 integrated slices + 126,813-voxel cloud (ZGR23 E units) | notebook export; `build_v3_data.py`; `build_dust3d.py` |
| `sightlines.json` | Bish+19 Keck/HIRES BHB sightlines (7) | `build_v3_data.py` |

## Regenerating the data

From the parent research repo (`field-exploration`, private analysis notebook — this repo lives
nested inside it at `field-exploration/viasual-app/`, gitignored by the parent, with its own git
history and GitHub Pages remote):

```bash
cd ~/research/field-exploration
conda run -n field-exploration-env python tools/run_cells.py 9 "exec(open('tools/build_web_data.py').read())"   # notebook exports
conda run -n field-exploration-env python tools/build_clouds.py       # HIPASS + UCHVC clouds
conda run -n field-exploration-env python tools/build_v3_data.py      # v3 additions (appends GASS to clouds.json)
conda run -n field-exploration-env python tools/build_dust3d.py       # Edenhofer 3D dust (needs the 2.3 GB FITS)
```

Then bump `DATA_VERSION` in `js/data.js` and the `?v=` constants in `index.html`, commit, push —
GitHub Pages redeploys in about a minute. `v2/` and `v1/` are frozen and read `v2/data/`.

## Verifying

`window.viasualVerify()` in the console returns the current field's numbers (counts per catalog,
ladder, HI, dust, visibility, list position). The default field (GD-1 × Sgr overlap) gives 8 stream
stars, 16 quasars and 3 rungs in v1, v2 and v3. `window.viasualDebug3d()` reports the 3D layers.

## Credits

Data: Bonaca & Price-Whelan 2025 · Baumgardt & Vasiliev 2021 · McConnachie 2012 · Pace 2024 (LVDB)
· Battaglia et al. 2022 · Geha et al. 2026 · Storey-Fisher et al. 2024 (Quaia) · Clementini et al.
2023 · V. Chandra (priv. comm.) · Xue et al. 2011 · Kepler × Gaia DR3 · Putman et al. 2002 ·
Adams et al. 2013 · Moss et al. 2013 · HI4PI (Ben Bekhti et al. 2016) · Westmeier 2018 · Schlegel,
Finkbeiner & Davis 1998 · Edenhofer et al. 2024 · Bish et al. 2019 · the Via visit lists.
Built by Matthew Werneken with Claude (Anthropic).
