#!/usr/bin/make -f
OPTIMIZATIONS ?= -msse -msse2 -mfpmath=sse -ffast-math -fomit-frame-pointer\
								 -O3 -fno-finite-math-only
PREFIX ?= /usr/local
CFLAGS ?= $(OPTIMIZATIONS) -Wall
LV2DIR ?= $(PREFIX)/lib/lv2
AUBIO_MODE ?= system

STRIP?=strip
STRIPFLAGS?=-s

###############################################################################
LIB_EXT=.so
BUILDDIR=build/

LOADLIBES=-lm
LV2NAME=pluckface
BUNDLE=pluckface.lv2
LOCAL_BUNDLE_DIR ?= $(BUNDLE)
targets=
SRCS =

.SUFFIXES:

UNAME=$(shell uname)
ifeq ($(UNAME),Darwin)
  LV2LDFLAGS=-dynamiclib
  LIB_EXT=.dylib
  STRIPFLAGS=-u -r -arch all -s lv2syms
  targets+=lv2syms
else
  LV2LDFLAGS=-Wl,-Bstatic -Wl,-Bdynamic
  LIB_EXT=.so
endif

ifneq ($(XWIN),)
  CC=$(XWIN)-gcc
  STRIP=$(XWIN)-strip
  LV2LDFLAGS=-Wl,-Bstatic -Wl,-Bdynamic -Wl,--as-needed
  LIB_EXT=.dll
  override LDFLAGS += -static-libgcc -static-libstdc++
endif

targets+=$(BUILDDIR)$(LV2NAME)$(LIB_EXT)

ifneq ($(MOD),)
  targets+=$(BUILDDIR)modgui
	MODLABEL=mod:label \"Pluckface\";
  MODBRAND=mod:brand \"sensorium\";
	MODGUILABEL=modgui:label \"Pluckface\";
  MODGUIBRAND=modgui:brand \"sensorium\";
else
  MODLABEL=
  MODBRAND=
endif

MODGUI_FILES := $(shell find modgui -type f | sort)
PRESET_FILES := $(wildcard presets/*.ttl)
BUILT_PRESET_FILES := $(patsubst presets/%.ttl,$(BUILDDIR)presets/%.ttl,$(PRESET_FILES))

# check for build-dependencies
ifeq ($(shell pkg-config --exists lv2 || echo no), no)
  $(error "LV2 SDK was not found")
endif

override CFLAGS += -fPIC
override CFLAGS += `pkg-config --cflags lv2`

NEED_AUBIO_CONFIG := 1
ifneq ($(MAKECMDGOALS),)
ifeq ($(filter-out clean,$(MAKECMDGOALS)),)
NEED_AUBIO_CONFIG := 0
endif
endif

ifeq ($(NEED_AUBIO_CONFIG),1)
ifeq ($(AUBIO_MODE),system)
ifeq ($(shell pkg-config --exists aubio || echo no), no)
  $(error "aubio was not found via pkg-config. Install aubio dev package or build with AUBIO_MODE=vendored")
endif
override CFLAGS += $(shell pkg-config --cflags aubio)
override CFLAGS += -DUSE_SYSTEM_AUBIO=1
AUBIO_LINK_LIBS := $(shell pkg-config --libs aubio)
else ifeq ($(AUBIO_MODE),vendored)
override CFLAGS += -Isrc/aubio
AUBIO_SRCS = $(BUILDDIR)mathutils.c $(BUILDDIR)fvec.c $(BUILDDIR)onset.c $(BUILDDIR)peakpicker.c $(BUILDDIR)biquad.c $(BUILDDIR)filter.c $(BUILDDIR)lvec.c \
						 $(BUILDDIR)specdesc.c $(BUILDDIR)statistics.c $(BUILDDIR)hist.c $(BUILDDIR)scale.c $(BUILDDIR)cvec.c $(BUILDDIR)pitch.c \
						 $(BUILDDIR)pitchyinfft.c $(BUILDDIR)pitchyin.c $(BUILDDIR)pitchspecacf.c $(BUILDDIR)pitchfcomb.c \
						 $(BUILDDIR)pitchmcomb.c $(BUILDDIR)pitchschmitt.c $(BUILDDIR)fft.c $(BUILDDIR)ooura_fft8g.c $(BUILDDIR)c_weighting.c \
						 $(BUILDDIR)phasevoc.c
AUBIO_OBJS = $(AUBIO_SRCS:.c=.o)
else
  $(error "Unknown AUBIO_MODE '$(AUBIO_MODE)'. Use AUBIO_MODE=system or AUBIO_MODE=vendored")
endif
endif

# build target definitions
default: all

all: $(BUILDDIR)manifest.ttl $(BUILDDIR)$(LV2NAME).ttl $(BUILT_PRESET_FILES) $(targets)

lv2syms:
	echo "_lv2_descriptor" > lv2syms

$(BUILDDIR)manifest.ttl: lv2ttl/manifest_ttl.in lv2ttl/manifest_modgui.in Makefile
	@mkdir -p $(BUILDDIR)
	sed "s/@LV2NAME@/$(LV2NAME)/;s/@LIB_EXT@/$(LIB_EXT)/" \
	  lv2ttl/manifest_ttl.in > $(BUILDDIR)manifest.ttl
ifneq ($(MOD),)
	sed "s/@LV2NAME@/$(LV2NAME)/;s/@URISUFFIX@/$(URISUFFIX)/;s/@MODBRAND@/$(MODGUIBRAND)/;s/@MODLABEL@/$(MODGUILABEL)/" \
		lv2ttl/manifest_modgui.in >> $(BUILDDIR)manifest.ttl
endif

$(BUILDDIR)$(LV2NAME).ttl: lv2ttl/$(LV2NAME)_ttl.in Makefile
	@mkdir -p $(BUILDDIR)
	cp lv2ttl/$(LV2NAME)_ttl.in $(BUILDDIR)$(LV2NAME).ttl

$(BUILDDIR)presets/%.ttl: presets/%.ttl
	@mkdir -p $(dir $@)
	cp $< $@

SRCS = $(BUILDDIR)RingBuffer.cpp
OBJS = $(SRCS:.cpp=.o)


init:
	@mkdir -p $(BUILDDIR)

$(BUILDDIR)%.o : src/aubio/%.c
	@mkdir -p $(BUILDDIR)
	$(CC) $(CFLAGS) -I src/aubio -c \
	$< -o $@

$(BUILDDIR)%.o : src/%.cpp
	@mkdir -p $(BUILDDIR)
	$(CC) $(CFLAGS) -I $(BUILDDIR) -c \
	$< -o $@

$(BUILDDIR)$(LV2NAME)$(LIB_EXT): src/$(LV2NAME).cpp $(OBJS) $(AUBIO_OBJS)
	$(CXX) $(CPPFLAGS) $(CFLAGS) \
	  -o $@ $< \
		-shared $(LV2LDFLAGS) $(LDFLAGS) $(LOADLIBES) $(AUBIO_LINK_LIBS) \
		$(AUBIO_OBJS) $(OBJS)
	$(STRIP) $(STRIPFLAGS) $(BUILDDIR)$(LV2NAME)$(LIB_EXT)

$(BUILDDIR)modgui: $(BUILDDIR)$(LV2NAME).ttl $(MODGUI_FILES)
	@rm -rf $(BUILDDIR)modgui
	@mkdir -p $(BUILDDIR)modgui
	cp -r modgui/* $(BUILDDIR)modgui/
	cp $(BUILDDIR)$(LV2NAME).ttl $(BUILDDIR)modgui/$(LV2NAME).ttl
	chmod -R a+rX $(BUILDDIR)modgui

# install/uninstall/clean target definitions

install: all
	install -d $(DESTDIR)$(LV2DIR)/$(BUNDLE)
	install -m755 $(BUILDDIR)$(LV2NAME)$(LIB_EXT) $(DESTDIR)$(LV2DIR)/$(BUNDLE)
	install -m644 $(BUILDDIR)manifest.ttl $(BUILDDIR)$(LV2NAME).ttl $(DESTDIR)$(LV2DIR)/$(BUNDLE)
	install -d $(DESTDIR)$(LV2DIR)/$(BUNDLE)/presets
	install -m644 $(BUILT_PRESET_FILES) $(DESTDIR)$(LV2DIR)/$(BUNDLE)/presets
ifneq ($(MOD),)
	install -d $(DESTDIR)$(LV2DIR)/$(BUNDLE)/modgui
	install -t $(DESTDIR)$(LV2DIR)/$(BUNDLE)/modgui $(BUILDDIR)modgui/*
	chmod -R a+rX $(DESTDIR)$(LV2DIR)/$(BUNDLE)/modgui
endif

sync-local-bundle: all
	@mkdir -p $(LOCAL_BUNDLE_DIR)
	cp $(BUILDDIR)manifest.ttl $(LOCAL_BUNDLE_DIR)/manifest.ttl
	cp $(BUILDDIR)$(LV2NAME).ttl $(LOCAL_BUNDLE_DIR)/$(LV2NAME).ttl
	mkdir -p $(LOCAL_BUNDLE_DIR)/presets
	cp $(BUILT_PRESET_FILES) $(LOCAL_BUNDLE_DIR)/presets/
	if test -f $(BUILDDIR)$(LV2NAME)$(LIB_EXT); then cp $(BUILDDIR)$(LV2NAME)$(LIB_EXT) $(LOCAL_BUNDLE_DIR)/$(LV2NAME)$(LIB_EXT); fi
ifneq ($(MOD),)
	rm -rf $(LOCAL_BUNDLE_DIR)/modgui
	cp -R $(BUILDDIR)modgui $(LOCAL_BUNDLE_DIR)/modgui
	chmod -R a+rX $(LOCAL_BUNDLE_DIR)/modgui
endif

uninstall:
	rm -f $(DESTDIR)$(LV2DIR)/$(BUNDLE)/manifest.ttl
	rm -f $(DESTDIR)$(LV2DIR)/$(BUNDLE)/$(LV2NAME).ttl
	rm -f $(DESTDIR)$(LV2DIR)/$(BUNDLE)/$(LV2NAME)$(LIB_EXT)
	rm -rf $(DESTDIR)$(LV2DIR)/$(BUNDLE)/modgui
	-rmdir $(DESTDIR)$(LV2DIR)/$(BUNDLE)

clean:
	rm -f lv2syms
	rm -rf $(BUILDDIR)

.PHONY: clean all install uninstall default init
