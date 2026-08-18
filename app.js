const map=L.map('map',{zoomControl:false,preferCanvas:true}).setView([33.5902,130.4017],15);
L.control.zoom({position:'bottomright'}).addTo(map);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap contributors'}).addTo(map);

const els={load:document.getElementById('loadAreaButton'),status:document.getElementById('status'),sheet:document.getElementById('topicSheet'),handle:document.getElementById('sheetHandle'),count:document.getElementById('sheetCount'),list:document.getElementById('topicList'),selection:document.getElementById('selectionBar'),selectionText:document.getElementById('selectionText'),clear:document.getElementById('clearSelectionButton'),localMode:document.getElementById('localModeButton'),reverseMode:document.getElementById('reverseModeButton')};
const markerLayer=L.layerGroup().addTo(map);
let places=[],topics=[],selectedTopic=null,displayPlaces=[],relationMode='local',reverseCache=new Map(),selectionToken=0;
const markerIcon=L.divIcon({className:'',html:'<div class="wiki-marker"></div>',iconSize:[12,12],iconAnchor:[6,6]});
const reverseMarkerIcon=L.divIcon({className:'',html:'<div class="wiki-marker reverse-marker"></div>',iconSize:[14,14],iconAnchor:[7,7]});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function setStatus(text){els.status.textContent=text}
function wikidataUrl(qid){return `https://www.wikidata.org/wiki/${encodeURIComponent(qid)}`}
function wikipediaUrl(title){return `https://ja.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g,'_'))}`}
function escapeHtml(s=''){return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
async function fetchJson(url,options={}){const r=await fetch(url,options);if(!r.ok)throw new Error(`${r.status} ${r.statusText}`);return r.json()}

async function fetchWikidataPlaces(bounds){
 const sw=bounds.getSouthWest(),ne=bounds.getNorthEast();
 const query=`SELECT ?item ?itemLabel ?article ?location WHERE {\n SERVICE wikibase:box { ?item wdt:P625 ?location . bd:serviceParam wikibase:cornerWest \"Point(${sw.lng} ${sw.lat})\"^^geo:wktLiteral . bd:serviceParam wikibase:cornerEast \"Point(${ne.lng} ${ne.lat})\"^^geo:wktLiteral . }\n OPTIONAL { ?article schema:about ?item ; schema:isPartOf <https://ja.wikipedia.org/> . }\n SERVICE wikibase:label { bd:serviceParam wikibase:language \"ja\". }\n}\nLIMIT 1000`;
 const data=await fetchJson('https://query.wikidata.org/sparql?format=json&query='+encodeURIComponent(query),{headers:{Accept:'application/sparql-results+json'}});
 const byId=new Map();
 for(const row of data.results.bindings){const qid=row.item.value.split('/').pop();const m=row.location.value.match(/Point\(([-\d.]+) ([-\d.]+)\)/);if(!m)continue;const p=byId.get(qid)||{qid,title:row.itemLabel?.value||qid,lat:+m[2],lng:+m[1],wikiTitle:null,links:new Set(),contexts:new Map(),source:'local'};if(row.article?.value)p.wikiTitle=decodeURIComponent(row.article.value.split('/wiki/')[1]||'').replace(/_/g,' ');byId.set(qid,p)}
 return [...byId.values()];
}
async function fetchPageLinks(title){const links=new Set();let cont=null;for(let page=0;page<12;page++){const params=new URLSearchParams({action:'query',format:'json',origin:'*',prop:'links',titles:title,plnamespace:'0',pllimit:'max'});if(cont)params.set('plcontinue',cont);const data=await fetchJson('https://ja.wikipedia.org/w/api.php?'+params);const obj=Object.values(data.query?.pages||{})[0];for(const link of obj?.links||[])links.add(link.title);cont=data.continue?.plcontinue;if(!cont)break}return links}
async function enrichWikipediaLinks(items){const withWiki=items.filter(p=>p.wikiTitle);for(let i=0;i<withWiki.length;i+=4){const batch=withWiki.slice(i,i+4);setStatus(`Wikipediaリンクを取得中 ${Math.min(i+batch.length,withWiki.length)}/${withWiki.length}`);await Promise.all(batch.map(async p=>{try{p.links=await fetchPageLinks(p.wikiTitle)}catch(e){console.warn('links',p.wikiTitle,e)}}));if(i+4<withWiki.length)await sleep(60)}}
function buildTopics(items){const counts=new Map();for(const p of items){for(const title of p.links){const entry=counts.get(title)||{title,count:0,placeIds:[]};entry.count++;entry.placeIds.push(p.qid);counts.set(title,entry)}}return [...counts.values()].sort((a,b)=>b.count-a.count||a.title.localeCompare(b.title,'ja'))}

async function fetchBacklinks(topicTitle){
 const titles=[];let cont=null;
 // Up to 3000 Japanese Wikipedia articles linking to the selected topic.
 for(let page=0;page<6;page++){
  const params=new URLSearchParams({action:'query',format:'json',origin:'*',list:'backlinks',bltitle:topicTitle,blnamespace:'0',bllimit:'max',blfilterredir:'nonredirects'});if(cont)params.set('blcontinue',cont);
  const data=await fetchJson('https://ja.wikipedia.org/w/api.php?'+params);for(const row of data.query?.backlinks||[])titles.push(row.title);cont=data.continue?.blcontinue;if(!cont)break;
 }
 return [...new Set(titles)];
}
async function fetchCoordinatesForTitles(titles,topicTitle,token){
 const found=[];
 for(let i=0;i<titles.length;i+=50){
  if(token!==selectionToken)return [];
  const batch=titles.slice(i,i+50);setStatus(`${topicTitle}：逆引き地点を確認中 ${Math.min(i+batch.length,titles.length)}/${titles.length}`);
  const params=new URLSearchParams({action:'query',format:'json',origin:'*',prop:'coordinates|pageprops',ppprop:'wikibase_item',colimit:'max',titles:batch.join('|')});
  const data=await fetchJson('https://ja.wikipedia.org/w/api.php?'+params);
  for(const page of Object.values(data.query?.pages||{})){const c=page.coordinates?.[0];if(!c)continue;found.push({qid:page.pageprops?.wikibase_item||`page-${page.pageid}`,title:page.title,lat:c.lat,lng:c.lon,wikiTitle:page.title,links:new Set([topicTitle]),contexts:new Map(),source:'reverse'})}
  if(i+50<titles.length)await sleep(40);
 }
 return found;
}
async function loadReverseTopic(topic){
 const token=++selectionToken;
 if(reverseCache.has(topic.title)){displayPlaces=reverseCache.get(topic.title);relationMode='reverse';updateModeButtons();renderMarkers();setStatus(`${topic.title}：逆引き ${displayPlaces.length}地点`);fitReverseResults();enrichTopicContexts(topic,displayPlaces,token);return}
 try{setStatus(`${topic.title}：Wikipediaを逆引き中…`);const backlinks=await fetchBacklinks(topic.title);if(token!==selectionToken)return;setStatus(`${topic.title}：被リンク ${backlinks.length}記事`);const reversePlaces=await fetchCoordinatesForTitles(backlinks,topic.title,token);if(token!==selectionToken)return;reverseCache.set(topic.title,reversePlaces);displayPlaces=reversePlaces;relationMode='reverse';updateModeButtons();renderMarkers();setStatus(`${topic.title}：逆引き ${reversePlaces.length}地点 / ${backlinks.length}記事`);fitReverseResults();enrichTopicContexts(topic,reversePlaces,token)}catch(e){console.error(e);if(token===selectionToken)setStatus('逆引きに失敗しました。もう一度お試しください。')}
}
function fitReverseResults(){if(!displayPlaces.length)return;const bounds=L.latLngBounds(displayPlaces.map(p=>[p.lat,p.lng]));if(bounds.isValid())map.fitBounds(bounds.pad(.12),{maxZoom:15})}

async function fetchTopicContext(place,topicTitle){if(!place.wikiTitle)return '';if(place.contexts.has(topicTitle))return place.contexts.get(topicTitle);const params=new URLSearchParams({action:'parse',format:'json',origin:'*',page:place.wikiTitle,prop:'text',disableeditsection:'1'});try{const data=await fetchJson('https://ja.wikipedia.org/w/api.php?'+params),html=data.parse?.text?.['*']||'',doc=new DOMParser().parseFromString(html,'text/html');let context='';for(const a of doc.querySelectorAll('a')){const href=a.getAttribute('href')||'',title=a.getAttribute('title')||'',hrefTarget=decodeURIComponent(href.split('/wiki/')[1]||'').split('#')[0].replace(/_/g,' ');if(title===topicTitle||hrefTarget===topicTitle){const block=a.closest('p,li,dd,td');if(!block)continue;const text=block.textContent.replace(/\[[^\]]*\]/g,'').replace(/\s+/g,' ').trim();if(text.length>=20){context=text.length>260?text.slice(0,257)+'…':text;break}}}if(!context){const bodyText=doc.body?.textContent.replace(/\s+/g,' ').trim()||'',i=bodyText.indexOf(topicTitle);if(i>=0){const start=Math.max(0,i-90),end=Math.min(bodyText.length,i+topicTitle.length+150);context=(start>0?'…':'')+bodyText.slice(start,end)+(end<bodyText.length?'…':'')}}place.contexts.set(topicTitle,context);return context}catch(e){console.warn('context',place.wikiTitle,topicTitle,e);place.contexts.set(topicTitle,'');return ''}}
async function enrichTopicContexts(topic,items=displayPlaces,token=selectionToken){const related=items.filter(p=>p.wikiTitle);for(let i=0;i<related.length;i+=4){if(token!==selectionToken)return;const batch=related.slice(i,i+4);setStatus(`${topic.title} の文脈を取得中 ${Math.min(i+batch.length,related.length)}/${related.length}`);await Promise.all(batch.map(p=>fetchTopicContext(p,topic.title)));if(token===selectionToken)renderMarkers();if(i+4<related.length)await sleep(60)}if(token===selectionToken)setStatus(`${topic.title}：${relationMode==='reverse'?'逆引き':'この範囲'} ${related.length}地点`)}
function popupHtml(p){const wiki=p.wikiTitle?`<a href="${wikipediaUrl(p.wikiTitle)}" target="_blank" rel="noopener">Wikipedia</a>`:'',google=`<a href="https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}" target="_blank" rel="noopener">Google Maps</a>`;let context='';if(selectedTopic){const stored=p.contexts?.get(selectedTopic.title),body=stored===undefined?'文脈を読み込み中…':stored||'本文中の該当箇所を短く抽出できませんでした。';context=`<div class="topic-context"><div class="topic-context-label">${escapeHtml(selectedTopic.title)}との関わり</div><div class="topic-context-text">${escapeHtml(body)}</div></div>`}const wd=p.qid?.startsWith('Q')?`<a href="${wikidataUrl(p.qid)}" target="_blank" rel="noopener">Wikidata</a>`:'';return `<div class="place-popup-title">${escapeHtml(p.title)}</div><div class="place-popup-meta">${p.source==='reverse'?'逆引き · ':''}${escapeHtml(p.qid||'')}${p.wikiTitle?' · 日本語Wikipediaあり':''}</div>${context}<div class="place-popup-links">${wiki}${wd}${google}</div>`}
function renderMarkers(){markerLayer.clearLayers();for(const p of displayPlaces)L.marker([p.lat,p.lng],{icon:p.source==='reverse'?reverseMarkerIcon:markerIcon,title:p.title}).bindPopup(()=>popupHtml(p),{maxWidth:330}).addTo(markerLayer)}
function renderTopics(){els.list.replaceChildren();els.count.textContent=topics.length?`${topics.length}件`:'';if(!topics.length){const d=document.createElement('div');d.className='place-popup-meta';d.textContent='トピックが見つかりませんでした。';els.list.append(d);return}for(const t of topics){const b=document.createElement('button');b.type='button';b.className='topic-chip';b.textContent=`${t.title} ${t.count}`;if(selectedTopic?.title===t.title)b.classList.add('active');b.addEventListener('click',()=>selectTopic(t));els.list.append(b)}}
function localPlacesForTopic(topic){const ids=new Set(topic.placeIds);return places.filter(p=>ids.has(p.qid))}
function updateModeButtons(){els.localMode.classList.toggle('active',relationMode==='local');els.reverseMode.classList.toggle('active',relationMode==='reverse')}
function showLocalTopic(){if(!selectedTopic)return;selectionToken++;relationMode='local';displayPlaces=localPlacesForTopic(selectedTopic);updateModeButtons();renderMarkers();setStatus(`${selectedTopic.title}：この範囲 ${displayPlaces.length}地点`);enrichTopicContexts(selectedTopic,displayPlaces,selectionToken)}
function selectTopic(topic){selectionToken++;selectedTopic=topic;relationMode='local';displayPlaces=localPlacesForTopic(topic);els.selection.hidden=false;els.selectionText.textContent=`${topic.title} · ${topic.count}地点`;els.sheet.classList.remove('open');els.handle.setAttribute('aria-expanded','false');updateModeButtons();renderTopics();renderMarkers();enrichTopicContexts(topic,displayPlaces,selectionToken)}
function clearTopic(){selectionToken++;selectedTopic=null;relationMode='local';displayPlaces=places;els.selection.hidden=true;updateModeButtons();renderTopics();renderMarkers();setStatus(`${places.length}地点を表示中`)}
async function loadArea(){selectionToken++;els.load.disabled=true;els.load.textContent='読み込み中…';selectedTopic=null;relationMode='local';els.selection.hidden=true;els.sheet.classList.remove('open');try{setStatus('Wikidataから地点を取得中…');places=await fetchWikidataPlaces(map.getBounds());displayPlaces=places;renderMarkers();const wikiCount=places.filter(p=>p.wikiTitle).length;setStatus(`${places.length}地点 / Wikipedia ${wikiCount}記事`);await enrichWikipediaLinks(places);topics=buildTopics(places);renderTopics();renderMarkers();setStatus(`${places.length}地点・${topics.length}トピック`);els.sheet.classList.remove('has-results');void els.sheet.offsetWidth;els.sheet.classList.add('has-results')}catch(e){console.error(e);setStatus('読み込みに失敗しました。範囲を少し狭めて再試行してください。')}finally{els.load.disabled=false;els.load.textContent='この範囲を読み込む'}}
els.load.addEventListener('click',loadArea);els.handle.addEventListener('click',()=>{const open=els.sheet.classList.toggle('open');els.handle.setAttribute('aria-expanded',String(open))});els.clear.addEventListener('click',clearTopic);els.localMode.addEventListener('click',showLocalTopic);els.reverseMode.addEventListener('click',()=>{if(selectedTopic)loadReverseTopic(selectedTopic)});map.on('movestart',()=>{if(!els.load.disabled&&!selectedTopic)setStatus('移動後「この範囲を読み込む」で更新')});
