// Recipes — list with game-type filter pills, and a new/edit form that can optionally link
// back to the harvested hunt that produced the ingredients. Online-only: no offline queue here
// (unlike logbook.js) since adding a recipe from the kitchen at home always has a connection —
// this isn't a backcountry-logging scenario.

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

// ── Recipe form tabs (Manual Entry / From ChatGPT) ──────────────────────────────────────────

function switchRecipeTab(tab) {
    const form = document.getElementById('recipe-form');
    const chatgptPane = document.getElementById('tab-chatgpt');
    if (!form || !chatgptPane) return;
    form.classList.toggle('hidden', tab !== 'manual');
    chatgptPane.classList.toggle('hidden', tab !== 'chatgpt');
    [['tab-btn-manual', 'manual'], ['tab-btn-chatgpt', 'chatgpt']].forEach(([id, name]) => {
        const btn = document.getElementById(id);
        if (!btn) return;
        const active = name === tab;
        btn.classList.toggle('border-rose-500', active);
        btn.classList.toggle('text-rose-400', active);
        btn.classList.toggle('border-transparent', !active);
        btn.classList.toggle('text-gray-400', !active);
    });
}

// See the matching comment in logbook.js — the service worker serves hbc-data entries
// stale-while-revalidate (instant from cache, refreshed in the background), so a write needs to
// delete its own affected cache entries or the very next load would still show the pre-write
// data until that background refresh catches up. Duplicated here rather than shared since this
// page deliberately doesn't load a shared app.js.
async function invalidateCache(urls) {
    try {
        const cache = await caches.open('hbc-data');
        await Promise.all(urls.map(u => cache.delete(u)));
    } catch { /* Cache Storage unavailable — the next background refresh will still catch up. */ }
}

// ── Recipes list page ───────────────────────────────────────────────────────────────────────

let _allRecipes = [];
let _activeGameFilter = null;

function renderGameFilterPills() {
    const wrap = document.getElementById('recipe-filter-pills');
    if (!wrap) return;
    const present = [...new Set(_allRecipes.map(r => r.game_type).filter(Boolean))];
    const pill = (label, value, active) =>
        `<button onclick="setGameFilter(${value === null ? 'null' : `'${value}'`})"
            class="px-2.5 py-1 rounded-full text-xs font-bold cursor-pointer transition ${active ? 'bg-rose-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}">${label}</button>`;
    wrap.innerHTML = pill('All', null, _activeGameFilter === null) + present.map(g => pill(g, g, _activeGameFilter === g)).join('');
}

function setGameFilter(g) {
    _activeGameFilter = g;
    renderGameFilterPills();
    renderRecipeList();
}

function renderRecipeList() {
    const list = document.getElementById('recipes-list');
    if (!list) return;
    const filtered = _activeGameFilter ? _allRecipes.filter(r => r.game_type === _activeGameFilter) : _allRecipes;

    document.getElementById('recipes-empty').classList.toggle('hidden', _allRecipes.length > 0);
    document.getElementById('recipes-filter-empty')?.classList.toggle('hidden', !(_allRecipes.length > 0 && filtered.length === 0));

    list.innerHTML = filtered.map(r => `
        <a href="/recipes/${r.id}" class="block bg-gray-800 rounded-lg border border-gray-700 shadow-xl p-4 space-y-1.5 hover:border-rose-500/40 transition">
            <div class="flex items-center justify-between gap-2 flex-wrap">
                <div class="text-sm font-bold text-rose-400">${r.title}</div>
                ${r.game_type ? `<span class="text-[10px] font-bold bg-rose-900/60 text-rose-300 px-2 py-0.5 rounded">${r.game_type}</span>` : ''}
            </div>
            ${r.hunt_log_entry ? `<div class="text-xs text-gray-500">🏹 From: ${r.hunt_log_entry.label}</div>` : ''}
            ${r.ingredients ? `<p class="text-xs text-gray-400 line-clamp-2">${r.ingredients.split('\n').filter(Boolean).slice(0, 4).join(', ')}</p>` : ''}
            ${(r.media && r.media.length) ? `<div class="flex gap-1.5 mt-1">${
                r.media.slice(0, 4).map(m => m.media_type === 'video'
                    ? `<div class="w-12 h-12 rounded bg-gray-900 flex items-center justify-center text-lg">🎬</div>`
                    : `<img src="${m.file_path}" class="w-12 h-12 object-cover rounded">`
                ).join('')
            }${r.media.length > 4 ? `<div class="w-12 h-12 rounded bg-gray-900 flex items-center justify-center text-xs text-gray-400">+${r.media.length - 4}</div>` : ''}</div>` : ''}
        </a>
    `).join('');
}

async function loadRecipesList() {
    if (!document.getElementById('recipes-list')) return;
    try {
        const res = await fetch('/api/recipes');
        _allRecipes = await res.json();
    } catch {
        document.getElementById('recipes-list').innerHTML = '<div class="text-center text-gray-500 text-sm py-10">Can\'t reach the server.</div>';
        return;
    }
    renderGameFilterPills();
    renderRecipeList();
}

// ── ChatGPT recipe paste parser ─────────────────────────────────────────────────────────────
//
// Splits a recipe generated from the user's own ChatGPT template into this form's fields:
//   Title
//   Short description
//   (ingredient sections, freeform headers — "The Meats", "Vegetables", etc.)
//   Preparation (numbered steps)
//   HB&C Recipe Note
//   Prep Time: / Cook Time: / Cooking Method: / Servings: / Cuisine:
//
// Best-effort, not a guaranteed-correct parse: it anchors on the parts of the template that are
// reliably present in every recipe (the "Preparation" and "HB&C Recipe Note" headers, and the
// "Label: value" lines at the end) rather than trying to understand every possible ingredient
// section heading, since those vary recipe to recipe ("The Meats" vs "Braising Liquid" vs
// whatever else ChatGPT titles that section). Ingredient section headers are left as plain lines
// inside the Ingredients field rather than parsed out individually — that field is already
// freeform "one per line" text, so preserving them there both keeps the grouping readable and
// sidesteps needing to guess at header wording. Verified against a real generated recipe before
// shipping — see the PR description for the worked example.
const RECIPE_EMOJI_HEADER_RE = /^[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}]/u;

function isEmojiHeaderLine(line) {
    return RECIPE_EMOJI_HEADER_RE.test(line.trim());
}

function stripLeadingEmoji(line) {
    return line.replace(RECIPE_EMOJI_HEADER_RE, '').trim();
}

function collapseBlankLines(text) {
    return text.replace(/\n{3,}/g, '\n\n').trim();
}

// Ingredient section headers (e.g. "🥩 The Meats", "🥕 Vegetables") sit directly against the
// previous section's last item in the pasted text, no blank line between them — inserts one
// before each header (except the very first) so the sections read clearly once they land in the
// Ingredients textarea.
function formatIngredientsBlock(sliceLines) {
    const out = [];
    sliceLines.forEach((line, idx) => {
        if (idx > 0 && isEmojiHeaderLine(line)) out.push('');
        out.push(line);
    });
    return collapseBlankLines(out.join('\n'));
}

function parseChatGptRecipe(raw) {
    const lines = raw.replace(/\r\n/g, '\n').split('\n');
    let i = 0;
    const skipBlank = () => { while (i < lines.length && !lines[i].trim()) i++; };

    skipBlank();
    if (i >= lines.length) return null;
    const title = stripLeadingEmoji(lines[i]);
    i++;
    skipBlank();

    const descLines = [];
    while (i < lines.length && lines[i].trim() && !isEmojiHeaderLine(lines[i])) {
        descLines.push(lines[i].trim());
        i++;
    }
    const description = descLines.join(' ');
    const ingredientsStart = i;

    let prepIdx = null;
    for (let j = i; j < lines.length; j++) {
        if (isEmojiHeaderLine(lines[j]) && /preparation/i.test(lines[j])) { prepIdx = j; break; }
    }

    let noteIdx = null;
    for (let j = (prepIdx !== null ? prepIdx + 1 : i); j < lines.length; j++) {
        if (/HB&C Recipe Note/i.test(lines[j])) { noteIdx = j; break; }
    }

    const META_LABELS = ['prep time', 'cook time', 'cooking method', 'servings', 'cuisine'];
    let metaIdx = null;
    const metaSearchStart = noteIdx !== null ? noteIdx + 1 : (prepIdx !== null ? prepIdx + 1 : i);
    for (let j = metaSearchStart; j < lines.length; j++) {
        const stripped = lines[j].trim().toLowerCase();
        if (META_LABELS.some(lbl => stripped.startsWith(lbl + ':'))) { metaIdx = j; break; }
    }

    const ingredientsEnd = prepIdx !== null ? prepIdx : (metaIdx !== null ? metaIdx : lines.length);
    const ingredients = formatIngredientsBlock(lines.slice(ingredientsStart, ingredientsEnd));

    let instructions = '';
    if (prepIdx !== null) {
        const instrEnd = noteIdx !== null ? noteIdx : (metaIdx !== null ? metaIdx : lines.length);
        instructions = collapseBlankLines(lines.slice(prepIdx + 1, instrEnd).join('\n'));
    }

    let notes = '';
    if (noteIdx !== null) {
        const notesEnd = metaIdx !== null ? metaIdx : lines.length;
        notes = collapseBlankLines(lines.slice(noteIdx + 1, notesEnd).join('\n'));
    }

    const meta = {};
    if (metaIdx !== null) {
        for (let j = metaIdx; j < lines.length; j++) {
            const m = /^\s*(prep time|cook time|cooking method|servings|cuisine)\s*:\s*(.+)$/i.exec(lines[j]);
            if (m) meta[m[1].toLowerCase()] = m[2].trim();
        }
    }

    return {
        title, description, ingredients, instructions, notes,
        prep_time: meta['prep time'] || '',
        cook_time: meta['cook time'] || '',
        cooking_method: meta['cooking method'] || '',
        servings: meta['servings'] || '',
        cuisine: meta['cuisine'] || '',
        _foundPreparation: prepIdx !== null,
        _foundNote: noteIdx !== null,
        _foundMeta: metaIdx !== null,
    };
}

// ── Recipe form (new + edit) ────────────────────────────────────────────────────────────────

async function initRecipeForm(recipeId) {
    const form = document.getElementById('recipe-form');
    if (!form) return;

    switchRecipeTab('manual');

    const btnParseChatGpt = document.getElementById('btn-parse-chatgpt');
    if (btnParseChatGpt) {
        btnParseChatGpt.addEventListener('click', () => {
            const status = document.getElementById('chatgpt-parse-status');
            const raw = document.getElementById('chatgpt-paste').value;
            if (!raw.trim()) { status.textContent = 'Paste a recipe first.'; return; }
            const parsed = parseChatGptRecipe(raw);
            if (!parsed) { status.textContent = "Couldn't find anything to parse."; return; }
            document.getElementById('f-title').value = parsed.title;
            document.getElementById('f-description').value = parsed.description;
            document.getElementById('f-ingredients').value = parsed.ingredients;
            document.getElementById('f-instructions').value = parsed.instructions;
            document.getElementById('f-notes').value = parsed.notes;
            document.getElementById('f-prep-time').value = parsed.prep_time;
            document.getElementById('f-cook-time').value = parsed.cook_time;
            document.getElementById('f-cooking-method').value = parsed.cooking_method;
            document.getElementById('f-servings').value = parsed.servings;
            document.getElementById('f-cuisine').value = parsed.cuisine;
            const missing = [
                !parsed._foundPreparation ? 'Preparation steps' : null,
                !parsed._foundNote ? 'HB&C Recipe Note' : null,
                !parsed._foundMeta ? 'Prep/Cook Time, Method, Servings, Cuisine' : null,
            ].filter(Boolean);
            status.textContent = missing.length
                ? `Filled in what it could find — couldn't locate: ${missing.join(', ')}. Check the fields below.`
                : 'Filled in — double-check the fields below before saving.';
            switchRecipeTab('manual');
        });
    }

    const huntSelect = document.getElementById('f-hunt-link');
    try {
        const res = await fetch('/api/recipes/harvest-options');
        const options = await res.json();
        huntSelect.innerHTML = '<option value="">— None —</option>' +
            options.map(o => `<option value="${o.id}">${o.label}</option>`).join('');
    } catch {
        huntSelect.innerHTML = '<option value="">— None (offline) —</option>';
    }

    // ── Media (photos/video) — online-only, same as the recipe form as a whole ───────────────
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
            if (!btn || !recipeId) return;
            if (!confirm('Remove this photo/video?')) return;
            try {
                await fetch(`/api/recipes/${recipeId}/media/${btn.dataset.deleteMedia}`, { method: 'DELETE' });
                await invalidateCache(['/api/recipes', `/api/recipes/${recipeId}`]);
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
                    const res = await fetch(`/api/recipes/${recipeId}/media`, { method: 'POST', body: fd });
                    if (res.ok) {
                        await invalidateCache(['/api/recipes', `/api/recipes/${recipeId}`]);
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

    if (recipeId) {
        document.getElementById('btn-delete').classList.remove('hidden');
        document.getElementById('btn-delete').addEventListener('click', async () => {
            if (!confirm('Delete this recipe? This cannot be undone.')) return;
            try {
                await fetch(`/api/recipes/${recipeId}`, { method: 'DELETE' });
                await invalidateCache(['/api/recipes', `/api/recipes/${recipeId}`]);
                window.location.href = '/recipes';
            } catch {
                document.getElementById('form-status').textContent = 'Could not delete — you appear to be offline.';
            }
        });
        try {
            const res = await fetch(`/api/recipes/${recipeId}`);
            if (!res.ok) throw new Error();
            const r = await res.json();
            document.getElementById('f-title').value = r.title || '';
            document.getElementById('f-description').value = r.description || '';
            document.getElementById('f-game-type').value = r.game_type || '';
            huntSelect.value = r.hunt_log_entry_id || '';
            document.getElementById('f-prep-time').value = r.prep_time || '';
            document.getElementById('f-cook-time').value = r.cook_time || '';
            document.getElementById('f-cooking-method').value = r.cooking_method || '';
            document.getElementById('f-servings').value = r.servings || '';
            document.getElementById('f-cuisine').value = r.cuisine || '';
            document.getElementById('f-ingredients').value = r.ingredients || '';
            document.getElementById('f-instructions').value = r.instructions || '';
            document.getElementById('f-notes').value = r.notes || '';
            renderMediaGrid(r.media);
        } catch {
            document.getElementById('form-status').textContent = "Couldn't load this recipe — you appear to be offline.";
            form.querySelectorAll('input, select, textarea, button').forEach(el => el.disabled = true);
        }
    }

    form.addEventListener('submit', async e => {
        e.preventDefault();
        const payload = {
            title: document.getElementById('f-title').value,
            description: document.getElementById('f-description').value || null,
            hunt_log_entry_id: huntSelect.value ? parseInt(huntSelect.value) : null,
            game_type: document.getElementById('f-game-type').value || null,
            prep_time: document.getElementById('f-prep-time').value || null,
            cook_time: document.getElementById('f-cook-time').value || null,
            cooking_method: document.getElementById('f-cooking-method').value || null,
            servings: document.getElementById('f-servings').value || null,
            cuisine: document.getElementById('f-cuisine').value || null,
            ingredients: document.getElementById('f-ingredients').value || null,
            instructions: document.getElementById('f-instructions').value || null,
            notes: document.getElementById('f-notes').value || null,
        };
        const status = document.getElementById('form-status');
        status.textContent = 'Saving…';
        try {
            const method = recipeId ? 'PUT' : 'POST';
            const url = recipeId ? `/api/recipes/${recipeId}` : '/api/recipes';
            const res = await fetch(url, {
                method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                status.textContent = 'Failed to save: ' + (err.detail || 'unknown error');
                return;
            }
            const saved = await res.json();
            await invalidateCache(recipeId ? ['/api/recipes', `/api/recipes/${recipeId}`] : ['/api/recipes']);
            // New recipes land on their own edit page so photos/video can be attached right
            // away; edits just go back to the list since media's already there to manage.
            window.location.href = (!recipeId && saved) ? `/recipes/${saved.id}/edit` : '/recipes';
        } catch {
            status.textContent = "Couldn't save — you appear to be offline. Try again once you're back in range.";
        }
    });
}

// ── Recipe view (read-only "notebook page") ─────────────────────────────────────────────────

async function initRecipeView(recipeId) {
    const box = document.getElementById('notebook-content');
    if (!box) return;
    document.getElementById('edit-link').href = `/recipes/${recipeId}/edit`;

    let r;
    try {
        const res = await fetch(`/api/recipes/${recipeId}`);
        if (!res.ok) throw new Error();
        r = await res.json();
    } catch {
        box.innerHTML = '<div class="text-center text-sm py-8 opacity-70">Couldn\'t load this recipe — you appear to be offline.</div>';
        return;
    }

    const ingredientItems = (r.ingredients || '').split('\n').map(s => s.trim()).filter(Boolean);
    const metaItems = [
        r.prep_time ? `⏱️ Prep: ${r.prep_time}` : null,
        r.cook_time ? `🔥 Cook: ${r.cook_time}` : null,
        r.cooking_method ? `👨‍🍳 ${r.cooking_method}` : null,
        r.servings ? `🍽️ Serves ${r.servings}` : null,
        r.cuisine ? `🌍 ${r.cuisine}` : null,
    ].filter(Boolean);

    box.innerHTML = `
        <div class="recipe-title">${r.title}</div>
        <div class="recipe-divider"><div></div><span>❖</span><div></div></div>
        ${r.description ? `<p class="text-center text-sm italic font-semibold" style="color:#3a2a18">${r.description}</p>` : ''}
        ${r.game_type ? `<div class="text-center text-sm font-extrabold uppercase tracking-widest mt-1.5" style="color:#7a2f00">${r.game_type}</div>` : ''}
        ${metaItems.length ? `<div class="text-center text-xs font-semibold mt-1.5 flex flex-wrap justify-center gap-x-3 gap-y-1" style="color:#3a2a18">${metaItems.map(i => `<span>${i}</span>`).join('')}</div>` : ''}
        ${r.hunt_log_entry ? `<a href="/logbook/${r.hunt_log_entry_id}" class="block text-center text-sm mt-1.5 font-semibold underline">🏹 From: ${r.hunt_log_entry.label}</a>` : ''}
        ${(r.media && r.media.length) ? `<div class="grid grid-cols-2 gap-2 mt-3">${
            r.media.map(m => m.media_type === 'video'
                ? `<video src="${m.file_path}" controls class="w-full rounded shadow"></video>`
                : `<img src="${m.file_path}" class="w-full rounded shadow object-cover cursor-pointer" onclick="window.open('${m.file_path}', '_blank')">`
            ).join('')
        }</div>` : ''}
        ${ingredientItems.length ? `
            <div class="recipe-section-heading">Ingredients</div>
            <ul class="list-disc pl-5 mt-2 space-y-1.5">${ingredientItems.map(i => `<li class="text-base font-semibold leading-snug">${i}</li>`).join('')}</ul>
        ` : ''}
        ${r.instructions ? `
            <div class="recipe-section-heading">Instructions</div>
            <p class="text-base mt-2 whitespace-pre-wrap leading-relaxed font-semibold">${r.instructions}</p>
        ` : ''}
        ${r.notes ? `
            <div class="recipe-section-heading">Notes</div>
            <p class="text-base mt-2 whitespace-pre-wrap leading-relaxed font-semibold">${r.notes}</p>
        ` : ''}
    `;
}

document.addEventListener('DOMContentLoaded', loadRecipesList);
