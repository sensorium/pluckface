function(event, funcs) {
    var INPUT_METER_HZ = 10;
    var INPUT_METER_INTERVAL_MS = Math.round(1000 / INPUT_METER_HZ);
    var UI_STATE_KEY = 'pluckometerUi';
    var PUPIL_SMOOTH_STEP = 0.45;
    var PAINT_EPSILON = 0.001;

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
                pupilRightSmoothNorm: 0.0,
                paintedInputNorm: null,
                paintedCv: null,
                paintedSmileT: null,
                paintedPupilLeft: null,
                paintedPupilRight: null
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
            face: icon.find('.pluckometer-face')[0],
            smileCurve: icon.find('.pluckometer-smile-curve')[0],
            pupilLeft: icon.find('#pluckometer-pupil-left')[0],
            pupilRight: icon.find('#pluckometer-pupil-right')[0]
        };

        dom.inputMask = dom.inputMeter ? dom.inputMeter.querySelector('.pluckometer-input-meter-mask') : null;
        dom.cvMask = dom.cvMeter ? dom.cvMeter.querySelector('.pluckometer-cv-meter-mask') : null;
        dom.hasFace = dom.face && dom.smileCurve && dom.pupilLeft && dom.pupilRight;
        state.dom = dom;
        return dom;
    }

    function hasRenderableUi(dom) {
        return dom.inputMask || dom.cvMask || dom.onsetLed || dom.hasFace;
    }

    function setCssVarIfChanged(el, name, value, state, paintedKey) {
        if (!el) return;
        if (state[paintedKey] !== null && Math.abs(state[paintedKey] - value) < PAINT_EPSILON) {
            return;
        }
        state[paintedKey] = value;
        el.style.setProperty(name, value);
    }

    function flushDisplayPaint() {
        var state = getState(false);
        if (!state) return;

        var dom = bindDom(state);
        var cv = Math.min(Math.max(state.cvPendingValue || 0.0, 0.0), 1.0);
        var leaky = state.leakyOnsetPendingValue || 0.0;
        var leftTarget = cv;
        var rightTarget = Math.min(Math.max(leaky / 20.0, 0.0), 1.0);

        state.pupilLeftSmoothNorm += PUPIL_SMOOTH_STEP * (leftTarget - state.pupilLeftSmoothNorm);
        state.pupilRightSmoothNorm += PUPIL_SMOOTH_STEP * (rightTarget - state.pupilRightSmoothNorm);

        if (dom.inputMask) {
            var db = Math.min(Math.max(state.inputPendingDb, -90.0), 0.0);
            var inputNorm = (db + 90.0) / 90.0;
            setCssVarIfChanged(dom.inputMask, '--meter-fill', inputNorm, state, 'paintedInputNorm');
        }

        setCssVarIfChanged(dom.cvMask, '--meter-fill', cv, state, 'paintedCv');
        setCssVarIfChanged(dom.smileCurve, '--smile-t', cv, state, 'paintedSmileT');
        setCssVarIfChanged(dom.pupilLeft, '--pupil-norm', state.pupilLeftSmoothNorm, state, 'paintedPupilLeft');
        setCssVarIfChanged(dom.pupilRight, '--pupil-norm', state.pupilRightSmoothNorm, state, 'paintedPupilRight');

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

    function resetPaintedState(state) {
        state.paintedInputNorm = null;
        state.paintedCv = null;
        state.paintedSmileT = null;
        state.paintedPupilLeft = null;
        state.paintedPupilRight = null;
    }

    function resetFaceCss(dom) {
        if (dom.inputMask) {
            dom.inputMask.style.setProperty('--meter-fill', '0');
        }
        if (dom.cvMask) {
            dom.cvMask.style.setProperty('--meter-fill', '0');
        }
        if (dom.smileCurve) {
            dom.smileCurve.style.setProperty('--smile-t', '0');
        }
        if (dom.pupilLeft) {
            dom.pupilLeft.style.setProperty('--pupil-norm', '0');
        }
        if (dom.pupilRight) {
            dom.pupilRight.style.setProperty('--pupil-norm', '0');
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

        state.inputPendingDb = -90.0;
        state.cvPendingValue = 0.0;
        state.leakyOnsetPendingValue = 0.0;
        state.displayLastPaintMs = Date.now();
        state.displayTimer = null;
        state.pupilLeftSmoothNorm = 0.0;
        state.pupilRightSmoothNorm = 0.0;
        resetPaintedState(state);
        resetFaceCss(dom);

        if (dom.onsetLed) {
            dom.onsetLed.classList.remove('active');
        }
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
