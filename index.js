/* ======================================================================
   STORY CLOCK v2 — in-story time that lives inside the messages
   ----------------------------------------------------------------------
   v1 floated a clock bar above the chat and rolled time forward at
   random, so the clock and the scene drifted apart. v2 fixes both:

   1. NO FLOATING BAR. The time is a small chip inside each message,
      next to the sender's name — part of the reply itself.

   2. THE WRITING DECIDES THE TIME. Every message is read for time cues
      in Thai and English and the clock follows what was written. Only
      when a message says nothing about time does it drift forward by a
      few quiet minutes.

   The timeline is recomputed from the messages themselves, so swipes,
   edits and deletions leave the clock consistent with what is on
   screen. Times set by hand are locked and act as anchors.
   ====================================================================== */

(function () {
    'use strict';

    const MODULE = 'storyClock';
    const PROMPT_KEY = 'storyClockTime';
    const META_KEY = 'storyClock';
    const STAMP_KEY = 'storyClock';
    const LOCK_KEY = 'storyClockLocked';

    const DEFAULTS = {
        enabled: true,
        showOnUser: false,
        showDate: true,
        sendToPrompt: true,
        readFromText: true,
        minGap: 2,
        maxGap: 9
    };

    const THAI_DAYS = ['\u0e2d\u0e32\u0e17\u0e34\u0e15\u0e22\u0e4c', '\u0e08\u0e31\u0e19\u0e17\u0e23\u0e4c', '\u0e2d\u0e31\u0e07\u0e04\u0e32\u0e23', '\u0e1e\u0e38\u0e18', '\u0e1e\u0e24\u0e2b\u0e31\u0e2a\u0e1a\u0e14\u0e35', '\u0e28\u0e38\u0e01\u0e23\u0e4c', '\u0e40\u0e2a\u0e32\u0e23\u0e4c'];

    const THAI_MONTHS = [
        '\u0e21.\u0e04.', '\u0e01.\u0e1e.', '\u0e21\u0e35.\u0e04.', '\u0e40\u0e21.\u0e22.', '\u0e1e.\u0e04.', '\u0e21\u0e34.\u0e22.',
        '\u0e01.\u0e04.', '\u0e2a.\u0e04.', '\u0e01.\u0e22.', '\u0e15.\u0e04.', '\u0e1e.\u0e22.', '\u0e18.\u0e04.'
    ];

    const PERIODS = [
        { until: 5,  key: 'latenight', label: '\u0e01\u0e25\u0e32\u0e07\u0e14\u0e36\u0e01',  icon: 'fa-moon' },
        { until: 7,  key: 'dawn',      label: '\u0e23\u0e38\u0e48\u0e07\u0e2a\u0e32\u0e07',   icon: 'fa-cloud-sun' },
        { until: 11, key: 'morning',   label: '\u0e15\u0e2d\u0e19\u0e40\u0e0a\u0e49\u0e32',  icon: 'fa-sun' },
        { until: 13, key: 'noon',      label: '\u0e40\u0e17\u0e35\u0e48\u0e22\u0e07\u0e27\u0e31\u0e19', icon: 'fa-sun' },
        { until: 16, key: 'afternoon', label: '\u0e15\u0e2d\u0e19\u0e1a\u0e48\u0e32\u0e22',  icon: 'fa-sun' },
        { until: 19, key: 'evening',   label: '\u0e15\u0e2d\u0e19\u0e40\u0e22\u0e47\u0e19',  icon: 'fa-cloud-sun' },
        { until: 22, key: 'night',     label: '\u0e15\u0e2d\u0e19\u0e04\u0e48\u0e33',   icon: 'fa-moon' },
        { until: 24, key: 'lateeve',   label: '\u0e14\u0e36\u0e01\u0e41\u0e25\u0e49\u0e27',  icon: 'fa-moon' }
    ];


    /* ============================== helpers ============================== */

    function ctx() {
        return typeof SillyTavern !== 'undefined' &&
            typeof SillyTavern.getContext === 'function'
            ? SillyTavern.getContext()
            : null;
    }

    function settings() {
        const context = ctx();

        if (!context || !context.extensionSettings) {
            return Object.assign({}, DEFAULTS);
        }

        if (!context.extensionSettings[MODULE]) {
            context.extensionSettings[MODULE] = Object.assign({}, DEFAULTS);
        }

        const config = context.extensionSettings[MODULE];

        Object.keys(DEFAULTS).forEach((key) => {
            if (config[key] === undefined) {
                config[key] = DEFAULTS[key];
            }
        });

        return config;
    }

    function saveSettings() {
        const context = ctx();

        if (context && typeof context.saveSettingsDebounced === 'function') {
            context.saveSettingsDebounced();
        }
    }

    function meta() {
        const context = ctx();

        if (!context) {
            return null;
        }

        const store = context.chatMetadata || context.chat_metadata;

        if (!store) {
            return null;
        }

        if (!store[META_KEY]) {
            store[META_KEY] = { seed: null };
        }

        return store[META_KEY];
    }

    function saveMeta() {
        const context = ctx();

        if (!context) {
            return;
        }

        if (typeof context.saveMetadataDebounced === 'function') {
            context.saveMetadataDebounced();
        } else if (typeof context.saveMetadata === 'function') {
            context.saveMetadata();
        }
    }

    function periodFor(date) {
        const hour = date.getHours();

        return PERIODS.find((period) => hour < period.until) ||
            PERIODS[PERIODS.length - 1];
    }

    function formatTime(date) {
        return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    }

    function formatDate(date) {
        return `${THAI_DAYS[date.getDay()]} ${date.getDate()} ${THAI_MONTHS[date.getMonth()]}`;
    }

    function dayNumber(seed, date) {
        if (!seed) {
            return 1;
        }

        const start = new Date(seed);

        const a = new Date(start.getFullYear(), start.getMonth(), start.getDate());
        const b = new Date(date.getFullYear(), date.getMonth(), date.getDate());

        return Math.max(1, Math.round((b - a) / 86400000) + 1);
    }

    // A stable pseudo-random gap: the same message index always gets
    // the same drift, so recomputing the timeline never makes old
    // messages wobble.
    function stableGap(index, min, max) {
        const span = Math.max(1, (max - min) + 1);

        let hash = (index + 1) * 2654435761 % 4294967296;

        hash = (hash ^ (hash >> 13)) >>> 0;

        return min + (hash % span);
    }


    /* ========================= reading the writing ======================= */

    const THAI_NUMBERS = {
        '\u0e2b\u0e19\u0e36\u0e48\u0e07': 1, '\u0e2a\u0e2d\u0e07': 2, '\u0e2a\u0e32\u0e21': 3, '\u0e2a\u0e35\u0e48': 4, '\u0e2b\u0e49\u0e32': 5,
        '\u0e2b\u0e01': 6, '\u0e40\u0e08\u0e47\u0e14': 7, '\u0e41\u0e1b\u0e14': 8, '\u0e40\u0e01\u0e49\u0e32': 9, '\u0e2a\u0e34\u0e1a': 10
    };

    function thaiNumber(token) {
        if (!token) {
            return null;
        }

        const trimmed = String(token).trim();

        if (/^\d+$/.test(trimmed)) {
            return Number(trimmed);
        }

        return THAI_NUMBERS[trimmed] !== undefined
            ? THAI_NUMBERS[trimmed]
            : null;
    }

    const NUM = '(\\d{1,2}|\\u0e2b\\u0e19\\u0e36\\u0e48\\u0e07|\\u0e2a\\u0e2d\\u0e07|\\u0e2a\\u0e32\\u0e21|\\u0e2a\\u0e35\\u0e48|\\u0e2b\\u0e49\\u0e32|\\u0e2b\\u0e01|\\u0e40\\u0e08\\u0e47\\u0e14|\\u0e41\\u0e1b\\u0e14|\\u0e40\\u0e01\\u0e49\\u0e32|\\u0e2a\\u0e34\\u0e1a)';

    // Words that name a part of the day, with the hour they imply.
    const PERIOD_WORDS = [
        { re: /\u0e40\u0e17\u0e35\u0e48\u0e22\u0e07\u0e04\u0e37\u0e19|midnight/i, hour: 0, minute: 10 },
        { re: /\u0e40\u0e0a\u0e49\u0e32\u0e21\u0e37\u0e14|\u0e1f\u0e49\u0e32\u0e2a\u0e32\u0e07|\u0e23\u0e38\u0e48\u0e07\u0e2a\u0e32\u0e07|\u0e43\u0e01\u0e25\u0e49\u0e23\u0e38\u0e48\u0e07|\u0e22\u0e48\u0e33\u0e23\u0e38\u0e48\u0e07|dawn|daybreak/i, hour: 5, minute: 40 },
        { re: /\u0e40\u0e0a\u0e49\u0e32\u0e15\u0e23\u0e39\u0e48|early morning/i, hour: 6, minute: 20 },
        { re: /\u0e15\u0e2d\u0e19\u0e2a\u0e32\u0e22|\u0e2a\u0e32\u0e22\u0e46|\u0e2a\u0e32\u0e22 \u0e46|\u0e2a\u0e32\u0e22\u0e41\u0e01\u0e48|late morning/i, hour: 10, minute: 15 },
        { re: /\u0e40\u0e0a\u0e49\u0e32\u0e19\u0e35\u0e49|\u0e15\u0e2d\u0e19\u0e40\u0e0a\u0e49\u0e32|\u0e22\u0e32\u0e21\u0e40\u0e0a\u0e49\u0e32|\u0e21\u0e37\u0e49\u0e2d\u0e40\u0e0a\u0e49\u0e32|\u0e2d\u0e23\u0e38\u0e13|this morning|in the morning|morning/i, hour: 8, minute: 20 },
        { re: /\u0e40\u0e17\u0e35\u0e48\u0e22\u0e07\u0e27\u0e31\u0e19|\u0e40\u0e17\u0e35\u0e48\u0e22\u0e07\u0e15\u0e23\u0e07|\u0e21\u0e37\u0e49\u0e2d\u0e40\u0e17\u0e35\u0e48\u0e22\u0e07|\u0e15\u0e2d\u0e19\u0e40\u0e17\u0e35\u0e48\u0e22\u0e07|noon|midday/i, hour: 12, minute: 15 },
        { re: /\u0e15\u0e2d\u0e19\u0e1a\u0e48\u0e32\u0e22|\u0e1a\u0e48\u0e32\u0e22\u0e19\u0e35\u0e49|\u0e22\u0e32\u0e21\u0e1a\u0e48\u0e32\u0e22|afternoon/i, hour: 14, minute: 30 },
        { re: /\u0e15\u0e2d\u0e19\u0e40\u0e22\u0e47\u0e19|\u0e40\u0e22\u0e47\u0e19\u0e19\u0e35\u0e49|\u0e22\u0e32\u0e21\u0e40\u0e22\u0e47\u0e19|\u0e41\u0e2a\u0e07\u0e2a\u0e38\u0e14\u0e17\u0e49\u0e32\u0e22|evening|sunset|dusk/i, hour: 17, minute: 40 },
        { re: /\u0e1e\u0e25\u0e1a\u0e04\u0e48\u0e33|\u0e2b\u0e31\u0e27\u0e04\u0e48\u0e33|\u0e40\u0e22\u0e47\u0e19\u0e22\u0e48\u0e33\u0e04\u0e48\u0e33/i, hour: 19, minute: 10 },
        { re: /\u0e15\u0e2d\u0e19\u0e04\u0e48\u0e33|\u0e04\u0e48\u0e33\u0e19\u0e35\u0e49|\u0e21\u0e37\u0e49\u0e2d\u0e40\u0e22\u0e47\u0e19|\u0e21\u0e37\u0e49\u0e2d\u0e04\u0e48\u0e33|\u0e04\u0e37\u0e19\u0e19\u0e35\u0e49|\u0e01\u0e25\u0e32\u0e07\u0e04\u0e37\u0e19|tonight|at night/i, hour: 20, minute: 30 },
        { re: /\u0e14\u0e36\u0e01\u0e41\u0e25\u0e49\u0e27|\u0e14\u0e36\u0e01\u0e21\u0e32\u0e01|\u0e01\u0e25\u0e32\u0e07\u0e14\u0e36\u0e01|late night/i, hour: 23, minute: 20 }
    ];

    // Pulls every time-related hint out of one message.
    function parseCues(rawText) {
        const text = String(rawText || '')
            .replace(/<[^>]*>/g, ' ')
            .replace(/\s+/g, ' ');

        const cues = {
            dayShift: 0,
            hour: null,
            minute: null,
            addMinutes: 0,
            found: false
        };

        if (!text) {
            return cues;
        }

        /* ---------- day jumps ---------- */

        let match = text.match(
            new RegExp(NUM + '\\s*\\u0e27\\u0e31\\u0e19\\s*(?:\\u0e16\\u0e31\\u0e14\\u0e21\\u0e32|\\u0e15\\u0e48\\u0e2d\\u0e21\\u0e32|\\u0e1c\\u0e48\\u0e32\\u0e19\\u0e44\\u0e1b|\\u0e43\\u0e2b\\u0e49\\u0e2b\\u0e25\\u0e31\\u0e07|\\u0e15\\u0e48\\u0e2d\\u0e08\\u0e32\\u0e01\\u0e19\\u0e31\\u0e49\\u0e19)')
        );

        if (match) {
            const days = thaiNumber(match[1]);

            if (days) {
                cues.dayShift += days;
                cues.found = true;
            }
        }

        if (
            !cues.dayShift &&
            /\u0e27\u0e31\u0e19\u0e23\u0e38\u0e48\u0e07\u0e02\u0e36\u0e49\u0e19|\u0e27\u0e31\u0e19\u0e16\u0e31\u0e14\u0e44\u0e1b|\u0e27\u0e31\u0e19\u0e15\u0e48\u0e2d\u0e21\u0e32|\u0e27\u0e31\u0e19\u0e16\u0e31\u0e14\u0e21\u0e32|\u0e40\u0e0a\u0e49\u0e32\u0e27\u0e31\u0e19\u0e43\u0e2b\u0e21\u0e48|next day|next morning|the following day/i.test(text)
        ) {
            cues.dayShift += 1;
            cues.found = true;
        }

        if (/\u0e40\u0e21\u0e37\u0e48\u0e2d\u0e27\u0e32\u0e19|yesterday/i.test(text)) {
            cues.dayShift -= 1;
            cues.found = true;
        }

        match = text.match(
            new RegExp(NUM + '\\s*(?:\\u0e2a\\u0e31\\u0e1b\\u0e14\\u0e32\\u0e2b\\u0e4c|\\u0e2d\\u0e32\\u0e17\\u0e34\\u0e15\\u0e22\\u0e4c)\\s*(?:\\u0e16\\u0e31\\u0e14\\u0e21\\u0e32|\\u0e15\\u0e48\\u0e2d\\u0e21\\u0e32|\\u0e1c\\u0e48\\u0e32\\u0e19\\u0e44\\u0e1b)')
        );

        if (match) {
            const weeks = thaiNumber(match[1]);

            if (weeks) {
                cues.dayShift += weeks * 7;
                cues.found = true;
            }
        } else if (/\u0e2a\u0e31\u0e1b\u0e14\u0e32\u0e2b\u0e4c\u0e15\u0e48\u0e2d\u0e21\u0e32|\u0e2a\u0e31\u0e1b\u0e14\u0e32\u0e2b\u0e4c\u0e16\u0e31\u0e14\u0e21\u0e32|\u0e2d\u0e32\u0e17\u0e34\u0e15\u0e22\u0e4c\u0e16\u0e31\u0e14\u0e21\u0e32|a week later/i.test(text)) {
            cues.dayShift += 7;
            cues.found = true;
        }

        /* ---------- explicit clock times ---------- */

        match = text.match(/(?:^|[^\d])([01]?\d|2[0-3])[:.]([0-5]\d)(?!\d)/);

        if (match) {
            cues.hour = Number(match[1]);
            cues.minute = Number(match[2]);
            cues.found = true;
        }

        // \u0e15\u0e352 / \u0e15\u0e35\u0e2a\u0e2d\u0e07  \u2192  01:00\u201305:00
        if (cues.hour === null) {
            match = text.match(new RegExp('\\u0e15\\u0e35\\s*' + NUM));

            if (match) {
                const hour = thaiNumber(match[1]);

                if (hour >= 1 && hour <= 5) {
                    cues.hour = hour;
                    cues.minute = 0;
                    cues.found = true;
                }
            }
        }

        // \u0e2a\u0e32\u0e21\u0e17\u0e38\u0e48\u0e21  \u2192  21:00
        if (cues.hour === null) {
            match = text.match(new RegExp(NUM + '\\s*\\u0e17\\u0e38\\u0e48\\u0e21'));

            if (match) {
                const hour = thaiNumber(match[1]);

                if (hour >= 1 && hour <= 6) {
                    cues.hour = 18 + hour;
                    cues.minute = 0;
                    cues.found = true;
                }
            }
        }

        // \u0e1a\u0e48\u0e32\u0e22\u0e2a\u0e2d\u0e07\u0e42\u0e21\u0e07  \u2192  14:00
        if (cues.hour === null) {
            match = text.match(new RegExp('\\u0e1a\\u0e48\\u0e32\\u0e22\\s*' + NUM + '\\s*\\u0e42\\u0e21\\u0e07'));

            if (match) {
                const hour = thaiNumber(match[1]);

                if (hour >= 1 && hour <= 5) {
                    cues.hour = 12 + hour;
                    cues.minute = 0;
                    cues.found = true;
                }
            }
        }

        // \u0e40\u0e08\u0e47\u0e14\u0e42\u0e21\u0e07\u0e40\u0e0a\u0e49\u0e32  \u2192  07:00
        if (cues.hour === null) {
            match = text.match(
                new RegExp(NUM + '\\s*\\u0e42\\u0e21\\u0e07(?:\\u0e40\\u0e0a\\u0e49\\u0e32)?')
            );

            if (match) {
                const hour = thaiNumber(match[1]);

                if (hour >= 1 && hour <= 11) {
                    cues.hour = hour;
                    cues.minute = 0;
                    cues.found = true;
                }
            }
        }

        /* ---------- part-of-day words ---------- */

        if (cues.hour === null) {

            for (let index = 0; index < PERIOD_WORDS.length; index += 1) {

                if (PERIOD_WORDS[index].re.test(text)) {
                    cues.hour = PERIOD_WORDS[index].hour;
                    cues.minute = PERIOD_WORDS[index].minute;
                    cues.found = true;
                    break;
                }

            }

        }

        /* ---------- relative jumps ---------- */

        match = text.match(
            new RegExp(NUM + '\\s*(?:\\u0e0a\\u0e31\\u0e48\\u0e27\\u0e42\\u0e21\\u0e07|\\u0e0a\\u0e21\\.)\\s*(?:\\u0e15\\u0e48\\u0e2d\\u0e21\\u0e32|\\u0e16\\u0e31\\u0e14\\u0e21\\u0e32|\\u0e1c\\u0e48\\u0e32\\u0e19\\u0e44\\u0e1b|\\u0e43\\u0e2b\\u0e49\\u0e2b\\u0e25\\u0e31\\u0e07)')
        );

        if (match) {
            const hours = thaiNumber(match[1]);

            if (hours) {
                cues.addMinutes += hours * 60;
                cues.found = true;
            }
        }

        match = text.match(/(\d{1,3})\s*\u0e19\u0e32\u0e17\u0e35\s*(?:\u0e15\u0e48\u0e2d\u0e21\u0e32|\u0e16\u0e31\u0e14\u0e21\u0e32|\u0e1c\u0e48\u0e32\u0e19\u0e44\u0e1b)/);

        if (match) {
            cues.addMinutes += Number(match[1]);
            cues.found = true;
        }

        return cues;
    }

    // Works out the time of one message from the time of the previous
    // one plus whatever its own text says.
    function nextTime(previousTs, rawText, index, config) {
        const date = new Date(previousTs);

        const cues = config.readFromText
            ? parseCues(rawText)
            : { dayShift: 0, hour: null, addMinutes: 0, found: false };

        if (!cues.found) {

            date.setMinutes(
                date.getMinutes() +
                stableGap(index, config.minGap, config.maxGap)
            );

            return date.getTime();

        }

        if (cues.dayShift) {
            date.setDate(date.getDate() + cues.dayShift);
        }

        if (cues.hour !== null) {
            date.setHours(cues.hour, cues.minute || 0, 0, 0);
        }

        if (cues.addMinutes) {
            date.setMinutes(date.getMinutes() + cues.addMinutes);
        }

        // Time only ever runs backwards when the text explicitly said so
        // (\u0e40\u0e21\u0e37\u0e48\u0e2d\u0e27\u0e32\u0e19). A named hour that lands before "now" means the
        // story has crossed midnight into the next day.
        if (date.getTime() <= previousTs && cues.dayShift >= 0) {

            if (cues.hour !== null) {
                date.setDate(date.getDate() + 1);
            } else {
                date.setTime(previousTs + 60000);
            }

        }

        return date.getTime();
    }


    /* ============================== timeline ============================= */

    // The opening message sets the scene, so the clock starts from
    // whatever IT says. Only if it mentions nothing does a sensible
    // default get picked.
    function seedFrom(rawText) {
        const cues = parseCues(rawText);
        const date = new Date();

        if (cues.hour !== null) {
            date.setHours(cues.hour, cues.minute || 0, 0, 0);
        } else {
            date.setHours(9, 15, 0, 0);
        }

        if (cues.dayShift > 0) {
            date.setDate(date.getDate() + cues.dayShift);
        }

        return date.getTime();
    }

    // Rebuilds every message's time from scratch, honouring any times
    // that were locked by hand.
    function recompute() {
        const context = ctx();
        const state = meta();
        const config = settings();

        if (!context || !state || !Array.isArray(context.chat)) {
            return;
        }

        let previous = null;

        context.chat.forEach((message, index) => {

            if (!message) {
                return;
            }

            if (!message.extra || typeof message.extra !== 'object') {
                message.extra = {};
            }

            // A hand-set time is an anchor: it wins, and everything
            // after it continues from there.
            if (
                message.extra[LOCK_KEY] &&
                typeof message.extra[STAMP_KEY] === 'number'
            ) {
                previous = message.extra[STAMP_KEY];
                return;
            }

            if (previous === null) {

                previous = seedFrom(message.mes);
                state.seed = previous;

            } else {

                previous = nextTime(previous, message.mes, index, config);

            }

            message.extra[STAMP_KEY] = previous;

        });

        if (!state.seed && previous !== null) {
            state.seed = previous;
        }

        saveMeta();
    }

    function currentTime() {
        const context = ctx();

        if (!context || !Array.isArray(context.chat)) {
            return null;
        }

        for (let index = context.chat.length - 1; index >= 0; index -= 1) {

            const message = context.chat[index];

            if (
                message &&
                message.extra &&
                typeof message.extra[STAMP_KEY] === 'number'
            ) {
                return message.extra[STAMP_KEY];
            }

        }

        return null;
    }


    /* ============================== prompt =============================== */

    function pushPrompt() {
        const context = ctx();
        const config = settings();
        const state = meta();
        const now = currentTime();

        if (!context || typeof context.setExtensionPrompt !== 'function') {
            return;
        }

        if (!config.enabled || !config.sendToPrompt || !now) {
            context.setExtensionPrompt(PROMPT_KEY, '');
            return;
        }

        const date = new Date(now);
        const period = periodFor(date);

        const text =
            `[\u0e40\u0e27\u0e25\u0e32\u0e43\u0e19\u0e40\u0e23\u0e37\u0e48\u0e2d\u0e07\u0e02\u0e13\u0e30\u0e19\u0e35\u0e49: ${formatTime(date)} \u2014 ${period.label} ` +
            `(${formatDate(date)}, \u0e27\u0e31\u0e19\u0e17\u0e35\u0e48 ${dayNumber(state && state.seed, date)} \u0e02\u0e2d\u0e07\u0e40\u0e23\u0e37\u0e48\u0e2d\u0e07)] ` +
            '\u0e40\u0e02\u0e35\u0e22\u0e19\u0e43\u0e2b\u0e49\u0e2a\u0e2d\u0e14\u0e04\u0e25\u0e49\u0e2d\u0e07\u0e01\u0e31\u0e1a\u0e0a\u0e48\u0e27\u0e07\u0e40\u0e27\u0e25\u0e32\u0e19\u0e35\u0e49 \u0e17\u0e31\u0e49\u0e07\u0e41\u0e2a\u0e07 \u0e2d\u0e32\u0e01\u0e32\u0e28 \u0e04\u0e27\u0e32\u0e21\u0e1e\u0e25\u0e38\u0e01\u0e1e\u0e25\u0e48\u0e32\u0e19\u0e23\u0e2d\u0e1a\u0e15\u0e31\u0e27 ' +
            '\u0e41\u0e25\u0e30\u0e2a\u0e34\u0e48\u0e07\u0e17\u0e35\u0e48\u0e04\u0e19\u0e17\u0e31\u0e48\u0e27\u0e44\u0e1b\u0e17\u0e33\u0e43\u0e19\u0e40\u0e27\u0e25\u0e32\u0e19\u0e35\u0e49 ' +
            '\u0e16\u0e49\u0e32\u0e08\u0e30\u0e02\u0e49\u0e32\u0e21\u0e40\u0e27\u0e25\u0e32\u0e2b\u0e23\u0e37\u0e2d\u0e02\u0e49\u0e32\u0e21\u0e27\u0e31\u0e19 \u0e43\u0e2b\u0e49\u0e40\u0e02\u0e35\u0e22\u0e19\u0e1a\u0e2d\u0e01\u0e44\u0e27\u0e49\u0e43\u0e19\u0e40\u0e19\u0e37\u0e49\u0e2d\u0e40\u0e23\u0e37\u0e48\u0e2d\u0e07\u0e15\u0e23\u0e07 \u0e46 \u0e40\u0e0a\u0e48\u0e19 "\u0e2a\u0e2d\u0e07\u0e0a\u0e31\u0e48\u0e27\u0e42\u0e21\u0e07\u0e15\u0e48\u0e2d\u0e21\u0e32" \u0e2b\u0e23\u0e37\u0e2d "\u0e40\u0e0a\u0e49\u0e32\u0e27\u0e31\u0e19\u0e16\u0e31\u0e14\u0e21\u0e32" ' +
            '\u0e23\u0e30\u0e1a\u0e1a\u0e08\u0e30\u0e2d\u0e48\u0e32\u0e19\u0e02\u0e49\u0e2d\u0e04\u0e27\u0e32\u0e21\u0e19\u0e31\u0e49\u0e19\u0e41\u0e25\u0e49\u0e27\u0e40\u0e25\u0e37\u0e48\u0e2d\u0e19\u0e19\u0e32\u0e2c\u0e34\u0e01\u0e32\u0e43\u0e2b\u0e49\u0e40\u0e2d\u0e07 \u0e2b\u0e49\u0e32\u0e21\u0e2d\u0e49\u0e32\u0e07\u0e2d\u0e34\u0e07\u0e40\u0e27\u0e25\u0e32\u0e08\u0e23\u0e34\u0e07\u0e02\u0e2d\u0e07\u0e1c\u0e39\u0e49\u0e40\u0e25\u0e48\u0e19';

        const positions = context.extension_prompt_types || {};
        const roles = context.extension_prompt_roles || {};

        context.setExtensionPrompt(
            PROMPT_KEY,
            text,
            positions.IN_CHAT !== undefined ? positions.IN_CHAT : 1,
            1,
            false,
            roles.SYSTEM !== undefined ? roles.SYSTEM : 0
        );
    }


    /* ================================ UI ================================= */

    // The chip goes inside the message, beside the sender's name.
    function renderChips() {
        const context = ctx();
        const config = settings();
        const state = meta();

        if (!context || !Array.isArray(context.chat)) {
            return;
        }

        document.querySelectorAll('#chat .mes').forEach((node) => {

            const index = Number(node.getAttribute('mesid'));
            const message = context.chat[index];

            let chip = node.querySelector('.story-clock-chip');

            const wanted =
                config.enabled &&
                message &&
                message.extra &&
                typeof message.extra[STAMP_KEY] === 'number' &&
                (config.showOnUser || !message.is_user);

            if (!wanted) {

                if (chip) {
                    chip.remove();
                }

                return;

            }

            if (!chip) {

                chip = document.createElement('span');
                chip.className = 'story-clock-chip';
                chip.title = '\u0e40\u0e27\u0e25\u0e32\u0e43\u0e19\u0e40\u0e23\u0e37\u0e48\u0e2d\u0e07 \u2014 \u0e01\u0e14\u0e40\u0e1e\u0e37\u0e48\u0e2d\u0e41\u0e01\u0e49\u0e44\u0e02';

                chip.addEventListener('click', (event) => {
                    event.stopPropagation();
                    openChipMenu(chip, index);
                });

                const host =
                    node.querySelector('.ch_name .flex1') ||
                    node.querySelector('.ch_name') ||
                    node.querySelector('.mes_block');

                if (!host) {
                    return;
                }

                host.appendChild(chip);

            }

            const date = new Date(message.extra[STAMP_KEY]);
            const period = periodFor(date);

            chip.dataset.period = period.key;
            chip.classList.toggle('is-locked', !!message.extra[LOCK_KEY]);

            chip.innerHTML = '';

            const icon = document.createElement('i');
            icon.className = `fa-solid ${period.icon}`;

            const time = document.createElement('b');
            time.textContent = formatTime(date);

            const label = document.createElement('span');
            label.textContent = period.label;

            chip.appendChild(icon);
            chip.appendChild(time);
            chip.appendChild(label);

            if (config.showDate) {

                const extra = document.createElement('small');

                extra.textContent =
                    `${formatDate(date)} \u2022 \u0e27\u0e31\u0e19\u0e17\u0e35\u0e48 ${dayNumber(state && state.seed, date)}`;

                chip.appendChild(extra);

            }

        });
    }

    let openMenu = null;

    function closeChipMenu() {
        if (openMenu) {
            openMenu.remove();
            openMenu = null;
        }
    }

    // Tapping a chip lets you pin that message to an exact time. The
    // pinned time becomes an anchor and everything after it shifts to
    // follow.
    function openChipMenu(chip, index) {
        const context = ctx();

        closeChipMenu();

        if (!context || !context.chat || !context.chat[index]) {
            return;
        }

        const message = context.chat[index];
        const date = new Date(message.extra[STAMP_KEY]);

        const menu = document.createElement('div');

        menu.className = 'story-clock-menu';

        menu.innerHTML = `
            <label>\u0e15\u0e31\u0e49\u0e07\u0e40\u0e27\u0e25\u0e32\u0e02\u0e2d\u0e07\u0e02\u0e49\u0e2d\u0e04\u0e27\u0e32\u0e21\u0e19\u0e35\u0e49
                <input type="time" class="story-clock-menu-time" value="${formatTime(date)}" />
            </label>
            <label>\u0e02\u0e22\u0e31\u0e1a\u0e27\u0e31\u0e19 (+/-)
                <input type="number" class="story-clock-menu-days" value="0" min="-30" max="30" />
            </label>
            <div class="story-clock-menu-actions">
                <button type="button" data-action="apply">\u0e15\u0e23\u0e36\u0e07\u0e40\u0e27\u0e25\u0e32\u0e19\u0e35\u0e49</button>
                <button type="button" data-action="unlock">\u0e04\u0e33\u0e19\u0e27\u0e13\u0e43\u0e2b\u0e21\u0e48\u0e08\u0e32\u0e01\u0e40\u0e19\u0e37\u0e49\u0e2d\u0e2b\u0e32</button>
            </div>
        `;

        document.body.appendChild(menu);

        const rect = chip.getBoundingClientRect();

        menu.style.top = `${window.scrollY + rect.bottom + 6}px`;
        menu.style.left = `${Math.max(8, window.scrollX + rect.left)}px`;

        openMenu = menu;

        menu.addEventListener('click', (event) => {

            event.stopPropagation();

            const action = event.target.getAttribute('data-action');

            if (!action) {
                return;
            }

            if (action === 'apply') {

                const value = menu.querySelector('.story-clock-menu-time').value;
                const days = Number(menu.querySelector('.story-clock-menu-days').value) || 0;

                if (value) {

                    const parts = value.split(':');
                    const next = new Date(message.extra[STAMP_KEY]);

                    next.setDate(next.getDate() + days);
                    next.setHours(Number(parts[0]), Number(parts[1]), 0, 0);

                    message.extra[STAMP_KEY] = next.getTime();
                    message.extra[LOCK_KEY] = true;

                }

            }

            if (action === 'unlock') {
                message.extra[LOCK_KEY] = false;
            }

            closeChipMenu();
            refresh();

        });
    }

    document.addEventListener('click', closeChipMenu);


    /* ============================== settings ============================= */

    function buildSettingsPanel() {
        const host =
            document.querySelector('#extensions_settings2') ||
            document.querySelector('#extensions_settings');

        if (!host || document.querySelector('#story-clock-settings')) {
            return;
        }

        const config = settings();

        const panel = document.createElement('div');

        panel.id = 'story-clock-settings';
        panel.className = 'story-clock-settings';

        panel.innerHTML = `
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Story Clock</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <label class="checkbox_label">
                        <input type="checkbox" id="sc-enabled" ${config.enabled ? 'checked' : ''} />
                        <span>\u0e40\u0e1b\u0e34\u0e14\u0e43\u0e0a\u0e49\u0e07\u0e32\u0e19</span>
                    </label>
                    <label class="checkbox_label">
                        <input type="checkbox" id="sc-read" ${config.readFromText ? 'checked' : ''} />
                        <span>\u0e2d\u0e48\u0e32\u0e19\u0e40\u0e27\u0e25\u0e32\u0e08\u0e32\u0e01\u0e40\u0e19\u0e37\u0e49\u0e2d\u0e2b\u0e32\u0e02\u0e49\u0e2d\u0e04\u0e27\u0e32\u0e21</span>
                    </label>
                    <label class="checkbox_label">
                        <input type="checkbox" id="sc-user" ${config.showOnUser ? 'checked' : ''} />
                        <span>\u0e41\u0e2a\u0e14\u0e07\u0e43\u0e19\u0e02\u0e49\u0e2d\u0e04\u0e27\u0e32\u0e21\u0e02\u0e2d\u0e07\u0e40\u0e23\u0e32\u0e14\u0e49\u0e27\u0e22</span>
                    </label>
                    <label class="checkbox_label">
                        <input type="checkbox" id="sc-date" ${config.showDate ? 'checked' : ''} />
                        <span>\u0e41\u0e2a\u0e14\u0e07\u0e27\u0e31\u0e19\u0e17\u0e35\u0e48 / \u0e27\u0e31\u0e19\u0e17\u0e35\u0e48\u0e02\u0e2d\u0e07\u0e40\u0e23\u0e37\u0e48\u0e2d\u0e07</span>
                    </label>
                    <label class="checkbox_label">
                        <input type="checkbox" id="sc-prompt" ${config.sendToPrompt ? 'checked' : ''} />
                        <span>\u0e2a\u0e48\u0e07\u0e40\u0e27\u0e25\u0e32\u0e40\u0e02\u0e49\u0e32\u0e1e\u0e23\u0e2d\u0e21\u0e15\u0e4c\u0e43\u0e2b\u0e49\u0e1a\u0e2d\u0e17\u0e23\u0e39\u0e49</span>
                    </label>

                    <label>\u0e40\u0e27\u0e25\u0e32\u0e17\u0e35\u0e48\u0e40\u0e14\u0e34\u0e19\u0e40\u0e2d\u0e07\u0e40\u0e21\u0e37\u0e48\u0e2d\u0e02\u0e49\u0e2d\u0e04\u0e27\u0e32\u0e21\u0e44\u0e21\u0e48\u0e1a\u0e2d\u0e01\u0e40\u0e27\u0e25\u0e32 (\u0e19\u0e32\u0e17\u0e35)</label>
                    <div class="story-clock-row">
                        <input type="number" id="sc-min" min="0" max="600" value="${config.minGap}" />
                        <span>\u0e16\u0e36\u0e07</span>
                        <input type="number" id="sc-max" min="1" max="600" value="${config.maxGap}" />
                    </div>

                    <div class="story-clock-row">
                        <button type="button" id="sc-recompute" class="menu_button">\u0e04\u0e33\u0e19\u0e27\u0e13\u0e44\u0e17\u0e21\u0e4c\u0e44\u0e25\u0e19\u0e4c\u0e43\u0e2b\u0e21\u0e48\u0e17\u0e31\u0e49\u0e07\u0e2b\u0e21\u0e14</button>
                    </div>
                </div>
            </div>
        `;

        host.appendChild(panel);

        const bind = (id, key, type) => {

            const input = panel.querySelector(id);

            if (!input) {
                return;
            }

            input.addEventListener('change', () => {

                settings()[key] = type === 'bool'
                    ? input.checked
                    : Number(input.value);

                saveSettings();
                refresh();

            });

        };

        bind('#sc-enabled', 'enabled', 'bool');
        bind('#sc-read', 'readFromText', 'bool');
        bind('#sc-user', 'showOnUser', 'bool');
        bind('#sc-date', 'showDate', 'bool');
        bind('#sc-prompt', 'sendToPrompt', 'bool');
        bind('#sc-min', 'minGap', 'num');
        bind('#sc-max', 'maxGap', 'num');

        const reset = panel.querySelector('#sc-recompute');

        if (reset) {

            reset.addEventListener('click', () => {

                const context = ctx();

                if (context && Array.isArray(context.chat)) {

                    context.chat.forEach((message) => {
                        if (message && message.extra) {
                            message.extra[LOCK_KEY] = false;
                        }
                    });

                }

                refresh();

            });

        }
    }


    /* =============================== wiring ============================== */

    function refresh() {
        if (!settings().enabled) {
            document.querySelectorAll('.story-clock-chip')
                .forEach((chip) => chip.remove());

            pushPrompt();
            return;
        }

        recompute();
        renderChips();
        pushPrompt();
    }

    function init() {
        const context = ctx();

        if (!context) {
            setTimeout(init, 800);
            return;
        }

        settings();
        buildSettingsPanel();
        refresh();

        const source = context.eventSource;
        const types = context.event_types || context.eventTypes;

        if (source && types) {

            [
                types.CHAT_CHANGED,
                types.MESSAGE_RECEIVED,
                types.MESSAGE_SENT,
                types.MESSAGE_SWIPED,
                types.MESSAGE_DELETED,
                types.MESSAGE_EDITED,
                types.MESSAGE_UPDATED,
                types.CHARACTER_MESSAGE_RENDERED,
                types.USER_MESSAGE_RENDERED
            ].forEach((type) => {

                if (type) {
                    source.on(type, () => setTimeout(refresh, 40));
                }

            });

        }

        // The chat DOM is rebuilt in ways not every ST version
        // announces, so the chips are re-applied periodically.
        setInterval(renderChips, 2500);

        console.log('[Story Clock] v2 ready');
    }

    init();

})();
