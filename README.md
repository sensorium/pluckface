Pluckface - Onset Rate Detector
============

This is work in progress, don't use it yet.

Pluckface tells how fast you're playing, and sends out a control voltage (CV) you can use to change parameters on effects.  

Lots of notes, high CV, play sparse, low CV.  Say, lots of reverb when you play slow, and less when you're burning your fingers.  

It also sends a trigger signal out on each note detected (but other plugins also do that).

The project was initially hacked from an Aubio Harmonizer LV2 plugin by Daniel Sheeler: https://github.com/dsheeler/harmonizer.lv2
It builds using an included local copy of the Aubio library: https://github.com/aubio/aubio

Install
-------
Compiling pluckface requires the LV2 SDK, bash, gnu-make, and a c-compiler.

By default the build uses a system aubio install (via pkg-config). If aubio
development headers are not installed, use the vendored fallback mode.

```bash
  git clone git://github.com/sensorium/pluckface.lv2.git
  cd pluckface.lv2
  make
  sudo make install PREFIX=/usr
```

Build modes
-----------

Default (system aubio):

```bash
  make AUBIO_MODE=system
```

Vendored fallback (compile local src/aubio copy):

```bash
  make AUBIO_MODE=vendored
```

Note to packagers: The Makefile honors PREFIX and DESTDIR variables as well
 as CFLAGS, LDFLAGS and OPTIMIZATIONS (additions to CFLAGS).

Development build notes
-----------------------

Use templates as the source of truth for LV2 metadata:

- Edit `lv2ttl/pluckface.ttl.in` (and `lv2ttl/manifest.modgui.in` when GUI port lists change).
- Avoid editing generated files directly unless you intentionally want to sync checked-in artifacts.
- Do not manually edit `build/pluckface.ttl` or `pluckface.lv2/pluckface.ttl`; regenerate them from templates via `make`.

Regenerate metadata and plugin artifacts:

```bash
  make MOD=1 AUBIO_MODE=vendored all
```

For MOD Desktop development, refresh the local `pluckface.lv2` bundle from
generated `build/` outputs in one step:

```bash
  make MOD=1 AUBIO_MODE=vendored sync-local-bundle
```

This updates `pluckface.lv2/manifest.ttl`, `pluckface.lv2/pluckface.ttl`,
the plugin binary, and replaces `pluckface.lv2/modgui` with the latest
generated assets.

This regenerates, among other outputs:

- `build/pluckface.ttl` (generated from `lv2ttl/pluckface.ttl.in`)
- `build/manifest.ttl` (includes MOD GUI metadata)
- `build/pluckface.dylib`

If you only changed plugin TTL metadata, regenerate just that file:

```bash
  make MOD=1 AUBIO_MODE=vendored build/pluckface.ttl
```

MOD UI refresh behavior
-----------------------

MOD can cache plugin and GUI metadata. After metadata changes (port names,
ranges, added/removed ports), restart mod-ui or reboot the device to ensure
the new definitions are loaded.

Release checklist
-----------------

Before tagging or shipping a build:

1. Build with vendored aubio to ensure deterministic local CI-style output:

```bash
  make MOD=1 AUBIO_MODE=vendored all
```

2. Refresh the local bundle used by MOD Desktop so metadata and GUI assets match
   generated outputs:

```bash
  make MOD=1 AUBIO_MODE=vendored sync-local-bundle
```

3. Confirm template and generated metadata are in sync:

- `lv2ttl/pluckface.ttl.in`
- `build/pluckface.ttl`
- `pluckface.lv2/pluckface.ttl` (if committed in this repo)

4. Install into test LV2 path and verify ports appear with expected names/ranges.
5. Restart mod-ui (or reboot MOD device) and re-check the plugin UI after metadata changes.
6. Run a quick smoke test:

- Onset CV responds to playing rate
- Trigger CV pulses on detected onsets
- Invert CV flips output polarity within `0..1` (e.g. `0.2 -> 0.8`)
