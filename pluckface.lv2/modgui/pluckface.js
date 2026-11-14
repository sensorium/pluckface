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
    var KNOB_SPRITE_FRAMES = 60;
    var SCALE_CV_MIN = 0.0;
    var SCALE_CV_MAX = 0.5;
    var OFFSET_CV_MIN = -2.0;
    var OFFSET_CV_MAX = 1.0;
    var GRAPH_SPAN_MS = 20000;      // timeline length
    var GRAPH_SAMPLE_MS = 100;      // matches the plugin's 10 Hz publish rate
    var GRAPH_YMAX = 10.0;          // fixed top of the count axis
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
                paintedInputLevel: null,
                paintedCvLevel: null,
                paintedBlinkActive: null,
                paintedFootswitchOn: null,
                footswitchObserver: null,
                lastOnsetCount: 0.0,
                dom: null,
                lastAutoNormalize: 0.0,
                lastAutoScale: 1.0,
                lastAutoOffset: 0.0,
                scaleOverlayTimer: null,
                offsetOverlayTimer: null,
                graphMode: false,
                graphTimer: null,
                graphSamples: [],     // {t, win, integ, mix, cv}, sample-and-hold at 10 Hz
                graphOnsets: [],      // onset arrival times (ms)
                winLevel: 0.0,
                integLevel: 0.0,
                mixLevel: 0.0,
                cvLevel: 0.0,
                windowSeconds: 3.0
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
            inputLeds: inputMeter ? inputMeter.querySelector('.pluckface-input-meter-leds') : null,
            cvLeds: cvMeter ? cvMeter.querySelector('.pluckface-cv-meter-leds') : null,
            onsetLed: icon.find('.pluckface-onset-led')[0] || null,
            faceEyes: icon.find('.pluckface-face-eyes')[0] || null,
            face: icon.find('.pluckface-face')[0] || null,
            viewToggle: icon.find('.pluckface-view-toggle')[0] || null,
            graph: icon.find('.pluckface-graph')[0] || null,
            footswitch: icon.find('.mod-footswitch')[0] || null,
            scaleCvKnob: icon.find('.pluckface-scale-cv-knob')[0] || null,
            offsetCvKnob: icon.find('.pluckface-offset-cv-knob')[0] || null,
            scaleCvGlow: icon.find('.pluckface-scale-cv-knob .pluckface-knob-glow-overlay')[0] || null,
            offsetCvGlow: icon.find('.pluckface-offset-cv-knob .pluckface-knob-glow-overlay')[0] || null
        };
        return state.dom;
    }

    function hasRenderableUi(dom) {
        return !!(dom.inputLeds || dom.cvLeds || dom.onsetLed || dom.faceEyes || dom.face);
    }

    // -------------------------------------------------------------------------
    // Meter paint — called on a throttled timer, handles input + cv meters only
    // -------------------------------------------------------------------------
    function paintMeters(dom, state) {
        if (dom.inputLeds) {
            var db = Math.min(Math.max(state.inputPendingDb, -90.0), 0.0);
            var inputNorm = (db + 90.0) / 90.0;
            var inputLevel = Math.round(inputNorm * 6);
            if (state.paintedInputLevel !== inputLevel) {
                state.paintedInputLevel = inputLevel;
                dom.inputLeds.style.setProperty('--input-meter-level', String(inputLevel));
            }
        }
        if (dom.cvLeds) {
            var cv = Math.min(Math.max(state.cvPendingValue, 0.0), 1.0);
            var cvLevel = Math.round(cv * 10);
            if (state.paintedCvLevel !== cvLevel) {
                state.paintedCvLevel = cvLevel;
                dom.cvLeds.style.setProperty('--cv-meter-level', String(cvLevel));
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
        if (dom.viewToggle) { dom.viewToggle.classList.toggle('pedal-off', !isOn); }
        if (dom.faceEyes) { dom.faceEyes.classList.toggle('pedal-off', !isOn); }
    }

    // -------------------------------------------------------------------------
    // Knob glow overlay — briefly shows the glow sprite at a value-matched
    // frame on auto-norm toggle-off.
    // -------------------------------------------------------------------------
    var OVERLAY_HOLD_MS = 5500;   // visible time before fade begins
    var OVERLAY_FADE_MS = 500;    // CSS transition duration

    function clamp(value, minValue, maxValue) {
        return Math.min(Math.max(value, minValue), maxValue);
    }

    function normalizeToUnitRange(value, minValue, maxValue) {
        if (maxValue <= minValue) { return 0.0; }
        return (clamp(value, minValue, maxValue) - minValue) / (maxValue - minValue);
    }

    function frameForNormalizedValue(normalizedValue) {
        var frameCount = KNOB_SPRITE_FRAMES;
        var clamped = clamp(normalizedValue, 0.0, 1.0);
        return Math.round(clamped * (frameCount - 1));
    }

    function showKnobGlowOverlay(knobEl, glowEl, normalizedValue, state, timerKey) {
        if (!knobEl || !glowEl) { return; }
        if (state[timerKey]) { clearTimeout(state[timerKey]); state[timerKey] = null; }

        var frameIndex = frameForNormalizedValue(normalizedValue);
        var knobImageEl = knobEl.querySelector('.mod-knob-image');
        var frameWidthPx = (knobImageEl && (knobImageEl.clientWidth || knobImageEl.offsetWidth)) || 40;
        glowEl.style.setProperty('--glow-x', String(-frameIndex * frameWidthPx) + 'px');
        glowEl.classList.add('active');

        // After hold period, trigger CSS fade then remove
        state[timerKey] = setTimeout(function () {
            state[timerKey] = null;
            glowEl.classList.remove('active');
        }, OVERLAY_HOLD_MS);
    }


    // -------------------------------------------------------------------------
    // Level graph — alternative to the face. Values arrive at 10 Hz; they are
    // sampled on a fixed timer and joined with straight lines.
    // -------------------------------------------------------------------------
    var GRAPH_COLORS = {
        win: '#4dd0e1',
        integ: '#ffb74d',
        mix: '#ffffff',
        cv: '#81c784'
    };

    function sampleGraph(state) {
        var now = Date.now();
        state.graphSamples.push({
            t: now,
            win: state.winLevel,
            integ: state.integLevel,
            mix: state.mixLevel,
            cv: state.cvLevel
        });
        var cutoff = now - GRAPH_SPAN_MS - GRAPH_SAMPLE_MS;
        while (state.graphSamples.length && state.graphSamples[0].t < cutoff) { state.graphSamples.shift(); }
        while (state.graphOnsets.length && state.graphOnsets[0] < cutoff) { state.graphOnsets.shift(); }
        if (state.graphMode) { drawGraph(bindDom(state), state, now); }
    }

    function startGraphTimer(state) {
        if (state.graphTimer) { return; }
        state.graphTimer = setInterval(function () {
            var s = getState(false);
            if (s) { sampleGraph(s); }
        }, GRAPH_SAMPLE_MS);
    }

    function drawGraph(dom, state, now) {
        var canvas = dom.graph;
        if (!canvas) { return; }
        var ctx = canvas.getContext('2d');
        if (!ctx) { return; }
        var W = canvas.width, H = canvas.height;
        var left = 26, right = W - 6, top = 22, bottom = H - 30;
        var pw = right - left, ph = bottom - top;
        var samples = state.graphSamples;

        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = 'rgba(18,18,22,0.92)';
        ctx.fillRect(0, 0, W, H);

        var yMax = GRAPH_YMAX;

        function xOf(t) { return right - (now - t) / GRAPH_SPAN_MS * pw; }
        function yUnit(v) { return bottom - Math.min(Math.max(v, 0), 1) * ph; }
        function yCount(v) { return bottom - Math.min(v / yMax, 1) * ph; }

        // Grid and axis labels
        ctx.lineWidth = 1;
        ctx.font = '9px sans-serif';
        ctx.fillStyle = '#888';
        ctx.strokeStyle = 'rgba(255,255,255,0.12)';
        ctx.textAlign = 'right';
        for (var g = 0; g <= 4; g++) {
            var gy = Math.round(bottom - g / 4 * ph) + 0.5;
            ctx.beginPath(); ctx.moveTo(left, gy); ctx.lineTo(right, gy); ctx.stroke();
            ctx.fillText((yMax * g / 4).toFixed(1), left - 3, gy + 3);
        }
        ctx.textAlign = 'center';
        for (var sec = 0; sec <= 20; sec += 5) {
            var gx = Math.round(right - sec * 1000 / GRAPH_SPAN_MS * pw) + 0.5;
            ctx.fillText(sec === 0 ? 'now' : '-' + sec + 's', gx, bottom + 11);
        }

        // Window length marker
        var wx = Math.max(left, right - state.windowSeconds * 1000 / GRAPH_SPAN_MS * pw);
        ctx.strokeStyle = GRAPH_COLORS.win;
        ctx.globalAlpha = 0.6;
        ctx.beginPath(); ctx.moveTo(wx, top - 5.5); ctx.lineTo(right, top - 5.5);
        ctx.moveTo(wx, top - 9); ctx.lineTo(wx, top - 2); ctx.stroke();
        ctx.globalAlpha = 1;

        // Clip lines to the plot area
        ctx.save();
        ctx.beginPath(); ctx.rect(left, top - 2, pw, ph + 4); ctx.clip();

        function line(key, yFn, color, width) {
            if (samples.length < 2) { return; }
            ctx.strokeStyle = color;
            ctx.lineWidth = width;
            ctx.beginPath();
            for (var k = 0; k < samples.length; k++) {
                var x = xOf(samples[k].t), y = yFn(samples[k][key]);
                if (k === 0) { ctx.moveTo(x, y); } else { ctx.lineTo(x, y); }
            }
            ctx.stroke();
        }
        ctx.globalAlpha = 0.55;
        line('cv', yUnit, GRAPH_COLORS.cv, 1.5);
        ctx.globalAlpha = 1;
        line('win', yCount, GRAPH_COLORS.win, 1.5);
        line('integ', yCount, GRAPH_COLORS.integ, 1.5);
        line('mix', yCount, GRAPH_COLORS.mix, 2);

        // Onset ticks
        ctx.strokeStyle = 'rgba(255,255,255,0.7)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (var o = 0; o < state.graphOnsets.length; o++) {
            var ox = Math.round(xOf(state.graphOnsets[o])) + 0.5;
            ctx.moveTo(ox, bottom - 8); ctx.lineTo(ox, bottom);
        }
        ctx.stroke();
        ctx.restore();

        // Legend
        var items = [['Window', GRAPH_COLORS.win], ['Integrator', GRAPH_COLORS.integ],
                     ['Mix', GRAPH_COLORS.mix], ['CV 0-1', GRAPH_COLORS.cv]];
        ctx.textAlign = 'left';
        var lx = left;
        for (var n = 0; n < items.length; n++) {
            ctx.fillStyle = items[n][1];
            ctx.fillRect(lx, 4, 8, 3);
            ctx.fillStyle = '#ccc';
            ctx.fillText(items[n][0], lx + 11, 9);
            lx += 14 + ctx.measureText(items[n][0]).width + 6;
        }
        ctx.fillStyle = '#888';
        ctx.textAlign = 'right';
        ctx.fillText('window ' + state.windowSeconds.toFixed(1) + 's', right, 17);
        ctx.textAlign = 'left';
        ctx.fillText('onsets', left, H - 3);
    }

    function setGraphMode(dom, state, on) {
        state.graphMode = on;
        if (dom.face) { dom.face.classList.toggle('graph-mode', on); }
        if (dom.viewToggle) { dom.viewToggle.classList.toggle('graph-mode', on); }
        if (on) { drawGraph(dom, state, Date.now()); }
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
            if (oldState.graphTimer) { clearInterval(oldState.graphTimer); }
            if (oldState.scaleOverlayTimer) { clearTimeout(oldState.scaleOverlayTimer); }
            if (oldState.offsetOverlayTimer) { clearTimeout(oldState.offsetOverlayTimer); }
            if (oldState.footswitchObserver) { oldState.footswitchObserver.disconnect(); }
        }
        icon.removeData(UI_STATE_KEY);

        var state = getState(true);
        var dom = bindDom(state);
        if (!hasRenderableUi(dom)) { return; }

        // Reset meters
        if (dom.inputLeds) { dom.inputLeds.style.setProperty('--input-meter-level', '0'); }
        if (dom.cvLeds) { dom.cvLeds.style.setProperty('--cv-meter-level', '0'); }

        // Reset LED — write 0 once at startup so the CSS fallback doesn't show
        // if (dom.onsetLed) { dom.onsetLed.style.setProperty('--onset-intensity', '0'); }

        // Reset eyes
        if (dom.faceEyes) { dom.faceEyes.classList.remove('active'); }
        if (dom.scaleCvGlow) { dom.scaleCvGlow.classList.remove('active'); }
        if (dom.offsetCvGlow) { dom.offsetCvGlow.classList.remove('active'); }

        paintFaceVisibility(dom, state);
        startGraphTimer(state);
        if (dom.viewToggle) {
            // Keep presses here from starting a pedal drag in the host UI.
            ['mousedown', 'touchstart'].forEach(function (name) {
                dom.viewToggle.addEventListener(name, function (e) { e.stopPropagation(); });
            });
            dom.viewToggle.addEventListener('click', function () {
                var s = getState(false);
                if (!s) { return; }
                setGraphMode(bindDom(s), s, !s.graphMode);
            });
        }

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
            state.graphOnsets.push(Date.now());
            flashOnsetLed(dom, state);  // paint LED immediately, no timer
            blinkEyes(dom, state);       // open eyes with their own hold timer
        }
        return;
    }

    if (symbol === 'window_level') { state.winLevel = numericValue; return; }
    if (symbol === 'integrator_level') { state.integLevel = numericValue; return; }
    if (symbol === 'cv_level') { state.cvLevel = numericValue; return; }
    if (symbol === 'metric_level') { state.mixLevel = numericValue; return; }
    if (symbol === 'window_seconds') { state.windowSeconds = numericValue; return; }

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
            showKnobGlowOverlay(
                dom.scaleCvKnob,
                dom.scaleCvGlow,
                normalizeToUnitRange(state.lastAutoScale, SCALE_CV_MIN, SCALE_CV_MAX),
                state,
                'scaleOverlayTimer'
            );
            showKnobGlowOverlay(
                dom.offsetCvKnob,
                dom.offsetCvGlow,
                normalizeToUnitRange(state.lastAutoOffset, OFFSET_CV_MIN, OFFSET_CV_MAX),
                state,
                'offsetOverlayTimer'
            );
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
