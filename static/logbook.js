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
document.addEventListener('click', e => {
    const menu = document.getElementById('user-menu');
    if (menu && !menu.classList.contains('hidden') && !menu.parentElement.contains(e.target)) {
        menu.classList.add('hidden');
        const arrow = document.getElementById('user-menu-arrow');
        if (arrow) arrow.style.transform = '';
    }
});

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

function getQueue() {
    try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return []; }
}
function saveQueue(q) {
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch { /* storage unavailable — queue is best-effort */ }
}
function queueCount() { return getQueue().length; }

// Tries the network first; if it's unreachable, queues the write instead of failing outright.
// Returns { ok, queued, data }.
async function submitEntry(payload, method, url) {
    try {
        const res = await fetch(url, {
            method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        });
        if (res.ok) return { ok: true, queued: false, data: await res.json() };
        return { ok: false, queued: false, error: await res.text() };
    } catch {
        const q = getQueue();
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

    list.innerHTML = all.map(e => `
        <div class="bg-gray-800 rounded-lg border border-gray-700 shadow-xl p-4 space-y-1.5">
            <div class="flex items-center justify-between gap-2 flex-wrap">
                <div class="text-sm font-bold text-orange-400">${fmtDate(e.hunt_date)}${e.location_label ? ' — ' + e.location_label : ''}</div>
                <div class="flex items-center gap-2">
                    ${e._pending ? '<span class="text-[10px] font-bold bg-yellow-900/60 text-yellow-300 px-2 py-0.5 rounded">⏳ Pending sync</span>' : ''}
                    ${e.harvested ? '<span class="text-[10px] font-bold bg-orange-900/60 text-orange-300 px-2 py-0.5 rounded">🏹 Harvest</span>' : ''}
                    ${!e._pending ? `<a href="/logbook/${e.id}/edit" class="text-xs text-gray-400 hover:text-white transition">Edit</a>` : ''}
                </div>
            </div>
            <div class="text-xs text-gray-400">${[e.game_type, e.species, e.weapon].filter(Boolean).join(' · ') || '—'}</div>
            <div class="text-xs text-gray-500">${[e.weather_conditions, e.weather_temp_f != null ? e.weather_temp_f + '°F' : null, e.wind_direction ? 'wind ' + e.wind_direction : null, e.moon_phase].filter(Boolean).join(' · ')}</div>
            ${e.narrative ? `<p class="text-sm text-gray-300 mt-1 line-clamp-3">${e.narrative}</p>` : ''}
            ${(e.media && e.media.length) ? `<div class="flex gap-1.5 mt-1">${
                e.media.slice(0, 4).map(m => m.media_type === 'video'
                    ? `<div class="w-12 h-12 rounded bg-gray-900 flex items-center justify-center text-lg">🎬</div>`
                    : `<img src="${m.file_path}" class="w-12 h-12 object-cover rounded">`
                ).join('')
            }${e.media.length > 4 ? `<div class="w-12 h-12 rounded bg-gray-900 flex items-center justify-center text-xs text-gray-400">+${e.media.length - 4}</div>` : ''}</div>` : ''}
        </div>
    `).join('');
}

// ── Logbook entry form (new + edit) ─────────────────────────────────────────────────────────

function initLogbookForm(entryId) {
    const form = document.getElementById('logbook-form');
    if (!form) return;

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

    if (entryId) {
        document.getElementById('btn-delete').classList.remove('hidden');
        document.getElementById('btn-delete').addEventListener('click', async () => {
            if (!confirm('Delete this logbook entry? This cannot be undone.')) return;
            try {
                await fetch(`/api/logbook/${entryId}`, { method: 'DELETE' });
                window.location.href = '/logbook';
            } catch {
                document.getElementById('form-status').textContent = 'Could not delete — you appear to be offline.';
            }
        });
        (async () => {
            try {
                const res = await fetch(`/api/logbook/${entryId}`);
                if (!res.ok) throw new Error();
                const e = await res.json();
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
                renderMediaGrid(e.media);
            } catch {
                document.getElementById('form-status').textContent = "Couldn't load this entry — you appear to be offline. Editing existing entries needs a connection.";
                form.querySelectorAll('input, select, textarea, button').forEach(el => el.disabled = true);
            }
        })();
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
        const result = await submitEntry(payload, method, url);
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

document.addEventListener('DOMContentLoaded', () => {
    flushQueue().then(() => { loadLogbookList(); updatePendingBadge(); });
});
