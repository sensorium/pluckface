onsetdetector.lv2 - Audio to Midi
==============================

onsetdetector.lv2  uses the aubio toolkit for note onset and pitch detection
on audio input and outputs midi.

Install
-------
Compiling onsetdetector requires the LV2 SDK, bash, gnu-make, and a c-compiler.

By default the build uses a system aubio install (via pkg-config). If aubio
development headers are not installed, use the vendored fallback mode.

```bash
  git clone git://github.com/sensorium/onsetdetector.lv2.git
  cd onsetdetector.lv2
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
