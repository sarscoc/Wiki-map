const map = L.map('map', { zoomControl: false, preferCanvas: true }).setView([33.5902, 130.4017], 15);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

const els = {
  load: document.getElementById('loadAreaButton'),
  status: document.getElementById('status'),
  sheet: document.getElementById('topicSheet'),
  handle: document.getElementById('sheetHandle'),
  title: document.getElementById('sheetTitle'),
  count: document.getElementById('sheetCount'),
  list: document.getElementById('topicList'),
  selection: document.getElementById('selectionBar'),
  selectionText: document.getElementById('selectionText'),
  clear: document.getElementById('clearSelectionButton'),
  tabs: [...document.querySelectorAll('.sheet-tab')]
};

const markerLayer = L.layerGroup().addTo(map);
let places = [];
let topics = [];
let selectedTopic = null;
let displayPlaces = [];
let activeTab = 'topics';
let requestToken = 0;

const articleCache = new Map();
const linkPlaceCache = new Map();
const textPlaceCache = new Map();
const pageContextCache = new Map();
const HISTORY_KEY = 'wiki-map-history-v1';

const markerIcon = L.divIcon({ className: '', html: '<div class="wiki-marker"></div>', iconSize: [12, 12], iconAnchor: [6, 6] });
const linkIcon = L.divIcon({ className: '', html: '<div class="wiki-marker related-marker"></div>', iconSize: [14, 14], iconAnchor: [7, 7] });
const textIcon = L.divIcon({ className: '', html: '<div class="wiki-marker text-marker"></div>', iconSize: [14, 14], iconAnchor: [7, 7] });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function setStatus(text) { els.status.textContent = text; }
function wikidataUrl(qid) { return `https://www.wikidata.org/wiki/${encodeURIComponent(qid)}`; }
function wikipediaUrl(title) { return `https://ja.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`; }
function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}
async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

function readHistory() {
  try {
    const value = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(value) ? value : [];
  } catch (_) { return []; }
}
function writeHistory(items) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, 100))); } catch (_) {}
}
function addHistory(entry) {
  const items = readHistory();
  const key = entry.kind === 'topic' ? `topic:${entry.topicTitle}` : `place:${entry.topicTitle}:${entry.source}:${entry.qid || entry.placeTitle}`;
  const filtered = items.filter(item => item.key !== key);
  filtered.unshift({ ...entry, key, ts: Date.now() });
  writeHistory(filtered);
  if (activeTab === 'history') renderHistory();
}

async function fetchWikidataPlaces(bounds) {
  const sw = bounds.getSouthWest();
  const ne = bounds.getNorthEast();
  const query = `SELECT ?item ?itemLabel ?article ?location WHERE {
    SERVICE wikibase:box {
      ?item wdt:P625 ?location .
      bd:serviceParam wikibase:cornerWest "Point(${sw.lng} ${sw.lat})"^^geo:wktLiteral .
      bd:serviceParam wikibase:cornerEast "Point(${ne.lng} ${ne.lat})"^^geo:wktLiteral .
    }
    OPTIONAL { ?article schema:about ?item ; schema:isPartOf <https://ja.wikipedia.org/> . }
    SERVICE wikibase:label { bd:serviceParam wikibase:language "ja". }
  }
  LIMIT 1000`;
  const data = await fetchJson('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(query), {
    headers: { Accept: 'application/sparql-results+json' }
  });
  const byId = new Map();
  for (const row of data.results.bindings) {
    const qid = row.item.value.split('/').pop();
    const match = row.location.value.match(/Point\(([-\d.]+) ([-\d.]+)\)/);
    if (!match) continue;
    const place = byId.get(qid) || {
      qid,
      title: row.itemLabel?.value || qid,
      lat: +match[2],
      lng: +match[1],
      wikiTitle: null,
      links: new Set(),
      source: 'local',
      sourceContext: ''
    };
    if (row.article?.value) place.wikiTitle = decodeURIComponent(row.article.value.split('/wiki/')[1] || '').replace(/_/g, ' ');
    byId.set(qid, place);
  }
  return [...byId.values()];
}

async function fetchPageLinks(title) {
  const links = new Set();
  let cont = null;
  for (let page = 0; page < 12; page++) {
    const params = new URLSearchParams({ action: 'query', format: 'json', origin: '*', prop: 'links', titles: title, plnamespace: '0', pllimit: 'max' });
    if (cont) params.set('plcontinue', cont);
    const data = await fetchJson('https://ja.wikipedia.org/w/api.php?' + params);
    const item = Object.values(data.query?.pages || {})[0];
    for (const link of item?.links || []) links.add(link.title);
    cont = data.continue?.plcontinue;
    if (!cont) break;
  }
  return links;
}

async function enrichWikipediaLinks(items) {
  const withWiki = items.filter(p => p.wikiTitle);
  for (let i = 0; i < withWiki.length; i += 4) {
    const batch = withWiki.slice(i, i + 4);
    setStatus(`Wikipediaリンクを取得中 ${Math.min(i + batch.length, withWiki.length)}/${withWiki.length}`);
    await Promise.all(batch.map(async place => {
      try { place.links = await fetchPageLinks(place.wikiTitle); }
      catch (error) { console.warn('links', place.wikiTitle, error); }
    }));
    if (i + 4 < withWiki.length) await sleep(50);
  }
}

function buildTopics(items) {
  const counts = new Map();
  for (const place of items) {
    for (const title of place.links) {
      const entry = counts.get(title) || { title, count: 0, placeIds: [] };
      entry.count += 1;
      entry.placeIds.push(place.qid);
      counts.set(title, entry);
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.title.localeCompare(b.title, 'ja'));
}

function cleanBlockText(node) {
  return (node?.textContent || '').replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
}
function shortContext(text, needle = '', max = 280) {
  const compact = (text || '').replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  if (compact.length <= max) return compact;
  const index = needle ? compact.indexOf(needle) : -1;
  if (index < 0) return compact.slice(0, max - 1) + '…';
  const before = Math.floor((max - needle.length) * 0.42);
  let start = Math.max(0, index - before);
  let end = Math.min(compact.length, start + max);
  if (end - start < max) start = Math.max(0, end - max);
  return (start > 0 ? '…' : '') + compact.slice(start, end) + (end < compact.length ? '…' : '');
}

async function fetchArticle(topicTitle) {
  if (articleCache.has(topicTitle)) return articleCache.get(topicTitle);
  const params = new URLSearchParams({ action: 'parse', format: 'json', origin: '*', page: topicTitle, prop: 'text|links', disableeditsection: '1' });
  const data = await fetchJson('https://ja.wikipedia.org/w/api.php?' + params);
  const html = data.parse?.text?.['*'] || '';
  const links = (data.parse?.links || []).filter(link => link.ns === 0 && link.exists !== undefined).map(link => link['*']);
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('table,style,script,sup,.mw-editsection,.navbox,.infobox,.reflist').forEach(node => node.remove());

  const linkContexts = new Map();
  for (const a of doc.querySelectorAll('a')) {
    const href = a.getAttribute('href') || '';
    const title = a.getAttribute('title') || '';
    const hrefTitle = decodeURIComponent(href.split('/wiki/')[1] || '').split('#')[0].replace(/_/g, ' ');
    const target = title || hrefTitle;
    if (!target || linkContexts.has(target)) continue;
    const block = a.closest('p,li,dd,td');
    const text = cleanBlockText(block);
    if (text.length >= 20) linkContexts.set(target, shortContext(text, a.textContent.trim() || target));
  }

  const linkedText = new Set();
  for (const a of doc.querySelectorAll('a')) {
    const label = a.textContent.replace(/\s+/g, ' ').trim();
    if (label) linkedText.add(label);
  }

  const unlinkedBlocks = [];
  for (const original of doc.querySelectorAll('p,li,dd,td')) {
    const clone = original.cloneNode(true);
    clone.querySelectorAll('a').forEach(a => a.remove());
    const text = cleanBlockText(clone);
    if (text.length >= 20) unlinkedBlocks.push(text);
  }

  const result = { links: [...new Set(links)], linkContexts, linkedText, unlinkedBlocks };
  articleCache.set(topicTitle, result);
  return result;
}

async function coordinatesForTitles(titles, source, topicTitle, token, contextMap = new Map()) {
  const found = [];
  for (let i = 0; i < titles.length; i += 50) {
    if (token !== requestToken) return [];
    const batch = titles.slice(i, i + 50);
    setStatus(`${topicTitle}：${source === 'link' ? 'リンク' : 'テキスト候補'}を照合中 ${Math.min(i + batch.length, titles.length)}/${titles.length}`);
    const params = new URLSearchParams({ action: 'query', format: 'json', origin: '*', prop: 'coordinates|pageprops', ppprop: 'wikibase_item', colimit: 'max', redirects: '1', titles: batch.join('|') });
    const data = await fetchJson('https://ja.wikipedia.org/w/api.php?' + params);

    // MediaWikiの正規化・リダイレクト後も、元リンクの本文文脈を引き継ぐ。
    const originalFor = new Map(batch.map(title => [title, title]));
    for (const item of data.query?.normalized || []) {
      const original = originalFor.get(item.from) || item.from;
      originalFor.set(item.to, original);
    }
    for (const item of data.query?.redirects || []) {
      const original = originalFor.get(item.from) || item.from;
      originalFor.set(item.to, original);
    }

    for (const page of Object.values(data.query?.pages || {})) {
      const c = page.coordinates?.[0];
      if (!c) continue;
      const originalTitle = originalFor.get(page.title) || page.title;
      const context = contextMap.get(page.title) || contextMap.get(originalTitle) || '';
      // 「記事内リンク」は、本文中で実際に使われた文脈が確認できるものだけ表示する。
      if (source === 'link' && !context) continue;
      found.push({
        qid: page.pageprops?.wikibase_item || `page-${page.pageid}`,
        title: page.title,
        lat: c.lat,
        lng: c.lon,
        wikiTitle: page.title,
        source,
        sourceContext: context
      });
    }
    if (i + 50 < titles.length) await sleep(30);
  }
  return dedupePlaces(found);
}

function dedupePlaces(items) {
  const seen = new Set();
  return items.filter(place => {
    const key = place.qid || `${place.lat},${place.lng},${place.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractTextCandidates(article) {
  const endings = '(?:城跡|城|館跡|館|陣跡|陣屋|屋敷跡|屋敷|御殿|門跡|門|櫓|砦|台場|寺院|寺|神社|神宮|宮|教会|墓地|墓所|古墳|遺跡|史跡|跡地|公園|庭園|港|港湾|駅|街道|通り|商店街|市場|町|村|郡|区|市|県|国|山|川|河|池|湖|島|湾|岬)';
  const regex = new RegExp(`[一-龠々ヶヵぁ-んァ-ヶA-Za-z0-9・ー]{2,28}${endings}`, 'g');
  const out = new Map();
  for (const block of article.unlinkedBlocks) {
    for (const match of block.matchAll(regex)) {
      const candidate = match[0].replace(/^[のをにはがとでへよりから]+/, '').trim();
      if (candidate.length < 2 || candidate.length > 30 || /^\d+年$/.test(candidate)) continue;
      if (article.linkedText.has(candidate)) continue;
      if (!out.has(candidate)) out.set(candidate, shortContext(block, candidate));
      if (out.size >= 350) return out;
    }
  }
  return out;
}

async function resolveCandidateTitles(candidateMap, topicTitle, token) {
  const resolved = [];
  const entries = [...candidateMap.entries()];
  for (let i = 0; i < entries.length; i += 10) {
    if (token !== requestToken) return [];
    const batch = entries.slice(i, i + 10);
    setStatus(`${topicTitle}：本文候補を検索中 ${Math.min(i + batch.length, entries.length)}/${entries.length}`);
    await Promise.all(batch.map(async ([candidate, context]) => {
      try {
        const params = new URLSearchParams({ action: 'query', format: 'json', origin: '*', list: 'search', srsearch: `"${candidate}"`, srnamespace: '0', srlimit: '3' });
        const data = await fetchJson('https://ja.wikipedia.org/w/api.php?' + params);
        const hits = data.query?.search || [];
        const exact = hits.find(hit => hit.title === candidate) || hits[0];
        if (exact) resolved.push({ title: exact.title, context });
      } catch (error) { console.warn('candidate', candidate, error); }
    }));
    if (i + 10 < entries.length) await sleep(35);
    if (resolved.length >= 500) break;
  }
  return resolved;
}

async function loadLinkTab() {
  if (!selectedTopic) return;
  const token = ++requestToken;
  activeTab = 'links';
  updateTabs();
  renderPanelMessage('記事本文のリンクから、位置情報のある項目を探しています…');
  try {
    if (linkPlaceCache.has(selectedTopic.title)) {
      displayPlaces = linkPlaceCache.get(selectedTopic.title);
      finishRelatedTab('リンク', displayPlaces);
      return;
    }
    const article = await fetchArticle(selectedTopic.title);
    if (token !== requestToken) return;
    const result = await coordinatesForTitles(article.links, 'link', selectedTopic.title, token, article.linkContexts);
    if (token !== requestToken) return;
    linkPlaceCache.set(selectedTopic.title, result);
    displayPlaces = result;
    finishRelatedTab('リンク', result);
  } catch (error) {
    console.error(error);
    renderPanelMessage('この記事のリンクを取得できませんでした。');
    setStatus('リンクの取得に失敗しました。');
  }
}

async function loadTextTab() {
  if (!selectedTopic) return;
  const token = ++requestToken;
  activeTab = 'text';
  updateTabs();
  renderPanelMessage('リンクになっていない本文から、地名・施設名候補を探しています…');
  try {
    if (textPlaceCache.has(selectedTopic.title)) {
      displayPlaces = textPlaceCache.get(selectedTopic.title);
      finishRelatedTab('テキスト候補', displayPlaces);
      return;
    }
    const article = await fetchArticle(selectedTopic.title);
    if (token !== requestToken) return;
    const candidateMap = extractTextCandidates(article);
    const resolved = await resolveCandidateTitles(candidateMap, selectedTopic.title, token);
    if (token !== requestToken) return;
    const contextMap = new Map(resolved.map(item => [item.title, item.context]));
    const titles = [...new Set(resolved.map(item => item.title))];
    let result = await coordinatesForTitles(titles, 'text', selectedTopic.title, token, contextMap);
    if (token !== requestToken) return;

    let linkedPlaces = linkPlaceCache.get(selectedTopic.title);
    if (!linkedPlaces) {
      linkedPlaces = await coordinatesForTitles(article.links, 'link', selectedTopic.title, token, article.linkContexts);
      linkPlaceCache.set(selectedTopic.title, linkedPlaces);
    }
    const linkedQids = new Set(linkedPlaces.map(place => place.qid));
    result = result.filter(place => !linkedQids.has(place.qid));

    textPlaceCache.set(selectedTopic.title, result);
    displayPlaces = result;
    finishRelatedTab('テキスト候補', result);
  } catch (error) {
    console.error(error);
    renderPanelMessage('本文候補を取得できませんでした。');
    setStatus('テキスト候補の取得に失敗しました。');
  }
}

function finishRelatedTab(label, result) {
  renderRelatedList(result);
  renderMarkers();
  setStatus(`${selectedTopic.title}：${label} ${result.length}地点`);
  fitResults(result);
}
function fitResults(items) {
  if (!items.length) return;
  const bounds = L.latLngBounds(items.map(place => [place.lat, place.lng]));
  if (bounds.isValid()) map.fitBounds(bounds.pad(.12), { maxZoom: 15 });
}

async function fetchContextFromPage(pageTitle, topicTitle) {
  const cacheKey = `${pageTitle}=>${topicTitle}`;
  if (pageContextCache.has(cacheKey)) return pageContextCache.get(cacheKey);
  try {
    const params = new URLSearchParams({ action: 'parse', format: 'json', origin: '*', page: pageTitle, prop: 'text', disableeditsection: '1' });
    const data = await fetchJson('https://ja.wikipedia.org/w/api.php?' + params);
    const doc = new DOMParser().parseFromString(data.parse?.text?.['*'] || '', 'text/html');
    let context = '';
    for (const a of doc.querySelectorAll('a')) {
      const href = a.getAttribute('href') || '';
      const title = a.getAttribute('title') || '';
      const hrefTitle = decodeURIComponent(href.split('/wiki/')[1] || '').split('#')[0].replace(/_/g, ' ');
      if (title === topicTitle || hrefTitle === topicTitle) {
        const text = cleanBlockText(a.closest('p,li,dd,td'));
        if (text.length >= 20) { context = shortContext(text, a.textContent.trim() || topicTitle); break; }
      }
    }
    pageContextCache.set(cacheKey, context);
    return context;
  } catch (_) {
    pageContextCache.set(cacheKey, '');
    return '';
  }
}

function popupHtml(place) {
  const wiki = place.wikiTitle ? `<a href="${wikipediaUrl(place.wikiTitle)}" target="_blank" rel="noopener">Wikipedia</a>` : '';
  const wd = place.qid?.startsWith('Q') ? `<a href="${wikidataUrl(place.qid)}" target="_blank" rel="noopener">Wikidata</a>` : '';
  const google = `<a href="https://www.google.com/maps/search/?api=1&query=${place.lat},${place.lng}" target="_blank" rel="noopener">Google Maps</a>`;
  let quote = '';
  if (selectedTopic && place.sourceContext) {
    const label = place.source === 'local' ? `${selectedTopic.title}との関わり` : `「${selectedTopic.title}」での記述`;
    quote = `<div class="topic-context"><div class="topic-context-label">${escapeHtml(label)}</div><div class="topic-context-text">${escapeHtml(place.sourceContext)}</div></div>`;
  } else if (selectedTopic && place.source === 'local' && place.wikiTitle) {
    quote = '<div class="topic-context"><div class="topic-context-label">関わり</div><div class="topic-context-text">該当箇所を読み込み中…</div></div>';
  }
  const type = place.source === 'link' ? '記事内リンク' : place.source === 'text' ? '非リンク本文候補' : escapeHtml(place.qid || '');
  return `<div class="place-popup-title">${escapeHtml(place.title)}</div><div class="place-popup-meta">${type}</div>${quote}<div class="place-popup-links">${wiki}${wd}${google}</div>`;
}

function recordPlaceHistory(place) {
  if (!selectedTopic) return;
  addHistory({ kind: 'place', topicTitle: selectedTopic.title, placeTitle: place.title, qid: place.qid, source: place.source, lat: place.lat, lng: place.lng, wikiTitle: place.wikiTitle, context: place.sourceContext || '' });
}

function renderMarkers() {
  markerLayer.clearLayers();
  for (const place of displayPlaces) {
    const icon = place.source === 'link' ? linkIcon : place.source === 'text' ? textIcon : markerIcon;
    const marker = L.marker([place.lat, place.lng], { icon, title: place.title }).bindPopup(() => popupHtml(place), { maxWidth: 340 });
    marker.on('popupopen', async () => {
      recordPlaceHistory(place);
      if (selectedTopic && place.source === 'local' && place.wikiTitle && !place.sourceContext) {
        place.sourceContext = await fetchContextFromPage(place.wikiTitle, selectedTopic.title);
        marker.setPopupContent(popupHtml(place));
      }
    });
    marker.addTo(markerLayer);
  }
}

function renderTopics() {
  els.list.className = 'topic-list';
  els.list.replaceChildren();
  els.count.textContent = topics.length ? `${topics.length}件` : '';
  if (!topics.length) return renderPanelMessage('トピックが見つかりませんでした。');
  for (const topic of topics) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'topic-chip';
    button.textContent = `${topic.title} ${topic.count}`;
    if (selectedTopic?.title === topic.title) button.classList.add('active');
    button.addEventListener('click', () => selectTopic(topic));
    els.list.append(button);
  }
}

function openPlace(place) {
  recordPlaceHistory(place);
  map.setView([place.lat, place.lng], Math.max(map.getZoom(), 16));
  for (const layer of markerLayer.getLayers()) {
    if (!layer.getLatLng) continue;
    const ll = layer.getLatLng();
    if (Math.abs(ll.lat - place.lat) < 1e-8 && Math.abs(ll.lng - place.lng) < 1e-8) { layer.openPopup(); break; }
  }
}

function renderRelatedList(items) {
  els.list.replaceChildren();
  els.count.textContent = `${items.length}件`;
  if (!items.length) return renderPanelMessage('本文中で関係を確認でき、位置情報もある候補は見つかりませんでした。');
  els.list.className = 'topic-list search-results';
  for (const place of items) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'search-result';
    const sourceLabel = place.source === 'link' ? 'リンク' : '非リンク本文';
    const context = place.sourceContext || '本文中の候補として検出されました。';
    row.innerHTML = `<span class="search-result-title">${escapeHtml(place.title)}</span><span class="search-result-context">${escapeHtml(context)}</span><span class="search-result-meta"><span class="search-result-badge">${sourceLabel}</span><span class="search-result-badge">位置情報あり</span></span>`;
    row.addEventListener('click', () => openPlace(place));
    els.list.append(row);
  }
}

function renderHistory() {
  els.list.className = 'topic-list history-results';
  els.list.replaceChildren();
  const history = readHistory();
  els.count.textContent = history.length ? `${history.length}件` : '';
  if (!history.length) return renderPanelMessage('まだ履歴はありません。トピックや地点を開くとここに残ります。');
  const clearButton = document.createElement('button');
  clearButton.type = 'button';
  clearButton.className = 'history-clear';
  clearButton.textContent = '履歴を消去';
  clearButton.addEventListener('click', () => { writeHistory([]); renderHistory(); });
  els.list.append(clearButton);
  for (const item of history) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'history-result';
    const date = new Date(item.ts);
    const when = `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    if (item.kind === 'topic') {
      row.innerHTML = `<span class="history-kind">トピック</span><span class="history-title">${escapeHtml(item.topicTitle)}</span><span class="history-meta">${when}</span>`;
      row.addEventListener('click', () => selectTopic(topics.find(t => t.title === item.topicTitle) || { title: item.topicTitle, count: 0, placeIds: [] }));
    } else {
      const source = item.source === 'link' ? 'リンク' : item.source === 'text' ? 'テキスト候補' : 'この範囲';
      row.innerHTML = `<span class="history-kind">${source}</span><span class="history-title">${escapeHtml(item.placeTitle)}</span><span class="history-parent">${escapeHtml(item.topicTitle)}</span><span class="history-meta">${when}</span>`;
      row.addEventListener('click', () => {
        selectedTopic = { title: item.topicTitle, count: 0, placeIds: [] };
        els.selection.hidden = false;
        els.selectionText.textContent = item.topicTitle;
        displayPlaces = [{ qid: item.qid, title: item.placeTitle, lat: item.lat, lng: item.lng, wikiTitle: item.wikiTitle, source: item.source, sourceContext: item.context || '' }];
        renderMarkers();
        map.setView([item.lat, item.lng], 16);
        setTimeout(() => markerLayer.getLayers()[0]?.openPopup(), 0);
      });
    }
    els.list.append(row);
  }
}

function renderPanelMessage(text) {
  els.list.replaceChildren();
  const message = document.createElement('div');
  message.className = 'panel-message';
  message.textContent = text;
  els.list.append(message);
}

function updateTabs() {
  for (const button of els.tabs) {
    const tab = button.dataset.tab;
    button.classList.toggle('active', tab === activeTab);
    button.setAttribute('aria-selected', String(tab === activeTab));
    button.disabled = (tab === 'links' || tab === 'text') && !selectedTopic;
  }
  els.title.textContent = activeTab === 'topics' ? 'この周辺のトピック' : activeTab === 'history' ? '履歴' : selectedTopic?.title || 'トピックを選択';
}

function localPlacesForTopic(topic) {
  const ids = new Set(topic.placeIds || []);
  return places.filter(place => ids.has(place.qid));
}
function showTopics() {
  requestToken++;
  activeTab = 'topics';
  displayPlaces = selectedTopic ? localPlacesForTopic(selectedTopic) : places;
  updateTabs(); renderTopics(); renderMarkers();
  setStatus(selectedTopic ? `${selectedTopic.title}：この範囲 ${displayPlaces.length}地点` : `${places.length}地点・${topics.length}トピック`);
}
function selectTopic(topic) {
  requestToken++;
  selectedTopic = topic;
  activeTab = 'topics';
  displayPlaces = localPlacesForTopic(topic);
  els.selection.hidden = false;
  els.selectionText.textContent = topic.title;
  addHistory({ kind: 'topic', topicTitle: topic.title });
  updateTabs(); renderTopics(); renderMarkers();
  setStatus(`${topic.title}：この範囲 ${displayPlaces.length}地点`);
}
function clearTopic() {
  requestToken++;
  selectedTopic = null;
  activeTab = 'topics';
  displayPlaces = places;
  els.selection.hidden = true;
  updateTabs(); renderTopics(); renderMarkers();
  setStatus(`${places.length}地点を表示中`);
}

async function loadArea() {
  requestToken++;
  els.load.disabled = true;
  els.load.textContent = '読み込み中…';
  selectedTopic = null;
  activeTab = 'topics';
  els.selection.hidden = true;
  els.sheet.classList.remove('open');
  updateTabs();
  try {
    setStatus('Wikidataから地点を取得中…');
    places = await fetchWikidataPlaces(map.getBounds());
    displayPlaces = places;
    renderMarkers();
    const wikiCount = places.filter(place => place.wikiTitle).length;
    setStatus(`${places.length}地点 / Wikipedia ${wikiCount}記事`);
    await enrichWikipediaLinks(places);
    topics = buildTopics(places);
    renderTopics(); renderMarkers();
    setStatus(`${places.length}地点・${topics.length}トピック`);
    els.sheet.classList.remove('has-results');
    void els.sheet.offsetWidth;
    els.sheet.classList.add('has-results');
  } catch (error) {
    console.error(error);
    setStatus('読み込みに失敗しました。範囲を少し狭めて再試行してください。');
  } finally {
    els.load.disabled = false;
    els.load.textContent = 'この範囲を読み込む';
  }
}

els.load.addEventListener('click', loadArea);
els.handle.addEventListener('click', () => {
  const open = els.sheet.classList.toggle('open');
  els.handle.setAttribute('aria-expanded', String(open));
});
els.clear.addEventListener('click', clearTopic);
for (const button of els.tabs) {
  button.addEventListener('click', () => {
    const tab = button.dataset.tab;
    if (tab === 'topics') showTopics();
    else if (tab === 'links') loadLinkTab();
    else if (tab === 'text') loadTextTab();
    else if (tab === 'history') { requestToken++; activeTab = 'history'; updateTabs(); renderHistory(); setStatus('閲覧履歴'); }
  });
}
map.on('movestart', () => {
  if (!els.load.disabled && !selectedTopic && activeTab !== 'history') setStatus('移動後「この範囲を読み込む」で更新');
});

updateTabs();