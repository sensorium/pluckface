function(event, funcs) {
    var INPUT_METER_HZ = 10;
    var INPUT_METER_INTERVAL_MS = Math.round(1000 / INPUT_METER_HZ);

    var inputMeter = event.icon.find('.pluckometer-input-meter')[0];
    var cvMeter = event.icon.find('.pluckometer-cv-meter')[0];

    // State variables for throttled painting (closures)
    var inputPendingDb = -90.0;
    var inputLastPaintMs = 0;
    var inputMeterTimer = null;

    var cvPendingValue = 0.0;
    var cvLastPaintMs = 0;
    var cvMeterTimer = null;

    var leakyOnsetPendingValue = 0.0;
    var leakyOnsetLastPaintMs = 0;
    var leakyOnsetMeterTimer = null;

    var onsetLed = event.icon.find('.pluckometer-onset-led')[0];
    var smileCurve = event.icon.find('.pluckometer-smile-curve')[0];
    var pupilLeft = event.icon.find('#pluckometer-pupil-left')[0]; // Reference to left pupil
    var pupilRight = event.icon.find('#pluckometer-pupil-right')[0]; // Reference to right pupil
    if (!inputMeter && !cvMeter && !onsetLed && !smileCurve && !pupilLeft && !pupilRight) {
        return;
    }

    var inputMask = inputMeter ? inputMeter.querySelector('.pluckometer-input-meter-mask') : null;
    var cvMask = cvMeter ? cvMeter.querySelector('.pluckometer-cv-meter-mask') : null;
    if (!inputMask && !cvMask && !onsetLed) {
        return;
    }

    function flushInputPaint() {
        if (!inputMask) return;
        var db = Math.min(Math.max(inputPendingDb, -90.0), 0.0);
        var norm = (db + 90.0) / 90.0;
        inputMask.style.height = ((1 - norm) * 100) + '%';
        inputLastPaintMs = Date.now();
        inputMeterTimer = null;
    }

    function queueInputPaint(db) {
        if (!inputMask) return;
        inputPendingDb = db;
        var now = Date.now();
        var elapsed = now - inputLastPaintMs;
        if (elapsed >= INPUT_METER_INTERVAL_MS) {
            flushInputPaint();
        } else if (!inputMeterTimer) {
            inputMeterTimer = setTimeout(flushInputPaint, INPUT_METER_INTERVAL_MS - elapsed);
        }
    }

    function paintSmile(cv) {
        if (!smileCurve) {
            return;
        }
        var t = Math.min(Math.max(cv, 0.0), 1.0);

        // Adjust Y coordinates for the new 200x200 viewBox (eyes are at 70)
        var startY = 75 - (15 * t);
        smileCurve.setAttribute('d', 'M 10 ' + startY + ' Q 50 ' + (75 + (20 * t)) + ' 90 ' + startY);
        
        // Set CSS variable for efficiency
        smileCurve.style.setProperty('--smile-t', t);
    }

    function paintEyes(cv_out_val, leaky_onset_val) {
        if (!pupilLeft || !pupilRight) {
            return;
        }
        var leftNorm = Math.min(Math.max(cv_out_val, 0.0), 1.0);
        var rightNorm = Math.min(Math.max(leaky_onset_val / 100.0, 0.0), 1.0);

        var range = 5; // movement range (8 eye - 3 pupil)
        var centerY = 35;

        pupilLeft.setAttribute('cy', centerY - (leftNorm * range));
        pupilRight.setAttribute('cy', centerY - (rightNorm * range));
        
        // Set CSS variables for efficiency
        pupilLeft.style.setProperty('--pupil-norm', leftNorm);
        pupilRight.style.setProperty('--pupil-norm', rightNorm);
    }

    function flushCvPaint() {
        if (!cvMask) return;
        var cv = Math.min(Math.max(cvPendingValue || 0.0, 0.0), 1.0);
        cvMask.style.height = ((1 - cv) * 100) + '%';
        paintSmile(cv);
        paintEyes(cv, leakyOnsetPendingValue || 0.0);
        cvLastPaintMs = Date.now();
        cvMeterTimer = null;
    }

    function queueCvPaint(cv) {
        if (!cvMask) return;
        cvPendingValue = cv;
        var now = Date.now();
        var elapsed = now - cvLastPaintMs;
        if (elapsed >= INPUT_METER_INTERVAL_MS) {
            flushCvPaint();
        } else if (!cvMeterTimer) {
            cvMeterTimer = setTimeout(flushCvPaint, INPUT_METER_INTERVAL_MS - elapsed);
        }
    }

    function flushLeakyOnsetPaint() {
        if (!pupilRight) return; // Only need to update if pupilRight exists
        var leaky = leakyOnsetPendingValue || 0.0;
        paintEyes(cvPendingValue || 0.0, leaky);
        leakyOnsetLastPaintMs = Date.now();
        leakyOnsetMeterTimer = null;
    }

    function queueLeakyOnsetPaint(leaky) {
        if (!pupilRight) return;
        leakyOnsetPendingValue = leaky;
        var now = Date.now();
        var elapsed = now - leakyOnsetLastPaintMs;
        if (elapsed >= INPUT_METER_INTERVAL_MS) {
            flushLeakyOnsetPaint();
        } else if (!leakyOnsetMeterTimer) {
            leakyOnsetMeterTimer = setTimeout(flushLeakyOnsetPaint, INPUT_METER_INTERVAL_MS - elapsed);
        }
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

        if (inputMeterTimer) {
            clearTimeout(inputMeterTimer);
            inputMeterTimer = null;
        }
        inputLastPaintMs = Date.now();
        
        if (inputMask) {
            inputMask.style.height = '100%';
        }
        if (cvMask) {
            cvMask.style.height = '100%';
            cvPendingValue = 0.0;
            cvLastPaintMs = inputLastPaintMs;
            if (cvMeterTimer) {
                clearTimeout(cvMeterTimer);
                cvMeterTimer = null;
            }
        }
        if (leakyOnsetMeterTimer) {
            clearTimeout(leakyOnsetMeterTimer);
            leakyOnsetMeterTimer = null;
        }
        leakyOnsetPendingValue = 0.0;
        leakyOnsetLastPaintMs = inputLastPaintMs;

        if (pupilLeft && pupilRight) { // Reset pupil positions
            paintEyes(0.0, 0.0);
        }
        if (onsetLed) onsetLed.classList.remove('active');
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

    if (symbol === 'cv_out_meter') {
        queueCvPaint(numericValue);
        return;
    }

    if (symbol === 'leaky_onset_meter') { // Handle new meter updates
        queueLeakyOnsetPaint(numericValue);
        return;
    }

    if (symbol === 'onset_indicator') {
        if (onsetLed) {
            onsetLed.classList.toggle('active', numericValue > 0.5);
        }
    }
}
