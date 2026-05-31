function(event) {

    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------
    var METER_INTERVAL_MS = 100;   // minimum ms between meter repaints
    var UI_STATE_KEY = 'pluckfaceUi';
    var PAINT_EPSILON = 0.001;
    var INPUT_DB_EPSILON = 0.1;
    var BLINK_HOLD_MS = 60;   // how long eyes stay closed after an onset
    var ONSET_LED_HOLD_MS = 60;
    var icon = event.icon;

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------
    function getState(createIfMissing) {
        var state = icon.data(UI_STATE_KEY);
        if (!state && createIfMissing) {
            state = {
                inputPendingDb: -90.0,
                cvPendingValue: 0.0,
                meterLastPaintMs: 0,
                meterTimer: null,     // setTimeout handle for meter repaints
                blinkTimer: null,     // setTimeout handle for clearing blink
                paintedInputNorm: null,
                paintedCv: null,
                paintedBlinkActive: null,
                paintedFootswitchOn: null,
                footswitchObserver: null,
                lastOnsetCount: 0.0,
                dom: null,
                lastAutoNormalize: 0.0,
                lastAutoScale: 1.0,
                lastAutoOffset: 0.0,
                scaleOverlayTimer: null,
                offsetOverlayTimer: null
            };
            icon.data(UI_STATE_KEY, state);
        }
        return state;
    }

    // -------------------------------------------------------------------------
    // DOM binding (cached on state after first call)
    // -------------------------------------------------------------------------
    function bindDom(state) {
        if (state.dom) { return state.dom; }
        var inputMeter = icon.find('.pluckface-input-meter')[0];
        var cvMeter = icon.find('.pluckface-cv-meter')[0];
        state.dom = {
            inputMask: inputMeter ? inputMeter.querySelector('.pluckface-input-meter-mask') : null,
            cvMask: cvMeter ? cvMeter.querySelector('.pluckface-cv-meter-mask') : null,
            onsetLed: icon.find('.pluckface-onset-led')[0] || null,
            faceEyes: icon.find('.pluckface-face-eyes')[0] || null,
            face: icon.find('.pluckface-face')[0] || null,
            footswitch: icon.find('.mod-footswitch')[0] || null,
            scaleCvKnob: icon.find('.pluckface-scale-cv-knob')[0] || null,
            offsetCvKnob: icon.find('.pluckface-offset-cv-knob')[0] || null
        };
        return state.dom;
    }

    function hasRenderableUi(dom) {
        return !!(dom.inputMask || dom.cvMask || dom.onsetLed || dom.faceEyes || dom.face);
    }

    // -------------------------------------------------------------------------
    // Meter paint — called on a throttled timer, handles input + cv meters only
    // -------------------------------------------------------------------------
    function paintMeters(dom, state) {
        if (dom.inputMask) {
            var db = Math.min(Math.max(state.inputPendingDb, -90.0), 0.0);
            var inputNorm = (db + 90.0) / 90.0;
            if (state.paintedInputNorm === null ||
                Math.abs(state.paintedInputNorm - inputNorm) >= PAINT_EPSILON) {
                state.paintedInputNorm = inputNorm;
                dom.inputMask.style.setProperty('--meter-fill', String(inputNorm));
            }
        }
        if (dom.cvMask) {
            var cv = Math.min(Math.max(state.cvPendingValue, 0.0), 1.0);
            if (state.paintedCv === null ||
                Math.abs(state.paintedCv - cv) >= PAINT_EPSILON) {
                state.paintedCv = cv;
                dom.cvMask.style.setProperty('--meter-fill', String(cv));
            }
        }
    }

    function flushMeterPaint() {
        var state = getState(false);
        if (!state) { return; }
        state.meterTimer = null;
        state.meterLastPaintMs = Date.now();
        paintMeters(bindDom(state), state);
    }

    function scheduleMeterPaint(state) {
        if (state.meterTimer) { return; }   // already pending
        var elapsed = Date.now() - state.meterLastPaintMs;
        var delay = Math.max(0, METER_INTERVAL_MS - elapsed);
        state.meterTimer = setTimeout(flushMeterPaint, delay);
    }

    // -------------------------------------------------------------------------
    // Onset LED — called directly on each onset event, not via the meter timer
    // -------------------------------------------------------------------------

    function flashOnsetLed(dom, state) {
        if (!dom.onsetLed) return;
        // Cancel any pending off-timer
        if (state.ledTimer) {
            clearTimeout(state.ledTimer);
            state.ledTimer = null;
        }
        dom.onsetLed.classList.add('active');     // triggers fade-in transition
        state.ledTimer = setTimeout(function () {
            state.ledTimer = null;
            var s = getState(false);
            if (!s || !bindDom(s).onsetLed) return;
            bindDom(s).onsetLed.classList.remove('active');  // triggers fade-out transition
        }, ONSET_LED_HOLD_MS);   // reuse the same hold constant, or define LED_HOLD_MS separately
    }

    // -------------------------------------------------------------------------
    // Eyes — simple close/open (blink) with a dedicated hold timer, fully independent
    // -------------------------------------------------------------------------
    function blinkEyes(dom, state) {
        // Cancel any pending open
        if (state.blinkTimer) {
            clearTimeout(state.blinkTimer);
            state.blinkTimer = null;
        }

        if (state.paintedBlinkActive !== true) {
            state.paintedBlinkActive = true;
            if (dom.faceEyes) { dom.faceEyes.classList.add('active'); }
        }

        // Schedule open after hold period
        state.blinkTimer = setTimeout(function () {
            state.blinkTimer = null;
            var s = getState(false);
            if (!s) { return; }
            s.paintedBlinkActive = false;
            var d = bindDom(s);
            if (d.faceEyes) { d.faceEyes.classList.remove('active'); }
        }, BLINK_HOLD_MS);
    }

    // -------------------------------------------------------------------------
    // Face visibility (follows footswitch state)
    // -------------------------------------------------------------------------
    function paintFaceVisibility(dom, state) {
        var isOn = !dom.footswitch || !dom.footswitch.classList.contains('on');
        if (state.paintedFootswitchOn === isOn) { return; }
        state.paintedFootswitchOn = isOn;
        if (dom.face) { dom.face.classList.toggle('pedal-off', !isOn); }
        if (dom.faceEyes) { dom.faceEyes.classList.toggle('pedal-off', !isOn); }
    }

    // -------------------------------------------------------------------------
    // Value overlay — briefly shows a numeric readout centred over a knob,
    // used to display auto-norm scale/offset on toggle-off.
    // -------------------------------------------------------------------------
    var OVERLAY_HOLD_MS = 3500;   // visible time before fade begins
    var OVERLAY_FADE_MS = 500;    // CSS transition duration

    function showValueOverlay(knobEl, value, state, timerKey) {
        if (!knobEl) { return; }

        // Remove any existing overlay on this knob immediately
        var existing = knobEl.querySelector('.pluckface-value-overlay');
        if (existing) { knobEl.removeChild(existing); }
        if (state[timerKey]) { clearTimeout(state[timerKey]); state[timerKey] = null; }

        var overlay = document.createElement('div');
        overlay.className = 'pluckface-value-overlay';
        overlay.textContent = value.toFixed(3);
        overlay.style.cssText = [
            'position:absolute',
            'top:50%',
            'left:50%',
            'transform:translate(-50%,-50%)',
            'background:rgba(0,0,0,0.72)',
            'color:#fff',
            'font-size:10px',
            'font-family:monospace',
            'padding:2px 5px',
            'border-radius:3px',
            'pointer-events:none',
            'white-space:nowrap',
            'opacity:1',
            'transition:opacity ' + OVERLAY_FADE_MS + 'ms ease'
        ].join(';');

        // Absolute positioning requires a positioned ancestor
        if (getComputedStyle(knobEl).position === 'static') {
            knobEl.style.position = 'relative';
        }
        knobEl.appendChild(overlay);

        // After hold period, trigger CSS fade then remove
        state[timerKey] = setTimeout(function () {
            overlay.style.opacity = '0';
            state[timerKey] = setTimeout(function () {
                state[timerKey] = null;
                if (overlay.parentNode) { overlay.parentNode.removeChild(overlay); }
            }, OVERLAY_FADE_MS);
        }, OVERLAY_HOLD_MS);
    }

    // -------------------------------------------------------------------------
    // Startup
    // -------------------------------------------------------------------------
    if (event.type === 'start') {
        // Tear down any previous state
        var oldState = getState(false);
        if (oldState) {
            if (oldState.meterTimer) { clearTimeout(oldState.meterTimer); }
            if (oldState.blinkTimer) { clearTimeout(oldState.blinkTimer); }
            if (oldState.scaleOverlayTimer) { clearTimeout(oldState.scaleOverlayTimer); }
            if (oldState.offsetOverlayTimer) { clearTimeout(oldState.offsetOverlayTimer); }
            if (oldState.footswitchObserver) { oldState.footswitchObserver.disconnect(); }
        }
        icon.removeData(UI_STATE_KEY);

        var state = getState(true);
        var dom = bindDom(state);
        if (!hasRenderableUi(dom)) { return; }

        // Reset meters
        if (dom.inputMask) { dom.inputMask.style.setProperty('--meter-fill', '0'); }
        if (dom.cvMask) { dom.cvMask.style.setProperty('--meter-fill', '0'); }

        // Reset LED — write 0 once at startup so the CSS fallback doesn't show
        // if (dom.onsetLed) { dom.onsetLed.style.setProperty('--onset-intensity', '0'); }

        // Reset eyes
        if (dom.faceEyes) { dom.faceEyes.classList.remove('active'); }

        paintFaceVisibility(dom, state);

        // Watch footswitch for bypass changes
        if (dom.footswitch) {
            var observer = new MutationObserver(function () {
                var s = getState(false);
                if (!s) { return; }
                s.paintedFootswitchOn = null;
                paintFaceVisibility(bindDom(s), s);
            });
            observer.observe(dom.footswitch, { attributes: true, attributeFilter: ['class'] });
            state.footswitchObserver = observer;
        }
        return;
    }

    // -------------------------------------------------------------------------
    // Port events
    // -------------------------------------------------------------------------
    var symbol = event.symbol || (event.port && event.port.symbol);
    var value = (typeof event.value !== 'undefined') ? event.value : (event.port && event.port.value);
    var numericValue = parseFloat(value);
    if (!isFinite(numericValue)) { return; }

    var state = getState(true);
    var dom = bindDom(state);

    if (symbol === 'input_level_db') {
        if (Math.abs(state.inputPendingDb - numericValue) >= INPUT_DB_EPSILON) {
            state.inputPendingDb = numericValue;
            scheduleMeterPaint(state);
        }
        return;
    }

    if (symbol === 'cv_out_meter') {
        if (Math.abs(state.cvPendingValue - numericValue) >= PAINT_EPSILON) {
            state.cvPendingValue = numericValue;
            scheduleMeterPaint(state);
        }
        return;
    }

    if (symbol === 'onset_indicator') {
        // Rising edge only — ignore the plugin's 0 reset
        if (numericValue !== state.lastOnsetCount) {
            state.lastOnsetCount = numericValue;
            flashOnsetLed(dom, state);  // paint LED immediately, no timer
            blinkEyes(dom, state);       // open eyes with their own hold timer
        }
        return;
    }

    if (symbol === 'auto_scale_out') {
        state.lastAutoScale = numericValue;
        return;
    }

    if (symbol === 'auto_offset_out') {
        state.lastAutoOffset = numericValue;
        return;
    }

    // Detect falling edge on auto_normalise (note: TTL symbol uses 's' not 'z').
    // When the user toggles auto-norm off, push the last auto-computed scale and
    // offset back into the input knobs so they reflect what was actually in use.
    // port_set(symbol, value) is a host-injected global in MOD's icon JS context —
    // wrapped in try/catch so a missing or failed API doesn't crash the handler
    // and take the meters down with it.
    if (symbol === 'auto_normalise') {
        if (state.lastAutoNormalize > 0.5 && numericValue < 0.5) {
            showValueOverlay(dom.scaleCvKnob, state.lastAutoScale, state, 'scaleOverlayTimer');
            showValueOverlay(dom.offsetCvKnob, state.lastAutoOffset, state, 'offsetOverlayTimer');
            // the following doesn't work
            // try {
            //     port_set('scale_cv_out', state.lastAutoScale);
            //     port_set('offset_cv_out', state.lastAutoOffset);
            // } catch (e) {
            //     // port_set unavailable or failed — write-back skipped, but
            //     // the rest of the handler continues normally.
            // }
        }
        state.lastAutoNormalize = numericValue;
        return;
    }
}
