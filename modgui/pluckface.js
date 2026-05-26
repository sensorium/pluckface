function(event) {
    var INPUT_METER_INTERVAL_MS = 100;
    var UI_STATE_KEY = 'pluckfaceUi';
    var PAINT_EPSILON = 0.001;
    var INPUT_DB_EPSILON = 0.1;

    // -------------------------------------------------------------------------
    // ONSET LED: uses CSS custom property --onset-intensity (0.0-1.0) mapped to
    // opacity. Verify the stylesheet wires this: opacity: var(--onset-intensity)
    // CSS transition on opacity provides visual decay between frames — uncomment
    // the transition in the stylesheet for this to work.
    //
    // FACE EYES: uses .active class toggle only — the 2-frame blink animation
    // needs to complete before being cleared. EYES_HOLD_MS should be at least
    // as long as the CSS animation duration. Adjust if blinks feel truncated.
    // -------------------------------------------------------------------------
    var LED_HOLD_MS = 120;
    var EYES_HOLD_MS = 150;

    var icon = event.icon;

    function getState(createIfMissing) {
        var state = icon.data(UI_STATE_KEY);
        if (!state && createIfMissing) {
            state = {
                // Pending values, accumulated between paints
                inputPendingDb: -90.0,
                cvPendingValue: 0.0,
                onsetCountPending: 0,   // incremented on each rising edge of onset_indicator
                eyesActiveUntil: 0,     // timestamp until which faceEyes stays active

                // Paint scheduling
                displayLastPaintMs: 0,
                displayTimer: null,
                onsetLedTimer: null,

                // Last-painted values for change detection
                paintedInputNorm: null,
                paintedCv: null,
                paintedEyesActive: null,     // boolean
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
        el.style.setProperty(name, String(value));
    }

    function paintOnsetLed(dom, state) {
        var now = Date.now();
        var count = state.onsetCountPending;
        state.onsetCountPending = 0;

        // Only write to the LED on actual onsets — never write 0.
        // Then explicitly return it to zero so the CSS opacity transition can
        // do the visible fade.
        if (count > 0) {
            var intensity = 1.0 - Math.exp(-count * 0.7);
            if (dom.onsetLed) {
                dom.onsetLed.style.setProperty('--onset-intensity', String(intensity));
                dom.onsetLed.classList.remove('active');
                void dom.onsetLed.offsetWidth;
                dom.onsetLed.classList.add('active');
                if (state.onsetLedTimer) {
                    clearTimeout(state.onsetLedTimer);
                }
                state.onsetLedTimer = setTimeout(function () {
                    state.onsetLedTimer = null;
                    if (dom.onsetLed) {
                        dom.onsetLed.classList.remove('active');
                        dom.onsetLed.style.setProperty('--onset-intensity', '0');
                    }
                }, LED_HOLD_MS);
            }
        }

        // Eyes hold logic unchanged...
        if (count > 0) {
            state.eyesActiveUntil = now + EYES_HOLD_MS;
        }
        var eyesActive = now < state.eyesActiveUntil;
        if (state.paintedEyesActive !== eyesActive) {
            state.paintedEyesActive = eyesActive;
            if (dom.faceEyes) {
                dom.faceEyes.classList.toggle('active', eyesActive);
            }
        }

        return eyesActive;
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

        var eyesStillActive = paintOnsetLed(dom, state);

        state.displayLastPaintMs = Date.now();
        state.displayTimer = null;

        // Keep ticking while the eyes hold period is running.
        if (eyesStillActive) {
            state.displayTimer = setTimeout(flushDisplayPaint, INPUT_METER_INTERVAL_MS);
        }
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
        state.paintedEyesActive = null;
        state.paintedFootswitchOn = null;
    }

    // -------------------------------------------------------------------------
    // Event handling
    // -------------------------------------------------------------------------

    if (event.type === 'start') {
        var oldState = getState(false);
        if (oldState && oldState.displayTimer) {
            clearTimeout(oldState.displayTimer);
        }
        if (oldState && oldState.onsetLedTimer) {
            clearTimeout(oldState.onsetLedTimer);
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
        state.onsetCountPending = 0;
        state.eyesActiveUntil = 0;
        state.displayLastPaintMs = Date.now();
        state.displayTimer = null;
        state.onsetLedTimer = null;
        resetPaintedState(state);

        if (dom.inputMask) {
            dom.inputMask.style.setProperty('--meter-fill', '0');
        }
        if (dom.cvMask) {
            dom.cvMask.style.setProperty('--meter-fill', '0');
        }
        if (dom.onsetLed) {
            dom.onsetLed.classList.remove('active');
            dom.onsetLed.style.setProperty('--onset-intensity', '0');
        }
        if (dom.faceEyes) {
            dom.faceEyes.classList.remove('active');
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
        // Only count rising edges — the plugin's 0 reset events are ignored.
        // The count accumulator handles any onset rate correctly.
        if (numericValue > 0.5) {
            state.onsetCountPending++;
            scheduleDisplayPaint(state);
        }
    }
}
