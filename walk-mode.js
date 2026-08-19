// 歴史を掘る一覧と、実際に歩ける候補を分離する試作。
(() => {
  let selectedWalkTopic = null;
  const originalRenderTopics = renderTopics;
  const originalRenderMarkers = renderMarkers;
  const originalDrillInto = drillInto;

  function formatDistance(meters) {
    if (!Number.isFinite(meters)) return '';
    if (meters < 1000) return `${Math.max(10, Math.round(meters / 10) * 10)}m`;
    return `${(meters / 1000).toFixed(meters < 10000 ? 1 : 0)}km`;
  }

  function walkableTopics() {
    if (!drillTrail.length) return [];
    const center = map.getCenter();
    return currentTopics
      .filter(topic => topic.category === 'other' && Number.isFinite(topic.lat) && Number.isFinite(topic.lng))
      .map(topic => ({ ...topic, walkDistance: map.distance(center, L.latLng(topic.lat, topic.lng)) }))
      .filter(topic => topic.walkDistance <= 10000)
      .sort((a, b) => a.walkDistance - b.walkDistance)
      .slice(0, 8);
  }

  function openWalkTopic(topic) {
    selectedWalkTopic = topic;
    renderMarkers();
    map.panTo([topic.lat, topic.lng], { animate: true });
    setTimeout(() => {
      const layer = markerLayer.getLayers()[0];
      if (layer?.openPopup) layer.openPopup();
    }, 180);
  }

  function prependWalkSection() {
    if (!drillTrail.length || activeTab !== 'topics') return;
    const candidates = walkableTopics();
    if (!candidates.length) return;

    const section = document.createElement('section');
    section.className = 'walk-section';

    const heading = document.createElement('div');
    heading.className = 'walk-heading';
    heading.innerHTML = `<span>このへんで歩ける</span><span class="walk-heading-note">現在の地図中心から10km以内</span>`;
    section.append(heading);

    const row = document.createElement('div');
    row.className = 'walk-row';
    for (const topic of candidates) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'walk-card';
      if (selectedWalkTopic?.title === topic.title) button.classList.add('active');
      button.innerHTML = `<span class="walk-title">${escapeHtml(topic.title)}</span><span class="walk-distance">${formatDistance(topic.walkDistance)}</span>`;
      button.addEventListener('click', event => {
        event.stopPropagation();
        openWalkTopic(topic);
      });
      row.append(button);
    }
    section.append(row);
    els.list.prepend(section);
  }

  renderTopics = function() {
    originalRenderTopics();
    prependWalkSection();
  };

  renderMarkers = function() {
    if (!drillTrail.length) {
      selectedWalkTopic = null;
      originalRenderMarkers();
      return;
    }

    markerLayer.clearLayers();
    if (!selectedWalkTopic || !Number.isFinite(selectedWalkTopic.lat) || !Number.isFinite(selectedWalkTopic.lng)) return;

    const topic = selectedWalkTopic;
    const wiki = topic.wikiTitle ? `<a href="${wikipediaUrl(topic.wikiTitle)}" target="_blank" rel="noopener">Wikipedia</a>` : '';
    const wd = topic.qid ? `<a href="${wikidataUrl(topic.qid)}" target="_blank" rel="noopener">Wikidata</a>` : '';
    const google = `<a href="https://www.google.com/maps/search/?api=1&query=${topic.lat},${topic.lng}" target="_blank" rel="noopener">Google Maps</a>`;
    const parent = drillTrail.at(-1) || '';
    const marker = L.marker([topic.lat, topic.lng], { icon: topicMarkerIcon, title: topic.title });
    marker.bindPopup(`<div class="place-popup-title">${escapeHtml(topic.title)}</div><div class="topic-context"><div class="topic-context-label">${escapeHtml(parent)}での記述</div><div class="topic-context-text">${escapeHtml(topic.context || '')}</div></div><div class="place-popup-links">${wiki}${wd}${google}</div>`, { maxWidth: 340 });
    marker.addTo(markerLayer);
  };

  drillInto = async function(title, fromHistory = false) {
    selectedWalkTopic = null;
    return originalDrillInto(title, fromHistory);
  };

  const style = document.createElement('style');
  style.textContent = `
    .walk-section{width:100%;padding:3px 0 10px;border-bottom:1px solid #e7e7e3;margin-bottom:2px}
    .walk-heading{display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding:7px 3px 7px;font-size:11px;font-weight:700;color:#222}
    .walk-heading-note{font-size:8.5px;font-weight:500;color:#999;white-space:nowrap}
    .walk-row{display:flex;gap:6px;overflow-x:auto;padding:0 1px 3px;scrollbar-width:none}
    .walk-row::-webkit-scrollbar{display:none}
    .walk-card{flex:0 0 auto;display:flex;align-items:center;gap:7px;border:1px solid #d8d8d4;background:#fff;border-radius:11px;padding:7px 9px;font:inherit;cursor:pointer;max-width:220px;text-align:left}
    .walk-card.active{background:#242424;color:#fff;border-color:#242424}
    .walk-title{font-size:10.5px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .walk-distance{font-size:9px;color:#888;white-space:nowrap}
    .walk-card.active .walk-distance{color:#ddd}
  `;
  document.head.append(style);
})();
