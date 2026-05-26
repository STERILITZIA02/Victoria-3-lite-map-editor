Victoria 3 State Map Viewer
===========================

This is the internal tool README. For installation, GitHub upload notes,
debugging, and the bilingual user guide, read `../../README.md` from the
repository root.

Double-click `start-viewer.cmd`, or run:

```powershell
node server.js --open
```

Then open:

```text
http://127.0.0.1:8793
```

The viewer reads the active mod root first. If `map_data/state_regions` or
`map_data/provinces.png` does not exist in the active mod root, it falls back to
`tools/vanilla_1_13_6_reference/game`.

This keeps an unmodified mod loadable while still providing a complete map
inspection tool for future province/state edits.

Important safety note: Victoria 3 local mods should be loaded from an ASCII-only
path. The official wiki documents that paths containing non-ASCII characters can
make local mod files fail to load. When this viewer detects a non-ASCII mod root
such as a localized `Documents` folder, it disables saving game-visible
`map_data` overrides but still allows Reset Vanilla. Use an ASCII path such as
`C:\Users\26321\Paradox Interactive\Victoria 3\mod\eu_map` for actual saves.

Reset Vanilla removes generated `map_data/state_regions/*.txt` files and the
generated `common/history/states/00_states.txt` override, returning the mod root
to the vanilla-reference map state.

Features:

- Parses all state_region files and lists every state and province.
- Loads the Victoria 3 `provinces.png` world layout with a loading progress bar.
- Draws thicker dark province boundaries and thinner gold state boundaries.
- Marks special state-region provinces: city, farm, mine, wood, port,
  center_province, prime_land, and impassable.
- Exports saved `map_data/state_regions/*.txt` and
    `common/history/states/00_states.txt` overrides as a ZIP.
- Supports mouse-wheel zoom, drag panning, state search, state fitting,
  province click inspection, and province/state detail panels.
