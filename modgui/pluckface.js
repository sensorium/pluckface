function(event) {
    var INPUT_METER_INTERVAL_MS = 100;
    var UI_STATE_KEY = 'pluckfaceUi';
    var PAINT_EPSILON = 0.001;
    var INPUT_DB_EPSILON = 0.1;

    var icon = event.icon;

    function getState(createIfMissing) {
        var state = icon.data(UI_STATE_KEY);
        if (!state && createIfMissing) {
            state = {
                inputPendingDb: -90.0,
                cvPendingValue: 0.0,
                onsetIndicatorPending: false,
                displayLastPaintMs: 0,
                displayTimer: null,
                paintedInputNorm: null,
                paintedCv: null,
                paintedOnsetActive: null,
                paintedFootswitchOn: null
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
            inputMask: null,
            cvMask: null,
            onsetLed: icon.find('.pluckface-onset-led')[0],
            faceEyes: icon.find('.pluckface-face-eyes')[0],
            face: icon.find('.pluckface-face')[0],
            footswitch: icon.find('.mod-footswitch')[0]
        };

        var inputMeter = icon.find('.pluckface-input-meter')[0];
        var cvMeter = icon.find('.pluckface-cv-meter')[0];
        dom.inputMask = inputMeter ? inputMeter.querySelector('.pluckface-input-meter-mask') : null;
        dom.cvMask = cvMeter ? cvMeter.querySelector('.pluckface-cv-meter-mask') : null;
        state.dom = dom;
        return dom;
    }

    function hasRenderableUi(dom) {
        return dom.inputMask || dom.cvMask || dom.onsetLed || dom.faceEyes || dom.face;
    }

    function setCssVarIfChanged(el, name, value, state, paintedKey) {
        if (!el) return;
        if (state[paintedKey] !== null && Math.abs(state[paintedKey] - value) < PAINT_EPSILON) {
            return;
        }
        state[paintedKey] = value;
        el.style.setProperty(name, value);
    }

    function paintOnsetLed(dom, state) {
        var active = state.onsetIndicatorPending;
        if (state.paintedOnsetActive === active) {
            return;
        }
        state.paintedOnsetActive = active;

        if (dom.onsetLed) {
            dom.onsetLed.classList.toggle('active', active);
        }
        if (dom.faceEyes) {
            dom.faceEyes.classList.toggle('active', active);
        }

        if (active) {
            state.onsetIndicatorPending = false;
            // paintedOnsetActive stays true — matching what's in the DOM.
            // Schedule a paint so the next cycle sees active=false vs painted=true
            // and clears both elements.
            if (!state.displayTimer) {
                state.displayTimer = setTimeout(flushDisplayPaint, INPUT_METER_INTERVAL_MS);
            }
        }
    }

    function paintFaceVisibility(dom, state) {
        var isOn = !dom.footswitch || !dom.footswitch.classList.contains('on');
        if (state.paintedFootswitchOn === isOn) {
            return;
        }
        state.paintedFootswitchOn = isOn;

        if (dom.face) {
            dom.face.classList.toggle('pedal-off', !isOn);
        }
        if (dom.faceEyes) {
            dom.faceEyes.classList.toggle('pedal-off', !isOn);
        }
    }

    function flushDisplayPaint() {
        var state = getState(false);
        if (!state) return;

        var dom = bindDom(state);
        var cv = Math.min(Math.max(state.cvPendingValue, 0.0), 1.0);

        if (dom.inputMask) {
            var db = Math.min(Math.max(state.inputPendingDb, -90.0), 0.0);
            var inputNorm = (db + 90.0) / 90.0;
            setCssVarIfChanged(dom.inputMask, '--meter-fill', inputNorm, state, 'paintedInputNorm');
        }

        if (dom.cvMask) {
            setCssVarIfChanged(dom.cvMask, '--meter-fill', cv, state, 'paintedCv');
        }
        paintOnsetLed(dom, state);

        state.displayLastPaintMs = Date.now();
        state.displayTimer = null;
    }

    function scheduleDisplayPaint(state) {
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
        state.paintedOnsetActive = null;
        state.paintedFootswitchOn = null;
    }

    if (event.type === 'start') {
        var oldState = getState(false);
        if (oldState && oldState.displayTimer) {
            clearTimeout(oldState.displayTimer);
        }
        if (oldState && oldState.footswitchObserver) {
            oldState.footswitchObserver.disconnect();
        }

        icon.removeData(UI_STATE_KEY);
        var state = getState(true);
        var dom = bindDom(state);

        if (!hasRenderableUi(dom)) {
            return;
        }

        state.inputPendingDb = -90.0;
        state.cvPendingValue = 0.0;
        state.onsetIndicatorPending = false;
        state.displayLastPaintMs = Date.now();
        state.displayTimer = null;
        resetPaintedState(state);
        if (dom.inputMask) {
            dom.inputMask.style.setProperty('--meter-fill', '0');
        }
        if (dom.cvMask) {
            dom.cvMask.style.setProperty('--meter-fill', '0');
        }
        paintFaceVisibility(dom, state);

        if (dom.footswitch) {
            var footswitchObserver = new MutationObserver(function () {
                var state = getState(false);
                if (!state) return;
                state.paintedFootswitchOn = null;
                paintFaceVisibility(bindDom(state), state);
            });
            footswitchObserver.observe(dom.footswitch, { attributes: true, attributeFilter: ['class'] });
            state.footswitchObserver = footswitchObserver;
        }

        if (dom.onsetLed) {
            dom.onsetLed.classList.remove('active');
        }
        if (dom.faceEyes) {
            dom.faceEyes.classList.remove('active');
        }
        return;
    }

    var symbol = event.symbol || (event.port && event.port.symbol);
    var value = (typeof event.value !== 'undefined') ? event.value : (event.port && event.port.value);
    var numericValue = parseFloat(value);
    if (!isFinite(numericValue)) {
        return;
    }

    var state = getState(true);

    if (symbol === 'input_level_db') {
        if (Math.abs(state.inputPendingDb - numericValue) < INPUT_DB_EPSILON) {
            return;
        }
        state.inputPendingDb = numericValue;
        scheduleDisplayPaint(state);
        return;
    }

    if (symbol === 'cv_out_meter') {
        if (Math.abs(state.cvPendingValue - numericValue) < PAINT_EPSILON) {
            return;
        }
        state.cvPendingValue = numericValue;
        scheduleDisplayPaint(state);
        return;
    }

    if (symbol === 'onset_indicator') {
        var onsetActive = numericValue > 0.5;
        if (state.onsetIndicatorPending === onsetActive) {
            return;
        }
        state.onsetIndicatorPending = onsetActive;
        scheduleDisplayPaint(state);
    }
}
