/**
 * 出门：在她「住的地方」附近找真实存在的地方，她自己挑一家去。
 * 去哪由她定：决策层写想去什么样的地方 + 地图搜索词 → 这里去高德（没 key / 失败退回 OSM Nominatim）按词搜周边
 * → 整理成候选名单（名字、类型、距离、营业时间、去过几次）交回给她挑。代码不按关键词猜种类、不替她随机选。
 * 店里看到什么、买了什么由模型写，但店名、距离、营业时间、天气都是真的。
 * 坐标：设置里存 WGS84（和天气、OSM 一致），查高德时换成 GCJ-02，高德回来的再换回去。
 */

// 根本不是能去的「地方」的结果（公交站、停车场、路口、小区、写字楼、公司、酒店）：数据清洗，不是替她挑
const NOT_PLACE_TYPES = new Set(['bus_stop', 'station', 'stop', 'stop_position', 'platform', 'halt', 'subway_entrance', 'parking', 'parking_entrance', 'bus_station', 'taxi', 'crossing', 'junction', 'road', 'residential', 'office', 'hotel', 'guest_house']);
export function notAPlace(p) {
  const name = String(p.name || '').replace(/[（(].*?[)）]$/, '');
  const type = String(p.type || '');
  if (NOT_PLACE_TYPES.has(type.toLowerCase())) return true;
  if (/(站|站点|停车场|路口|公交|地铁|出入口)$/.test(name)) return true;
  if (/(有限公司|有限责任公司|公司)$/.test(name)) return true;
  return /公交车站|地铁站|停车场|出入口|门牌信息|楼栋号|交通设施|公司企业|^公司$|写字楼|住宅区|商务住宅|产业园/.test(type);
}

const WALK_M_PER_MIN = 75; // 4.5 km/h
const BIKE_M_PER_MIN = 200;
const ROUTE_FACTOR = 1.3; // 直线距离 → 实际路程

// ── 坐标 ──────────────────────────────────────────────
const A = 6378245.0;
const EE = 0.00669342162296594323;
function outOfChina(lat, lon) {
  return lon < 72.004 || lon > 137.8347 || lat < 0.8293 || lat > 55.8271;
}
function tLat(x, y) {
  let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  r += ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3;
  r += ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) * 2) / 3;
  return r;
}
function tLon(x, y) {
  let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  r += ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3;
  r += ((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x / 30) * Math.PI)) * 2) / 3;
  return r;
}
export function wgsToGcj(lat, lon) {
  if (outOfChina(lat, lon)) return [lat, lon];
  let dLat = tLat(lon - 105, lat - 35);
  let dLon = tLon(lon - 105, lat - 35);
  const rad = (lat / 180) * Math.PI;
  let magic = Math.sin(rad);
  magic = 1 - EE * magic * magic;
  const sq = Math.sqrt(magic);
  dLat = (dLat * 180) / (((A * (1 - EE)) / (magic * sq)) * Math.PI);
  dLon = (dLon * 180) / ((A / sq) * Math.cos(rad) * Math.PI);
  return [lat + dLat, lon + dLon];
}
export function gcjToWgs(lat, lon) {
  const [gl, gn] = wgsToGcj(lat, lon);
  return [lat * 2 - gl, lon * 2 - gn];
}

export function distanceM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toR = (d) => (d * Math.PI) / 180;
  const a = Math.sin(toR(lat2 - lat1) / 2) ** 2 + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(toR(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** 走过去还是骑车：路程 1.8 公里以内走路，再远骑共享单车；下雨天远的坐公交 */
export function travelOf(straightM, { wet = false } = {}) {
  const m = Math.round(straightM * ROUTE_FACTOR);
  if (m <= 1800) return { mode: '走路', meters: m, minutes: Math.max(3, Math.round(m / WALK_M_PER_MIN)) };
  if (wet) return { mode: '坐公交', meters: m, minutes: Math.round(m / 250) + 10 };
  return { mode: '骑共享单车', meters: m, minutes: Math.max(5, Math.round(m / BIKE_M_PER_MIN) + 3) };
}

export function fmtDistance(m) {
  return m < 1000 ? `${Math.round(m / 10) * 10} 米` : `${(m / 1000).toFixed(1)} 公里`;
}

// ── 营业时间 ──────────────────────────────────────────
/** 从「08:00-22:00」「Mo-Su 10:00-22:00; ...」这类文本里抠出时间段（忽略星期） */
export function parseHours(text) {
  const out = [];
  const re = /(\d{1,2}):(\d{2})\s*[-–~至]\s*(?:次日)?(\d{1,2}):(\d{2})/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const a = Number(m[1]) * 60 + Number(m[2]);
    let b = Number(m[3]) * 60 + Number(m[4]);
    if (b <= a) b += 24 * 60; // 跨夜
    out.push([a, b]);
  }
  if (/24\s*小时|24\/7|00:00-24:00/.test(String(text || ''))) out.push([0, 24 * 60]);
  return out;
}

/**
 * 从 nowMin 起待 stayMin 分钟，营业时间够不够：true 够 / false 关着或待不了这么久 / null 查不到营业时间
 */
export function openStatus(hoursText, nowMin, stayMin = 30) {
  const spans = parseHours(hoursText);
  if (!spans.length) return null;
  return spans.some(([a, b]) => {
    for (const t of [nowMin, nowMin + 24 * 60]) if (t >= a && t + stayMin <= b) return true;
    return false;
  });
}

// ── 查地点 ────────────────────────────────────────────
async function getJson(url, { headers = {}, timeoutMs = 15000 } = {}) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/** 高德周边搜索（v5，按她给的词搜，带营业时间和照片） */
export async function searchAmap({ key, lat, lon, radius, keywords }) {
  const [glat, glon] = wgsToGcj(lat, lon);
  const url =
    `https://restapi.amap.com/v5/place/around?key=${encodeURIComponent(key)}` +
    `&location=${glon.toFixed(6)},${glat.toFixed(6)}&radius=${Math.round(radius)}` +
    `&keywords=${encodeURIComponent(keywords)}&sortrule=distance&page_size=25&show_fields=business,photos`;
  const j = await getJson(url);
  if (String(j.status) !== '1') throw new Error(`高德：${j.info || j.infocode || '查询失败'}`);
  return (j.pois || [])
    .map((p) => {
      const [plon, plat] = String(p.location || '').split(',').map(Number);
      if (!Number.isFinite(plat) || !Number.isFinite(plon)) return null;
      const [wlat, wlon] = gcjToWgs(plat, plon);
      const b = p.business || {};
      return {
        id: 'amap:' + p.id,
        name: String(p.name || '').trim(),
        lat: wlat,
        lon: wlon,
        address: String(p.address || '').trim(),
        hours: String(b.opentime_today || b.opentime_week || '').trim(),
        rating: Number(b.rating) || 0,
        cost: Number(b.cost) || 0,
        tag: String(b.tag || '').slice(0, 40),
        type: String(p.type || '').split(';').pop(),
        photos: (Array.isArray(p.photos) ? p.photos : []).map((ph) => String(ph.url || '').replace(/^http:/, 'https:')).filter(Boolean).slice(0, 3),
        src: 'amap',
      };
    })
    .filter((x) => x && x.name && !notAPlace(x));
}

/** OSM Nominatim：在家周围的方框里按她给的词搜（要带 UA） */
export async function searchOsm({ lat, lon, radius, keywords, userAgent = 'aurabot-autonomy/0.7 (personal hobby bot)' }) {
  const dl = radius / 111320;
  const dn = radius / (111320 * Math.cos((lat * Math.PI) / 180));
  const viewbox = `${lon - dn},${lat + dl},${lon + dn},${lat - dl}`;
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=25&bounded=1&extratags=1&addressdetails=1&viewbox=${viewbox}&q=${encodeURIComponent(keywords)}`;
  const j = await getJson(url, { headers: { 'User-Agent': userAgent, 'Accept-Language': 'zh-CN' } });
  const out = [];
  for (const p of Array.isArray(j) ? j : []) {
    const name = String(p.name || '').trim();
    if (!name) continue;
    const a = p.address || {};
    const x = {
      id: `osm:${p.osm_type}${p.osm_id}`,
      name,
      lat: Number(p.lat),
      lon: Number(p.lon),
      address: [a.road, a.suburb || a.neighbourhood].filter(Boolean).join(' '),
      hours: String((p.extratags || {}).opening_hours || ''),
      rating: 0,
      cost: 0,
      tag: '',
      type: String(p.type || ''),
      src: 'osm',
    };
    if (!notAPlace(x)) out.push(x);
  }
  return out;
}

/**
 * 整理成给她挑的名单：算距离和路上多久，标营业时间够不够、去过几次。
 * 只去掉三种：超出范围的、今天已经去过的、到了肯定关着的（营业时间查得到才算）。按距离排，最多 limit 家。
 */
export function candidatesFor(places, { home, nowMin, visits = {}, today = '', radius = 0, wet = false, stayMin = 30, limit = 8 }) {
  const seen = new Set();
  return (places || [])
    .filter((p) => p && !seen.has(p.id) && seen.add(p.id))
    .map((p) => {
      const straight = distanceM(home.lat, home.lon, p.lat, p.lon);
      const travel = travelOf(straight, { wet });
      const open = openStatus(p.hours, nowMin + travel.minutes, stayMin);
      const v = visits[p.id];
      return { ...p, straight, travel, open, visits: (v && Number(v.count)) || 0, visitedToday: !!(v && v.lastDay === today) };
    })
    .filter((p) => (!radius || p.straight <= radius) && !p.visitedToday && p.open !== false)
    .sort((a, b) => a.straight - b.straight)
    .slice(0, limit);
}

/** 名单的一行（给她挑的时候看） */
export function candidateLine(p, i) {
  return [
    `${i + 1}. ${p.name}`,
    p.type && /[一-鿿]/.test(p.type) ? `（${p.type}）` : '',
    `｜${fmtDistance(p.travel.meters)}，${p.travel.mode} ${p.travel.minutes} 分钟`,
    p.hours ? `｜营业 ${p.hours}` : '｜营业时间不详',
    p.rating ? `｜评分 ${p.rating}${p.cost ? `、人均 ${p.cost} 元` : ''}` : '',
    p.tag ? `｜${p.tag}` : '',
    p.visits ? `｜去过 ${p.visits} 次` : '',
  ].join('');
}
