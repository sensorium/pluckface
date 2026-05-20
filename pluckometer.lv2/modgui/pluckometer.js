function(event, funcs) {
    var INPUT_METER_HZ = 10;
    var INPUT_METER_INTERVAL_MS = Math.round(1000 / INPUT_METER_HZ);

    // Central Source of Truth for Face Geometry (100x100 ViewBox)
    var FACE_CONFIG = {
        eyeCenterY: 35,
        eyeCenterXLeft: 35,
        eyeCenterXRight: 65,
        eyeRadius: 10,
        pupilRadius: 3,
        smileBaselineY: 75,
        smileXLeft: 20,
        smileXRight: 80,
        smileCenterX: 50
    };

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

    var pupilLeftSmoothNorm = 0.0;
    var pupilRightSmoothNorm = 0.0;
    var PUPIL_SMOOTH_STEP = 0.45;

    var onsetLed = event.icon.find('.pluckometer-onset-led')[0];
    var smileCurve = event.icon.find('.pluckometer-smile-curve')[0];
    var pupilLeft = event.icon.find('#pluckometer-pupil-left')[0]; // Reference to left pupil
    var pupilRight = event.icon.find('#pluckometer-pupil-right')[0]; // Reference to right pupil
    if (!inputMeter && !cvMeter && !onsetLed && !smileCurve && !pupilLeft && !pupilRight) {
        return;
    }

    var inputMask = inputMeter ? inputMeter.querySelector('.pluckometer-input-meter-mask') : null;
    var cvMask = cvMeter ? cvMeter.querySelector('.pluckometer-cv-meter-mask') : null;
    var hasFace = smileCurve || (pupilLeft && pupilRight);
    if (!inputMask && !cvMask && !onsetLed && !hasFace) {
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
        if (!smileCurve) return;
        var t = cv;

        var startY = FACE_CONFIG.smileBaselineY - (15 * t);
        var controlY = FACE_CONFIG.smileBaselineY + (20 * t);
        var d = 'M ' + FACE_CONFIG.smileXLeft + ' ' + startY + ' Q ' + FACE_CONFIG.smileCenterX + ' ' + controlY + ' ' + FACE_CONFIG.smileXRight + ' ' + startY;
        smileCurve.setAttribute('d', d);

        // Set CSS variable for efficiency
        smileCurve.style.setProperty('--smile-t', t);
    }

    function paintEyes(cv_out_val, leaky_onset_val, snap) {
        if (!pupilLeft || !pupilRight) return;

        var leftTarget = Math.min(Math.max(cv_out_val, 0.0), 1.0);
        // leaky_onset_meter scale for leaky_onset_val is set in pluckometer.cpp
        var rightTarget = Math.min(Math.max(leaky_onset_val / 20.0, 0.0), 1.0);
        var step = snap ? 1.0 : PUPIL_SMOOTH_STEP;

        pupilLeftSmoothNorm += step * (leftTarget - pupilLeftSmoothNorm);
        pupilRightSmoothNorm += step * (rightTarget - pupilRightSmoothNorm);

        var range = FACE_CONFIG.eyeRadius - FACE_CONFIG.pupilRadius;
        var restY = FACE_CONFIG.eyeCenterY + (FACE_CONFIG.eyeRadius / 2);

        pupilLeft.setAttribute('cy', restY - (pupilLeftSmoothNorm * range));
        pupilRight.setAttribute('cy', restY - (pupilRightSmoothNorm * range));
    }

    function resetPupilMotion() {
        pupilLeftSmoothNorm = 0.0;
        pupilRightSmoothNorm = 0.0;
        paintEyes(0.0, 0.0, true);
    }

    function flushCvPaint() {
        var cv = Math.min(Math.max(cvPendingValue || 0.0, 0.0), 1.0);
        if (cvMask) {
            cvMask.style.height = ((1 - cv) * 100) + '%';
        }
        paintSmile(cv);
        paintEyes(cv, leakyOnsetPendingValue || 0.0, false);
        cvLastPaintMs = Date.now();
        cvMeterTimer = null;
    }

    function queueCvPaint(cv) {
        if (!cvMask && !(pupilLeft && pupilRight) && !smileCurve) return;
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

        // Initialize Face Geometry from FACE_CONFIG
        var eyeSockets = event.icon.find('.pluckometer-eye-socket');
        if (eyeSockets.length >= 2) {
            eyeSockets[0].setAttribute('cx', FACE_CONFIG.eyeCenterXLeft);
            eyeSockets[0].setAttribute('cy', FACE_CONFIG.eyeCenterY);
            eyeSockets[0].setAttribute('r', FACE_CONFIG.eyeRadius);
            eyeSockets[1].setAttribute('cx', FACE_CONFIG.eyeCenterXRight);
            eyeSockets[1].setAttribute('cy', FACE_CONFIG.eyeCenterY);
            eyeSockets[1].setAttribute('r', FACE_CONFIG.eyeRadius);
        }
        if (pupilLeft && pupilRight) {
            pupilLeft.setAttribute('cx', FACE_CONFIG.eyeCenterXLeft);
            pupilLeft.setAttribute('r', FACE_CONFIG.pupilRadius);
            pupilRight.setAttribute('cx', FACE_CONFIG.eyeCenterXRight);
            pupilRight.setAttribute('r', FACE_CONFIG.pupilRadius);
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

        if (pupilLeft && pupilRight) {
            resetPupilMotion();
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
