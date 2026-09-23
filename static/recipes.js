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

// ── Recipe form (new + edit) ────────────────────────────────────────────────────────────────

async function initRecipeForm(recipeId) {
    const form = document.getElementById('recipe-form');
    if (!form) return;

    const huntSelect = document.getElementById('f-hunt-link');
    try {
        const res = await fetch('/api/recipes/harvest-options');
        const options = await res.json();
        huntSelect.innerHTML = '<option value="">— None —</option>' +
            options.map(o => `<option value="${o.id}">${o.label}</option>`).join('');
    } catch {
        huntSelect.innerHTML = '<option value="">— None (offline) —</option>';
    }

    if (recipeId) {
        document.getElementById('btn-delete').classList.remove('hidden');
        document.getElementById('btn-delete').addEventListener('click', async () => {
            if (!confirm('Delete this recipe? This cannot be undone.')) return;
            try {
                await fetch(`/api/recipes/${recipeId}`, { method: 'DELETE' });
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
            document.getElementById('f-game-type').value = r.game_type || '';
            huntSelect.value = r.hunt_log_entry_id || '';
            document.getElementById('f-ingredients').value = r.ingredients || '';
            document.getElementById('f-instructions').value = r.instructions || '';
            document.getElementById('f-notes').value = r.notes || '';
        } catch {
            document.getElementById('form-status').textContent = "Couldn't load this recipe — you appear to be offline.";
            form.querySelectorAll('input, select, textarea, button').forEach(el => el.disabled = true);
        }
    }

    form.addEventListener('submit', async e => {
        e.preventDefault();
        const payload = {
            title: document.getElementById('f-title').value,
            hunt_log_entry_id: huntSelect.value ? parseInt(huntSelect.value) : null,
            game_type: document.getElementById('f-game-type').value || null,
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
            window.location.href = '/recipes';
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

    box.innerHTML = `
        <div class="recipe-title">${r.title}</div>
        <div class="recipe-divider"><div></div><span>❖</span><div></div></div>
        ${r.game_type ? `<div class="text-center text-sm font-extrabold uppercase tracking-widest" style="color:#7a2f00">${r.game_type}</div>` : ''}
        ${r.hunt_log_entry ? `<a href="/logbook/${r.hunt_log_entry_id}" class="block text-center text-sm mt-1.5 font-semibold underline">🏹 From: ${r.hunt_log_entry.label}</a>` : ''}
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
