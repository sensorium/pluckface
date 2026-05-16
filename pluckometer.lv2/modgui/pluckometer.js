function(event, funcs) {
    var INPUT_METER_HZ = 10;
    var INPUT_METER_INTERVAL_MS = Math.round(1000 / INPUT_METER_HZ);
    var INPUT_SEGMENT_COLORS = [
        '#0b5d57', '#0f6a5f', '#147767', '#19856f',
        '#1f9277', '#27a07f', '#35ad8a', '#4cb992',
        '#68c29b', '#87c9a0', '#a8cda2', '#c7ce9f',
        '#d2c08a', '#bf9aa1', '#a56cb0', '#82085b'
    ];

    var inputMeter = event.icon.find('.pluckometer-input-meter')[0];
    var cvMeter = event.icon.find('.pluckometer-cv-meter')[0];
    var onsetLed = event.icon.find('.pluckometer-onset-led')[0];
    var smileCurve = event.icon.find('.pluckometer-smile-curve')[0];
    var silenceThresholdDb = (inputMeter && typeof inputMeter._silenceThresholdDb === 'number')
        ? inputMeter._silenceThresholdDb
        : -90.0;
    if (!inputMeter && !cvMeter && !onsetLed && !smileCurve) {
        return;
    }

    var inputSegs = inputMeter ? inputMeter.querySelectorAll('.pluckometer-input-meter-seg') : [];
    var cvSegs = cvMeter ? cvMeter.querySelectorAll('.pluckometer-cv-meter-seg') : [];
    if ((!inputSegs || !inputSegs.length) && (!cvSegs || !cvSegs.length) && !onsetLed) {
        return;
    }

    function applyInputPalette() {
        for (var i = 0; i < inputSegs.length; i++) {
            var seg = inputSegs[i];
            var t = (inputSegs.length > 1) ? (i / (inputSegs.length - 1)) : 0.0;
            var paletteIndex = Math.round(t * (INPUT_SEGMENT_COLORS.length - 1));
            seg.style.setProperty('--input-seg-color', INPUT_SEGMENT_COLORS[paletteIndex]);
        }
    }

    function paint(segs, level) {
        var warnStart = Math.floor(segs.length * 0.7);
        var hotStart = Math.floor(segs.length * 0.9);
        for (var i = 0; i < segs.length; i++) {
            var seg = segs[i];
            var active = i < level;
            seg.classList.toggle('active', active);
            seg.classList.toggle('warn', active && i >= warnStart && i < hotStart);
            seg.classList.toggle('hot', active && i >= hotStart);
        }
    }

    function paintInputLevel(db) {
        if (!inputSegs || !inputSegs.length) {
            return;
        }

        if (db < -90.0) db = -90.0;
        if (db > 0.0) db = 0.0;

        var norm = (db + 90.0) / 90.0;
        if (norm < 0.0) norm = 0.0;
        if (norm > 1.0) norm = 1.0;

        var inputLevel = Math.round(norm * inputSegs.length);
        for (var i = 0; i < inputSegs.length; i++) {
            var seg = inputSegs[i];
            seg.classList.toggle('active', i < inputLevel);
            seg.classList.remove('warn');
            seg.classList.remove('hot');
        }
    }

    function flushInputPaint() {
        if (!inputMeter || !inputSegs || !inputSegs.length) {
            return;
        }

        var db = (typeof inputMeter._pendingInputDb === 'number') ? inputMeter._pendingInputDb : -90.0;
        paintInputLevel(db);
        paintInputThreshold();
        inputMeter._lastInputPaintMs = Date.now();
        inputMeter._inputMeterTimer = null;
    }

    function queueInputPaint(db) {
        if (!inputMeter) {
            return;
        }

        inputMeter._pendingInputDb = db;
        var now = Date.now();
        var last = inputMeter._lastInputPaintMs || 0;
        var elapsed = now - last;

        if (elapsed >= INPUT_METER_INTERVAL_MS) {
            flushInputPaint();
            return;
        }

        if (!inputMeter._inputMeterTimer) {
            inputMeter._inputMeterTimer = setTimeout(flushInputPaint, INPUT_METER_INTERVAL_MS - elapsed);
        }
    }

    function paintInputThreshold() {
        if (!inputSegs || !inputSegs.length) {
            return;
        }

        var t = (inputMeter && typeof inputMeter._silenceThresholdDb === 'number')
            ? inputMeter._silenceThresholdDb
            : silenceThresholdDb;
        if (t < -90.0) t = -90.0;
        if (t > -10.0) t = -10.0;
        if (inputMeter) {
            inputMeter._silenceThresholdDb = t;
        }

        // Map the slider's own range (-90..-10 dB) to full meter height.
        var norm = (t + 90.0) / 80.0;
        if (norm < 0.0) norm = 0.0;
        if (norm > 1.0) norm = 1.0;

        var marker = Math.round(norm * (inputSegs.length - 1));
        for (var i = 0; i < inputSegs.length; i++) {
            inputSegs[i].classList.toggle('threshold', i === marker);
        }
    }

    function paintSmile(cv) {
        if (!smileCurve) {
            return;
        }

        // Interpolate from a flat line (cv=0) to a smiling curve (cv=1).
        var t = cv;
        if (t < 0.0) t = 0.0;
        if (t > 1.0) t = 1.0;

        var startY = 25 - (15 * t);
        var endY = startY;
        var controlY = 25 + (20 * t);
        smileCurve.setAttribute('d', 'M 10 ' + startY + ' Q 50 ' + controlY + ' 90 ' + endY);
    }

    if (event.type === 'start') {
        var hiddenSliderSymbols = ['onset_method', 'onset_sensitivity', 'window_seconds', 'leaky_mix', 'leaky_decay_seconds', 'cv_smoothing', 'offset_cv_out', 'scale_cv_out'];
        for (var s = 0; s < hiddenSliderSymbols.length; s++) {
            var hiddenSlider = event.icon.find('.mod-slider-image[mod-port-symbol="' + hiddenSliderSymbols[s] + '"]').closest('.mod-slider');
            if (hiddenSlider && hiddenSlider.length) {
                hiddenSlider.addClass('pluckometer-hidden-control');
            }
        }

        // Hide only the autogenerated control-group silence slider.
        // Keep the dedicated custom silence slider visible.
        var autoSilenceSlider = event.icon.find('.mod-control-group .mod-slider-image[mod-port-symbol="silence_threshold"]').closest('.mod-slider');
        if (autoSilenceSlider && autoSilenceSlider.length) {
            autoSilenceSlider.addClass('pluckometer-hidden-control');
        }

        if (inputMeter && inputMeter._inputMeterTimer) {
            clearTimeout(inputMeter._inputMeterTimer);
            inputMeter._inputMeterTimer = null;
        }

        if (inputSegs.length) {
            applyInputPalette();
            paintInputLevel(-90.0);
        }
        if (cvSegs.length) paint(cvSegs, 0);
        if (onsetLed) onsetLed.classList.remove('active');
        paintInputThreshold();
        paintSmile(0.0);
        return;
    }

    var symbol = event.symbol || (event.port && event.port.symbol);
    var value = (typeof event.value !== 'undefined') ? event.value : (event.port && event.port.value);
    var numericValue = parseFloat(value);
    if (!isFinite(numericValue)) {
        return;
    }

    if (symbol === 'input_level_db') {
        var db = numericValue;
        queueInputPaint(db);
        return;
    }

    if (symbol === 'silence_threshold') {
        silenceThresholdDb = numericValue;
        if (inputMeter) {
            inputMeter._silenceThresholdDb = silenceThresholdDb;
        }
        paintInputThreshold();
        return;
    }

    if (symbol === 'cv_out_meter') {
        var cv = numericValue;
        if (cv < 0.0) cv = 0.0;
        if (cv > 1.0) cv = 1.0;

        var cvLevel = Math.round(cv * cvSegs.length);
        if (cvSegs.length) paint(cvSegs, cvLevel);
        paintSmile(cv);
        return;
    }

    if (symbol === 'onset_indicator') {
        if (onsetLed) {
            onsetLed.classList.toggle('active', numericValue > 0.5);
        }
    }
}
