/*
  Copyright 2026 Tim Barrass https://github.com/sensorium
  Pluckface was hacked based on the Aubio Harmonizer LV2 plugin by Daniel Sheeler https://github.com/dsheeler/harmonizer.lv2
  Copyright 2017 Daniel Sheeler <dsheeler@pobox.com>

  Permission to use, copy, modify, and/or distribute this software for any
  purpose with or without fee is hereby granted, provided that the above
  copyright notice and this permission notice appear in all copies.

  THIS SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
  WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
  MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
  ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
  WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
  ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
  OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
*/

#include <math.h>
#include <stdlib.h>
#include <string.h>
#include <algorithm>
#include <new>
#include "RingBuffer.h"
#ifdef USE_SYSTEM_AUBIO
#include <aubio/aubio.h>
#else
#include "types.h"
#include "fvec.h"
#include "musicutils.h"
#include "onset/onset.h"
#endif

#include <lv2/lv2plug.in/ns/ext/urid/urid.h>
#include "lv2/lv2plug.in/ns/ext/log/logger.h"
#include "lv2/lv2plug.in/ns/lv2core/lv2.h"

#define PLUCKFACE_URI "urn:sensorium:pluckface"
#define RB_SIZE 16384
#define NUM_ONSET_METHODS 9

#define WINDOW_SECONDS_MAX 10

typedef enum
{
  PLUCKFACE_ONSET_METHOD = 0,
  PLUCKFACE_ONSET_SENSITIVITY = 1,
  PLUCKFACE_SILENCE_THRESHOLD = 2,
  PLUCKFACE_WINDOW_SECONDS = 3,
  PLUCKFACE_SCALE_CV_OUT = 4,
  PLUCKFACE_OFFSET_CV_OUT = 5,
  PLUCKFACE_LEAKY_MIX = 6,
  PLUCKFACE_LEAKY_DECAY_SECONDS = 7,
  PLUCKFACE_CV_SMOOTHING = 8,
  PLUCKFACE_CV_OUT = 9,
  PLUCKFACE_CV_INVERT_OUT = 10,
  PLUCKFACE_CV_TRIGGER_OUT = 11,
  PLUCKFACE_INPUT = 12,
  PLUCKFACE_INPUT_LEVEL_DB = 13,
  PLUCKFACE_CV_OUT_METER = 14,
  PLUCKFACE_ONSET_INDICATOR = 15,
  PLUCKFACE_AUTO_NORMALIZE = 16,
  PLUCKFACE_AUTO_SCALE_OUT = 17,
  PLUCKFACE_AUTO_OFFSET_OUT = 18
} PortIndex;

static const char *kOnsetMethods[NUM_ONSET_METHODS] = {
    "default",
    "energy",
    "hfc",
    "complex",
    "phase",
    "specdiff",
    "kl",
    "mkl",
    "specflux"};

static const float kOnsetSensitivityMin = 0.0f;
static const float kOnsetSensitivityMax = 1.0f;
static const float kCvTriggerLow = 0.0f;
static const float kCvTriggerHigh = 10.0f;
static const float kCvTriggerDurationSeconds = 0.12f;
static const float kCvParamRampSeconds = 0.01f;
static const float kGuiMeterHz = 10.0f;
// Minimum change in cv_out required to update the output buffer.
// mod-host reads buffer[0] once per JACK block for CV addressing and fires
// a param_set message only when the value changes. A dead-band suppresses
// floating-point noise from the EMA, preventing constant param_set traffic
// when the signal is stable. 1/1023 gives ~10-bit resolution across [0,1].
static const float kCvDeadBand = 1.0f / 1023.0f;

typedef struct
{
  aubio_onset_t *onsets[NUM_ONSET_METHODS];
  LV2_Log_Log *log;
  LV2_Log_Logger logger;
  LV2_URID_Map *map;
  RingBuffer *ringbuf;
  smpl_t bufsize;
  smpl_t hopsize;
  uint_t overruns;
  fvec_t *ab_in;
  fvec_t *onset;
  smpl_t samplerate;
  const float *onset_method;
  const float *onset_sensitivity;
  const float *silence_threshold;
  const float *window_seconds;
  const float *scale_cv_out;
  const float *offset_cv_out;
  const float *leaky_mix;
  const float *leaky_decay_seconds;
  const float *cv_smoothing;
  const float *input;
  float *cv_out;
  float *cv_inverted_out;
  float *cv_trigger_out;
  float *input_level_db;
  float *cv_out_meter;
  float *onset_indicator;
  int8_t *onsets_detected;
  int16_t window_index;
  int16_t onsets_total;
  float leaky_onset_level;
  float metric_lp;
  float target_metric;
  float ramped_scale;
  float ramped_offset;
  bool cv_params_initialized;
  uint32_t trigger_samples_remaining;
  uint32_t trigger_duration_samples;
  float input_level_db_lp;
  float last_published_input_db;
  uint32_t gui_meter_interval_samples;
  uint32_t gui_meter_sample_counter;
  float gui_cv_out_meter_value;
  float last_published_cv_meter;
  float onset_indicator_count;
  // Cached aubio setter values — only call setters when these change,
  // avoiding unnecessary work in the DSP thread every run() call.
  float last_silence_threshold;
  float last_aubio_threshold;
  int last_method_index;
  // Last values written to the CV output buffers. The dead-band check
  // compares against these to suppress noise-floor updates, which would
  // otherwise trigger a param_set message from mod-host every JACK block
  // when the port is used for CV addressing.
  float last_written_cv_out;
  float last_written_cv_inverted_out;
  // cached_alpha is recomputed when cv_smoothing or the JACK block size
  // changes. param_alpha is recomputed when the block size changes.
  // last_n_samples tracks the block size to detect changes.
  uint32_t last_n_samples;
  float param_alpha;
  float cached_alpha;
  float last_cv_smoothing;
  // Auto-normalisation: peak/floor followers track the observed range of
  // metric_lp and derive scale/offset to map it to [0, 1].
  const float *auto_normalize;
  float auto_norm_max;       // peak follower
  float auto_norm_min;       // floor follower
  float auto_norm_coeff;     // per-block drift coefficient (cached, 20s decay)
  float last_auto_normalize; // previous toggle value, for edge detection
  float *auto_scale_out;
  float *auto_offset_out;
} Pluckface;

static void
publish_gui_meters(Pluckface *self)
{
  if (self->input_level_db)
  {
    const float norm = (self->input_level_db_lp + 90.0f) / 90.0f;
    const float steps = 13.0f; // Quantize to 14 levels (0 to 13)
    const float quantized_norm = floorf(norm * steps + 0.5f) / steps;
    const float quantized_db = (quantized_norm * 90.0f) - 90.0f;
    if (quantized_db != self->last_published_input_db)
    {
      *self->input_level_db = quantized_db;
      self->last_published_input_db = quantized_db;
    }
  }
  if (self->cv_out_meter)
  {
    const float steps = 19.0f; // Quantize to 20 levels (0 to 19)
    const float quantized = floorf(self->gui_cv_out_meter_value * steps + 0.5f) / steps;
    if (quantized != self->last_published_cv_meter)
    {
      *self->cv_out_meter = quantized;
      self->last_published_cv_meter = quantized;
    }
  }
}

static LV2_Handle
instantiate(const LV2_Descriptor *descriptor,
            double rate,
            const char *bundle_path,
            const LV2_Feature *const *features)
{
  (void)descriptor;
  (void)bundle_path;

  Pluckface *self = (Pluckface *)calloc(1, sizeof(Pluckface));
  if (!self)
  {
    return NULL;
  }

  self->ringbuf = new RingBuffer(RB_SIZE * sizeof(smpl_t));
  for (int i = 0; features[i]; ++i)
  {
    if (!strcmp(features[i]->URI, LV2_URID__map))
    {
      self->map = (LV2_URID_Map *)features[i]->data;
    }
    else if (!strcmp(features[i]->URI, LV2_LOG__log))
    {
      self->log = (LV2_Log_Log *)features[i]->data;
    }
  }
  lv2_log_logger_init(&self->logger, self->map, self->log);
  if (!self->map)
  {
    lv2_log_error(&self->logger, "pluckface.lv2 error: Host does not support urid:map\n");
    free(self);
    return NULL;
  }
  self->samplerate = (float)rate;
  self->bufsize = 512;
  self->hopsize = 256;
  self->onset = new_fvec(1);
  self->ab_in = new_fvec(self->hopsize);

  for (int i = 0; i < NUM_ONSET_METHODS; i++)
  {
    self->onsets[i] = new_aubio_onset((char *)kOnsetMethods[i], self->bufsize, self->hopsize, self->samplerate);
  }

  int size_detected = (int)ceilf((float)WINDOW_SECONDS_MAX * self->samplerate / self->hopsize);
  self->onsets_detected = new (std::nothrow) int8_t[size_detected];
  if (self->onsets_detected == nullptr)
  {
    lv2_log_error(&self->logger, "pluckface.lv2 error: couldn't allocate memory for onsets_detected\n");
    free(self);
    return NULL;
  }
  memset(self->onsets_detected, 0, size_detected * sizeof(int8_t));
  self->window_index = 0;
  self->onsets_total = 0;
  self->leaky_onset_level = 0.0f;
  self->metric_lp = 0.0f;
  self->target_metric = 0.0f;
  self->ramped_scale = 1.0f;
  self->ramped_offset = 0.0f;
  self->cv_params_initialized = false;
  self->trigger_samples_remaining = 0;
  self->trigger_duration_samples = std::max(1u, (uint32_t)floorf(self->samplerate * kCvTriggerDurationSeconds));
  self->input_level_db_lp = -90.0f;
  self->last_published_input_db = -999.0f; // Force first update
  self->gui_meter_interval_samples = std::max(1u, (uint32_t)(self->samplerate / kGuiMeterHz + 0.5f));
  self->gui_meter_sample_counter = 0;
  self->gui_cv_out_meter_value = 0.0f;
  self->last_published_cv_meter = -1.0f; // Force first update
  self->onset_indicator_count = 0.0f;
  self->last_silence_threshold = -999.0f; // Force first aubio setter call
  self->last_aubio_threshold = -999.0f;
  self->last_method_index = -1;
  // Seed with out-of-range value so the dead-band check always fires on
  // the first run() call, ensuring a clean write to the CV buffers.
  self->last_written_cv_out = -1.0f;
  self->last_written_cv_inverted_out = 1.0f;
  // last_n_samples = 0 forces alpha and param_alpha to be computed on the
  // first run() call once the JACK block size is known.
  self->last_n_samples = 0;
  self->param_alpha = 1.0f;
  // cached_alpha and last_cv_smoothing: seed with an impossible value so the
  // first run() call always computes and caches a real alpha.
  self->cached_alpha = 1.0f;
  self->last_cv_smoothing = -1.0f;
  self->auto_norm_max = 0.0f;
  self->auto_norm_min = 0.0f;
  self->auto_norm_coeff = 1.0f;
  self->last_auto_normalize = 0.0f;
  return (LV2_Handle)self;
}

static void
connect_port(LV2_Handle instance,
             uint32_t port,
             void *data)
{
  Pluckface *self = (Pluckface *)instance;
  switch ((PortIndex)port)
  {
  case PLUCKFACE_ONSET_METHOD:
    self->onset_method = (float *)data;
    break;
  case PLUCKFACE_ONSET_SENSITIVITY:
    self->onset_sensitivity = (float *)data;
    break;
  case PLUCKFACE_SILENCE_THRESHOLD:
    self->silence_threshold = (float *)data;
    break;
  case PLUCKFACE_WINDOW_SECONDS:
    self->window_seconds = (float *)data;
    break;
  case PLUCKFACE_SCALE_CV_OUT:
    self->scale_cv_out = (float *)data;
    break;
  case PLUCKFACE_OFFSET_CV_OUT:
    self->offset_cv_out = (float *)data;
    break;
  case PLUCKFACE_LEAKY_MIX:
    self->leaky_mix = (float *)data;
    break;
  case PLUCKFACE_LEAKY_DECAY_SECONDS:
    self->leaky_decay_seconds = (float *)data;
    break;
  case PLUCKFACE_CV_SMOOTHING:
    self->cv_smoothing = (float *)data;
    break;
  case PLUCKFACE_CV_INVERT_OUT:
    self->cv_inverted_out = (float *)data;
    break;
  case PLUCKFACE_INPUT:
    self->input = (float *)data;
    break;
  case PLUCKFACE_CV_OUT:
    self->cv_out = (float *)data;
    break;
  case PLUCKFACE_CV_TRIGGER_OUT:
    self->cv_trigger_out = (float *)data;
    break;
  case PLUCKFACE_INPUT_LEVEL_DB:
    self->input_level_db = (float *)data;
    break;
  case PLUCKFACE_CV_OUT_METER:
    self->cv_out_meter = (float *)data;
    break;
  case PLUCKFACE_ONSET_INDICATOR:
    self->onset_indicator = (float *)data;
    break;
  case PLUCKFACE_AUTO_NORMALIZE:
    self->auto_normalize = (const float *)data;
    break;
  case PLUCKFACE_AUTO_SCALE_OUT:
    self->auto_scale_out = (float *)data;
    break;
  case PLUCKFACE_AUTO_OFFSET_OUT:
    self->auto_offset_out = (float *)data;
    break;
  }
}

static void
activate(LV2_Handle instance)
{
  Pluckface *self = (Pluckface *)instance;
  if (!self)
  {
    return;
  }
  self->gui_meter_sample_counter = 0;
  self->onset_indicator_count = 0.0f;
  self->last_n_samples = 0;          // force alpha recompute on next run()
  self->last_written_cv_out = -1.0f; // force clean CV write on next run()
  self->last_published_cv_meter = -1.0f;
  self->last_published_input_db = -999.0f;
  publish_gui_meters(self);
}

static void
deactivate(LV2_Handle instance)
{
  (void)instance;
}

static void
run(LV2_Handle instance, uint32_t n_samples)
{
  Pluckface *self = (Pluckface *)instance;

  // Hosts should connect all ports before run(), but guard anyway to avoid
  // hard crashes if a host/plugin state is incomplete.
  if (!self || !self->input || !self->cv_out || !self->cv_trigger_out ||
      !self->cv_inverted_out ||
      !self->onset_method || !self->onset_sensitivity || !self->silence_threshold ||
      !self->window_seconds || !self->scale_cv_out || !self->offset_cv_out ||
      !self->leaky_mix || !self->leaky_decay_seconds || !self->cv_smoothing ||
      !self->auto_normalize)
  {
    if (self && self->cv_out)
    {
      for (uint32_t i = 0; i < n_samples; i++)
      {
        self->cv_out[i] = 0.0f;
        if (self->cv_inverted_out)
          self->cv_inverted_out[i] = 1.0f;
        if (self->cv_trigger_out)
        {
          self->cv_trigger_out[i] = kCvTriggerLow;
        }
      }
    }
    if (self && self->input_level_db)
    {
      *self->input_level_db = -90.0f;
    }
    if (self && self->cv_out_meter)
    {
      *self->cv_out_meter = 0.0f;
    }
    if (self && self->onset_indicator)
    {
      *self->onset_indicator = 0.0f;
    }
    return;
  }

  const float *input = self->input;

  // Recompute alpha when cv_smoothing or the JACK block size changes.
  // powf/expf are expensive; both change rarely.
  // The EMA advances once per JACK block — mod-host reads buffer[0] for
  // CV addressing, so block size is the natural update interval.
  const float cv_smoothing = std::max(0.0f, std::min(1.0f, *self->cv_smoothing));
  if (cv_smoothing != self->last_cv_smoothing || n_samples != self->last_n_samples)
  {
    float alpha = 1.0f;
    if (cv_smoothing > 0.0f)
    {
      const float min_smoothing_seconds = 0.05f;
      const float max_smoothing_seconds = 1.0f;
      const float smoothing_seconds = min_smoothing_seconds *
                                      powf(max_smoothing_seconds / min_smoothing_seconds, cv_smoothing);
      alpha = 1.0f - expf(-(float)n_samples / (smoothing_seconds * self->samplerate));
      alpha = std::max(0.000001f, std::min(1.0f, alpha));
    }
    self->cached_alpha = alpha;
    self->last_cv_smoothing = cv_smoothing;
    // param_alpha depends on block size; recompute together.
    self->param_alpha = 1.0f - expf(-(float)n_samples /
                                    (kCvParamRampSeconds * self->samplerate));
    // auto-norm drift coefficient: same expf pattern, hardcoded 20s decay.
    const float kAutoNormDecaySeconds = 20.0f;
    self->auto_norm_coeff = 1.0f - expf(-(float)n_samples /
                                        (kAutoNormDecaySeconds * self->samplerate));
    self->last_n_samples = n_samples;
  }
  const float alpha = self->cached_alpha;
  const float param_alpha = self->param_alpha;
  const float cv_out_min = 0.0f;
  const float cv_out_max = 1.0f;

  const float scale_target = *self->scale_cv_out;
  const float offset_target = *self->offset_cv_out;
  if (!self->cv_params_initialized)
  {
    self->ramped_scale = scale_target;
    self->ramped_offset = offset_target;
    self->cv_params_initialized = true;
  }

  // Fill the ring buffer and estimate input level for metering.
  double sum_squares = 0.0;
  for (uint32_t i = 0; i < n_samples; i++)
  {
    const float s = input[i];
    sum_squares += (double)s * (double)s;
    if (self->ringbuf->Write((unsigned char *)&input[i], sizeof(smpl_t)) < (int)sizeof(smpl_t))
    {
      self->overruns++;
      // Rate-limit to avoid adding overhead under the exact conditions
      // (buffer pressure) where logging hurts most.
      if (self->overruns == 1 || (self->overruns % (uint32_t)self->samplerate) == 0)
      {
        lv2_log_trace(&self->logger, "overrun on ringbuf: %d\n", self->overruns);
      }
    }
  }

  if (n_samples > 0)
  {
    const float rms = sqrtf((float)(sum_squares / (double)n_samples));
    const float min_rms = 0.000001f;
    const float raw_db = 20.0f * log10f(std::max(min_rms, rms));
    const float clamped_db = std::max(-90.0f, std::min(0.0f, raw_db));
    const float block_seconds = n_samples / self->samplerate;
    const float attack_seconds = 0.03f;
    const float release_seconds = 0.20f;
    const float tau = (clamped_db > self->input_level_db_lp) ? attack_seconds : release_seconds;
    const float coeff = expf(-block_seconds / tau);
    self->input_level_db_lp = coeff * self->input_level_db_lp + (1.0f - coeff) * clamped_db;
  }

  const int method_index = std::max(0, std::min(NUM_ONSET_METHODS - 1, (int)*self->onset_method));
  const float onset_sensitivity = std::max(kOnsetSensitivityMin, std::min(kOnsetSensitivityMax, *self->onset_sensitivity));
  const float aubio_onset_threshold = powf(10.0f, -onset_sensitivity);
  // Only call aubio setters when the values have actually changed — these
  // are called unconditionally each run() otherwise, wasting DSP cycles.
  const float silence_threshold = (float)*self->silence_threshold;
  if (silence_threshold != self->last_silence_threshold || method_index != self->last_method_index)
  {
    aubio_onset_set_silence(self->onsets[method_index], silence_threshold);
    self->last_silence_threshold = silence_threshold;
  }
  if (aubio_onset_threshold != self->last_aubio_threshold || method_index != self->last_method_index)
  {
    aubio_onset_set_threshold(self->onsets[method_index], aubio_onset_threshold);
    self->last_aubio_threshold = aubio_onset_threshold;
  }
  self->last_method_index = method_index;

  // Determine current window size in cells
  int16_t window_cells = (int16_t)floorf(std::min((float)WINDOW_SECONDS_MAX, *self->window_seconds) * self->samplerate / self->hopsize);
  if (window_cells < 1)
    window_cells = 1;

  // Convert decay time (seconds) into hop-wise exponential leak factor.
  const float min_decay_seconds = 0.001f;
  const float decay_seconds = std::max(min_decay_seconds, *self->leaky_decay_seconds);
  const float hop_seconds = self->hopsize / self->samplerate;
  const float leak = expf(-hop_seconds / decay_seconds);
  const float leaky_mix = std::max(0.0f, std::min(1.0f, *self->leaky_mix));

  // Hop through the ring buffer
  while (self->ringbuf->GetReadAvail() >= sizeof(smpl_t) * self->hopsize)
  {
    self->ringbuf->Read((unsigned char *)self->ab_in->data, sizeof(smpl_t) * self->hopsize);
    aubio_onset_do(self->onsets[method_index], self->ab_in, self->onset);

    // curlevel is local: it's only meaningful within this hop iteration.
    const smpl_t curlevel = aubio_level_detection(self->ab_in, *self->silence_threshold);
    int8_t current_onset = 0;
    if (fvec_get_sample(self->onset, 0)) // Onset detected
    {
      if (curlevel != 1.0f)
      {
        current_onset = 1;
        self->trigger_samples_remaining = self->trigger_duration_samples;
      }
    }

    // Update sliding window
    // Ensure window_index is within current bounds if window_cells shrank
    self->window_index %= window_cells;

    self->onsets_total -= self->onsets_detected[self->window_index];
    self->onsets_total += current_onset;
    self->onsets_detected[self->window_index] = current_onset;
    self->window_index = (self->window_index + 1) % window_cells;

    if (current_onset)
    {
      // Increment the monotonic counter and publish immediately.
      // mod-host observes a durable value change on every onset — no
      // pulse-width race against the 10Hz meter tick.
      self->onset_indicator_count += 1.0f;
      if (self->onset_indicator)
      {
        *self->onset_indicator = self->onset_indicator_count;
      }
    }

    self->leaky_onset_level = leak * self->leaky_onset_level + (float)current_onset;

    const float onset_metric = (1.0f - leaky_mix) * self->onsets_total + leaky_mix * self->leaky_onset_level;
    self->target_metric = onset_metric;
  }

  // Advance the EMA and param ramps once per JACK block. mod-host reads
  // buffer[0] once per block for CV addressing, so block rate is both the
  // finest granularity that matters and the natural update interval.
  self->metric_lp += alpha * (self->target_metric - self->metric_lp);
  self->ramped_scale += param_alpha * (scale_target - self->ramped_scale);
  self->ramped_offset += param_alpha * (offset_target - self->ramped_offset);

  const bool auto_norm_on = (*self->auto_normalize > 0.5f);

  // Detect 0→1 edge: reset both trackers to the current metric value so the
  // followers start fresh rather than inheriting stale history.
  if (auto_norm_on && self->last_auto_normalize < 0.5f)
  {
    self->auto_norm_max = self->metric_lp;
    self->auto_norm_min = self->metric_lp;
  }
  self->last_auto_normalize = auto_norm_on ? 1.0f : 0.0f;

  // Update peak/floor followers only while auto-norm is active.
  // Instant attack on new extremes; slow drift back toward the signal
  // (20s time constant, coefficient cached in block-size guard above).
  if (auto_norm_on)
  {
    if (self->metric_lp > self->auto_norm_max)
      self->auto_norm_max = self->metric_lp;
    else
      self->auto_norm_max += self->auto_norm_coeff * (self->metric_lp - self->auto_norm_max);

    if (self->metric_lp < self->auto_norm_min)
      self->auto_norm_min = self->metric_lp;
    else
      self->auto_norm_min += self->auto_norm_coeff * (self->metric_lp - self->auto_norm_min);
  }

  // Derive effective scale and offset.
  // Auto-norm: map [tracked_min, tracked_max] → [0, 1].
  // Manual:    use the user's ramped scale/offset as before.
  static const float kAutoNormMinRange = 0.001f;
  float effective_scale, effective_offset;
  if (auto_norm_on)
  {
    const float range = self->auto_norm_max - self->auto_norm_min;
    if (range > kAutoNormMinRange)
    {
      effective_scale = 1.0f / range;
      effective_offset = -self->auto_norm_min * effective_scale;
    }
    else
    {
      // Range too small yet (e.g. just after reset) — pass through unscaled
      // until the trackers have observed enough signal to work with.
      effective_scale = 1.0f;
      effective_offset = 0.0f;
    }
  }
  else
  {
    effective_scale = self->ramped_scale;
    effective_offset = self->ramped_offset;
  }
  float cv_value = (self->metric_lp * effective_scale) + effective_offset;
  cv_value = std::max(cv_out_min, std::min(cv_out_max, cv_value));
  self->gui_cv_out_meter_value = cv_value; // unquantised, for the display meter

  // Only update the output values when the change exceeds the dead-band.
  // This suppresses EMA noise-floor drift, which would otherwise trigger a
  // param_set message from mod-host every block when the port is CV-addressed
  // and the signal is stable.
  if (fabsf(cv_value - self->last_written_cv_out) >= kCvDeadBand)
  {
    self->last_written_cv_out = cv_value;
    self->last_written_cv_inverted_out = 1.0f - cv_value;
  }

  // Fill the block with the current CV values and handle trigger output.
  for (uint32_t i = 0; i < n_samples; i++)
  {
    self->cv_out[i] = self->last_written_cv_out;
    self->cv_inverted_out[i] = self->last_written_cv_inverted_out;

    if (self->trigger_samples_remaining > 0)
    {
      self->cv_trigger_out[i] = kCvTriggerHigh;
      self->trigger_samples_remaining--;
    }
    else
    {
      self->cv_trigger_out[i] = kCvTriggerLow;
    }
  }

  self->gui_meter_sample_counter += n_samples;
  if (self->gui_meter_sample_counter >= self->gui_meter_interval_samples)
  {
    publish_gui_meters(self);
    if (self->auto_scale_out)
      *self->auto_scale_out = effective_scale;
    if (self->auto_offset_out)
      *self->auto_offset_out = effective_offset;
    self->gui_meter_sample_counter = 0;
  }
}

static void
cleanup(LV2_Handle instance)
{
  Pluckface *self = (Pluckface *)instance;
  for (uint8_t i = 0; i < NUM_ONSET_METHODS; i++)
  {
    del_aubio_onset(self->onsets[i]);
  }
  del_fvec(self->onset);
  del_fvec(self->ab_in);
  delete self->ringbuf;
  if (self->onsets_detected != nullptr)
  {
    delete[] self->onsets_detected;
    self->onsets_detected = nullptr;
  }
  free(self);
}

static const void *
extension_data(const char *uri)
{
  (void)uri;
  return NULL;
}

static const LV2_Descriptor descriptor = {
    PLUCKFACE_URI,
    instantiate,
    connect_port,
    activate,
    run,
    deactivate,
    cleanup,
    extension_data};

LV2_SYMBOL_EXPORT const LV2_Descriptor *
lv2_descriptor(uint32_t index)
{
  switch (index)
  {
  case 0:
    return &descriptor;
  default:
    return NULL;
  }
}
