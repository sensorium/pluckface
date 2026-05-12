function(event, funcs) {
    var meter = event.icon.find('.pluckometer-input-meter')[0];
    if (!meter) {
        return;
    }

    var segs = meter.querySelectorAll('.pluckometer-input-meter-seg');
    if (!segs || !segs.length) {
        return;
    }

    function paint(level) {
        for (var i = 0; i < segs.length; i++) {
            var seg = segs[i];
            var active = i < level;
            seg.classList.toggle('active', active);
            seg.classList.toggle('warn', active && i >= 7 && i < 9);
            seg.classList.toggle('hot', active && i >= 9);
        }
    }

    if (event.type === 'start') {
        paint(0);
        return;
    }

    if (event.symbol === 'input_level_db') {
        var db = event.value;
        if (db < -90.0) db = -90.0;
        if (db > 0.0) db = 0.0;

        // Focus visual response on practical guitar range: -70 dB to -20 dB.
        var norm = (db + 70.0) / 50.0;
        if (norm < 0.0) norm = 0.0;
        if (norm > 1.0) norm = 1.0;

        var level = Math.round(norm * segs.length);
        paint(level);
    }
}
