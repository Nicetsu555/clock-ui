/* ======================================================================
   STORY CLOCK — an in-story clock for SillyTavern's main chat
   ----------------------------------------------------------------------
   The clock does NOT follow your computer. It follows the STORY:

   - When a chat starts (first message on screen), the clock picks a
     random plausible time and that becomes "now" for this chat.
   - Every time {{char}} replies, story time moves forward by a random
     gap (a few minutes normally, occasionally a much longer skip), so
     the conversation quietly drifts through the day on its own.
   - Every message remembers the story time it happened at, so the
     clock never jumps around when the chat re-renders, and swipes /
     deletions rewind it correctly.
   - The current story time is injected into the prompt, so {{char}}
     actually knows whether it's 7 in the morning or 2am.

   Everything is stored per chat, inside that chat's own metadata.
   ====================================================================== */

(function () {
    'use strict';

    const MODULE = 'storyClock';
    const PROMPT_KEY = 'storyClockTime';
    const META_KEY = 'storyClock';

    // Defaults, editable from the extension's settings panel.
    const DEFAULTS = {
        enabled: true,
        showBar: true,
        showStamps: true,
        sendToPrompt: true,
        minGap: 3,          // minutes added per reply, low end
        maxGap: 18,         // minutes added per reply, high end
        skipChance: 12,     // % chance a reply jumps much further
        skipMin: 45,        // minutes, long-skip low end
        skipMax: 150        // minutes, long-skip high end
    };

    // Hours the clock is allowed to pick when a brand-new chat starts.
    // Weighted towards waking hours — a story rarely opens at 4am.
    const START_HOURS = [
        7, 8, 9, 9, 10, 10, 11, 12, 13, 14,
        15, 16, 17, 18, 19, 19, 20, 20, 21, 22, 23
    ];

    const THAI_DAYS = [
        'อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ',
        'พฤหัสบดี', 'ศุกร์', 'เสาร์'
    ];

    const THAI_MONTHS = [
        'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
        'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'
    ];

    // Each slice of the day gets its own label, icon and screen tint.
    const PERIODS = [
        { until: 5,  key: 'latenight', label: 'กลางดึก',  icon: 'fa-moon' },
        { until: 7,  key: 'dawn',      label: 'รุ่งสาง',   icon: 'fa-cloud-sun' },
        { until: 11, key: 'morning',   label: 'ตอนเช้า',  icon: 'fa-sun' },
        { until: 13, key: 'noon',      label: 'เที่ยงวัน', icon: 'fa-sun' },
        { until: 16, key: 'afternoon', label: 'ตอนบ่าย',  icon: 'fa-sun' },
        { until: 19, key: 'evening',   label: 'ตอนเย็น',  icon: 'fa-cloud-sun' },
        { until: 22, key: 'night',     label: 'ตอนค่ำ',   icon: 'fa-moon' },
        { until: 24, key: 'lateeve',   label: 'ดึกแล้ว',  icon: 'fa-moon' }
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

        // Fill in anything added by a later version.
        Object.keys(DEFAULTS).forEach((key) => {
            if (context.extensionSettings[MODULE][key] === undefined) {
                context.extensionSettings[MODULE][key] = DEFAULTS[key];
            }
        });

        return context.extensionSettings[MODULE];
    }

    function saveSettings() {
        const context = ctx();

        if (context && typeof context.saveSettingsDebounced === 'function') {
            context.saveSettingsDebounced();
        }
    }

    // Per-chat clock state lives in the chat's own metadata, so every
    // chat (and every branch) keeps its own timeline.
    function meta() {
        const context = ctx();

        if (!context) {
            return null;
        }

        const store =
            context.chatMetadata ||
            context.chat_metadata ||
            null;

        if (!store) {
            return null;
        }

        if (!store[META_KEY]) {
            store[META_KEY] = { start: null, now: null };
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

    function randomInt(min, max) {
        return Math.floor(min + Math.random() * (max - min + 1));
    }

    function periodFor(date) {
        const hour = date.getHours();

        return PERIODS.find((period) => hour < period.until) ||
            PERIODS[PERIODS.length - 1];
    }

    function formatTime(date) {
        const hh = String(date.getHours()).padStart(2, '0');
        const mm = String(date.getMinutes()).padStart(2, '0');

        return `${hh}:${mm}`;
    }

    function formatDate(date) {
        return `${THAI_DAYS[date.getDay()]} ${date.getDate()} ${THAI_MONTHS[date.getMonth()]}`;
    }

    // "Day 1" is the day the chat opened on; every calendar rollover
    // afterwards bumps the counter.
    function dayNumber(state, date) {
        if (!state || !state.start) {
            return 1;
        }

        const start = new Date(state.start);

        const a = new Date(start.getFullYear(), start.getMonth(), start.getDate());
        const b = new Date(date.getFullYear(), date.getMonth(), date.getDate());

        return Math.max(1, Math.round((b - a) / 86400000) + 1);
    }


    /* ============================ clock state ============================ */

    // Picks the random opening time for a chat that doesn't have one.
    function seedClock(state) {
        const base = new Date();

        base.setHours(
            START_HOURS[randomInt(0, START_HOURS.length - 1)],
            randomInt(0, 59),
            0,
            0
        );

        state.start = base.getTime();
        state.now = base.getTime();

        return state;
    }

    // The clock is rebuilt from the messages themselves: whatever the
    // newest stamped message says is "now". That makes swipes, edits
    // and deletions rewind time for free.
    function syncFromChat() {
        const context = ctx();
        const state = meta();

        if (!context || !state || !Array.isArray(context.chat)) {
            return state;
        }

        if (!state.start) {
            seedClock(state);
        }

        let latest = null;

        context.chat.forEach((message) => {
            const at = message &&
                message.extra &&
                message.extra[META_KEY];

            if (typeof at === 'number') {
                latest = at;
            }
        });

        if (latest !== null) {
            state.now = latest;
        }

        // Anything not stamped yet (the first message, imported chats)
        // gets stamped now so it keeps its time from here on.
        stampUnstamped();

        return state;
    }

    function stampUnstamped() {
        const context = ctx();
        const state = meta();

        if (!context || !state || !Array.isArray(context.chat)) {
            return;
        }

        let changed = false;

        context.chat.forEach((message, index) => {
            if (!message) {
                return;
            }

            if (!message.extra || typeof message.extra !== 'object') {
                message.extra = {};
            }

            if (typeof message.extra[META_KEY] === 'number') {
                return;
            }

            // The opening message sits exactly on the start time; later
            // unstamped ones get a small gap each so the order reads
            // naturally instead of everything sharing one minute.
            message.extra[META_KEY] = index === 0
                ? state.start
                : state.now + index * 60000;

            changed = true;
        });

        if (changed) {
            const last = context.chat[context.chat.length - 1];

            if (last && last.extra) {
                state.now = last.extra[META_KEY];
            }

            saveMeta();
        }
    }

    // Moves story time forward by a random gap and stamps the message
    // that caused the move.
    function advance(messageIndex) {
        const context = ctx();
        const state = meta();
        const config = settings();

        if (!context || !state) {
            return;
        }

        if (!state.start) {
            seedClock(state);
        }

        const longSkip = randomInt(1, 100) <= config.skipChance;

        const gap = longSkip
            ? randomInt(config.skipMin, config.skipMax)
            : randomInt(config.minGap, config.maxGap);

        state.now = state.now + gap * 60000;

        const message = context.chat && context.chat[messageIndex];

        if (message) {
            if (!message.extra || typeof message.extra !== 'object') {
                message.extra = {};
            }

            message.extra[META_KEY] = state.now;
        }

        saveMeta();
        render();
        pushPrompt();
    }

    // Manual jumps from the bar (+1 ชม. / เช้าวันถัดไป / ตั้งเวลาเอง).
    function jump(minutes) {
        const state = meta();

        if (!state) {
            return;
        }

        if (!state.start) {
            seedClock(state);
        }

        state.now = state.now + minutes * 60000;

        stampLast();
        saveMeta();
        render();
        pushPrompt();
    }

    function jumpToNextMorning() {
        const state = meta();

        if (!state) {
            return;
        }

        const next = new Date(state.now);

        next.setDate(next.getDate() + 1);
        next.setHours(randomInt(6, 8), randomInt(0, 59), 0, 0);

        state.now = next.getTime();

        stampLast();
        saveMeta();
        render();
        pushPrompt();
    }

    function setExact(hours, minutes, addDays) {
        const state = meta();

        if (!state) {
            return;
        }

        const next = new Date(state.now);

        if (addDays) {
            next.setDate(next.getDate() + addDays);
        }

        next.setHours(hours, minutes, 0, 0);

        state.now = next.getTime();

        stampLast();
        saveMeta();
        render();
        pushPrompt();
    }

    // Keeps the newest message in step with a manual jump, so the bar
    // and the message stamps never disagree.
    function stampLast() {
        const context = ctx();
        const state = meta();

        if (!context || !state || !Array.isArray(context.chat)) {
            return;
        }

        const last = context.chat[context.chat.length - 1];

        if (!last) {
            return;
        }

        if (!last.extra || typeof last.extra !== 'object') {
            last.extra = {};
        }

        last.extra[META_KEY] = state.now;
    }


    /* ============================== prompt =============================== */

    // What {{char}} is told about the time. Short on purpose — one
    // system line, at the bottom of the prompt where it stays fresh.
    function pushPrompt() {
        const context = ctx();
        const state = meta();
        const config = settings();

        if (!context || typeof context.setExtensionPrompt !== 'function') {
            return;
        }

        if (!config.enabled || !config.sendToPrompt || !state || !state.now) {
            context.setExtensionPrompt(PROMPT_KEY, '');
            return;
        }

        const date = new Date(state.now);
        const period = periodFor(date);

        const text =
            `[เวลาในเรื่องตอนนี้: ${formatTime(date)} — ${period.label} ` +
            `(${formatDate(date)}, วันที่ ${dayNumber(state, date)} ของเรื่อง)] ` +
            'ให้บทสนทนาและบรรยายสอดคล้องกับช่วงเวลานี้ เช่น แสง อากาศ ความง่วง ' +
            'กิจกรรมที่คนทั่วไปทำในเวลานี้ ห้ามพูดถึงเวลาอื่นที่ขัดกัน และห้ามอ้างอิงเวลาจริงของผู้เล่น';

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

    let bar = null;
    let editor = null;

    function buildBar() {
        if (bar) {
            return bar;
        }

        const sheld = document.querySelector('#sheld');

        if (!sheld) {
            return null;
        }

        bar = document.createElement('div');
        bar.id = 'story-clock-bar';

        bar.innerHTML = `
            <div class="story-clock-main" id="story-clock-main">
                <i class="fa-solid fa-sun story-clock-icon" id="story-clock-icon"></i>
                <strong id="story-clock-time">--:--</strong>
                <span class="story-clock-period" id="story-clock-period"></span>
            </div>

            <div class="story-clock-meta" id="story-clock-meta"></div>

            <div class="story-clock-actions">
                <button type="button" id="story-clock-hour" title="เดินเวลาไป 1 ชั่วโมง">+1 ชม.</button>
                <button type="button" id="story-clock-morning" title="ข้ามไปเช้าวันถัดไป">เช้าวันถัดไป</button>
                <button type="button" id="story-clock-edit" title="ตั้งเวลาเอง"><i class="fa-solid fa-pen"></i></button>
            </div>

            <div class="story-clock-editor" id="story-clock-editor">
                <label>ตั้งเวลา
                    <input type="time" id="story-clock-input" />
                </label>
                <label>ข้ามไป (วัน)
                    <input type="number" id="story-clock-days" value="0" min="0" max="30" />
                </label>
                <div class="story-clock-editor-actions">
                    <button type="button" id="story-clock-apply">ตกลง</button>
                    <button type="button" id="story-clock-reroll">สุ่มใหม่</button>
                </div>
            </div>
        `;

        sheld.insertBefore(bar, sheld.firstChild);

        editor = bar.querySelector('#story-clock-editor');

        bar.querySelector('#story-clock-hour')
            .addEventListener('click', () => jump(60));

        bar.querySelector('#story-clock-morning')
            .addEventListener('click', jumpToNextMorning);

        bar.querySelector('#story-clock-edit')
            .addEventListener('click', () => {
                editor.classList.toggle('open');
            });

        bar.querySelector('#story-clock-apply')
            .addEventListener('click', () => {
                const value = bar.querySelector('#story-clock-input').value;
                const days = Number(bar.querySelector('#story-clock-days').value) || 0;

                if (!value) {
                    return;
                }

                const parts = value.split(':');

                setExact(Number(parts[0]), Number(parts[1]), days);

                editor.classList.remove('open');
            });

        bar.querySelector('#story-clock-reroll')
            .addEventListener('click', () => {
                const state = meta();

                if (!state) {
                    return;
                }

                seedClock(state);
                stampLast();
                saveMeta();
                render();
                pushPrompt();

                editor.classList.remove('open');
            });

        return bar;
    }

    function render() {
        const config = settings();
        const state = meta();

        const element = config.enabled && config.showBar
            ? buildBar()
            : bar;

        if (!element) {
            return;
        }

        element.style.display =
            config.enabled && config.showBar ? '' : 'none';

        if (!state || !state.now) {
            return;
        }

        const date = new Date(state.now);
        const period = periodFor(date);

        element.dataset.period = period.key;

        element.querySelector('#story-clock-time').textContent =
            formatTime(date);

        element.querySelector('#story-clock-period').textContent =
            period.label;

        element.querySelector('#story-clock-icon').className =
            `fa-solid ${period.icon} story-clock-icon`;

        element.querySelector('#story-clock-meta').textContent =
            `${formatDate(date)} • วันที่ ${dayNumber(state, date)} ของเรื่อง`;

        const input = element.querySelector('#story-clock-input');

        if (input) {
            input.value = formatTime(date);
        }

        renderStamps();
    }

    // Small story-time label under each message. Purely cosmetic — the
    // real value lives in the message's own extra data.
    function renderStamps() {
        const context = ctx();
        const config = settings();

        if (!context || !Array.isArray(context.chat)) {
            return;
        }

        document.querySelectorAll('#chat .mes').forEach((node) => {
            const index = Number(node.getAttribute('mesid'));
            const message = context.chat[index];

            let stamp = node.querySelector('.story-clock-stamp');

            if (
                !config.enabled ||
                !config.showStamps ||
                !message ||
                !message.extra ||
                typeof message.extra[META_KEY] !== 'number'
            ) {
                if (stamp) {
                    stamp.remove();
                }

                return;
            }

            if (!stamp) {
                stamp = document.createElement('div');
                stamp.className = 'story-clock-stamp';

                const body = node.querySelector('.mes_text') || node;

                body.appendChild(stamp);
            }

            const date = new Date(message.extra[META_KEY]);

            stamp.textContent =
                `${formatTime(date)} • ${periodFor(date).label}`;
        });
    }


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
                        <span>เปิดใช้งาน</span>
                    </label>
                    <label class="checkbox_label">
                        <input type="checkbox" id="sc-bar" ${config.showBar ? 'checked' : ''} />
                        <span>แสดงแถบนาฬิกาด้านบน</span>
                    </label>
                    <label class="checkbox_label">
                        <input type="checkbox" id="sc-stamps" ${config.showStamps ? 'checked' : ''} />
                        <span>แสดงเวลาใต้ข้อความ</span>
                    </label>
                    <label class="checkbox_label">
                        <input type="checkbox" id="sc-prompt" ${config.sendToPrompt ? 'checked' : ''} />
                        <span>ส่งเวลาเข้าพรอมต์ให้บอทรู้</span>
                    </label>

                    <label>เวลาที่เดินต่อหนึ่งตา (นาที)</label>
                    <div class="story-clock-row">
                        <input type="number" id="sc-min" min="0" max="600" value="${config.minGap}" />
                        <span>ถึง</span>
                        <input type="number" id="sc-max" min="1" max="600" value="${config.maxGap}" />
                    </div>

                    <label>โอกาสข้ามเวลานาน ๆ (%)</label>
                    <input type="number" id="sc-skip" min="0" max="100" value="${config.skipChance}" />
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
                const value = type === 'bool'
                    ? input.checked
                    : Number(input.value);

                settings()[key] = value;

                saveSettings();
                render();
                pushPrompt();
            });
        };

        bind('#sc-enabled', 'enabled', 'bool');
        bind('#sc-bar', 'showBar', 'bool');
        bind('#sc-stamps', 'showStamps', 'bool');
        bind('#sc-prompt', 'sendToPrompt', 'bool');
        bind('#sc-min', 'minGap', 'num');
        bind('#sc-max', 'maxGap', 'num');
        bind('#sc-skip', 'skipChance', 'num');
    }


    /* =============================== wiring ============================== */

    function onChatChanged() {
        syncFromChat();
        render();
        pushPrompt();
    }

    function onMessageReceived(index) {
        // A reply is what moves story time forward.
        advance(
            typeof index === 'number'
                ? index
                : (ctx()?.chat?.length ?? 1) - 1
        );
    }

    function onMessageSent(index) {
        // {{user}}'s own message doesn't move the clock — it just gets
        // stamped with the time it was sent at.
        const context = ctx();
        const state = meta();

        if (!context || !state) {
            return;
        }

        const message = context.chat &&
            context.chat[typeof index === 'number' ? index : context.chat.length - 1];

        if (message) {
            if (!message.extra || typeof message.extra !== 'object') {
                message.extra = {};
            }

            message.extra[META_KEY] = state.now;
        }

        saveMeta();
        render();
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
        syncFromChat();
        render();
        pushPrompt();

        const source = context.eventSource;
        const types = context.event_types || context.eventTypes;

        if (source && types) {
            source.on(types.CHAT_CHANGED, onChatChanged);
            source.on(types.MESSAGE_RECEIVED, onMessageReceived);
            source.on(types.MESSAGE_SENT, onMessageSent);

            [
                types.MESSAGE_SWIPED,
                types.MESSAGE_DELETED,
                types.MESSAGE_EDITED,
                types.CHARACTER_MESSAGE_RENDERED,
                types.USER_MESSAGE_RENDERED
            ].forEach((type) => {
                if (type) {
                    source.on(type, () => {
                        syncFromChat();
                        render();
                        pushPrompt();
                    });
                }
            });
        }

        // Safety net: the chat DOM gets rebuilt in ways not every ST
        // version announces, so the stamps are refreshed periodically.
        setInterval(renderStamps, 3000);

        console.log('[Story Clock] ready');
    }

    init();

})();
