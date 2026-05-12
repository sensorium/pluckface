function(event, funcs) {
    var inputMeter = event.icon.find('.pluckometer-input-meter')[0];
    var cvMeter = event.icon.find('.pluckometer-cv-meter')[0];
    if (!inputMeter && !cvMeter) {
        return;
    }

    var inputSegs = inputMeter ? inputMeter.querySelectorAll('.pluckometer-input-meter-seg') : [];
    var cvSegs = cvMeter ? cvMeter.querySelectorAll('.pluckometer-cv-meter-seg') : [];
    if ((!inputSegs || !inputSegs.length) && (!cvSegs || !cvSegs.length)) {
        return;
    }

    function paint(segs, level) {
        for (var i = 0; i < segs.length; i++) {
            var seg = segs[i];
            var active = i < level;
            seg.classList.toggle('active', active);
            seg.classList.toggle('warn', active && i >= 7 && i < 9);
            seg.classList.toggle('hot', active && i >= 9);
        }
    }

    if (event.type === 'start') {
        if (inputSegs.length) paint(inputSegs, 0);
        if (cvSegs.length) paint(cvSegs, 0);
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
        if (db < -90.0) db = -90.0;
        if (db > 0.0) db = 0.0;

        // Use full meter range so quiet setups still show movement.
        var norm = (db + 90.0) / 90.0;
        if (norm < 0.0) norm = 0.0;
        if (norm > 1.0) norm = 1.0;

        var inputLevel = Math.round(norm * inputSegs.length);
        if (inputSegs.length) paint(inputSegs, inputLevel);
        return;
    }

    if (symbol === 'cv_out_meter') {
        var cv = numericValue;
        if (cv < 0.0) cv = 0.0;
        if (cv > 1.0) cv = 1.0;

        var cvLevel = Math.round(cv * cvSegs.length);
        if (cvSegs.length) paint(cvSegs, cvLevel);
    }
}
