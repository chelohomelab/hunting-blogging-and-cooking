// Hunt logbook — list + new/edit entry form. Deliberately standalone, same pattern as
// hunting.js. The offline write-queue below is what makes "log a hunt with zero cell signal"
// actually work: GPS and moon-phase are pure client-side computations (no network needed at
// all), and a new/updated entry that can't reach the server is queued in localStorage and
// flushed automatically once connectivity returns. Single writer, single device — no conflict
// resolution needed (see docs/VISION.md's offline-first architecture notes).
//
// Scope note: only NEW entries and EDITS are queueable offline. Loading an existing entry to
// edit still requires a live fetch — editing a past entry while genuinely offline in the field
// is not the scenario this was built for (that's logging a new hunt), so it's left online-only
// rather than adding a full offline read-cache for it here.

function toggleUserMenu(id) {
    const menu = document.getElementById(id);
    const arrow = document.getElementById(id + '-arrow');
    if (!menu) return;
    const isOpen = !menu.classList.contains('hidden');
    menu.classList.toggle('hidden');
    if (arrow) arrow.style.transform = isOpen ? '' : 'rotate(180deg)';
}
['user-menu', 'mobile-user-menu'].forEach(id => {
    document.addEventListener('click', e => {
        const menu = document.getElementById(id);
        if (menu && !menu.classList.contains('hidden') && !menu.parentElement.contains(e.target)) {
            menu.classList.add('hidden');
            const arrow = document.getElementById(id + '-arrow');
            if (arrow) arrow.style.transform = '';
        }
    });
});

function openMobileNav() {
    const d = document.getElementById('mobile-nav-drawer');
    d.classList.remove('hidden');
    d.classList.add('flex', 'flex-col');
    document.getElementById('mobile-nav-overlay').classList.remove('hidden');
}
function closeMobileNav() {
    const d = document.getElementById('mobile-nav-drawer');
    d.classList.add('hidden');
    d.classList.remove('flex', 'flex-col');
    document.getElementById('mobile-nav-overlay').classList.add('hidden');
}

// ── Moon phase — pure calculation, no API/connectivity ever needed ─────────────────────────

const MOON_PHASES = ['New Moon', 'Waxing Crescent', 'First Quarter', 'Waxing Gibbous',
    'Full Moon', 'Waning Gibbous', 'Last Quarter', 'Waning Crescent'];

function moonPhaseFor(dateStr) {
    // dateStr is "YYYY-MM-DD"; noon UTC avoids timezone edge-cases shifting the date by a day.
    const [y, m, d] = dateStr.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    const knownNewMoon = Date.UTC(2000, 0, 6, 18, 14, 0);
    const synodicMonthMs = 29.53058867 * 86400000;
    let phase = ((date.getTime() - knownNewMoon) % synodicMonthMs) / synodicMonthMs;
    if (phase < 0) phase += 1;
    return MOON_PHASES[Math.floor(phase * 8 + 0.5) % 8];
}

// ── Auto-draft narrative — turns the structured fields into a starting paragraph, purely from
// what's already on the form (no API call, works offline same as the rest of this form) ──────

function draftNarrative() {
    const val = id => (document.getElementById(id).value || '').trim();
    const date = val('f-date');
    const location = val('f-location-label');
    const gameType = val('f-game-type');
    const species = val('f-species');
    const weapon = val('f-weapon');
    const temp = val('f-temp');
    const conditions = val('f-conditions');
    const windDir = val('f-wind-dir');
    const windSpeed = val('f-wind-speed');
    const moonPhase = (document.getElementById('moon-phase-display').textContent || '').trim();
    const harvested = document.getElementById('f-harvested').checked;
    const harvestNotes = val('f-harvest-notes');

    const dateLabel = date
        ? new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
        : 'a recent outing';
    const quarry = species || gameType;
    const showBothNames = species && gameType && species.toLowerCase() !== gameType.toLowerCase();

    const sentences = [];

    let opener = `Headed out${location ? ' to ' + location : ''} on ${dateLabel}`;
    if (quarry) opener += ` for ${quarry}${showBothNames ? ' (' + gameType + ')' : ''}`;
    sentences.push(opener + '.');

    const conditionBits = [];
    if (conditions) conditionBits.push(conditions.toLowerCase());
    if (temp) conditionBits.push(`${temp}°F`);
    if (windDir || windSpeed) conditionBits.push(`wind ${windSpeed ? windSpeed + ' mph ' : ''}out of the ${windDir || 'unknown direction'}`.trim());
    if (conditionBits.length) {
        sentences.push(`Conditions were ${conditionBits.join(', ')}${moonPhase && moonPhase !== '—' ? `, under a ${moonPhase.toLowerCase()}` : ''}.`);
    } else if (moonPhase && moonPhase !== '—') {
        sentences.push(`It was a ${moonPhase.toLowerCase()}.`);
    }

    if (weapon) sentences.push(`Hunting with ${weapon}.`);

    if (harvested) {
        sentences.push(`Successfully harvested${species ? ' the ' + species.toLowerCase() : ''} this time.`);
        if (harvestNotes) sentences.push(harvestNotes);
    } else {
        sentences.push('No harvest this time, but a good day in the field.');
    }

    return sentences.join(' ');
}

// ── Offline write-queue (localStorage — text-only entries, well within its size limits) ────

const QUEUE_KEY = 'hbc_logbook_queue';
// Set right before navigating to /logbook/new to resume editing a not-yet-synced entry (see
// loadLogbookList's pending-item click handling below) — a localStorage handoff rather than a
// URL query string, so the page actually navigated to is exactly '/logbook/new' with no query
// string, matching what the service worker already has cached for offline use. A query string
// would be a cache-key miss (see static/sw.js's per-URL cache matching) and fail to load at all
// while offline — exactly the scenario this needs to work in.
const RESUME_PENDING_KEY = 'hbc_logbook_resume_pending';

function getQueue() {
    try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return []; }
}
function saveQueue(q) {
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch { /* storage unavailable — queue is best-effort */ }
}
function queueCount() { return getQueue().length; }

// The service worker (static/sw.js) serves hbc-data entries stale-while-revalidate: a cached GET
// is returned instantly, with a background fetch refreshing the cache for next time. That's fast,
// but without this, your OWN just-made write wouldn't show up until that next background refresh
// — deleting the relevant cache entries here means the very next load has nothing cached for
// them, so it falls through to a real, immediate network fetch instead. Cache name is
// hardcoded to match DATA_CACHE in sw.js (no clean way to share a constant across those two
// worlds) — keep them in sync if that ever changes.
async function invalidateCache(urls) {
    try {
        const cache = await caches.open('hbc-data');
        await Promise.all(urls.map(u => cache.delete(u)));
    } catch { /* Cache Storage unavailable — the next background refresh will still catch up. */ }
}

// Tries the network first; if it's unreachable, queues the write instead of failing outright.
// existingLocalId, when set, means this is an edit of an entry that's already sitting in the
// queue from an earlier offline save — update it in place instead of pushing a second, duplicate
// queue entry. invalidateUrls lists the GET endpoints this write affects (defaults to just
// `url`) — see invalidateCache() above. Returns { ok, queued, data }.
async function submitEntry(payload, method, url, existingLocalId = null, invalidateUrls = null) {
    try {
        const res = await fetch(url, {
            method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        });
        if (res.ok) {
            // Connectivity came back between opening this edit and saving it — the entry is
            // about to be created for real, so drop the now-superseded queued copy.
            if (existingLocalId) saveQueue(getQueue().filter(item => item.localId !== existingLocalId));
            await invalidateCache(invalidateUrls || [url]);
            return { ok: true, queued: false, data: await res.json() };
        }
        return { ok: false, queued: false, error: await res.text() };
    } catch {
        const q = getQueue();
        if (existingLocalId) {
            const idx = q.findIndex(item => item.localId === existingLocalId);
            if (idx !== -1) {
                q[idx] = { ...q[idx], payload };
                saveQueue(q);
                return { ok: true, queued: true };
            }
        }
        q.push({ localId: 'pending-' + Date.now() + '-' + Math.random().toString(36).slice(2), method, url, payload });
        saveQueue(q);
        return { ok: true, queued: true };
    }
}

async function flushQueue() {
    const q = getQueue();
    if (!q.length) return { flushed: 0, remaining: 0 };
    const remaining = [];
    let flushed = 0;
    for (const item of q) {
        try {
            const res = await fetch(item.url, {
                method: item.method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(item.payload),
            });
            if (res.ok) flushed++; else remaining.push(item);
        } catch {
            remaining.push(item); // still offline — keep it queued
        }
    }
    saveQueue(remaining);
    return { flushed, remaining: remaining.length };
}

window.addEventListener('online', () => { flushQueue().then(updatePendingBadge); });

function updatePendingBadge() {
    const badge = document.getElementById('pending-sync-badge');
    if (!badge) return;
    const n = queueCount();
    badge.classList.toggle('hidden', n === 0);
    const countEl = document.getElementById('pending-count');
    if (countEl) countEl.textContent = n;
}

// ── Logbook list page ───────────────────────────────────────────────────────────────────────

function fmtDate(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

async function loadLogbookList() {
    const list = document.getElementById('logbook-list');
    if (!list) return;
    let entries = [];
    try {
        const res = await fetch('/api/logbook');
        entries = await res.json();
    } catch {
        list.innerHTML = '<div class="text-center text-gray-500 text-sm py-10">Can\'t reach the server — showing anything queued locally only.</div>';
    }
    const pending = getQueue().map(q => ({ ...q.payload, _pending: true, _localId: q.localId }));
    const all = [...pending, ...entries];

    document.getElementById('logbook-empty').classList.toggle('hidden', all.length > 0);
    if (!all.length) { list.innerHTML = ''; return; }

    // Pending (not-yet-synced) entries have no real id yet, so they render as plain divs — not
    // <a> links — and are made clickable via the delegated listener below instead, which routes
    // through RESUME_PENDING_KEY so the edit form can be reopened with the queued data.
    list.innerHTML = all.map(e => {
        const isTrip = (e.day_count || 0) > 0;
        const tag = e._pending ? 'div' : 'a';
        const href = isTrip ? `/logbook/trip/${e.id}` : `/logbook/${e.id}`;
        const hrefAttr = e._pending ? '' : `href="${href}"`;
        const resumeAttr = e._pending ? `data-resume-pending="${e._localId}"` : '';
        const titleLine = isTrip
            ? `${(e.scheduled_hunt && e.scheduled_hunt.label) || e.location_label || 'Trip'}`
            : `${fmtDate(e.hunt_date)}${e.location_label ? ' — ' + e.location_label : ''}`;
        const dayBadge = isTrip ? `<span class="text-[10px] font-bold bg-blue-900/60 text-blue-300 px-2 py-0.5 rounded">🏕️ ${e.day_count} day${e.day_count === 1 ? '' : 's'}</span>` : '';
        return `
        <${tag} ${hrefAttr} ${resumeAttr} class="block bg-gray-800 rounded-lg border border-gray-700 shadow-xl p-4 space-y-1.5 transition hover:border-orange-500/40 cursor-pointer">
            <div class="flex items-center justify-between gap-2 flex-wrap">
                <div class="text-sm font-bold text-orange-400">${titleLine}</div>
                <div class="flex items-center gap-2">
                    ${e._pending ? '<span class="text-[10px] font-bold bg-yellow-900/60 text-yellow-300 px-2 py-0.5 rounded">⏳ Pending sync</span>' : ''}
                    ${dayBadge}
                    ${e.harvested ? '<span class="text-[10px] font-bold bg-orange-900/60 text-orange-300 px-2 py-0.5 rounded">🏹 Harvest</span>' : ''}
                </div>
            </div>
            <div class="text-xs text-gray-400">${[e.game_type, e.species, e.weapon].filter(Boolean).join(' · ') || '—'}</div>
            ${!isTrip ? `<div class="text-xs text-gray-500">${[e.weather_conditions, e.weather_temp_f != null ? e.weather_temp_f + '°F' : null, e.wind_direction ? 'wind ' + e.wind_direction : null, e.moon_phase].filter(Boolean).join(' · ')}</div>` : ''}
            ${e.narrative ? `<p class="text-sm text-gray-300 mt-1 line-clamp-3">${e.narrative}</p>` : ''}
            ${(e.media && e.media.length) ? `<div class="flex gap-1.5 mt-1">${
                e.media.slice(0, 4).map(m => m.media_type === 'video'
                    ? `<div class="w-12 h-12 rounded bg-gray-900 flex items-center justify-center text-lg">🎬</div>`
                    : `<img src="${m.file_path}" class="w-12 h-12 object-cover rounded">`
                ).join('')
            }${e.media.length > 4 ? `<div class="w-12 h-12 rounded bg-gray-900 flex items-center justify-center text-xs text-gray-400">+${e.media.length - 4}</div>` : ''}</div>` : ''}
        </${tag}>
    `;
    }).join('');
}

document.addEventListener('click', e => {
    const el = e.target.closest('[data-resume-pending]');
    if (!el) return;
    localStorage.setItem(RESUME_PENDING_KEY, el.dataset.resumePending);
    window.location.href = '/logbook/new';
});

// ── Weather auto-fill — same idea as "Use My Location": one tap fills in fields you'd
// otherwise type by hand, using coordinates already captured for the entry. Unlike location,
// this genuinely needs a live connection (there's no on-device weather sensor), so it's an
// optional convenience on top of manual entry, not a replacement for it. Open-Meteo (no API key,
// CORS-enabled for direct browser use) — the forecast endpoint covers the recent past (up to 92
// days) and near-future; anything older goes to the historical archive endpoint instead, since
// the forecast endpoint doesn't retain data that far back.
const WEATHER_CODE_TO_CONDITION = {
    0: 'Clear', 1: 'Partly Cloudy', 2: 'Partly Cloudy', 3: 'Cloudy',
    45: 'Fog', 48: 'Fog',
    51: 'Rain', 53: 'Rain', 55: 'Rain', 56: 'Rain', 57: 'Rain',
    61: 'Rain', 63: 'Rain', 65: 'Rain', 66: 'Rain', 67: 'Rain',
    71: 'Snow', 73: 'Snow', 75: 'Snow', 77: 'Snow',
    80: 'Rain', 81: 'Rain', 82: 'Rain',
    85: 'Snow', 86: 'Snow',
    95: 'Rain', 96: 'Rain', 99: 'Rain',
};

function degToCompass(deg) {
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return dirs[Math.round(deg / 45) % 8];
}

// Picks the forecast endpoint for dates within the last 90 days (or in the future — it also
// serves a 16-day forecast), and the historical archive endpoint for anything older.
function weatherApiBase(dateStr) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const [y, m, d] = dateStr.split('-').map(Number);
    const target = new Date(y, m - 1, d);
    const daysAgo = Math.round((today - target) / 86400000);
    return daysAgo <= 90
        ? 'https://api.open-meteo.com/v1/forecast'
        : 'https://archive-api.open-meteo.com/v1/archive';
}

// Throws on any failure (offline, bad response, date outside the archive's coverage) — caller
// shows a status message either way, matching the pattern used elsewhere in this file rather
// than swallowing errors here.
async function fillWeatherFromApi(lat, lng, dateStr, period) {
    const hour = period === 'evening' ? '17:00' : '07:00';
    const base = weatherApiBase(dateStr);
    const url = `${base}?latitude=${lat}&longitude=${lng}&start_date=${dateStr}&end_date=${dateStr}` +
        `&hourly=temperature_2m,weathercode,windspeed_10m,winddirection_10m` +
        `&temperature_unit=fahrenheit&windspeed_unit=mph&timezone=auto`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('weather request failed');
    const data = await res.json();
    const idx = (data.hourly && data.hourly.time || []).indexOf(`${dateStr}T${hour}`);
    if (idx === -1) throw new Error('no hourly data for that date/hour');
    document.getElementById('f-temp').value = Math.round(data.hourly.temperature_2m[idx]);
    document.getElementById('f-conditions').value = WEATHER_CODE_TO_CONDITION[data.hourly.weathercode[idx]] || '';
    document.getElementById('f-wind-dir').value = degToCompass(data.hourly.winddirection_10m[idx]);
    document.getElementById('f-wind-speed').value = Math.round(data.hourly.windspeed_10m[idx]);
}

// ── Logbook entry form (new + edit) ─────────────────────────────────────────────────────────

function initLogbookForm(entryId) {
    const form = document.getElementById('logbook-form');
    if (!form) return;

    // Resuming a not-yet-synced entry for editing — see RESUME_PENDING_KEY's comment above and
    // the click handler in loadLogbookList(). Only relevant on /logbook/new (entryId is null);
    // /logbook/{id}/edit always means a real, already-synced entry.
    let editingLocalId = null;
    let editingQueueItem = null;
    if (!entryId) {
        const resumeId = localStorage.getItem(RESUME_PENDING_KEY);
        if (resumeId) {
            localStorage.removeItem(RESUME_PENDING_KEY);
            editingQueueItem = getQueue().find(item => item.localId === resumeId) || null;
            if (editingQueueItem) editingLocalId = resumeId;
        }
    }

    const dateInput = document.getElementById('f-date');
    const moonDisplay = document.getElementById('moon-phase-display');
    function recomputeMoon() {
        if (!dateInput.value) return;
        const phase = moonPhaseFor(dateInput.value);
        moonDisplay.textContent = phase;
        document.getElementById('f-moon-phase').value = phase;
    }
    dateInput.addEventListener('change', recomputeMoon);
    if (!dateInput.value) dateInput.value = new Date().toISOString().slice(0, 10);
    recomputeMoon();

    document.getElementById('f-harvested').addEventListener('change', e => {
        document.getElementById('harvest-notes-wrap').classList.toggle('hidden', !e.target.checked);
    });

    document.getElementById('btn-locate').addEventListener('click', () => {
        const status = document.getElementById('loc-status');
        if (!navigator.geolocation) { status.textContent = 'Geolocation not supported on this device.'; return; }
        status.textContent = 'Getting location…';
        navigator.geolocation.getCurrentPosition(
            pos => {
                document.getElementById('f-lat').value = pos.coords.latitude;
                document.getElementById('f-lng').value = pos.coords.longitude;
                status.textContent = `📍 ${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}`;
            },
            err => { status.textContent = `Couldn't get location: ${err.message}`; },
            { enableHighAccuracy: true, timeout: 15000 }
        );
    });

    const huntPeriodSelect = document.getElementById('f-hunt-period');
    if (huntPeriodSelect && !huntPeriodSelect.value) {
        huntPeriodSelect.value = new Date().getHours() < 12 ? 'morning' : 'evening';
    }
    const btnWeather = document.getElementById('btn-weather');
    if (btnWeather) {
        btnWeather.addEventListener('click', async () => {
            const status = document.getElementById('weather-status');
            const lat = document.getElementById('f-lat').value;
            const lng = document.getElementById('f-lng').value;
            const date = dateInput.value;
            if (!lat || !lng) { status.textContent = "No location captured yet — tap 'Use My Location' above first."; return; }
            if (!date) { status.textContent = 'Pick a date first.'; return; }
            const period = huntPeriodSelect.value;
            status.textContent = 'Getting weather…';
            try {
                await fillWeatherFromApi(lat, lng, date, period);
                status.textContent = `✓ ${period === 'evening' ? 'Evening' : 'Morning'} weather filled in — double-check it against what you actually saw.`;
            } catch {
                status.textContent = "Couldn't get weather — you appear to be offline, or that date isn't available.";
            }
        });
    }

    // ── Media (photos/video) — online-only, see the HuntLogMedia comment in database.py ────
    const mediaGrid = document.getElementById('media-grid');
    function mediaItemHtml(m) {
        const inner = m.media_type === 'video'
            ? `<video src="${m.file_path}" controls class="w-full h-28 object-cover rounded-lg bg-black"></video>`
            : `<img src="${m.file_path}" class="w-full h-28 object-cover rounded-lg">`;
        return `<div class="relative group" data-media-id="${m.id}">${inner}
            <button type="button" data-delete-media="${m.id}" class="absolute top-1 right-1 bg-red-900/80 hover:bg-red-800 text-white text-xs w-6 h-6 rounded-full opacity-0 group-hover:opacity-100 transition cursor-pointer">×</button>
        </div>`;
    }
    function renderMediaGrid(mediaList) {
        if (mediaGrid) mediaGrid.innerHTML = (mediaList || []).map(mediaItemHtml).join('');
    }
    if (mediaGrid) {
        mediaGrid.addEventListener('click', async e => {
            const btn = e.target.closest('[data-delete-media]');
            if (!btn || !entryId) return;
            if (!confirm('Remove this photo/video?')) return;
            try {
                await fetch(`/api/logbook/${entryId}/media/${btn.dataset.deleteMedia}`, { method: 'DELETE' });
                await invalidateCache(['/api/logbook', `/api/logbook/${entryId}`]);
                btn.closest('[data-media-id]')?.remove();
            } catch {
                alert("Couldn't delete — you appear to be offline.");
            }
        });
    }
    const mediaFileInput = document.getElementById('media-file-input');
    if (mediaFileInput) {
        mediaFileInput.addEventListener('change', async e => {
            const files = Array.from(e.target.files);
            e.target.value = '';
            for (const file of files) {
                const fd = new FormData();
                fd.append('file', file);
                try {
                    const res = await fetch(`/api/logbook/${entryId}/media`, { method: 'POST', body: fd });
                    if (res.ok) {
                        await invalidateCache(['/api/logbook', `/api/logbook/${entryId}`]);
                        mediaGrid.insertAdjacentHTML('beforeend', mediaItemHtml(await res.json()));
                    } else {
                        const err = await res.json().catch(() => ({}));
                        alert(`Upload failed: ${err.detail || 'unknown error'}`);
                    }
                } catch {
                    alert("Couldn't upload — you appear to be offline. Try again once you're back in range.");
                }
            }
        });
    }

    document.getElementById('btn-draft').addEventListener('click', () => {
        const textarea = document.getElementById('f-narrative');
        textarea.value = (textarea.value ? textarea.value + '\n\n' : '') + draftNarrative();
        textarea.focus();
    });

    function populateFormFields(e) {
        dateInput.value = e.hunt_date;
        recomputeMoon();
        document.getElementById('f-location-label').value = e.location_label || '';
        if (e.latitude != null) document.getElementById('f-lat').value = e.latitude;
        if (e.longitude != null) document.getElementById('f-lng').value = e.longitude;
        if (e.latitude != null) document.getElementById('loc-status').textContent = `📍 ${e.latitude.toFixed(5)}, ${e.longitude.toFixed(5)}`;
        document.getElementById('f-game-type').value = e.game_type || '';
        document.getElementById('f-species').value = e.species || '';
        document.getElementById('f-weapon').value = e.weapon || '';
        document.getElementById('f-temp').value = e.weather_temp_f ?? '';
        document.getElementById('f-conditions').value = e.weather_conditions || '';
        document.getElementById('f-wind-dir').value = e.wind_direction || '';
        document.getElementById('f-wind-speed').value = e.wind_speed_mph ?? '';
        document.getElementById('f-harvested').checked = !!e.harvested;
        document.getElementById('harvest-notes-wrap').classList.toggle('hidden', !e.harvested);
        document.getElementById('f-harvest-notes').value = e.harvest_notes || '';
        document.getElementById('f-narrative').value = e.narrative || '';
    }

    if (entryId || editingLocalId) {
        document.getElementById('btn-delete').classList.remove('hidden');
        document.getElementById('btn-delete').addEventListener('click', async () => {
            if (!confirm('Delete this logbook entry? This cannot be undone.')) return;
            if (editingLocalId) {
                // Only ever sat in the local queue — nothing to delete server-side.
                saveQueue(getQueue().filter(item => item.localId !== editingLocalId));
                window.location.href = '/logbook';
                return;
            }
            try {
                await fetch(`/api/logbook/${entryId}`, { method: 'DELETE' });
                await invalidateCache(['/api/logbook', `/api/logbook/${entryId}`]);
                window.location.href = '/logbook';
            } catch {
                document.getElementById('form-status').textContent = 'Could not delete — you appear to be offline.';
            }
        });
    }

    if (entryId) {
        (async () => {
            try {
                const res = await fetch(`/api/logbook/${entryId}`);
                if (!res.ok) throw new Error();
                const e = await res.json();
                populateFormFields(e);
                renderMediaGrid(e.media);
            } catch {
                document.getElementById('form-status').textContent = "Couldn't load this entry — you appear to be offline. Editing existing entries needs a connection.";
                form.querySelectorAll('input, select, textarea, button').forEach(el => el.disabled = true);
            }
        })();
    } else if (editingQueueItem) {
        populateFormFields(editingQueueItem.payload);
        document.getElementById('form-status').textContent = '⏳ Editing an entry that hasn\'t synced yet — changes are saved back to this device until you\'re back in range.';
    }

    form.addEventListener('submit', async e => {
        e.preventDefault();
        const payload = {
            hunt_date: dateInput.value,
            location_label: document.getElementById('f-location-label').value || null,
            latitude: document.getElementById('f-lat').value ? parseFloat(document.getElementById('f-lat').value) : null,
            longitude: document.getElementById('f-lng').value ? parseFloat(document.getElementById('f-lng').value) : null,
            game_type: document.getElementById('f-game-type').value || null,
            species: document.getElementById('f-species').value || null,
            weapon: document.getElementById('f-weapon').value || null,
            weather_temp_f: document.getElementById('f-temp').value ? parseFloat(document.getElementById('f-temp').value) : null,
            weather_conditions: document.getElementById('f-conditions').value || null,
            wind_direction: document.getElementById('f-wind-dir').value || null,
            wind_speed_mph: document.getElementById('f-wind-speed').value ? parseFloat(document.getElementById('f-wind-speed').value) : null,
            moon_phase: document.getElementById('f-moon-phase').value || null,
            harvested: document.getElementById('f-harvested').checked,
            harvest_notes: document.getElementById('f-harvest-notes').value || null,
            narrative: document.getElementById('f-narrative').value || null,
        };
        const status = document.getElementById('form-status');
        status.textContent = 'Saving…';
        const method = entryId ? 'PUT' : 'POST';
        const url = entryId ? `/api/logbook/${entryId}` : '/api/logbook';
        const invalidateUrls = entryId ? ['/api/logbook', url] : ['/api/logbook'];
        const result = await submitEntry(payload, method, url, editingLocalId, invalidateUrls);
        if (result.queued) {
            status.textContent = "📥 Saved offline — no signal right now, this'll sync automatically once you're back in range.";
            setTimeout(() => { window.location.href = '/logbook'; }, 1500);
        } else if (result.ok) {
            // New entries land on their own edit page so photos/video can be attached right
            // away; edits just go back to the list since media's already there to manage.
            window.location.href = (!entryId && result.data) ? `/logbook/${result.data.id}/edit` : '/logbook';
        } else {
            status.textContent = 'Failed to save: ' + (result.error || 'unknown error');
        }
    });
}

// ── Logbook entry view (read-only "notebook page") ──────────────────────────────────────────

async function initLogbookView(entryId) {
    const box = document.getElementById('notebook-content');
    if (!box) return;
    document.getElementById('edit-link').href = `/logbook/${entryId}/edit`;

    let e;
    try {
        const res = await fetch(`/api/logbook/${entryId}`);
        if (!res.ok) throw new Error();
        e = await res.json();
    } catch {
        box.innerHTML = '<div class="text-center text-sm py-8 opacity-70">Couldn\'t load this entry — you appear to be offline.</div>';
        return;
    }

    const metaLine1 = [e.game_type, e.species, e.weapon].filter(Boolean).join(' · ');
    const metaLine2 = [e.weather_conditions, e.weather_temp_f != null ? e.weather_temp_f + '°F' : null,
        e.wind_direction ? 'wind ' + e.wind_direction + (e.wind_speed_mph ? ' ' + e.wind_speed_mph + 'mph' : '') : null,
        e.moon_phase].filter(Boolean).join(' · ');

    box.innerHTML = `
        <div class="text-2xl font-extrabold leading-tight">${fmtDate(e.hunt_date)}${e.location_label ? ' — ' + e.location_label : ''}</div>
        ${e.harvested ? '<div class="text-sm font-extrabold uppercase tracking-wide mt-1" style="color:#7a2f00">🏹 Harvest</div>' : ''}
        ${metaLine1 ? `<div class="text-lg mt-2 font-bold">${metaLine1}</div>` : ''}
        ${metaLine2 ? `<div class="text-base mt-0.5 font-semibold" style="color:#3a2a18">${metaLine2}</div>` : ''}
        ${e.harvest_notes ? `<p class="text-lg mt-3 font-semibold">${e.harvest_notes}</p>` : ''}
        ${e.narrative ? `<p class="text-lg mt-4 whitespace-pre-wrap leading-relaxed font-semibold">${e.narrative}</p>` : '<p class="text-lg mt-4 italic font-semibold" style="color:#3a2a18">No story written yet.</p>'}
        ${(e.media && e.media.length) ? `<div class="grid grid-cols-2 gap-2 mt-3">${
            e.media.map(m => m.media_type === 'video'
                ? `<video src="${m.file_path}" controls class="w-full rounded shadow"></video>`
                : `<img src="${m.file_path}" class="w-full rounded shadow object-cover cursor-pointer" onclick="window.open('${m.file_path}', '_blank')">`
            ).join('')
        }</div>` : ''}
    `;
}

// ── Trip entries — a multi-day hunt logged against a Scheduled Hunt (see database.py's
// ScheduledHunt/HuntLogDay docstrings and docs/VISION.md's 2026-09-23 discussion). Creating the
// trip itself (via "Log this hunt" on the Hunting page) needs a connection, but every day added
// after that reuses the exact same submitEntry()/flushQueue() offline queue as a normal entry —
// it doesn't care what shape the payload is, only that it's a {method, url, payload} triple.

let _tripEntryId = null;
let _tripDays = [];

function _dayIdFromQueueUrl(url) {
    const m = url.match(/\/days\/(\d+)/);
    return m ? Number(m[1]) : null;
}

function tripPendingDays(entryId) {
    const re = new RegExp(`^/api/logbook/${entryId}/days`);
    return getQueue()
        .filter(q => re.test(q.url))
        .map(q => ({ ...q.payload, _pending: true, _localId: q.localId, _isUpdate: q.method === 'PUT', _updateUrl: q.url }));
}

function mediaItemHtmlForDay(m) {
    const inner = m.media_type === 'video'
        ? `<video src="${m.file_path}" controls class="w-full h-28 object-cover rounded-lg bg-black"></video>`
        : `<img src="${m.file_path}" class="w-full h-28 object-cover rounded-lg">`;
    return `<div class="relative group" data-media-id="${m.id}">${inner}
        <button type="button" data-delete-day-media="${m.id}" class="absolute top-1 right-1 bg-red-900/80 hover:bg-red-800 text-white text-xs w-6 h-6 rounded-full opacity-0 group-hover:opacity-100 transition cursor-pointer">×</button>
    </div>`;
}

async function initTripForm(entryId) {
    _tripEntryId = entryId;
    let e;
    try {
        const res = await fetch(`/api/logbook/${entryId}`);
        if (!res.ok) throw new Error();
        e = await res.json();
    } catch {
        document.getElementById('trip-plan-label').textContent = "Couldn't load this trip — you appear to be offline and it hasn't been viewed here before.";
        return;
    }

    document.getElementById('trip-view-link').href = `/logbook/trip/${entryId}`;
    document.getElementById('trip-plan-label').textContent = e.scheduled_hunt
        ? `${e.scheduled_hunt.label} · ${fmtDate(e.scheduled_hunt.start_date)} – ${fmtDate(e.scheduled_hunt.end_date)}`
        : 'Trip (no longer linked to a scheduled hunt plan)';
    document.getElementById('trip-location').value = e.location_label || '';
    document.getElementById('trip-narrative').value = e.narrative || '';
    _tripDays = e.days || [];
    renderTripDaysList();

    document.getElementById('day-date').addEventListener('change', recomputeDayMoon);

    document.getElementById('day-btn-locate').addEventListener('click', () => {
        const status = document.getElementById('day-loc-status');
        if (!navigator.geolocation) { status.textContent = 'GPS not available on this device/browser.'; return; }
        status.textContent = 'Getting location…';
        navigator.geolocation.getCurrentPosition(
            pos => {
                document.getElementById('day-lat').value = pos.coords.latitude;
                document.getElementById('day-lng').value = pos.coords.longitude;
                status.textContent = `📍 ${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}`;
            },
            () => { status.textContent = 'Could not get location — GPS may be off, or permission denied.'; },
            { enableHighAccuracy: true, timeout: 15000 }
        );
    });

    document.getElementById('day-harvested').addEventListener('change', ev => {
        document.getElementById('day-harvest-notes-wrap').classList.toggle('hidden', !ev.target.checked);
    });

    document.getElementById('day-btn-draft').addEventListener('click', () => {
        const textarea = document.getElementById('day-narrative');
        textarea.value = (textarea.value ? textarea.value + '\n\n' : '') + draftDayNarrative();
        textarea.focus();
    });

    document.getElementById('day-media-grid').addEventListener('click', async ev => {
        const btn = ev.target.closest('[data-delete-day-media]');
        const dayId = document.getElementById('day-id').value;
        if (!btn || !dayId) return;
        if (!confirm('Remove this photo/video?')) return;
        try {
            await fetch(`/api/logbook/${entryId}/days/${dayId}/media/${btn.dataset.deleteDayMedia}`, { method: 'DELETE' });
            await invalidateCache(['/api/logbook', `/api/logbook/${entryId}`]);
            btn.closest('[data-media-id]')?.remove();
            const d = _tripDays.find(x => x.id === Number(dayId));
            if (d) d.media = (d.media || []).filter(m => m.id !== Number(btn.dataset.deleteDayMedia));
        } catch {
            alert("Couldn't delete — you appear to be offline.");
        }
    });

    document.getElementById('day-media-file-input').addEventListener('change', async ev => {
        const dayId = document.getElementById('day-id').value;
        const files = Array.from(ev.target.files);
        ev.target.value = '';
        if (!dayId) return;
        const grid = document.getElementById('day-media-grid');
        for (const file of files) {
            const fd = new FormData();
            fd.append('file', file);
            try {
                const res = await fetch(`/api/logbook/${entryId}/days/${dayId}/media`, { method: 'POST', body: fd });
                if (res.ok) {
                    await invalidateCache(['/api/logbook', `/api/logbook/${entryId}`]);
                    const m = await res.json();
                    grid.insertAdjacentHTML('beforeend', mediaItemHtmlForDay(m));
                    const d = _tripDays.find(x => x.id === Number(dayId));
                    if (d) { d.media = d.media || []; d.media.push(m); }
                } else {
                    const err = await res.json().catch(() => ({}));
                    alert(`Upload failed: ${err.detail || 'unknown error'}`);
                }
            } catch {
                alert("Couldn't upload — you appear to be offline. Try again once you're back in range.");
            }
        }
    });

    document.getElementById('day-btn-delete').addEventListener('click', async () => {
        const dayId = document.getElementById('day-id').value;
        if (!dayId || !confirm('Delete this day? This cannot be undone.')) return;
        try {
            await fetch(`/api/logbook/${entryId}/days/${dayId}`, { method: 'DELETE' });
            await invalidateCache(['/api/logbook', `/api/logbook/${entryId}`]);
        } catch {
            alert("Couldn't delete — you appear to be offline.");
            return;
        }
        _tripDays = _tripDays.filter(d => d.id !== Number(dayId));
        hideDayForm();
        renderTripDaysList();
    });

    document.getElementById('trip-btn-summary').addEventListener('click', () => {
        document.getElementById('trip-narrative').value = generateTripSummary();
    });
}

function renderTripDaysList() {
    const list = document.getElementById('days-list');
    if (!list) return;
    const pending = tripPendingDays(_tripEntryId);
    const pendingEditDayIds = new Set(pending.filter(p => p._isUpdate).map(p => _dayIdFromQueueUrl(p._updateUrl)).filter(Boolean));
    const pendingNew = pending.filter(p => !p._isUpdate);
    const all = [..._tripDays, ...pendingNew];

    document.getElementById('days-empty').classList.toggle('hidden', all.length > 0);
    document.getElementById('days-heading').textContent = `Days (${_tripDays.length})`;

    list.innerHTML = all.map(d => {
        const isPendingNew = !!d._pending;
        const isPendingEdit = !isPendingNew && pendingEditDayIds.has(d.id);
        const harvestBadge = d.harvested ? '<span class="text-[10px] font-bold bg-orange-900/60 text-orange-300 px-2 py-0.5 rounded">🏹 Harvest</span>' : '';
        const syncBadge = (isPendingNew || isPendingEdit) ? '<span class="text-[10px] font-bold bg-yellow-900/60 text-yellow-300 px-2 py-0.5 rounded">⏳ Sync pending</span>' : '';
        const clickAttr = isPendingNew ? '' : `onclick="showDayForm(${d.id})"`;
        return `
        <div ${clickAttr} class="bg-gray-900 border border-gray-800 rounded-lg p-3 space-y-1.5 transition ${isPendingNew ? '' : 'cursor-pointer hover:border-orange-500/40'}">
            <div class="flex items-center justify-between gap-2 flex-wrap">
                <div class="text-sm font-bold text-orange-400">${fmtDate(d.hunt_date)}${d.location_label ? ' — ' + d.location_label : ''}</div>
                <div class="flex gap-1.5">${harvestBadge}${syncBadge}</div>
            </div>
            <div class="text-xs text-gray-500">${[d.weather_conditions, d.weather_temp_f != null ? d.weather_temp_f + '°F' : null, d.moon_phase].filter(Boolean).join(' · ')}</div>
            ${d.narrative ? `<p class="text-sm text-gray-300 line-clamp-2">${d.narrative}</p>` : ''}
            ${(d.media && d.media.length) ? `<div class="flex gap-1.5 mt-1">${d.media.slice(0, 4).map(m => m.media_type === 'video'
                ? `<div class="w-10 h-10 rounded bg-gray-800 flex items-center justify-center text-sm">🎬</div>`
                : `<img src="${m.file_path}" class="w-10 h-10 object-cover rounded">`
            ).join('')}</div>` : ''}
        </div>`;
    }).join('');
}

function recomputeDayMoon() {
    const dateInput = document.getElementById('day-date');
    if (!dateInput.value) return;
    const phase = moonPhaseFor(dateInput.value);
    document.getElementById('day-moon-phase-display').textContent = phase;
    document.getElementById('day-moon-phase').value = phase;
}

function showDayForm(dayId) {
    const wrap = document.getElementById('day-form-wrap');
    wrap.classList.remove('hidden');
    document.getElementById('day-id').value = dayId || '';
    document.getElementById('day-btn-delete').classList.toggle('hidden', !dayId);
    document.getElementById('day-form-heading').textContent = dayId ? 'Edit Day' : 'New Day';
    document.getElementById('day-form-status').textContent = '';

    const d = dayId ? _tripDays.find(x => x.id === dayId) : null;
    document.getElementById('day-date').value = d ? d.hunt_date : new Date().toISOString().slice(0, 10);
    recomputeDayMoon();
    document.getElementById('day-location-label').value = (d && d.location_label) || '';
    document.getElementById('day-lat').value = (d && d.latitude != null) ? d.latitude : '';
    document.getElementById('day-lng').value = (d && d.longitude != null) ? d.longitude : '';
    document.getElementById('day-loc-status').textContent = (d && d.latitude != null)
        ? `📍 ${d.latitude.toFixed(5)}, ${d.longitude.toFixed(5)}`
        : 'Not captured — works with zero cell signal, just needs device GPS.';
    document.getElementById('day-temp').value = (d && d.weather_temp_f != null) ? d.weather_temp_f : '';
    document.getElementById('day-conditions').value = (d && d.weather_conditions) || '';
    document.getElementById('day-wind-dir').value = (d && d.wind_direction) || '';
    document.getElementById('day-wind-speed').value = (d && d.wind_speed_mph != null) ? d.wind_speed_mph : '';
    document.getElementById('day-harvested').checked = !!(d && d.harvested);
    document.getElementById('day-harvest-notes-wrap').classList.toggle('hidden', !(d && d.harvested));
    document.getElementById('day-harvest-notes').value = (d && d.harvest_notes) || '';
    document.getElementById('day-narrative').value = (d && d.narrative) || '';

    if (d) {
        document.getElementById('day-media-section').classList.remove('hidden');
        document.getElementById('day-media-hint').classList.add('hidden');
        document.getElementById('day-media-grid').innerHTML = (d.media || []).map(mediaItemHtmlForDay).join('');
    } else {
        document.getElementById('day-media-section').classList.add('hidden');
        document.getElementById('day-media-hint').classList.remove('hidden');
        document.getElementById('day-media-grid').innerHTML = '';
    }

    wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function hideDayForm() {
    document.getElementById('day-form-wrap').classList.add('hidden');
}

function draftDayNarrative() {
    const val = id => (document.getElementById(id).value || '').trim();
    const date = val('day-date');
    const location = val('day-location-label');
    const temp = val('day-temp');
    const conditions = val('day-conditions');
    const windDir = val('day-wind-dir');
    const windSpeed = val('day-wind-speed');
    const moonPhase = (document.getElementById('day-moon-phase-display').textContent || '').trim();
    const harvested = document.getElementById('day-harvested').checked;
    const harvestNotes = val('day-harvest-notes');

    const dateLabel = date
        ? new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
        : 'today';

    const sentences = [`${location ? 'Hunted ' + location + ' on' : 'Out on'} ${dateLabel}.`];
    const conditionBits = [];
    if (conditions) conditionBits.push(conditions.toLowerCase());
    if (temp) conditionBits.push(`${temp}°F`);
    if (windDir || windSpeed) conditionBits.push(`wind ${windSpeed ? windSpeed + ' mph ' : ''}out of the ${windDir || 'unknown direction'}`.trim());
    if (conditionBits.length) {
        sentences.push(`Conditions were ${conditionBits.join(', ')}${moonPhase && moonPhase !== '—' ? `, under a ${moonPhase.toLowerCase()}` : ''}.`);
    } else if (moonPhase && moonPhase !== '—') {
        sentences.push(`It was a ${moonPhase.toLowerCase()}.`);
    }
    if (harvested) {
        sentences.push(`Successfully harvested this day.`);
        if (harvestNotes) sentences.push(harvestNotes);
    } else {
        sentences.push('No harvest this day.');
    }
    return sentences.join(' ');
}

function generateTripSummary() {
    if (!_tripDays.length) return '';
    const parts = _tripDays.map((d, i) => {
        const bits = [`Day ${i + 1} (${fmtDate(d.hunt_date)}${d.location_label ? ' — ' + d.location_label : ''})`];
        if (d.narrative) bits.push(d.narrative);
        else if (d.harvested) bits.push(`Harvested${d.harvest_notes ? ': ' + d.harvest_notes : '.'}`);
        else bits.push('No harvest.');
        return bits.join(': ');
    });
    return parts.join('\n\n');
}

async function saveDay() {
    const dayId = document.getElementById('day-id').value;
    const payload = {
        hunt_date: document.getElementById('day-date').value,
        location_label: document.getElementById('day-location-label').value || null,
        latitude: document.getElementById('day-lat').value ? parseFloat(document.getElementById('day-lat').value) : null,
        longitude: document.getElementById('day-lng').value ? parseFloat(document.getElementById('day-lng').value) : null,
        weather_temp_f: document.getElementById('day-temp').value ? parseFloat(document.getElementById('day-temp').value) : null,
        weather_conditions: document.getElementById('day-conditions').value || null,
        wind_direction: document.getElementById('day-wind-dir').value || null,
        wind_speed_mph: document.getElementById('day-wind-speed').value ? parseFloat(document.getElementById('day-wind-speed').value) : null,
        moon_phase: document.getElementById('day-moon-phase').value || null,
        harvested: document.getElementById('day-harvested').checked,
        harvest_notes: document.getElementById('day-harvest-notes').value || null,
        narrative: document.getElementById('day-narrative').value || null,
    };
    const status = document.getElementById('day-form-status');
    if (!payload.hunt_date) {
        status.textContent = 'Date is required.';
        return;
    }
    status.textContent = 'Saving…';
    const method = dayId ? 'PUT' : 'POST';
    const url = dayId ? `/api/logbook/${_tripEntryId}/days/${dayId}` : `/api/logbook/${_tripEntryId}/days`;
    const result = await submitEntry(payload, method, url, null, ['/api/logbook', `/api/logbook/${_tripEntryId}`]);
    if (result.queued) {
        status.textContent = "📥 Saved offline — this'll sync automatically once you're back in range.";
        setTimeout(() => { hideDayForm(); renderTripDaysList(); }, 1200);
    } else if (result.ok) {
        const idx = _tripDays.findIndex(x => x.id === result.data.id);
        if (idx >= 0) _tripDays[idx] = result.data; else _tripDays.push(result.data);
        if (!dayId) {
            // New days land back in the (now edit-mode) form so photos can be attached right away.
            showDayForm(result.data.id);
            renderTripDaysList();
            document.getElementById('day-form-status').textContent = 'Saved — you can now add photos below.';
            return;
        }
        hideDayForm();
        renderTripDaysList();
    } else {
        status.textContent = 'Failed to save: ' + (result.error || 'unknown error');
    }
}

async function saveTripFields(statusElId) {
    const status = document.getElementById(statusElId);
    status.textContent = 'Saving…';
    try {
        const res = await fetch(`/api/logbook/${_tripEntryId}/trip`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                location_label: document.getElementById('trip-location').value || null,
                narrative: document.getElementById('trip-narrative').value || null,
            }),
        });
        if (res.ok) await invalidateCache(['/api/logbook', `/api/logbook/${_tripEntryId}`]);
        status.textContent = res.ok ? 'Saved.' : 'Failed to save.';
        setTimeout(() => { status.textContent = ''; }, 2000);
    } catch {
        status.textContent = "Couldn't save — you appear to be offline.";
    }
}
function saveTripInfo() { saveTripFields('trip-info-status'); }
function saveTripSummary() { saveTripFields('trip-summary-status'); }

async function deleteTrip() {
    if (!confirm('Delete this entire trip log, including all days and photos? This cannot be undone.')) return;
    try {
        await fetch(`/api/logbook/${_tripEntryId}`, { method: 'DELETE' });
        await invalidateCache(['/api/logbook', `/api/logbook/${_tripEntryId}`]);
        window.location.href = '/logbook';
    } catch {
        alert("Couldn't delete — you appear to be offline.");
    }
}

// ── Trip view (read-only "notebook page") ───────────────────────────────────────────────────

async function initTripView(entryId) {
    const box = document.getElementById('notebook-content');
    if (!box) return;
    document.getElementById('edit-link').href = `/logbook/trip/${entryId}/edit`;

    let e;
    try {
        const res = await fetch(`/api/logbook/${entryId}`);
        if (!res.ok) throw new Error();
        e = await res.json();
    } catch {
        box.innerHTML = '<div class="text-center text-sm py-8 opacity-70">Couldn\'t load this trip — you appear to be offline.</div>';
        return;
    }

    const days = e.days || [];
    const dateRange = e.scheduled_hunt
        ? (e.scheduled_hunt.start_date === e.scheduled_hunt.end_date
            ? fmtDate(e.scheduled_hunt.start_date)
            : `${fmtDate(e.scheduled_hunt.start_date)} – ${fmtDate(e.scheduled_hunt.end_date)}`)
        : '';
    const title = (e.scheduled_hunt && e.scheduled_hunt.label) || e.location_label || 'Trip Log';

    box.innerHTML = `
        <div class="text-2xl font-extrabold leading-tight">${title}</div>
        <div class="text-sm font-extrabold uppercase tracking-wide mt-1" style="color:#6b3410">${days.length} day${days.length === 1 ? '' : 's'}${dateRange ? ' · ' + dateRange : ''}</div>
        ${e.location_label ? `<div class="text-base mt-1 font-semibold">${e.location_label}</div>` : ''}
        ${e.narrative ? `<p class="text-lg mt-3 whitespace-pre-wrap leading-relaxed font-semibold">${e.narrative}</p>` : ''}
        ${days.map((d, i) => `
            <div class="trip-day-card">
                <div class="text-base font-extrabold">Day ${i + 1} — ${fmtDate(d.hunt_date)}${d.location_label ? ' — ' + d.location_label : ''}</div>
                ${d.harvested ? '<div class="text-sm font-extrabold uppercase tracking-wide mt-0.5" style="color:#7a2f00">🏹 Harvest</div>' : ''}
                ${[d.weather_conditions, d.weather_temp_f != null ? d.weather_temp_f + '°F' : null, d.moon_phase].filter(Boolean).length ? `<div class="text-sm mt-1 font-semibold">${[d.weather_conditions, d.weather_temp_f != null ? d.weather_temp_f + '°F' : null, d.moon_phase].filter(Boolean).join(' · ')}</div>` : ''}
                ${d.harvest_notes ? `<p class="text-sm mt-1 font-semibold">${d.harvest_notes}</p>` : ''}
                ${d.narrative ? `<p class="text-sm mt-2 whitespace-pre-wrap leading-relaxed font-semibold">${d.narrative}</p>` : ''}
                ${(d.media && d.media.length) ? `<div class="grid grid-cols-2 gap-2 mt-2">${
                    d.media.map(m => m.media_type === 'video'
                        ? `<video src="${m.file_path}" controls class="w-full rounded shadow"></video>`
                        : `<img src="${m.file_path}" class="w-full rounded shadow object-cover cursor-pointer" onclick="window.open('${m.file_path}', '_blank')">`
                    ).join('')
                }</div>` : ''}
            </div>
        `).join('') || '<p class="text-lg mt-4 opacity-50 italic">No days logged yet.</p>'}
    `;
}

document.addEventListener('DOMContentLoaded', () => {
    flushQueue().then(() => { loadLogbookList(); updatePendingBadge(); });
});
