// Map view — plots every logbook entry that has a captured GPS coordinate. Deliberately just a
// "where have I logged hunts" reference view, not a real field-mapping tool: the user already
// uses OnX for that in the backcountry (see docs/VISION.md). Needs a live connection for map
// tiles either way, so there's no offline story here worth building.

async function initHuntMap() {
    const map = L.map('hunt-map', { zoomControl: true }).setView([39.8283, -98.5795], 4); // CONUS default

    // CartoDB's free dark basemap (no API key) — matches the app's dark theme better than
    // stock OpenStreetMap tiles would.
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        maxZoom: 19,
    }).addTo(map);

    let entries = [];
    try {
        const res = await fetch('/api/logbook');
        entries = await res.json();
    } catch {
        document.getElementById('map-empty').textContent = "Can't reach the server to load logged locations.";
        document.getElementById('map-empty').classList.remove('hidden');
        return;
    }

    const pinned = entries.filter(e => e.latitude != null && e.longitude != null);
    if (!pinned.length) {
        document.getElementById('map-empty').classList.remove('hidden');
        return;
    }

    const markers = pinned.map(e => {
        const title = [e.hunt_date, e.location_label].filter(Boolean).join(' — ');
        const subtitle = [e.game_type, e.species].filter(Boolean).join(' · ');
        const marker = L.marker([e.latitude, e.longitude]).addTo(map);
        marker.bindPopup(`
            <div class="text-sm">
                <div class="font-bold">${title || 'Logged hunt'}</div>
                ${subtitle ? `<div class="text-xs text-gray-400">${subtitle}</div>` : ''}
                ${e.harvested ? '<div class="text-xs text-orange-400 font-bold mt-1">🏹 Harvest</div>' : ''}
                <a href="/logbook/${e.id}/edit">View entry →</a>
            </div>
        `);
        return marker;
    });

    if (markers.length === 1) {
        map.setView(markers[0].getLatLng(), 12);
    } else {
        map.fitBounds(L.featureGroup(markers).getBounds().pad(0.2));
    }
}

document.addEventListener('DOMContentLoaded', initHuntMap);
