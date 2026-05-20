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

    // Pending meter/face values (updated on port events)
    var inputPendingDb = -90.0;
    var cvPendingValue = 0.0;
    var leakyOnsetPendingValue = 0.0;

    // Single display paint throttle
    var displayLastPaintMs = 0;
    var displayTimer = null;

    var pupilLeftSmoothNorm = 0.0;
    var pupilRightSmoothNorm = 0.0;
    var PUPIL_SMOOTH_STEP = 0.45;

    var onsetLed = event.icon.find('.pluckometer-onset-led')[0];
    var smileCurve = event.icon.find('.pluckometer-smile-curve')[0];
    var pupilLeft = event.icon.find('#pluckometer-pupil-left')[0];
    var pupilRight = event.icon.find('#pluckometer-pupil-right')[0];
    if (!inputMeter && !cvMeter && !onsetLed && !smileCurve && !pupilLeft && !pupilRight) {
        return;
    }

    var inputMask = inputMeter ? inputMeter.querySelector('.pluckometer-input-meter-mask') : null;
    var cvMask = cvMeter ? cvMeter.querySelector('.pluckometer-cv-meter-mask') : null;
    var hasFace = smileCurve || (pupilLeft && pupilRight);
    if (!inputMask && !cvMask && !onsetLed && !hasFace) {
        return;
    }

    function paintSmile(cv) {
        if (!smileCurve) return;
        var t = cv;

        var startY = FACE_CONFIG.smileBaselineY - (15 * t);
        var controlY = FACE_CONFIG.smileBaselineY + (20 * t);
        var d = 'M ' + FACE_CONFIG.smileXLeft + ' ' + startY + ' Q ' + FACE_CONFIG.smileCenterX + ' ' + controlY + ' ' + FACE_CONFIG.smileXRight + ' ' + startY;
        smileCurve.setAttribute('d', d);

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

    function flushDisplayPaint() {
        if (inputMask) {
            var db = Math.min(Math.max(inputPendingDb, -90.0), 0.0);
            var inputNorm = (db + 90.0) / 90.0;
            inputMask.style.height = ((1 - inputNorm) * 100) + '%';
        }

        var cv = Math.min(Math.max(cvPendingValue || 0.0, 0.0), 1.0);
        if (cvMask) {
            cvMask.style.height = ((1 - cv) * 100) + '%';
        }

        paintSmile(cv);
        paintEyes(cv, leakyOnsetPendingValue || 0.0, false);

        displayLastPaintMs = Date.now();
        displayTimer = null;
    }

    function scheduleDisplayPaint() {
        var now = Date.now();
        var elapsed = now - displayLastPaintMs;
        if (elapsed >= INPUT_METER_INTERVAL_MS) {
            flushDisplayPaint();
        } else if (!displayTimer) {
            displayTimer = setTimeout(flushDisplayPaint, INPUT_METER_INTERVAL_MS - elapsed);
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

        var autoSilenceSlider = event.icon.find('.mod-control-group .mod-slider-image[mod-port-symbol="silence_threshold"]').closest('.mod-slider');
        if (autoSilenceSlider && autoSilenceSlider.length) {
            autoSilenceSlider.addClass('pluckometer-hidden-control');
        }

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

        if (displayTimer) {
            clearTimeout(displayTimer);
            displayTimer = null;
        }

        inputPendingDb = -90.0;
        cvPendingValue = 0.0;
        leakyOnsetPendingValue = 0.0;
        displayLastPaintMs = Date.now();

        if (inputMask) {
            inputMask.style.height = '100%';
        }
        if (cvMask) {
            cvMask.style.height = '100%';
        }
        if (pupilLeft && pupilRight) {
            resetPupilMotion();
        }
        if (onsetLed) {
            onsetLed.classList.remove('active');
        }
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
        inputPendingDb = numericValue;
        scheduleDisplayPaint();
        return;
    }

    if (symbol === 'cv_out_meter') {
        cvPendingValue = numericValue;
        scheduleDisplayPaint();
        return;
    }

    if (symbol === 'leaky_onset_meter') {
        leakyOnsetPendingValue = numericValue;
        scheduleDisplayPaint();
        return;
    }

    if (symbol === 'onset_indicator') {
        if (onsetLed) {
            onsetLed.classList.toggle('active', numericValue > 0.5);
        }
    }
}
