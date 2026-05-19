function(event, funcs) {
    var INPUT_METER_HZ = 10;
    var INPUT_METER_INTERVAL_MS = Math.round(1000 / INPUT_METER_HZ);

    var inputMeter = event.icon.find('.pluckometer-input-meter')[0];
    var cvMeter = event.icon.find('.pluckometer-cv-meter')[0];
    var cvPendingValue = null;
    var cvLastPaintMs = 0;
    var cvMeterTimer = null;
    var leakyOnsetPendingValue = null; // New variable for leaky onset meter
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
        if (!inputMeter || !inputMask) {
            return;
        }
        var db = (typeof inputMeter._pendingInputDb === 'number') ? inputMeter._pendingInputDb : -90.0;
        if (db < -90.0) db = -90.0;
        if (db > 0.0) db = 0.0;
        var norm = (db + 90.0) / 90.0;
        if (norm < 0.0) norm = 0.0;
        if (norm > 1.0) norm = 1.0;
        inputMask.style.height = ((1 - norm) * 100) + '%';
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

    function paintSmile(cv) {
        if (!smileCurve) {
            return;
        }

        // Interpolate from a flat line (cv=0) to a smiling curve (cv=1).
        var t = cv;
        if (t < 0.0) t = 0.0;
        if (t > 1.0) t = 1.0;

        // Adjust Y coordinates for the new 100x100 viewBox (eyes are at 35)
        var startY = 75 - (15 * t);
        var endY = startY;
        var controlY = 75 + (20 * t);
        smileCurve.setAttribute('d', 'M 10 ' + startY + ' Q 50 ' + controlY + ' 90 ' + endY);
    }

    function paintEyes(cv_out_val, leaky_onset_val) {
        if (!pupilLeft || !pupilRight) {
            return;
        }

        // Left pupil (cv_out_meter, 0-1 range)
        var leftPupilNorm = cv_out_val;
        if (leftPupilNorm < 0.0) leftPupilNorm = 0.0;
        if (leftPupilNorm > 1.0) leftPupilNorm = 1.0;

        // Right pupil (leaky_onset_meter, 0-10 range, normalize to 0-1)
        var rightPupilNorm = leaky_onset_val / 10.0; // Normalize 0-10 to 0-1
        if (rightPupilNorm < 0.0) rightPupilNorm = 0.0;
        if (rightPupilNorm > 1.0) rightPupilNorm = 1.0;

        // Eye parameters (from HTML SVG)
        var eyeCenterX = 35; // For left eye
        var eyeCenterY = 35;
        var eyeRadius = 8;
        var pupilRadius = 3;
        var pupilMovementRange = eyeRadius - pupilRadius; // Max offset from center

        // Pupil Y position: 0 = bottom, 1 = top
        // pupilY = eyeCenterY + pupilMovementRange - (leftPupilNorm * 2 * pupilMovementRange); // Inverted for 0=bottom, 1=top
        // Let's make it simpler: 0 = center, 1 = top
        var leftPupilY = eyeCenterY - (leftPupilNorm * pupilMovementRange);
        var rightPupilY = eyeCenterY - (rightPupilNorm * pupilMovementRange);

        pupilLeft.setAttribute('cy', leftPupilY);
        pupilRight.setAttribute('cy', rightPupilY);
    }

    function flushCvPaint() {
        if (!cvMask) return;
        var cv = (typeof cvPendingValue === 'number') ? cvPendingValue : 0.0;
        if (cv < 0.0) cv = 0.0;
        if (cv > 1.0) cv = 1.0;
        cvMask.style.height = ((1 - cv) * 100) + '%';
        paintSmile(cv);
        paintEyes(cv, leakyOnsetPendingValue || 0.0); // Pass both values to paintEyes
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
            return;
        }
        if (!cvMeterTimer) {
            cvMeterTimer = setTimeout(flushCvPaint, INPUT_METER_INTERVAL_MS - elapsed);
        }
    }

    function flushLeakyOnsetPaint() {
        if (!pupilRight) return; // Only need to update if pupilRight exists
        var leaky = (typeof leakyOnsetPendingValue === 'number') ? leakyOnsetPendingValue : 0.0;
        // paintEyes will handle normalization and actual drawing
        paintEyes(cvPendingValue || 0.0, leaky); // Pass both values
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
            return;
        }
        if (!leakyOnsetMeterTimer) {
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

        if (inputMeter && inputMeter._inputMeterTimer) {
            clearTimeout(inputMeter._inputMeterTimer);
            inputMeter._inputMeterTimer = null;
        }

        if (inputMask) {
            inputMask.style.height = '100%';
        }
        if (cvMask) {
            cvMask.style.height = '100%';
            cvPendingValue = 0.0;
            cvLastPaintMs = Date.now();
            if (cvMeterTimer) {
                clearTimeout(cvMeterTimer);
                cvMeterTimer = null;
            }
        }
        if (leakyOnsetMeterTimer) { // Clear timer for new meter
            clearTimeout(leakyOnsetMeterTimer);
            leakyOnsetMeterTimer = null;
        }
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
