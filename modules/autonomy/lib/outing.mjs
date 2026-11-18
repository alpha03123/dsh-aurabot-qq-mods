/**
 * 出门：在她「住的地方」附近找真实存在的店 / 公园，挑一家去。
 * 地点数据：高德 Web 服务（有 key 时，国内数据准）→ 没 key 或失败时退回 OSM Nominatim。
 * 店里看到什么、买了什么由模型写，但店名、距离、营业时间、天气都是真的。
 * 坐标：设置里存 WGS84（和天气、OSM 一致），查高德时换成 GCJ-02，高德回来的再换回去。
 */

/** 能去的地方。indoor = 下雨也能去；stay = 待多久（分钟）；hours = 查不到营业时间时按这个猜 */
/**
 * 搜回来的东西要像这一类才收：名字里带关键词，或者 OSM 类型对得上。
 * Nominatim 按关键词搜会混进酒店、单位、寺庙（名字或地址里沾了字），不筛会「去酒店翻书」。
 */
export const PLACE_MATCH = {
  supermarket: { name: /超市|超级市场|生鲜|大润发|永辉|盒马|华润|物美|联华|世纪联华|三江|欧尚|沃尔玛|麦德龙|Ole|奥乐齐|ALDI/i, types: ['supermarket'], not: /宠物|海鲜|建材|家具|母婴|酒店|宾馆/ },
  market: { name: /菜场|菜市场|农贸|菜市/, types: ['marketplace', 'greengrocer'], not: /酒店|宾馆/ },
  convenience: { name: /便利|全家|罗森|7-?11|喜士多|好德|可的|美宜佳|十足/i, types: ['convenience'], not: /酒店|宾馆/ },
  bakery: { name: /面包|烘焙|蛋糕|西点|甜品|bakery/i, types: ['bakery', 'pastry', 'confectionery'], not: /酒店|宾馆|厂/ },
  cafe: { name: /咖啡|coffee|cafe|café|星巴克|瑞幸|Costa|Manner|Tims|M Stand|Seesaw/i, types: ['cafe', 'coffee'], not: /酒店|宾馆/ },
  bookstore: { name: /书店|书城|书局|书房|书屋|图书|西西弗|新华书|钟书阁|言几又|先锋/, types: ['books'], not: /酒店|宾馆|供电|法院|局$|^.{0,4}书城店/ },
  mall: { name: /购物中心|商场|百货|购物广场|商业广场|城市广场|天街|万达广场|印象城|银泰|吾悦|万象城|大悦城|天一广场|和义大道|来福士|宝龙|龙湖/, types: ['mall', 'department_store'], not: /酒店|宾馆|公园|地铁|站$|写字楼|大厦$|健身|文化|升旗|烧烤|市民|休闲|音乐/ },
  snack: { name: /小吃|面馆|面店|馄饨|汤圆|包子|粥|米线|米粉|粉面|早餐|早点|生煎|馒头|烧饼|豆浆/, types: ['fast_food'], not: /酒店|宾馆/ },
  park: { name: /公园|绿地|游园|植物园|湿地/, types: ['park', 'garden', 'nature_reserve'], not: /小区|酒店|别墅|产业园|科技园|工业园|物流园/ },
};

const NOT_PLACE_TYPES = new Set(['bus_stop', 'station', 'stop', 'stop_position', 'platform', 'halt', 'subway_entrance', 'parking', 'parking_entrance', 'bus_station', 'taxi', 'crossing', 'junction', 'road', 'residential', 'office', 'hotel', 'guest_house']);

/** 高德的查法：按分类代码查最准；菜场、小吃分类太杂，带关键词 */
export const AMAP_QUERY = {
  supermarket: { types: '060400' },
  market: { types: '060700', keywords: '菜市场' },
  convenience: { types: '060200' },
  bakery: { types: '050800' },
  cafe: { types: '050500' },
  bookstore: { types: '061205' },
  mall: { types: '060101' },
  snack: { types: '050000', keywords: '小吃' },
  park: { types: '110101' },
};

/** 高德回来的再筛一道：分类代码查超市会混进便利店，查菜场会混进水果店、熟食摊 */
export function amapLooksLike(kind, p) {
  const name = String(p.name || '');
  const type = String(p.type || '');
  if (/(站|停车场|公交|地铁)$/.test(name.replace(/[（(].*?[)）]$/, ''))) return false;
  if (kind === 'supermarket') return !/便利店/.test(type) || /超市|生鲜/.test(name);
  if (kind === 'market') return /市场|菜场|菜市/.test(name);
  return true;
}

/** 这条像不像这一类 */
export function looksLike(kind, p) {
  const m = PLACE_MATCH[kind];
  if (!m) return true;
  const name = String(p.name || '');
  // 公交站、地铁站、停车场常借附近商场 / 公园的名字（「万达广场南」），一律不算
  if (NOT_PLACE_TYPES.has(String(p.type || '').toLowerCase())) return false;
  if (/(站|站点|停车场|路口|公交|地铁)$/.test(name.replace(/[（(].*?[)）]$/, ''))) return false;
  if (m.not && m.not.test(name)) return false;
  if (m.types.includes(String(p.type || '').toLowerCase())) return true;
  return m.name.test(name);
}

export const PLACE_KINDS = {
  supermarket: { label: '超市', amap: '超市', osm: ['超市'], indoor: true, stay: [20, 40], hours: '08:00-22:00', words: /超市|买菜|买东西|采购|零食|水果|日用/ },
  market: { label: '菜市场', amap: '菜市场', osm: ['菜市场', '农贸市场'], indoor: true, stay: [20, 35], hours: '06:00-18:00', words: /菜场|菜市场|菜市|农贸/ },
  convenience: { label: '便利店', amap: '便利店', osm: ['便利店'], indoor: true, stay: [5, 12], hours: '00:00-24:00', words: /便利店|全家|罗森|7-?11|喜士多/ },
  bakery: { label: '面包店', amap: '面包店', osm: ['面包', '烘焙'], indoor: true, stay: [10, 20], hours: '08:00-21:00', words: /面包|烘焙|蛋糕|甜点/ },
  cafe: { label: '咖啡馆', amap: '咖啡', osm: ['咖啡'], indoor: true, stay: [40, 80], hours: '09:00-21:00', words: /咖啡|拿铁|奶茶|茶饮/ },
  bookstore: { label: '书店', amap: '书店', osm: ['书店'], indoor: true, stay: [30, 60], hours: '09:00-21:00', words: /书店|看书|买书|翻书/ },
  mall: { label: '商场', amap: '购物中心', osm: ['购物中心', '广场'], indoor: true, stay: [60, 120], hours: '10:00-22:00', words: /商场|购物中心|逛街|广场|电影/ },
  snack: { label: '小吃店', amap: '小吃', osm: ['小吃', '面馆'], indoor: true, stay: [20, 40], hours: '07:00-21:00', words: /小吃|面馆|馄饨|汤圆|早点|吃点东西/ },
  park: { label: '公园', amap: '公园', osm: ['公园'], indoor: false, stay: [30, 60], hours: '05:00-22:00', words: /公园|散步|遛弯|走走|晒太阳|湖边|江边/ },
};

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

/** 从 nowMin 起待 stayMin 分钟，都在营业时间里吗；查不到时间的按种类猜 */
export function openFor(hoursText, kind, nowMin, stayMin) {
  let spans = parseHours(hoursText);
  if (!spans.length) spans = parseHours((PLACE_KINDS[kind] || {}).hours || '');
  if (!spans.length) return true;
  return spans.some(([a, b]) => {
    for (const t of [nowMin, nowMin + 24 * 60]) if (t >= a && t + stayMin <= b) return true;
    return false;
  });
}

// ── 选种类 ────────────────────────────────────────────
/** 从她写的 detail 猜想去哪类地方；猜不出就按天气 / 时间随便挑一类 */
export function pickKind(detail, { wet = false, hour = 12, random = Math.random } = {}) {
  const t = String(detail || '');
  for (const [k, v] of Object.entries(PLACE_KINDS)) if (v.words.test(t)) return k;
  let pool = Object.keys(PLACE_KINDS).filter((k) => k !== 'convenience');
  if (wet) pool = pool.filter((k) => PLACE_KINDS[k].indoor);
  if (hour < 9) pool = pool.filter((k) => ['market', 'snack', 'park', 'bakery'].includes(k));
  if (hour >= 21) pool = ['convenience'];
  return pool[Math.floor(random() * pool.length)] || 'supermarket';
}

// ── 查地点 ────────────────────────────────────────────
async function getJson(url, { headers = {}, timeoutMs = 15000 } = {}) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/** 高德周边搜索（v5，带营业时间） */
export async function searchAmap({ key, lat, lon, radius, kind }) {
  const [glat, glon] = wgsToGcj(lat, lon);
  const q = AMAP_QUERY[kind] || { keywords: PLACE_KINDS[kind].amap };
  const url =
    `https://restapi.amap.com/v5/place/around?key=${encodeURIComponent(key)}` +
    `&location=${glon.toFixed(6)},${glat.toFixed(6)}&radius=${Math.round(radius)}` +
    (q.types ? `&types=${q.types}` : '') +
    (q.keywords ? `&keywords=${encodeURIComponent(q.keywords)}` : '') +
    `&page_size=25&show_fields=business,photos`;
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
        kind,
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
    .filter((x) => x && x.name && amapLooksLike(kind, x));
}

/** OSM Nominatim：在家周围的方框里按关键词搜（每秒最多一次，要带 UA） */
export async function searchOsm({ lat, lon, radius, kind, userAgent = 'aurabot-autonomy/0.7 (personal hobby bot)' }) {
  const dl = radius / 111320;
  const dn = radius / (111320 * Math.cos((lat * Math.PI) / 180));
  const viewbox = `${lon - dn},${lat + dl},${lon + dn},${lat - dl}`;
  const out = [];
  const seen = new Set();
  for (const q of PLACE_KINDS[kind].osm) {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=25&bounded=1&extratags=1&addressdetails=1&viewbox=${viewbox}&q=${encodeURIComponent(q)}`;
    const j = await getJson(url, { headers: { 'User-Agent': userAgent, 'Accept-Language': 'zh-CN' } });
    for (const p of Array.isArray(j) ? j : []) {
      const name = String(p.name || '').trim();
      if (!name || seen.has(p.osm_id)) continue;
      seen.add(p.osm_id);
      if (!looksLike(kind, { name, type: p.type })) continue;
      const a = p.address || {};
      out.push({
        id: `osm:${p.osm_type}${p.osm_id}`,
        name,
        kind,
        lat: Number(p.lat),
        lon: Number(p.lon),
        address: [a.road, a.suburb || a.neighbourhood].filter(Boolean).join(' '),
        hours: String((p.extratags || {}).opening_hours || ''),
        rating: 0,
        cost: 0,
        tag: '',
        type: String(p.type || ''),
        src: 'osm',
      });
    }
    await new Promise((r) => setTimeout(r, 1100));
  }
  return out;
}

/**
 * 挑一家：去过、喜欢的有三成机会再去（常去的那家）；否则按距离加权随机，近的更容易被挑中。
 * 今天去过的不再去；营业时间对不上的不去。
 */
export function choosePlace(places, { home, kind, nowMin, visits = {}, today = '', radius = 0, wet = false, random = Math.random }) {
  const k = PLACE_KINDS[kind];
  const cands = places
    .filter((p) => p.kind === kind)
    .map((p) => {
      const straight = distanceM(home.lat, home.lon, p.lat, p.lon);
      const travel = travelOf(straight, { wet });
      const stay = Math.round(k.stay[0] + random() * (k.stay[1] - k.stay[0]));
      return { ...p, straight, travel, stay };
    })
    .filter((p) => !radius || p.straight <= radius)
    .filter((p) => !(visits[p.id] && visits[p.id].lastDay === today))
    .filter((p) => openFor(p.hours, kind, nowMin + p.travel.minutes, p.stay));
  if (!cands.length) return null;
  const fav = cands.filter((p) => visits[p.id] && visits[p.id].count >= 2);
  if (fav.length && random() < 0.3) return fav[Math.floor(random() * fav.length)];
  const w = cands.map((p) => 1 / Math.max(200, p.straight));
  const sum = w.reduce((a, b) => a + b, 0);
  let r = random() * sum;
  for (let i = 0; i < cands.length; i++) {
    r -= w[i];
    if (r <= 0) return cands[i];
  }
  return cands[cands.length - 1];
}
