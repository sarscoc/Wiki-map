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
  trail: document.getElementById('trailBar'),
  trailText: document.getElementById('trailText'),
  clear: document.getElementById('clearTrailButton'),
  filters: document.getElementById('topicFilters'),
  filterButtons: [...document.querySelectorAll('.topic-filter')],
  tabs: [...document.querySelectorAll('.sheet-tab')]
};

const markerLayer = L.layerGroup().addTo(map);
const rootMarkerIcon = L.divIcon({ className: '', html: '<div class="wiki-marker"></div>', iconSize: [12, 12], iconAnchor: [6, 6] });
const topicMarkerIcon = L.divIcon({ className: '', html: '<div class="wiki-marker related-marker"></div>', iconSize: [14, 14], iconAnchor: [7, 7] });

let areaPlaces = [];
let rootTopics = [];
let currentTopics = [];
let drillTrail = [];
let activeTab = 'topics';
let requestToken = 0;

const articleCache = new Map();
const metadataCache = new Map();
const HISTORY_KEY = 'wiki-map-history-v2';
const TYPE_CACHE_KEY = 'wiki-map-topic-types-v7';

const filterState = {
  transit_stop: false,
  route: false,
  numbered_road: false,
  transit_operator: false,
  place: false,
  date: false,
  org: false,
  common: false
};

const typeCache = new Map();
try {
  const saved = JSON.parse(localStorage.getItem(TYPE_CACHE_KEY) || '{}');
  for (const [key, value] of Object.entries(saved)) typeCache.set(key, value);
} catch (_) {}

const exactTypes = {
  transit_stop: new Set(['鉄道駅','駅','停留場','停留所','バス停','バスターミナル','地下鉄駅','路面電車停留場','railway station','train station','bus stop','tram stop','metro station','bus station'].map(v => v.toLowerCase())),
  route: new Set(['鉄道路線','地下鉄路線','高速鉄道路線','路面電車路線','バス路線','railway line','rapid transit line','tram line','bus route'].map(v => v.toLowerCase())),
  transit_operator: new Set(['鉄道事業者','鉄道会社','バス事業者','バス会社','交通事業者','公共交通事業者','railway company','rail transport company','bus company','public transport operator','transport company'].map(v => v.toLowerCase())),
  place: new Set(['行政区画','行政区域','行政区','都市','市町村','市','町','村','区','都道府県','県','国','国家','島','地方','地域','地理的地域','集落','地区','郡','大字','町丁','住宅地','地名','human settlement','administrative territorial entity','administrative division','ward','city','town','village','prefecture','country','island','geographic region','district','neighborhood','locality'].map(v => v.toLowerCase())),
  date: new Set(['年','暦日','日付','世紀','年代','元号','時代区分','year','calendar date','century','decade','era'].map(v => v.toLowerCase())),
  org: new Set(['企業','会社','株式会社','法人','組織','団体','学校','大学','銀行','事業者','病院','新聞社','出版社','company','business','organization','organisation','corporation','university','school','bank','hospital','publisher'].map(v => v.toLowerCase())),
  common: new Set(['概念','用語','現象','活動','学問分野','分野','ジャンル','職業','制度','思想','理論','技法','単位','識別子','コード','一覧','座標系','郵便番号','concept','term','phenomenon','activity','academic discipline','genre','occupation','system','theory','unit','identifier','code','list','coordinate system','postal code'].map(v => v.toLowerCase()))
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function setStatus(text) { els.status.textContent = text; }
function wikipediaUrl(title) { return `https://ja.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`; }
function wikidataUrl(qid) { return `https://www.wikidata.org/wiki/${encodeURIComponent(qid)}`; }
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
function addHistory(title, parent = '') {
  const items = readHistory().filter(item => item.title !== title);
  items.unshift({ title, parent, ts: Date.now() });
  writeHistory(items);
}

function obviousCategory(title) {
  if (/^(?:\d{3,4}年|\d{1,2}月\d{1,2}日|\d{1,2}月|\d{1,2}日|\d{1,2}世紀|\d{3,4}年代)$/.test(title) || /^(?:明治|大正|昭和|平成|令和)(?:\d+年?)?$/.test(title)) return 'date';
  if (/(?:国道|県道|都道|府道|道道)\s*\d+号/.test(title)) return 'numbered_road';
  if (/(?:駅|停留場|停留所|バス停|バスターミナル|停車場)$/.test(title)) return 'transit_stop';
  if (/(?:地下鉄|鉄道|新幹線|モノレール|市電|路面電車).*(?:線|路線)$/.test(title) || /(?:本線|支線)$/.test(title)) return 'route';
  if (/^(?:JR九州|西日本鉄道|西鉄バス|福岡市交通局|福岡市地下鉄)$/.test(title) || /(?:鉄道会社|バス会社|交通局)$/.test(title)) return 'transit_operator';
  if (/\((?:[^)]+市|[^)]+県|[^)]+区|[^)]+町|[^)]+村)\)$/.test(title) || (/(?:都|府|県|市|区|町|村|郡|地方|地区|地域)$/.test(title) && !/(?:会社|大学|学校|病院)$/.test(title))) return 'place';
  if (/(?:株式会社|有限会社|会社|銀行|大学|学校|中学校|高等学校|小学校|病院|新聞社|放送局|協会|財団|法人)$/.test(title)) return 'org';
  if (/^(?:ISBN(?: \(識別子\))?|UTC(?:[+-]\d+)?|メートル|地理座標系|日本の郵便番号|学校コード|国の一覧|都市計画|用途地域)$/.test(title) || /一覧$/.test(title)) return 'common';
  return null;
}

function categoryFromLabels(labels) {
  const set = new Set(labels.map(value => String(value).trim().toLowerCase()));
  for (const category of ['transit_stop','route','transit_operator','date','org','place','common']) {
    for (const type of exactTypes[category]) if (set.has(type)) return category;
  }
  return 'other';
}

function saveTypeCache() {
  try {
    const object = {};
    let n = 0;
    for (const [key, value] of typeCache) {
      object[key] = value;
      if (++n >= 6000) break;
    }
    localStorage.setItem(TYPE_CACHE_KEY, JSON.stringify(object));
  } catch (_) {}
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
  const data = await fetchJson('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(query), { headers: { Accept: 'application/sparql-results+json' } });
  const byId = new Map();
  for (const row of data.results.bindings) {
    const qid = row.item.value.split('/').pop();
    const match = row.location.value.match(/Point\(([-\d.]+) ([-\d.]+)\)/);
    if (!match) continue;
    const place = byId.get(qid) || { qid, title: row.itemLabel?.value || qid, lat: +match[2], lng: +match[1], wikiTitle: null };
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

async function buildRootTopics(items) {
  const withWiki = items.filter(place => place.wikiTitle);
  const counts = new Map();
  for (let i = 0; i < withWiki.length; i += 4) {
    const batch = withWiki.slice(i, i + 4);
    setStatus(`周辺記事を読込中 ${Math.min(i + batch.length, withWiki.length)}/${withWiki.length}`);
    await Promise.all(batch.map(async place => {
      try {
        const links = await fetchPageLinks(place.wikiTitle);
        for (const title of links) {
          const topic = counts.get(title) || { title, count: 0, context: '', source: 'area' };
          topic.count += 1;
          counts.set(title, topic);
        }
      } catch (error) { console.warn('links', place.wikiTitle, error); }
    }));
    if (i + 4 < withWiki.length) await sleep(40);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.title.localeCompare(b.title, 'ja'));
}

function cleanBlockText(node) {
  return (node?.textContent || '').replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
}
function shortContext(text, needle = '', max = 260) {
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

function removeSection(doc, headingNames) {
  for (const heading of [...doc.querySelectorAll('h2')]) {
    const title = (heading.querySelector('.mw-headline')?.textContent || heading.textContent || '').replace(/\[編集\]/g, '').trim();
    if (!headingNames.has(title)) continue;
    let node = heading;
    while (node) {
      const next = node.nextElementSibling;
      node.remove();
      if (!next || next.tagName === 'H2') break;
      node = next;
    }
  }
}

async function fetchArticleTopics(title) {
  if (articleCache.has(title)) return articleCache.get(title);
  const params = new URLSearchParams({ action: 'parse', format: 'json', origin: '*', page: title, prop: 'text', disableeditsection: '1' });
  const data = await fetchJson('https://ja.wikipedia.org/w/api.php?' + params);
  const html = data.parse?.text?.['*'] || '';
  const doc = new DOMParser().parseFromString(html, 'text/html');

  doc.querySelectorAll('style,script,sup,.mw-editsection,.navbox,.vertical-navbox,.sidebar,.metadata,.ambox,.reflist,.catlinks').forEach(node => node.remove());
  removeSection(doc, new Set(['脚注','注釈','出典','参考文献','関連項目','外部リンク','参考資料','参考文献・出典']));

  const topics = new Map();
  for (const anchor of doc.querySelectorAll('a')) {
    const href = anchor.getAttribute('href') || '';
    const attrTitle = anchor.getAttribute('title') || '';
    const hrefTitle = decodeURIComponent(href.split('/wiki/')[1] || '').split('#')[0].replace(/_/g, ' ');
    const target = attrTitle || hrefTitle;
    if (!target || target.includes(':') || target === title) continue;
    const block = anchor.closest('p,li,dd,td,th');
    const text = cleanBlockText(block);
    if (text.length < 20) continue;
    const label = anchor.textContent.replace(/\s+/g, ' ').trim() || target;
    const current = topics.get(target) || { title: target, count: 0, context: shortContext(text, label), source: 'article' };
    current.count += 1;
    if (!current.context) current.context = shortContext(text, label);
    topics.set(target, current);
  }

  const result = [...topics.values()].sort((a, b) => b.count - a.count || a.title.localeCompare(b.title, 'ja'));
  articleCache.set(title, result);
  return result;
}

async function enrichTopicMetadata(topics, token) {
  const unresolved = [];
  for (const topic of topics) {
    const obvious = obviousCategory(topic.title);
    const cachedCategory = typeCache.get(topic.title);
    const cachedMeta = metadataCache.get(topic.title);
    if (cachedMeta) {
      Object.assign(topic, cachedMeta);
      continue;
    }
    if (obvious || cachedCategory) topic.category = obvious || cachedCategory;
    unresolved.push(topic);
  }

  for (let i = 0; i < unresolved.length; i += 50) {
    if (token !== requestToken) return [];
    const batch = unresolved.slice(i, i + 50);
    setStatus(`トピックを整理中 ${Math.min(i + batch.length, unresolved.length)}/${unresolved.length}`);
    try {
      const params = new URLSearchParams({ action: 'query', format: 'json', origin: '*', prop: 'coordinates|pageprops', ppprop: 'wikibase_item', colimit: 'max', redirects: '1', titles: batch.map(item => item.title).join('|') });
      const data = await fetchJson('https://ja.wikipedia.org/w/api.php?' + params);
      const originalFor = new Map(batch.map(item => [item.title, item.title]));
      for (const item of data.query?.normalized || []) originalFor.set(item.to, originalFor.get(item.from) || item.from);
      for (const item of data.query?.redirects || []) originalFor.set(item.to, originalFor.get(item.from) || item.from);

      const byQid = new Map();
      const qids = [];
      for (const page of Object.values(data.query?.pages || {})) {
        const originalTitle = originalFor.get(page.title) || page.title;
        const topic = batch.find(item => item.title === originalTitle) || batch.find(item => item.title === page.title);
        if (!topic) continue;
        topic.wikiTitle = page.title;
        const c = page.coordinates?.[0];
        if (c) { topic.lat = c.lat; topic.lng = c.lon; }
        const qid = page.pageprops?.wikibase_item;
        if (qid) {
          topic.qid = qid;
          byQid.set(qid, topic);
          qids.push(qid);
        }
      }

      if (qids.length) {
        const claimParams = new URLSearchParams({ action: 'wbgetentities', format: 'json', origin: '*', ids: [...new Set(qids)].join('|'), props: 'claims' });
        const entities = await fetchJson('https://www.wikidata.org/w/api.php?' + claimParams);
        const typeIds = new Set();
        const itemTypes = new Map();
        for (const qid of byQid.keys()) {
          const ids = (entities.entities?.[qid]?.claims?.P31 || []).map(claim => claim.mainsnak?.datavalue?.value?.id).filter(Boolean);
          itemTypes.set(qid, ids);
          ids.forEach(id => typeIds.add(id));
        }
        const labels = new Map();
        const allTypes = [...typeIds];
        for (let j = 0; j < allTypes.length; j += 50) {
          const part = allTypes.slice(j, j + 50);
          const labelParams = new URLSearchParams({ action: 'wbgetentities', format: 'json', origin: '*', ids: part.join('|'), props: 'labels', languages: 'ja|en' });
          const labelData = await fetchJson('https://www.wikidata.org/w/api.php?' + labelParams);
          for (const id of part) {
            const entity = labelData.entities?.[id];
            labels.set(id, [entity?.labels?.ja?.value, entity?.labels?.en?.value].filter(Boolean));
          }
        }
        for (const [qid, topic] of byQid) {
          if (!topic.category) {
            const names = (itemTypes.get(qid) || []).flatMap(id => labels.get(id) || []);
            topic.category = categoryFromLabels(names);
          }
        }
      }

      for (const topic of batch) {
        if (!topic.category) topic.category = obviousCategory(topic.title) || 'other';
        typeCache.set(topic.title, topic.category);
        metadataCache.set(topic.title, { category: topic.category, qid: topic.qid, wikiTitle: topic.wikiTitle, lat: topic.lat, lng: topic.lng });
      }
    } catch (error) {
      console.warn('metadata batch', error);
      for (const topic of batch) {
        if (!topic.category) topic.category = obviousCategory(topic.title) || typeCache.get(topic.title) || 'other';
      }
    }
    if (i + 50 < unresolved.length) await sleep(25);
  }
  saveTypeCache();
  return topics;
}

function isVisibleTopic(topic) {
  return topic.category === 'other' || !!filterState[topic.category];
}

function filteredTopics() {
  return currentTopics.filter(isVisibleTopic);
}

function updateFilterButtons() {
  for (const button of els.filterButtons) {
    const category = button.dataset.category;
    button.classList.toggle('active', !!filterState[category]);
    button.setAttribute('aria-pressed', String(!!filterState[category]));
  }
}

function renderRootMarkers() {
  markerLayer.clearLayers();
  for (const place of areaPlaces) {
    const marker = L.marker([place.lat, place.lng], { icon: rootMarkerIcon, title: place.title });
    const wiki = place.wikiTitle ? `<a href="${wikipediaUrl(place.wikiTitle)}" target="_blank" rel="noopener">Wikipedia</a>` : '';
    const wd = place.qid ? `<a href="${wikidataUrl(place.qid)}" target="_blank" rel="noopener">Wikidata</a>` : '';
    marker.bindPopup(`<div class="place-popup-title">${escapeHtml(place.title)}</div><div class="place-popup-links">${wiki}${wd}</div>`, { maxWidth: 320 });
    marker.addTo(markerLayer);
  }
}

function renderTopicMarkers() {
  markerLayer.clearLayers();
  for (const topic of filteredTopics()) {
    if (!Number.isFinite(topic.lat) || !Number.isFinite(topic.lng)) continue;
    const marker = L.marker([topic.lat, topic.lng], { icon: topicMarkerIcon, title: topic.title });
    const wiki = topic.wikiTitle ? `<a href="${wikipediaUrl(topic.wikiTitle)}" target="_blank" rel="noopener">Wikipedia</a>` : '';
    const wd = topic.qid ? `<a href="${wikidataUrl(topic.qid)}" target="_blank" rel="noopener">Wikidata</a>` : '';
    const google = `<a href="https://www.google.com/maps/search/?api=1&query=${topic.lat},${topic.lng}" target="_blank" rel="noopener">Google Maps</a>`;
    marker.bindPopup(`<div class="place-popup-title">${escapeHtml(topic.title)}</div><div class="topic-context"><div class="topic-context-label">${escapeHtml(drillTrail.at(-1) || '')}での記述</div><div class="topic-context-text">${escapeHtml(topic.context || '')}</div></div><div class="place-popup-links">${wiki}${wd}${google}</div>`, { maxWidth: 340 });
    marker.addTo(markerLayer);
  }
}

function updateTrail() {
  if (!drillTrail.length) {
    els.trail.hidden = true;
    els.trailText.textContent = '';
    return;
  }
  els.trail.hidden = false;
  els.trailText.textContent = `現在地 ＞ ${drillTrail.join(' ＞ ')}`;
}

function renderTopics() {
  els.list.replaceChildren();
  els.list.className = drillTrail.length ? 'topic-list search-results' : 'topic-list';
  const visible = filteredTopics();
  els.count.textContent = `${visible.length}/${currentTopics.length}`;
  if (!visible.length) {
    const message = document.createElement('div');
    message.className = 'panel-message';
    message.textContent = '表示できるトピックがありません。SHOWからカテゴリを追加できます。';
    els.list.append(message);
    return;
  }

  if (!drillTrail.length) {
    for (const topic of visible) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'topic-chip';
      button.textContent = `${topic.title} ${topic.count}`;
      button.addEventListener('click', () => drillInto(topic.title));
      els.list.append(button);
    }
    return;
  }

  for (const topic of visible) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'search-result';
    const pinBadge = Number.isFinite(topic.lat) && Number.isFinite(topic.lng) ? '<span class="search-result-badge">地図あり</span>' : '';
    row.innerHTML = `<span class="search-result-title">${escapeHtml(topic.title)}</span><span class="search-result-context">${escapeHtml(topic.context || '本文内リンク')}</span><span class="search-result-meta"><span class="search-result-badge">記事トピック</span>${pinBadge}<span class="search-result-badge">${topic.count}回</span></span>`;
    row.addEventListener('click', () => drillInto(topic.wikiTitle || topic.title));
    els.list.append(row);
  }
}

function renderHistory() {
  els.list.replaceChildren();
  els.list.className = 'topic-list history-results';
  const history = readHistory();
  els.count.textContent = history.length ? `${history.length}件` : '';
  if (!history.length) {
    const message = document.createElement('div');
    message.className = 'panel-message';
    message.textContent = 'まだ履歴はありません。トピックを掘るとここに残ります。';
    els.list.append(message);
    return;
  }
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'history-clear';
  clear.textContent = '履歴を消去';
  clear.addEventListener('click', () => { writeHistory([]); renderHistory(); });
  els.list.append(clear);
  for (const item of history) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'history-result';
    const date = new Date(item.ts);
    const when = `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    row.innerHTML = `<span class="history-kind">記事</span><span class="history-title">${escapeHtml(item.title)}</span>${item.parent ? `<span class="history-parent">${escapeHtml(item.parent)} から</span>` : ''}<span class="history-meta">${when}</span>`;
    row.addEventListener('click', () => drillInto(item.title, true));
    els.list.append(row);
  }
}

function updateTabs() {
  for (const button of els.tabs) {
    const tab = button.dataset.tab;
    button.classList.toggle('active', tab === activeTab);
    button.setAttribute('aria-selected', String(tab === activeTab));
  }
  els.filters.hidden = activeTab !== 'topics';
  els.title.textContent = activeTab === 'history' ? '履歴' : drillTrail.length ? `${drillTrail.at(-1)}の記事から` : 'この周辺のトピック';
}

async function drillInto(title, fromHistory = false) {
  const token = ++requestToken;
  activeTab = 'topics';
  updateTabs();
  const parent = drillTrail.at(-1) || '';
  if (fromHistory) drillTrail = [title];
  else drillTrail.push(title);
  updateTrail();
  els.list.replaceChildren();
  const loading = document.createElement('div');
  loading.className = 'panel-message';
  loading.textContent = `${title} の記事全文からトピックを探しています…`;
  els.list.append(loading);
  els.title.textContent = `${title}の記事から`;
  try {
    let articleTopics = await fetchArticleTopics(title);
    if (token !== requestToken) return;
    articleTopics = articleTopics.map(topic => ({ ...topic }));
    currentTopics = await enrichTopicMetadata(articleTopics, token);
    if (token !== requestToken) return;
    addHistory(title, parent);
    renderTopics();
    renderTopicMarkers();
    setStatus(`${title}：${currentTopics.length}トピック / 地図あり ${currentTopics.filter(topic => Number.isFinite(topic.lat) && Number.isFinite(topic.lng)).length}`);
    els.sheet.classList.add('open');
    els.handle.setAttribute('aria-expanded', 'true');
  } catch (error) {
    console.error(error);
    currentTopics = [];
    renderTopics();
    setStatus(`${title} の記事を読み込めませんでした。`);
  }
}

function resetToRoot() {
  requestToken++;
  drillTrail = [];
  activeTab = 'topics';
  currentTopics = rootTopics;
  updateTrail();
  updateTabs();
  renderTopics();
  renderRootMarkers();
  setStatus(`${areaPlaces.length}地点・${rootTopics.length}トピック`);
}

async function loadArea() {
  const token = ++requestToken;
  els.load.disabled = true;
  els.load.textContent = '読み込み中…';
  drillTrail = [];
  activeTab = 'topics';
  updateTrail();
  updateTabs();
  els.sheet.classList.remove('open');
  try {
    setStatus('Wikidataから周辺地点を取得中…');
    areaPlaces = await fetchWikidataPlaces(map.getBounds());
    if (token !== requestToken) return;
    renderRootMarkers();
    const rawTopics = await buildRootTopics(areaPlaces);
    if (token !== requestToken) return;
    currentTopics = rawTopics.map(topic => ({ ...topic }));
    rootTopics = await enrichTopicMetadata(currentTopics, token);
    if (token !== requestToken) return;
    currentTopics = rootTopics;
    renderTopics();
    setStatus(`${areaPlaces.length}地点・${rootTopics.length}トピック`);
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
els.clear.addEventListener('click', resetToRoot);
for (const button of els.filterButtons) {
  button.addEventListener('click', () => {
    const category = button.dataset.category;
    filterState[category] = !filterState[category];
    updateFilterButtons();
    if (activeTab === 'topics') {
      renderTopics();
      if (drillTrail.length) renderTopicMarkers();
    }
  });
}
for (const button of els.tabs) {
  button.addEventListener('click', () => {
    activeTab = button.dataset.tab;
    updateTabs();
    if (activeTab === 'history') renderHistory();
    else renderTopics();
  });
}
map.on('movestart', () => {
  if (!els.load.disabled && !drillTrail.length) setStatus('移動後「この範囲を読み込む」で更新');
});

updateFilterButtons();
updateTrail();
updateTabs();
