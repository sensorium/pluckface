Pluckometer - Onset Rate Detector
============

Pluckometer tells how fast you're playing, and sends out a control voltage (CV) you can use to change parameters on effects.  Lots of notes, high CV, play sparse, low CV.  Say, lots of reverb when you play slow, and less when you're burning your fingers.  It also sends a trigger signal out on each note detected (but other plugins also do that, yawn).

Install
-------
Compiling pluckometer requires the LV2 SDK, bash, gnu-make, and a c-compiler.

By default the build uses a system aubio install (via pkg-config). If aubio
development headers are not installed, use the vendored fallback mode.

```bash
  git clone git://github.com/sensorium/pluckometer.lv2.git
  cd pluckometer.lv2
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

- Edit `lv2ttl/pluckometer.ttl.in` (and `lv2ttl/manifest.modgui.in` when GUI port lists change).
- Avoid editing generated files directly unless you intentionally want to sync checked-in artifacts.

Regenerate metadata and plugin artifacts:

```bash
  make MOD=1 AUBIO_MODE=vendored all
```

This regenerates, among other outputs:

- `build/pluckometer.ttl` (generated from `lv2ttl/pluckometer.ttl.in`)
- `build/manifest.ttl` (includes MOD GUI metadata)
- `build/pluckometer.dylib`

If you only changed plugin TTL metadata, regenerate just that file:

```bash
  make MOD=1 AUBIO_MODE=vendored build/pluckometer.ttl
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

2. Confirm template and generated metadata are in sync:

- `lv2ttl/pluckometer.ttl.in`
- `build/pluckometer.ttl`
- `pluckometer.lv2/pluckometer.ttl` (if committed in this repo)

3. Install into test LV2 path and verify ports appear with expected names/ranges.
4. Restart mod-ui (or reboot MOD device) and re-check the plugin UI after metadata changes.
5. Run a quick smoke test:

- Onset CV responds to playing rate
- Trigger CV pulses on detected onsets
- Clamp modes `-10..0`, `-5..5`, `0..10` behave as expected
