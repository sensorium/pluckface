#!/usr/bin/make -f
OPTIMIZATIONS ?= -msse -msse2 -mfpmath=sse -ffast-math -fomit-frame-pointer\
								 -O3 -fno-finite-math-only
PREFIX ?= /usr/local
CFLAGS ?= $(OPTIMIZATIONS) -Wall
LV2DIR ?= $(PREFIX)/lib/lv2
AUBIO_MODE ?= system

STRIP?=strip
STRIPFLAGS?=-s

pluckometer_VERSION?=$(shell git describe --tags HEAD 2>/dev/null\
									 	| sed 's/-g.*$$//;s/^v//' || echo "LV2")
###############################################################################
LIB_EXT=.so
BUILDDIR=build/

LOADLIBES=-lm
LV2NAME=pluckometer
BUNDLE=pluckometer.lv2
targets=
SRCS =

.SUFFIXES:

.SUFFIXES: .cpp

UNAME=$(shell uname)
ifeq ($(UNAME),Darwin)
  LV2LDFLAGS=-dynamiclib
  LIB_EXT=.dylib
  EXTENDED_RE=-E
  STRIPFLAGS=-u -r -arch all -s lv2syms
  targets+=lv2syms
else
  LV2LDFLAGS=-Wl,-Bstatic -Wl,-Bdynamic
  LIB_EXT=.so
  EXTENDED_RE=-r
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
	MODLABEL=mod:label \"Pluckometer\";
  MODBRAND=mod:brand \"sensorium\";
	MODGUILABEL=modgui:label \"Pluckometer\";
  MODGUIBRAND=modgui:brand \"sensorium\";
else
  MODLABEL=
  MODBRAND=
endif

MODGUI_FILES := $(shell find modgui -type f | sort)

###############################################################################
# extract versions
LV2VERSION=$(pluckometer_VERSION)
include git2lv2.mk

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

all: initialize $(BUILDDIR)manifest.ttl $(BUILDDIR)$(LV2NAME).ttl $(targets)

lv2syms:
	echo "_lv2_descriptor" > lv2syms

$(BUILDDIR)manifest.ttl: lv2ttl/manifest.ttl.in lv2ttl/manifest.modgui.in Makefile
	@mkdir -p $(BUILDDIR)
	sed "s/@LV2NAME@/$(LV2NAME)/;s/@LIB_EXT@/$(LIB_EXT)/" \
	  lv2ttl/manifest.ttl.in > $(BUILDDIR)manifest.ttl
ifneq ($(MOD),)
	sed "s/@LV2NAME@/$(LV2NAME)/;s/@URISUFFIX@/$(URISUFFIX)/;s/@MODBRAND@/$(MODGUIBRAND)/;s/@MODLABEL@/$(MODGUILABEL)/" \
		lv2ttl/manifest.modgui.in >> $(BUILDDIR)manifest.ttl
endif

$(BUILDDIR)$(LV2NAME).ttl: lv2ttl/$(LV2NAME).ttl.in Makefile
	@mkdir -p $(BUILDDIR)
	sed "s/@VERSION@/lv2:microVersion $(LV2MIC) ;lv2:minorVersion $(LV2MIN) ;/g" \
		lv2ttl/$(LV2NAME).ttl.in > $(BUILDDIR)$(LV2NAME).ttl

SRCS = $(BUILDDIR)RingBuffer.cpp
OBJS = $(SRCS:.cpp=.o)

.SUFFIXES:

.SUFFIXES: .c

initialize: init

init:
	@mkdir -p $(BUILDDIR)
#	cp -rp src/*.cpp src/*.h $(BUILDDIR)
#	cp -rp src/aubio/* $(BUILDDIR)

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

# install/uninstall/clean target definitions

install: all
	install -d $(DESTDIR)$(LV2DIR)/$(BUNDLE)
	install -m755 $(BUILDDIR)$(LV2NAME)$(LIB_EXT) $(DESTDIR)$(LV2DIR)/$(BUNDLE)
	install -m644 $(BUILDDIR)manifest.ttl $(BUILDDIR)$(LV2NAME).ttl $(DESTDIR)$(LV2DIR)/$(BUNDLE)
ifneq ($(MOD),)
	install -d $(DESTDIR)$(LV2DIR)/$(BUNDLE)/modgui
	install -t $(DESTDIR)$(LV2DIR)/$(BUNDLE)/modgui $(BUILDDIR)modgui/*
endif

uninstall:
	rm -f $(DESTDIR)$(LV2DIR)/$(BUNDLE)/manifest.ttl
	rm -f $(DESTDIR)$(LV2DIR)/$(BUNDLE)/$(LV2NAME).ttl
	rm -f $(DESTDIR)$(LV2DIR)/$(BUNDLE)/$(LV2NAME)$(LIB_EXT)
	rm -rf $(DESTDIR)$(LV2DIR)/$(BUNDLE)/modgui
	-rmdir $(DESTDIR)$(LV2DIR)/$(BUNDLE)

clean:
	rm -f $(BUILDDIR)manifest.ttl $(BUILDDIR)$(LV2NAME).ttl \
	 $(BUILDDIR)$(LV2NAME)$(LIB_EXT) lv2syms
	rm -rf $(BUILDDIR)modgui
	
	-test -d $(BUILDDIR) && rm -rf $(BUILDDIR) || true

.PHONY: clean all install uninstall
