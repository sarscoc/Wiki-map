const map=L.map('map',{zoomControl:false,preferCanvas:true}).setView([33.5902,130.4017],15);
L.control.zoom({position:'bottomright'}).addTo(map);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap contributors'}).addTo(map);

const els={load:document.getElementById('loadAreaButton'),status:document.getElementById('status'),sheet:document.getElementById('topicSheet'),handle:document.getElementById('sheetHandle'),title:document.getElementById('sheetTitle'),count:document.getElementById('sheetCount'),list:document.getElementById('topicList'),selection:document.getElementById('selectionBar'),selectionText:document.getElementById('selectionText'),clear:document.getElementById('clearSelectionButton')};
const markerLayer=L.layerGroup().addTo(map);
let places=[];let topics=[];let selectedTopic=null;
const markerIcon=L.divIcon({className:'',html:'<div class="wiki-marker"></div>',iconSize:[12,12],iconAnchor:[6,6]});
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
 for(const row of data.results.bindings){const qid=row.item.value.split('/').pop();const m=row.location.value.match(/Point\(([-\d.]+) ([-\d.]+)\)/);if(!m)continue;const p=byId.get(qid)||{qid,title:row.itemLabel?.value||qid,lat:+m[2],lng:+m[1],wikiTitle:null,links:new Set(),contexts:new Map()};if(row.article?.value)p.wikiTitle=decodeURIComponent(row.article.value.split('/wiki/')[1]||'').replace(/_/g,' ');byId.set(qid,p)}
 return [...byId.values()];
}

async function fetchPageLinks(title){
 const links=new Set();let cont=null;
 // Follow substantially more continuation pages so uncommon links are not lost.
 for(let page=0;page<12;page++){
  const params=new URLSearchParams({action:'query',format:'json',origin:'*',prop:'links',titles:title,plnamespace:'0',pllimit:'max'});if(cont)params.set('plcontinue',cont);
  const data=await fetchJson('https://ja.wikipedia.org/w/api.php?'+params);const obj=Object.values(data.query?.pages||{})[0];for(const link of obj?.links||[])links.add(link.title);cont=data.continue?.plcontinue;if(!cont)break;
 }
 return links;
}

async function enrichWikipediaLinks(items){
 const withWiki=items.filter(p=>p.wikiTitle);
 for(let i=0;i<withWiki.length;i+=4){const batch=withWiki.slice(i,i+4);setStatus(`Wikipediaリンクを取得中 ${Math.min(i+batch.length,withWiki.length)}/${withWiki.length}`);await Promise.all(batch.map(async p=>{try{p.links=await fetchPageLinks(p.wikiTitle)}catch(e){console.warn('links',p.wikiTitle,e)}}));if(i+4<withWiki.length)await sleep(60)}
}

function buildTopics(items){
 const counts=new Map();
 for(const p of items){for(const title of p.links){const entry=counts.get(title)||{title,count:0,placeIds:[]};entry.count++;entry.placeIds.push(p.qid);counts.set(title,entry)}}
 // Keep the long tail: a topic mentioned by only one local article can be the useful historical clue.
 return [...counts.values()].sort((a,b)=>b.count-a.count||a.title.localeCompare(b.title,'ja'));
}

async function fetchTopicContext(place,topicTitle){
 if(!place.wikiTitle)return '';if(place.contexts.has(topicTitle))return place.contexts.get(topicTitle);
 const params=new URLSearchParams({action:'parse',format:'json',origin:'*',page:place.wikiTitle,prop:'text',disableeditsection:'1'});
 try{const data=await fetchJson('https://ja.wikipedia.org/w/api.php?'+params);const html=data.parse?.text?.['*']||'';const doc=new DOMParser().parseFromString(html,'text/html');let context='';for(const a of doc.querySelectorAll('a')){const href=a.getAttribute('href')||'',title=a.getAttribute('title')||'';const hrefTarget=decodeURIComponent(href.split('/wiki/')[1]||'').split('#')[0].replace(/_/g,' ');if(title===topicTitle||hrefTarget===topicTitle){const block=a.closest('p,li,dd,td');if(!block)continue;const text=block.textContent.replace(/\[[^\]]*\]/g,'').replace(/\s+/g,' ').trim();if(text.length>=20){context=text.length>260?text.slice(0,257)+'…':text;break}}}if(!context){const bodyText=doc.body?.textContent.replace(/\s+/g,' ').trim()||'',i=bodyText.indexOf(topicTitle);if(i>=0){const start=Math.max(0,i-90),end=Math.min(bodyText.length,i+topicTitle.length+150);context=(start>0?'…':'')+bodyText.slice(start,end)+(end<bodyText.length?'…':'')}}place.contexts.set(topicTitle,context);return context}catch(e){console.warn('context',place.wikiTitle,topicTitle,e);place.contexts.set(topicTitle,'');return ''}
}
async function enrichTopicContexts(topic){const ids=new Set(topic.placeIds),related=places.filter(p=>ids.has(p.qid)&&p.wikiTitle);for(let i=0;i<related.length;i+=4){const batch=related.slice(i,i+4);setStatus(`${topic.title} の文脈を取得中 ${Math.min(i+batch.length,related.length)}/${related.length}`);await Promise.all(batch.map(p=>fetchTopicContext(p,topic.title)));if(selectedTopic?.title===topic.title)renderMarkers();if(i+4<related.length)await sleep(60)}if(selectedTopic?.title===topic.title)setStatus(`${topic.title}：関連地点 ${related.length}件`)}
function popupHtml(p){const wiki=p.wikiTitle?`<a href="${wikipediaUrl(p.wikiTitle)}" target="_blank" rel="noopener">Wikipedia</a>`:'',google=`<a href="https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}" target="_blank" rel="noopener">Google Maps</a>`;let context='';if(selectedTopic){const stored=p.contexts?.get(selectedTopic.title),body=stored===undefined?'文脈を読み込み中…':stored||'本文中の該当箇所を短く抽出できませんでした。';context=`<div class="topic-context"><div class="topic-context-label">${escapeHtml(selectedTopic.title)}との関わり</div><div class="topic-context-text">${escapeHtml(body)}</div></div>`}return `<div class="place-popup-title">${escapeHtml(p.title)}</div><div class="place-popup-meta">${escapeHtml(p.qid)}${p.wikiTitle?' · 日本語Wikipediaあり':''}</div>${context}<div class="place-popup-links">${wiki}<a href="${wikidataUrl(p.qid)}" target="_blank" rel="noopener">Wikidata</a>${google}</div>`}
function renderMarkers(){markerLayer.clearLayers();let visible=places;if(selectedTopic){const ids=new Set(selectedTopic.placeIds);visible=places.filter(p=>ids.has(p.qid))}for(const p of visible)L.marker([p.lat,p.lng],{icon:markerIcon,title:p.title}).bindPopup(()=>popupHtml(p),{maxWidth:330}).addTo(markerLayer);if(selectedTopic)setStatus(`${selectedTopic.title}：関連地点 ${visible.length}件`)}
function renderTopics(){els.list.replaceChildren();els.count.textContent=topics.length?`${topics.length}件`:'';if(!topics.length){const d=document.createElement('div');d.className='place-popup-meta';d.textContent='トピックが見つかりませんでした。';els.list.append(d);return}for(const t of topics){const b=document.createElement('button');b.type='button';b.className='topic-chip';b.textContent=`${t.title} ${t.count}`;if(selectedTopic?.title===t.title)b.classList.add('active');b.addEventListener('click',()=>selectTopic(t));els.list.append(b)}}
function selectTopic(topic){selectedTopic=topic;els.selection.hidden=false;els.selectionText.textContent=`${topic.title} · ${topic.count}地点`;els.sheet.classList.remove('open');els.handle.setAttribute('aria-expanded','false');renderTopics();renderMarkers();enrichTopicContexts(topic)}
function clearTopic(){selectedTopic=null;els.selection.hidden=true;renderTopics();renderMarkers();setStatus(`${places.length}地点を表示中`)}
async function loadArea(){els.load.disabled=true;els.load.textContent='読み込み中…';selectedTopic=null;els.selection.hidden=true;els.sheet.classList.remove('open');try{setStatus('Wikidataから地点を取得中…');places=await fetchWikidataPlaces(map.getBounds());renderMarkers();const wikiCount=places.filter(p=>p.wikiTitle).length;setStatus(`${places.length}地点 / Wikipedia ${wikiCount}記事`);await enrichWikipediaLinks(places);topics=buildTopics(places);renderTopics();renderMarkers();setStatus(`${places.length}地点・${topics.length}トピック`);els.sheet.classList.remove('has-results');void els.sheet.offsetWidth;els.sheet.classList.add('has-results')}catch(e){console.error(e);setStatus('読み込みに失敗しました。範囲を少し狭めて再試行してください。')}finally{els.load.disabled=false;els.load.textContent='この範囲を読み込む'}}
els.load.addEventListener('click',loadArea);els.handle.addEventListener('click',()=>{const open=els.sheet.classList.toggle('open');els.handle.setAttribute('aria-expanded',String(open))});els.clear.addEventListener('click',clearTopic);map.on('movestart',()=>{if(!els.load.disabled)setStatus('移動後「この範囲を読み込む」で更新')});
