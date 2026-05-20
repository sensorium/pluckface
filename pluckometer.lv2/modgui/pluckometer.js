function(event, funcs) {
    var INPUT_METER_HZ = 10;
    var INPUT_METER_INTERVAL_MS = Math.round(1000 / INPUT_METER_HZ);
    var UI_STATE_KEY = 'pluckometerUi';
    var PUPIL_SMOOTH_STEP = 0.45;

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

    var icon = event.icon;

    function getState(createIfMissing) {
        var state = icon.data(UI_STATE_KEY);
        if (!state && createIfMissing) {
            state = {
                inputPendingDb: -90.0,
                cvPendingValue: 0.0,
                leakyOnsetPendingValue: 0.0,
                displayLastPaintMs: 0,
                displayTimer: null,
                pupilLeftSmoothNorm: 0.0,
                pupilRightSmoothNorm: 0.0
            };
            icon.data(UI_STATE_KEY, state);
        }
        return state;
    }

    function bindDom(state) {
        if (state.dom) {
            return state.dom;
        }

        var dom = {
            inputMeter: icon.find('.pluckometer-input-meter')[0],
            cvMeter: icon.find('.pluckometer-cv-meter')[0],
            onsetLed: icon.find('.pluckometer-onset-led')[0],
            smileCurve: icon.find('.pluckometer-smile-curve')[0],
            pupilLeft: icon.find('#pluckometer-pupil-left')[0],
            pupilRight: icon.find('#pluckometer-pupil-right')[0]
        };

        dom.inputMask = dom.inputMeter ? dom.inputMeter.querySelector('.pluckometer-input-meter-mask') : null;
        dom.cvMask = dom.cvMeter ? dom.cvMeter.querySelector('.pluckometer-cv-meter-mask') : null;
        dom.hasFace = dom.smileCurve || (dom.pupilLeft && dom.pupilRight);
        state.dom = dom;
        return dom;
    }

    function hasRenderableUi(dom) {
        return dom.inputMask || dom.cvMask || dom.onsetLed || dom.hasFace;
    }

    function paintSmile(dom, cv) {
        if (!dom.smileCurve) return;
        var t = cv;
        var startY = FACE_CONFIG.smileBaselineY - (15 * t);
        var controlY = FACE_CONFIG.smileBaselineY + (20 * t);
        var d = 'M ' + FACE_CONFIG.smileXLeft + ' ' + startY + ' Q ' + FACE_CONFIG.smileCenterX + ' ' + controlY + ' ' + FACE_CONFIG.smileXRight + ' ' + startY;
        dom.smileCurve.setAttribute('d', d);
        dom.smileCurve.style.setProperty('--smile-t', t);
    }

    function paintEyes(dom, state, cv_out_val, leaky_onset_val, snap) {
        if (!dom.pupilLeft || !dom.pupilRight) return;

        var leftTarget = Math.min(Math.max(cv_out_val, 0.0), 1.0);
        var rightTarget = Math.min(Math.max(leaky_onset_val / 20.0, 0.0), 1.0);
        var step = snap ? 1.0 : PUPIL_SMOOTH_STEP;

        state.pupilLeftSmoothNorm += step * (leftTarget - state.pupilLeftSmoothNorm);
        state.pupilRightSmoothNorm += step * (rightTarget - state.pupilRightSmoothNorm);

        var range = FACE_CONFIG.eyeRadius - FACE_CONFIG.pupilRadius;
        var restY = FACE_CONFIG.eyeCenterY + (FACE_CONFIG.eyeRadius / 2);

        dom.pupilLeft.setAttribute('cy', restY - (state.pupilLeftSmoothNorm * range));
        dom.pupilRight.setAttribute('cy', restY - (state.pupilRightSmoothNorm * range));
    }

    function flushDisplayPaint() {
        var state = getState(false);
        if (!state) return;

        var dom = bindDom(state);

        if (dom.inputMask) {
            var db = Math.min(Math.max(state.inputPendingDb, -90.0), 0.0);
            var inputNorm = (db + 90.0) / 90.0;
            dom.inputMask.style.height = ((1 - inputNorm) * 100) + '%';
        }

        var cv = Math.min(Math.max(state.cvPendingValue || 0.0, 0.0), 1.0);
        if (dom.cvMask) {
            dom.cvMask.style.height = ((1 - cv) * 100) + '%';
        }

        paintSmile(dom, cv);
        paintEyes(dom, state, cv, state.leakyOnsetPendingValue || 0.0, false);

        state.displayLastPaintMs = Date.now();
        state.displayTimer = null;
    }

    function scheduleDisplayPaint() {
        var state = getState(true);
        var now = Date.now();
        var elapsed = now - state.displayLastPaintMs;
        if (elapsed >= INPUT_METER_INTERVAL_MS) {
            flushDisplayPaint();
        } else if (!state.displayTimer) {
            state.displayTimer = setTimeout(flushDisplayPaint, INPUT_METER_INTERVAL_MS - elapsed);
        }
    }

    if (event.type === 'start') {
        var oldState = getState(false);
        if (oldState && oldState.displayTimer) {
            clearTimeout(oldState.displayTimer);
        }

        icon.removeData(UI_STATE_KEY);
        var state = getState(true);
        var dom = bindDom(state);

        if (!hasRenderableUi(dom)) {
            return;
        }

        var hiddenSliderSymbols = ['onset_method', 'onset_sensitivity', 'window_seconds', 'leaky_mix', 'leaky_decay_seconds', 'cv_smoothing', 'offset_cv_out', 'scale_cv_out'];
        for (var s = 0; s < hiddenSliderSymbols.length; s++) {
            var hiddenSlider = icon.find('.mod-slider-image[mod-port-symbol="' + hiddenSliderSymbols[s] + '"]').closest('.mod-slider');
            if (hiddenSlider && hiddenSlider.length) {
                hiddenSlider.addClass('pluckometer-hidden-control');
            }
        }

        var autoSilenceSlider = icon.find('.mod-control-group .mod-slider-image[mod-port-symbol="silence_threshold"]').closest('.mod-slider');
        if (autoSilenceSlider && autoSilenceSlider.length) {
            autoSilenceSlider.addClass('pluckometer-hidden-control');
        }

        var eyeSockets = icon.find('.pluckometer-eye-socket');
        if (eyeSockets.length >= 2) {
            eyeSockets[0].setAttribute('cx', FACE_CONFIG.eyeCenterXLeft);
            eyeSockets[0].setAttribute('cy', FACE_CONFIG.eyeCenterY);
            eyeSockets[0].setAttribute('r', FACE_CONFIG.eyeRadius);
            eyeSockets[1].setAttribute('cx', FACE_CONFIG.eyeCenterXRight);
            eyeSockets[1].setAttribute('cy', FACE_CONFIG.eyeCenterY);
            eyeSockets[1].setAttribute('r', FACE_CONFIG.eyeRadius);
        }
        if (dom.pupilLeft && dom.pupilRight) {
            dom.pupilLeft.setAttribute('cx', FACE_CONFIG.eyeCenterXLeft);
            dom.pupilLeft.setAttribute('r', FACE_CONFIG.pupilRadius);
            dom.pupilRight.setAttribute('cx', FACE_CONFIG.eyeCenterXRight);
            dom.pupilRight.setAttribute('r', FACE_CONFIG.pupilRadius);
        }

        state.inputPendingDb = -90.0;
        state.cvPendingValue = 0.0;
        state.leakyOnsetPendingValue = 0.0;
        state.displayLastPaintMs = Date.now();
        state.displayTimer = null;
        state.pupilLeftSmoothNorm = 0.0;
        state.pupilRightSmoothNorm = 0.0;

        if (dom.inputMask) {
            dom.inputMask.style.height = '100%';
        }
        if (dom.cvMask) {
            dom.cvMask.style.height = '100%';
        }
        if (dom.pupilLeft && dom.pupilRight) {
            paintEyes(dom, state, 0.0, 0.0, true);
        }
        if (dom.onsetLed) {
            dom.onsetLed.classList.remove('active');
        }
        paintSmile(dom, 0.0);
        return;
    }

    var state = getState(true);
    var dom = bindDom(state);
    if (!hasRenderableUi(dom)) {
        return;
    }

    var symbol = event.symbol || (event.port && event.port.symbol);
    var value = (typeof event.value !== 'undefined') ? event.value : (event.port && event.port.value);
    var numericValue = parseFloat(value);
    if (!isFinite(numericValue)) {
        return;
    }

    if (symbol === 'input_level_db') {
        state.inputPendingDb = numericValue;
        scheduleDisplayPaint();
        return;
    }

    if (symbol === 'cv_out_meter') {
        state.cvPendingValue = numericValue;
        scheduleDisplayPaint();
        return;
    }

    if (symbol === 'leaky_onset_meter') {
        state.leakyOnsetPendingValue = numericValue;
        scheduleDisplayPaint();
        return;
    }

    if (symbol === 'onset_indicator') {
        if (dom.onsetLed) {
            dom.onsetLed.classList.toggle('active', numericValue > 0.5);
        }
    }
}
