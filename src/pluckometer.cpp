/*
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

#include <stdio.h>
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

#define PLUCKOMETER_URI "urn:sensorium:pluckometer"
#define RB_SIZE 16384
#define NUM_ONSET_METHODS 9

#define WINDOW_SECONDS_MAX 10

typedef enum
{
  PLUCKOMETER_ONSET_METHOD = 0,
  PLUCKOMETER_ONSET_SENSITIVITY = 1,
  PLUCKOMETER_SILENCE_THRESHOLD = 2,
  PLUCKOMETER_WINDOW_SECONDS = 3,
  PLUCKOMETER_SCALE_CV_OUT = 4,
  PLUCKOMETER_OFFSET_CV_OUT = 5,
  PLUCKOMETER_LEAKY_MIX = 6,
  PLUCKOMETER_LEAKY_DECAY_SECONDS = 7,
  PLUCKOMETER_CV_SMOOTHING = 8,
  PLUCKOMETER_INVERT_CV = 9,
  PLUCKOMETER_INPUT = 10,
  PLUCKOMETER_CV_OUT = 11,
  PLUCKOMETER_CV_TRIGGER_OUT = 12
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
static const float kCvTriggerDurationSeconds = 0.01f;
static const float kCvParamRampSeconds = 0.01f;


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
  smpl_t curlevel;
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
  const float *invert_cv;
  const float *input;
  float *cv_out;
  float *cv_trigger_out;
  int8_t *onsets_detected;
  int16_t window_index;
  int16_t onsets_total;
  int16_t previous_total;
  float leaky_onset_level;
  float metric_lp;
  float target_metric;
  float ramped_scale;
  float ramped_offset;
  bool cv_params_initialized;
  uint32_t trigger_samples_remaining;
  uint32_t trigger_duration_samples;
} Pluckometer;

static LV2_Handle
instantiate(const LV2_Descriptor *descriptor,
            double rate,
            const char *bundle_path,
            const LV2_Feature *const *features)
{
  (void)descriptor;
  (void)bundle_path;

  Pluckometer *self = (Pluckometer *)calloc(1, sizeof(Pluckometer));
  if (!self)
  {
    return NULL;
  }

  self->map = NULL;
  self->log = NULL;
  self->onsets_detected = NULL;
  self->overruns = 0;
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
    lv2_log_error(&self->logger, "pluckometer.lv2 error: Host does not support urid:map\n");
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
    lv2_log_error(&self->logger, "pluckometer.lv2 error: couldn't allocate memory for onsets_detected\n");
    free(self);
    return NULL;
  }
  memset(self->onsets_detected, 0, size_detected * sizeof(int8_t));
  self->window_index = 0;
  self->onsets_total = 0;
  self->previous_total = -1;
  self->leaky_onset_level = 0.0f;
  self->metric_lp = 0.0f;
  self->target_metric = 0.0f;
  self->ramped_scale = 1.0f;
  self->ramped_offset = 0.0f;
  self->cv_params_initialized = false;
  self->trigger_samples_remaining = 0;
  self->trigger_duration_samples = std::max(1u, (uint32_t)floorf(self->samplerate * kCvTriggerDurationSeconds));
  return (LV2_Handle)self;
}

static void
connect_port(LV2_Handle instance,
             uint32_t port,
             void *data)
{
  Pluckometer *self = (Pluckometer *)instance;
  switch ((PortIndex)port)
  {
  case PLUCKOMETER_ONSET_METHOD:
    self->onset_method = (float *)data;
    break;
  case PLUCKOMETER_ONSET_SENSITIVITY:
    self->onset_sensitivity = (float *)data;
    break;
  case PLUCKOMETER_SILENCE_THRESHOLD:
    self->silence_threshold = (float *)data;
    break;
  case PLUCKOMETER_WINDOW_SECONDS:
    self->window_seconds = (float *)data;
    break;
  case PLUCKOMETER_SCALE_CV_OUT:
    self->scale_cv_out = (float *)data;
    break;
  case PLUCKOMETER_OFFSET_CV_OUT:
    self->offset_cv_out = (float *)data;
    break;
  case PLUCKOMETER_LEAKY_MIX:
    self->leaky_mix = (float *)data;
    break;
  case PLUCKOMETER_LEAKY_DECAY_SECONDS:
    self->leaky_decay_seconds = (float *)data;
    break;
  case PLUCKOMETER_CV_SMOOTHING:
    self->cv_smoothing = (float *)data;
    break;
  case PLUCKOMETER_INVERT_CV:
    self->invert_cv = (float *)data;
    break;
  case PLUCKOMETER_INPUT:
    self->input = (float *)data;
    break;
  case PLUCKOMETER_CV_OUT:
    self->cv_out = (float *)data;
    break;
  case PLUCKOMETER_CV_TRIGGER_OUT:
    self->cv_trigger_out = (float *)data;
    break;
  }
}

static void
activate(LV2_Handle instance)
{
  (void)instance;
}

static void
deactivate(LV2_Handle instance)
{
  (void)instance;
}

static void
run(LV2_Handle instance, uint32_t n_samples)
{
  Pluckometer *self = (Pluckometer *)instance;

  // Hosts should connect all ports before run(), but guard anyway to avoid
  // hard crashes if a host/plugin state is incomplete.
  if (!self || !self->input || !self->cv_out || !self->cv_trigger_out ||
      !self->onset_method || !self->onset_sensitivity || !self->silence_threshold ||
      !self->window_seconds || !self->scale_cv_out || !self->offset_cv_out ||
      !self->leaky_mix || !self->leaky_decay_seconds || !self->cv_smoothing ||
      !self->invert_cv)
  {
    if (self && self->cv_out)
    {
      for (uint32_t i = 0; i < n_samples; i++)
      {
        self->cv_out[i] = 0.0f;
        if (self->cv_trigger_out)
        {
          self->cv_trigger_out[i] = kCvTriggerLow;
        }
      }
    }
    return;
  }

  const float *input = self->input;

  // Map smoothing control to an exponential time constant so the full range
  // is useful and perceptually smoother. 0 = effectively bypassed smoothing.
  const float cv_smoothing = std::max(0.0f, std::min(1.0f, *self->cv_smoothing));
  float alpha = 1.0f;
  if (cv_smoothing > 0.0f)
  {
    const float min_smoothing_seconds = 0.05f;
    const float max_smoothing_seconds = 1.0f;
    const float smoothing_seconds = min_smoothing_seconds *
                                    powf(max_smoothing_seconds / min_smoothing_seconds, cv_smoothing);
    alpha = 1.0f - expf(-1.0f / (smoothing_seconds * self->samplerate));
    alpha = std::max(0.000001f, std::min(1.0f, alpha));
  }
  const float cv_out_min = 0.0f;
  const float cv_out_max = 1.0f;
  const bool invert = (*self->invert_cv > 0.5f);

  const float scale_target = *self->scale_cv_out;
  const float offset_target = *self->offset_cv_out;
  if (!self->cv_params_initialized)
  {
    self->ramped_scale = scale_target;
    self->ramped_offset = offset_target;
    self->cv_params_initialized = true;
  }
  const float param_alpha = 1.0f - expf(-1.0f / (kCvParamRampSeconds * self->samplerate));

  // Fill the ring buffer
  for (uint32_t i = 0; i < n_samples; i++)
  {
    if (self->ringbuf->Write((unsigned char *)&input[i], sizeof(smpl_t)) < (int)sizeof(smpl_t))
    {
      self->overruns++;
      lv2_log_trace(&self->logger, "overrun on ringbuf: %d\n", self->overruns);
    }
  }

  // Determine current window size in cells
  int16_t window_cells = (int16_t)floorf(std::min((float)WINDOW_SECONDS_MAX, *self->window_seconds) * self->samplerate / self->hopsize);
  if (window_cells < 1) window_cells = 1;

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
    const int method_index = std::max(0, std::min(NUM_ONSET_METHODS - 1, (int)*self->onset_method));
    const float onset_sensitivity = std::max(kOnsetSensitivityMin, std::min(kOnsetSensitivityMax, *self->onset_sensitivity));
    const float aubio_onset_threshold = powf(10.0f, -onset_sensitivity);
    aubio_onset_set_silence(self->onsets[method_index], (float)*self->silence_threshold);
    aubio_onset_set_threshold(self->onsets[method_index], aubio_onset_threshold);
    aubio_onset_do(self->onsets[method_index], self->ab_in, self->onset);

    self->curlevel = aubio_level_detection(self->ab_in, *self->silence_threshold);
    int8_t current_onset = 0;
    if (fvec_get_sample(self->onset, 0)) // Onset detected
    {
      if (self->curlevel != 1.0f)
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

    self->leaky_onset_level = leak * self->leaky_onset_level + (float)current_onset;

    self->previous_total = self->onsets_total;

    const float onset_metric = (1.0f - leaky_mix) * self->onsets_total + leaky_mix * self->leaky_onset_level;
    self->target_metric = onset_metric;
  }

  // Fill CV output for ALL samples in this block
  for (uint32_t i = 0; i < n_samples; i++)
  {
    self->metric_lp = alpha * self->target_metric + (1.0f - alpha) * self->metric_lp;
    self->ramped_scale += param_alpha * (scale_target - self->ramped_scale);
    self->ramped_offset += param_alpha * (offset_target - self->ramped_offset);

    float cv_value = self->metric_lp * self->ramped_scale + self->ramped_offset;
    cv_value = std::max(cv_out_min, std::min(cv_out_max, cv_value));
    if (invert) cv_value = 1.0f - cv_value;
    self->cv_out[i] = cv_value;

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
}

static void
cleanup(LV2_Handle instance)
{
  Pluckometer *self = (Pluckometer *)instance;
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
    PLUCKOMETER_URI,
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
