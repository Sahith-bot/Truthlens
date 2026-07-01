/**
 * ============================================================
 *  TruthLens — State News Service (Backend Layer)
 *  File: stateNewsService.js
 *
 *  PURPOSE
 *  -------
 *  Provides a fully isolated aggregation layer for Andhra Pradesh
 *  and Telangana state news, completely separate from the global
 *  news flow in index.html.
 *
 *  DESIGN PRINCIPLES
 *  -----------------
 *  - Zero coupling to global fetch / allFetched / API key rotation
 *    in index.html. The service manages its own state and key pool.
 *  - Accepts API keys as config so they can be supplied externally.
 *  - Returns structured StateNewsArticle objects ready for rendering.
 *  - Exposes a clean public API via the `StateNewsService` object.
 *
 *  PUBLIC API
 *  ----------
 *  StateNewsService.init(apiKeys)        — supply 1–N NewsData.io keys
 *  StateNewsService.fetchAP()            — fetch + filter AP articles
 *  StateNewsService.fetchTS()            — fetch + filter TS articles
 *  StateNewsService.fetchBoth()          — fetch AP + TS concurrently
 *  StateNewsService.getCache(state)      — return cached results
 *  StateNewsService.clearCache()         — clear all cached results
 *
 *  OUTPUT SCHEMA (StateNewsArticle)
 *  --------------------------------
 *  {
 *    id          : number   — auto-increment unique ID
 *    title       : string   — cleaned headline
 *    description : string   — excerpt / lead paragraph
 *    source      : string   — publisher / outlet name
 *    date        : string   — ISO 8601 date string
 *    dateAgo     : string   — human-readable relative time ("2h ago")
 *    state       : string   — "Andhra Pradesh" | "Telangana"
 *    category    : string   — one of STATE_CATEGORIES keys
 *    imageUrl    : string   — article image (may be empty)
 *    articleUrl  : string   — canonical article URL
 *    verdict     : object   — { real, fake, unclear, unverified, label }
 *    confidence  : number   — 0–100 state-relevance confidence score
 *  }
 * ============================================================
 */

'use strict';

/* ── NEWSDATA.IO CONFIG ──────────────────────────────────────────── */
const NEWS_BASE    = 'https://newsdata.io/api/1/news';
const COUNTRY_IN   = 'in';
const LANG_EN      = 'en';
const STATE_PAGE_SIZE = 10;   // max per call (free tier)

/* ── STATE DETECTION KEYWORD TABLES ────────────────────────────────
   Each entry: { pattern: RegExp, weight: number }
   Total confidence = sum of matched weights (capped at 100).
   An article is accepted if confidence >= CONFIDENCE_THRESHOLD.
──────────────────────────────────────────────────────────────────── */
const CONFIDENCE_THRESHOLD = 20;

const AP_KEYWORDS = [
  // Cities / districts
  { pattern: /\bvisakhapatnam\b|\bvizag\b/i,             weight: 35 },
  { pattern: /\bvijayawada\b/i,                          weight: 35 },
  { pattern: /\bamaravati\b/i,                           weight: 35 },
  { pattern: /\bguntur\b/i,                              weight: 30 },
  { pattern: /\btirupati\b/i,                            weight: 30 },
  { pattern: /\bkurnool\b/i,                             weight: 30 },
  { pattern: /\brajamahendravaram\b|\brajahmundry\b/i,   weight: 30 },
  { pattern: /\bnellore\b/i,                             weight: 30 },
  { pattern: /\bkakinada\b/i,                            weight: 30 },
  { pattern: /\bongole\b/i,                              weight: 30 },
  { pattern: /\beluru\b/i,                               weight: 28 },
  { pattern: /\banantapur\b/i,                           weight: 28 },
  { pattern: /\bkadapa\b/i,                              weight: 28 },
  { pattern: /\bchittoor\b/i,                            weight: 28 },
  { pattern: /\bsrikakulam\b/i,                          weight: 28 },
  { pattern: /\bvizianagaram\b/i,                        weight: 28 },
  { pattern: /\bwest godavari\b|\beast godavari\b/i,     weight: 28 },
  { pattern: /\bprakasam\b/i,                            weight: 28 },
  { pattern: /\bnandyal\b/i,                             weight: 25 },
  { pattern: /\bbapatla\b/i,                             weight: 25 },

  // State name / abbreviation
  { pattern: /\bandhra\s?pradesh\b/i,                    weight: 40 },
  { pattern: /\b(?<!\w)ap\s+(?:cm|govt|govt|police|minister|high\s+court)\b/i, weight: 30 },

  // Key political figures / bodies
  { pattern: /\bchandrababu\s?naidu\b/i,                 weight: 30 },
  { pattern: /\bpawan\s?kalyan\b/i,                      weight: 25 },
  { pattern: /\bjagan\s?mohan\s?reddy\b|\bjagan\s?reddy\b/i, weight: 30 },
  { pattern: /\btdp\b/i,                                 weight: 25 },
  { pattern: /\bysrcp\b|\bysr\s?congress\b/i,            weight: 25 },
  { pattern: /\bap\s+government\b|\bap\s+state\b/i,      weight: 30 },
  { pattern: /\bap\s+high\s+court\b/i,                   weight: 30 },

  // Infrastructure / projects
  { pattern: /\bpollavaram\b/i,                          weight: 30 },
  { pattern: /\bap\s+capital\b/i,                        weight: 25 },
  { pattern: /\bkonaseema\b/i,                           weight: 28 },
  { pattern: /\bsriharikota\b/i,                         weight: 28 },

  // Broad regional mention
  { pattern: /\btelugu\s+desam\b/i,                      weight: 25 },
  { pattern: /\bap\s+election\b|\bandhra\s+election\b/i, weight: 30 },
];

const TS_KEYWORDS = [
  // Cities / districts
  { pattern: /\bhyderabad\b/i,                           weight: 30 },
  { pattern: /\bsecunderabad\b/i,                        weight: 30 },
  { pattern: /\bcyberabad\b/i,                           weight: 30 },
  { pattern: /\bwarangal\b/i,                            weight: 30 },
  { pattern: /\bnizamabad\b/i,                           weight: 30 },
  { pattern: /\bkarimnagar\b/i,                          weight: 30 },
  { pattern: /\bkhammam\b/i,                             weight: 28 },
  { pattern: /\bmahbubnagar\b/i,                         weight: 28 },
  { pattern: /\bnalgonda\b/i,                            weight: 28 },
  { pattern: /\badilabad\b/i,                            weight: 28 },
  { pattern: /\bmedak\b/i,                               weight: 28 },
  { pattern: /\brangareddy\b/i,                          weight: 28 },
  { pattern: /\bsiddipet\b/i,                            weight: 28 },
  { pattern: /\bsuryapet\b/i,                            weight: 25 },
  { pattern: /\byadadri\b/i,                             weight: 25 },
  { pattern: /\bmedchal\b/i,                             weight: 25 },
  { pattern: /\bsangareddy\b/i,                          weight: 25 },
  { pattern: /\bvikarabad\b/i,                           weight: 25 },
  { pattern: /\bwanaparthy\b/i,                          weight: 25 },
  { pattern: /\bnarayanpet\b/i,                          weight: 25 },

  // State name / abbreviation
  { pattern: /\btelangana\b/i,                           weight: 40 },
  { pattern: /\bts\s+(?:cm|govt|police|minister|high\s+court)\b/i, weight: 30 },

  // Key political figures / bodies
  { pattern: /\brevanth\s?reddy\b/i,                     weight: 30 },
  { pattern: /\bkcr\b|\bchandrashekar\s?rao\b/i,         weight: 30 },
  { pattern: /\bbrs\b|\bbharat\s?rashtra\s?samithi\b/i,  weight: 25 },
  { pattern: /\btrs\b|\btelangana\s?rashtra\s?samithi\b/i, weight: 25 },
  { pattern: /\bits\s+government\b|\bts\s+state\b/i,     weight: 30 },
  { pattern: /\btelangana\s+high\s+court\b/i,            weight: 30 },
  { pattern: /\bghmc\b/i,                                weight: 28 },

  // Infrastructure / projects
  { pattern: /\bhitec\s?city\b|\bhytech\s?city\b/i,      weight: 25 },
  { pattern: /\bt-hub\b|\bthub\b/i,                      weight: 25 },
  { pattern: /\bkaleshwaram\b/i,                         weight: 28 },
  { pattern: /\brytu\s?bandhu\b/i,                       weight: 28 },
  { pattern: /\baarogyasri\b/i,                          weight: 28 },
  { pattern: /\bhyd\s+metro\b|\bhyderabad\s+metro\b/i,   weight: 25 },
  { pattern: /\bsrdp\b/i,                                weight: 25 },

  // Broad
  { pattern: /\btelangana\s+election\b/i,                weight: 30 },
  { pattern: /\btrs\s+party\b|\bbrs\s+party\b/i,         weight: 25 },
];

/* ── CATEGORY DETECTION ─────────────────────────────────────────── */
const STATE_CATEGORIES = {
  politics    : 'politics',
  sports      : 'sports',
  health      : 'health',
  tech        : 'tech',
  business    : 'business',
  entertainment: 'entertainment',
  agriculture : 'agriculture',
  environment : 'environment',
  crime       : 'crime',
  current     : 'current',
};

// Keyword → category mappings (first match wins, priority order)
const CAT_KEYWORD_MAP = [
  { cat: 'politics',     re: /\belection|minister|parliament|assembly|cm|chief\s+minister|mla|mp\b|governor|politics|vote|party|government|cabinet|bjp|congress|trs|brs|tdp|ysrcp\b/i },
  { cat: 'crime',        re: /\bcrime|murder|arrested?|police|fir|scam|fraud|rape|kidnap|theft|robbery|drug|smuggling|court\s+verdict|acquit|convict/i },
  { cat: 'health',       re: /\bhospital|medical|health|disease|dengue|malaria|covid|vaccine|doctor|patient|aarogyasri|nims|aiims\b/i },
  { cat: 'tech',         re: /\btechnology|startup|it\s+company|software|hitec|t-hub|innovation|ai\b|artificial\s+intelligence|digital|cyber\b/i },
  { cat: 'business',     re: /\bbusiness|economy|gdp|investment|industry|trade|stock|budget|tax|revenue|bank|finance|rbi\b/i },
  { cat: 'agriculture',  re: /\bagriculture|farmer|crop|harvest|irrigation|drought|rytu\s?bandhu|kisan|fertilizer|paddy|groundwater\b/i },
  { cat: 'environment',  re: /\benvironment|flood|cyclone|rain|storm|disaster|pollution|climate|river|reservoir|forest|wildlife\b/i },
  { cat: 'sports',       re: /\bsports?|cricket|football|badminton|kabaddi|ipl\b|tournament|championship|athlete|medal|olympics\b/i },
  { cat: 'entertainment',re: /\bmovie|film|cinema|actor|actress|director|music|album|ott|series|bollywood|tollywood|kollywood\b/i },
];

function detectStateCategory(rawApiCat, title, description) {
  // 1. Honour the API-supplied category if it maps cleanly
  const apiCatMap = {
    politics: 'politics', sports: 'sports', health: 'health',
    technology: 'tech', science: 'tech', business: 'business',
    entertainment: 'entertainment', environment: 'environment',
    crime: 'crime', food: 'current', education: 'current',
  };
  if (rawApiCat && apiCatMap[rawApiCat]) return apiCatMap[rawApiCat];

  // 2. Keyword scan of title + description
  const text = `${title || ''} ${description || ''}`.toLowerCase();
  for (const { cat, re } of CAT_KEYWORD_MAP) {
    if (re.test(text)) return cat;
  }
  return 'current';
}

/* ── VERDICT SCORING ────────────────────────────────────────────── */
// Replicates the same heuristic logic from index.html (but self-contained)
const FAKE_KW = ['fake', 'hoax', 'false', 'misleading', 'fabricated', 'debunked',
                 'rumour', 'rumor', 'scam', 'misinformation', 'disinformation'];
const REAL_KW = ['confirmed', 'official', 'verified', 'government', 'announced',
                 'court', 'minister', 'signed', 'launched', 'approved', 'released'];

function scoreVerdictState(title, description) {
  const text = `${title || ''} ${description || ''}`.toLowerCase();
  let fakeScore = Math.min(FAKE_KW.filter(k => text.includes(k)).length * 18, 85);
  let realScore = Math.min(REAL_KW.filter(k => text.includes(k)).length * 10 + 52, 92);
  if (fakeScore + realScore > 100) realScore = 100 - fakeScore - 8;
  const unclear    = Math.max(0, Math.floor((100 - realScore - fakeScore) * 0.7));
  const unverified = Math.max(0, 100 - realScore - fakeScore - unclear);
  const label      = fakeScore > 40 ? 'Likely Fake'
                   : realScore < 55 ? 'Unclear'
                   : 'Verified Real';
  return { real: realScore, fake: fakeScore, unclear, unverified, label };
}

/* ── RELATIVE TIME ──────────────────────────────────────────────── */
function timeAgoState(dateStr) {
  if (!dateStr) return 'Recently';
  let d = new Date(dateStr);
  if (isNaN(d.getTime())) d = new Date(dateStr.replace(' ', 'T'));
  if (isNaN(d.getTime())) return 'Recently';
  const s = Math.floor((Date.now() - d) / 1000);
  if (s < 0)     return 'Just now';
  if (s < 60)    return 'Just now';
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/* ── STATE DETECTION ────────────────────────────────────────────── */
/**
 * Score an article against a keyword table.
 * Returns a confidence score 0–100.
 */
function computeConfidence(title, description, keywordTable) {
  const text = `${title || ''} ${description || ''}`.toLowerCase();
  let score = 0;
  for (const { pattern, weight } of keywordTable) {
    if (pattern.test(text)) score += weight;
  }
  return Math.min(score, 100);
}

/**
 * Determine which state(s) an article belongs to.
 * Returns { ap: number, ts: number } confidence scores.
 * An article can be relevant to both states (e.g. joint boundary news).
 */
function detectStates(title, description) {
  return {
    ap: computeConfidence(title, description, AP_KEYWORDS),
    ts: computeConfidence(title, description, TS_KEYWORDS),
  };
}

/* ── ARTICLE MAPPER ─────────────────────────────────────────────── */
let _stateIdCounter = 10000; // offset from global counter to avoid collisions

function mapStateArticle(rawArticle, detectedState, confidence) {
  const cats = Array.isArray(rawArticle.category)
    ? rawArticle.category[0]
    : (rawArticle.category || '');

  const title       = (rawArticle.title || 'No title').replace(/\s*-\s*[^-]+$/, '').trim();
  const description = rawArticle.description || rawArticle.content || 'No description available.';
  const verdict     = scoreVerdictState(title, description);
  const category    = detectStateCategory(cats, title, description);

  return {
    id          : _stateIdCounter++,
    title,
    description,
    source      : rawArticle.source_id || rawArticle.creator?.[0] || 'Unknown Source',
    date        : rawArticle.pubDate   || new Date().toISOString(),
    dateAgo     : timeAgoState(rawArticle.pubDate),
    state       : detectedState,                // "Andhra Pradesh" | "Telangana"
    category,                                   // from STATE_CATEGORIES
    imageUrl    : rawArticle.image_url   || '',
    articleUrl  : rawArticle.link        || '',
    verdict,
    confidence,                                 // 0–100 state-relevance score
  };
}

/* ═══════════════════════════════════════════════════════════════════
   MAIN SERVICE OBJECT
═══════════════════════════════════════════════════════════════════ */
const StateNewsService = (() => {

  /* ── Private State ─────────────────────────────────────────────── */
  let _keys      = [];           // Array<{ key, used, limit, exhausted }>
  let _cache     = { ap: [], ts: [] };
  let _loadingAP = false;
  let _loadingTS = false;
  const _seen    = new Set();    // deduplicate across AP + TS fetches

  /* ── Key Rotation (private) ────────────────────────────────────── */
  function _getActiveKey() {
    return _keys.find(k => !k.exhausted && k.used < k.limit) || null;
  }

  function _consumeCredit(keyObj) {
    keyObj.used++;
    if (keyObj.used >= keyObj.limit) {
      keyObj.exhausted = true;
      console.warn(`[StateNewsService] Key exhausted: ${keyObj.key.slice(0, 8)}…`);
    }
  }

  /* ── Core Fetch (private) ──────────────────────────────────────── */
  /**
   * Fetch a single page from NewsData.io with automatic key rotation.
   * Mirrors the fetchWithKeyRotation logic in index.html but is
   * completely independent.
   *
   * @param {string} category  - NewsData.io category string
   * @param {string} [query]   - optional keyword q= param
   * @returns {Promise<object[]>} raw NewsData.io result items
   */
  async function _fetch(category, query = '') {
    while (true) {
      const keyObj = _getActiveKey();
      if (!keyObj) {
        throw new Error('[StateNewsService] All API keys exhausted for state news.');
      }

      const params = new URLSearchParams({
        apikey   : keyObj.key,
        language : LANG_EN,
        country  : COUNTRY_IN,
        size     : STATE_PAGE_SIZE,
      });
      if (category) params.set('category', category);
      if (query)    params.set('q', query);

      let res;
      try {
        res = await fetch(`${NEWS_BASE}?${params}`);
      } catch (networkErr) {
        throw new Error(`[StateNewsService] Network error: ${networkErr.message}`);
      }

      // Handle HTTP-level errors
      if (!res.ok) {
        const errBody  = await res.json().catch(() => ({}));
        const errMsg   = errBody?.results?.message || `HTTP ${res.status}`;
        const lower    = errMsg.toLowerCase();

        if (res.status === 401 || res.status === 429
            || lower.includes('credit') || lower.includes('apikey')
            || lower.includes('limit')  || lower.includes('invalid')) {
          keyObj.exhausted = true;
          console.warn(`[StateNewsService] Key rotated due to: ${errMsg}`);
          continue; // try next key
        }
        throw new Error(`[StateNewsService] API error: ${errMsg}`);
      }

      // Parse response
      const data = await res.json();
      if (data.status !== 'success') {
        const msg   = data?.results?.message || 'Unknown API error';
        const lower = msg.toLowerCase();
        if (lower.includes('credit') || lower.includes('limit') || lower.includes('apikey')) {
          keyObj.exhausted = true;
          console.warn(`[StateNewsService] Key rotated (response body): ${msg}`);
          continue;
        }
        throw new Error(`[StateNewsService] API returned failure: ${msg}`);
      }

      // Success
      _consumeCredit(keyObj);
      return data.results || [];
    }
  }

  /* ── NLP / SIMILARITY CLUSTERING ─────────────────────────────── */
  function tokenize(text) {
    if (!text) return new Set();
    return new Set(
      text.toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 3)
    );
  }

  function calculateSimilarity(textA, textB) {
    const setA = tokenize(textA);
    const setB = tokenize(textB);
    if (setA.size === 0 || setB.size === 0) return 0;
    
    let intersection = 0;
    for (const token of setA) {
      if (setB.has(token)) intersection++;
    }
    const union = setA.size + setB.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }

  /**
   * Group similar articles together and rank them.
   * Modifies the array to return only top articles, appending related sources.
   */
  function _aggregateAndRank(articles) {
    const clusters = [];
    
    for (const article of articles) {
      let matchedCluster = null;
      for (const cluster of clusters) {
        // Compare title similarity
        const sim = calculateSimilarity(article.title, cluster.main.title);
        if (sim > 0.30) { // Threshold for similarity (30% word overlap)
          matchedCluster = cluster;
          break;
        }
      }
      
      if (matchedCluster) {
        matchedCluster.related.push(article);
      } else {
        clusters.push({ main: article, related: [] });
      }
    }

    // Rank and format
    const aggregated = clusters.map(c => {
      const main = c.main;
      main.clusterSize = c.related.length + 1;
      main.relatedSources = [];
      
      if (c.related.length > 0) {
        // Collect additional sources for display
        const extraSources = c.related.map(r => r.source).filter(s => s !== main.source);
        main.relatedSources = [...new Set(extraSources)]; // Deduplicate sources
        
        // Boost confidence score based on cluster size (more sources = more important)
        main.confidence += (c.related.length * 15); 
        
        // AI Summary: Create a synthesized description if there are multiple articles
        if (main.description) {
           const relDesc = c.related.find(r => r.description && r.description.length > 20)?.description;
           if (relDesc) {
             const mainFirstSentence = main.description.split(/(?<=[.?!])\s+/)[0];
             const relFirstSentence = relDesc.split(/(?<=[.?!])\s+/)[0];
             if (mainFirstSentence !== relFirstSentence) {
                main.aiSummary = mainFirstSentence + ' ' + relFirstSentence;
             }
           }
        }
      }
      
      // Ensure AI summary exists (fallback to standard description)
      if (!main.aiSummary && main.description) {
        main.aiSummary = main.description.split(/(?<=[.?!])\s+/)[0]; 
      } else if (!main.aiSummary) {
        main.aiSummary = "No summary available.";
      }
      
      return main;
    });

    // Sort by combined confidence + recency
    aggregated.sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return new Date(b.date) - new Date(a.date);
    });

    return aggregated;
  }

  /* ── State Filter Pipeline (private) ──────────────────────────── */
  /**
   * Take raw NewsData articles, run state detection, and return
   * structured StateNewsArticle[] for the requested state.
   *
   * @param {object[]} rawArticles
   * @param {string}   stateKey    - "ap" | "ts"
   * @returns {StateNewsArticle[]}
   */
  function _filterAndMap(rawArticles, stateKey) {
    const stateName  = stateKey === 'ap' ? 'Andhra Pradesh' : 'Telangana';
    const keywords   = stateKey === 'ap' ? AP_KEYWORDS      : TS_KEYWORDS;
    const results    = [];

    for (const raw of rawArticles) {
      // Deduplicate exact matches across all state fetches
      const key = raw.link || raw.title || '';
      if (_seen.has(key)) continue;

      const confidence = computeConfidence(raw.title, raw.description, keywords);
      if (confidence < CONFIDENCE_THRESHOLD) continue;  // not relevant enough

      _seen.add(key);
      results.push(mapStateArticle(raw, stateName, confidence));
    }

    // Apply Aggregation, NLP deduplication, and Ranking
    return _aggregateAndRank(results);
  }

  /* ── Fetch strategies ──────────────────────────────────────────── */

  /**
   * Categories to query for state news (spread credit across topics).
   * We use India-specific broad categories then keyword-filter server side.
   */
  const STATE_FETCH_CATEGORIES = [
    'politics', 'top', 'business', 'entertainment',
    'health',   'sports', 'technology',
  ];

  /**
   * Build list of { category, query } fetch jobs for a given state.
   * We alternate between category-only calls and keyword-boosted calls.
   */
  function _buildFetchJobs(stateKey) {
    const q = stateKey === 'ap'
      ? 'andhra pradesh OR visakhapatnam OR vijayawada OR amaravati'
      : 'telangana OR hyderabad OR warangal OR karimnagar';

    return [
      // 1 keyword-boosted call (highest relevance)
      { category: 'top',      query: q },
      // 1 politics-specific call
      { category: 'politics', query: q },
      // 1 broad call to catch uncategorized articles
      { category: '',         query: q },
    ];
  }

  /* ── PUBLIC METHODS ────────────────────────────────────────────── */

  /**
   * Initialise the service with API keys.
   * Should be called before any fetch. Keys are wrapped in a private
   * tracking structure; the originals in index.html are unaffected.
   *
   * @param {Array<string|object>} apiKeys
   *   Either plain key strings or objects { key, limit? }
   */
  function init(apiKeys) {
    if (!Array.isArray(apiKeys) || apiKeys.length === 0) {
      throw new Error('[StateNewsService] init() requires a non-empty array of API keys.');
    }
    _keys = apiKeys.map(k => {
      if (typeof k === 'string') return { key: k,    used: 0, limit: 200, exhausted: false };
      return                            { key: k.key, used: 0, limit: k.limit || 200, exhausted: false };
    });
    _cache = { ap: [], ts: [] };
    _seen.clear();
    _stateIdCounter = 10000;
    console.log(`[StateNewsService] Initialised with ${_keys.length} key(s).`);
  }

  /**
   * Fetch and process Andhra Pradesh news.
   * Returns structured StateNewsArticle[] for AP.
   *
   * Credit cost: up to 3 API calls.
   */
  async function fetchAP() {
    if (_loadingAP) {
      console.warn('[StateNewsService] AP fetch already in progress.');
      return _cache.ap;
    }
    if (!_getActiveKey()) throw new Error('[StateNewsService] No API keys available.');

    _loadingAP = true;
    const rawPool  = [];
    const jobs     = _buildFetchJobs('ap');
    let creditsUsed = 0;

    for (const job of jobs) {
      if (!_getActiveKey()) break;
      try {
        const items = await _fetch(job.category, job.query);
        rawPool.push(...items);
        creditsUsed++;
      } catch (err) {
        console.error(`[StateNewsService] AP fetch job failed (cat=${job.category}):`, err.message);
        if (!_getActiveKey()) break;
      }
    }

    const articles    = _filterAndMap(rawPool, 'ap');
    _cache.ap         = articles;
    _loadingAP        = false;

    console.log(`[StateNewsService] AP: ${articles.length} articles (${creditsUsed} credits used).`);
    return articles;
  }

  /**
   * Fetch and process Telangana news.
   * Returns structured StateNewsArticle[] for TS.
   *
   * Credit cost: up to 3 API calls.
   */
  async function fetchTS() {
    if (_loadingTS) {
      console.warn('[StateNewsService] TS fetch already in progress.');
      return _cache.ts;
    }
    if (!_getActiveKey()) throw new Error('[StateNewsService] No API keys available.');

    _loadingTS = true;
    const rawPool = [];
    const jobs    = _buildFetchJobs('ts');
    let creditsUsed = 0;

    for (const job of jobs) {
      if (!_getActiveKey()) break;
      try {
        const items = await _fetch(job.category, job.query);
        rawPool.push(...items);
        creditsUsed++;
      } catch (err) {
        console.error(`[StateNewsService] TS fetch job failed (cat=${job.category}):`, err.message);
        if (!_getActiveKey()) break;
      }
    }

    const articles = _filterAndMap(rawPool, 'ts');
    _cache.ts      = articles;
    _loadingTS     = false;

    console.log(`[StateNewsService] TS: ${articles.length} articles (${creditsUsed} credits used).`);
    return articles;
  }

  /**
   * Fetch both states concurrently.
   * Returns { ap: StateNewsArticle[], ts: StateNewsArticle[] }
   *
   * Credit cost: up to 6 API calls total.
   */
  async function fetchBoth() {
    const [ap, ts] = await Promise.allSettled([fetchAP(), fetchTS()]);

    return {
      ap: ap.status === 'fulfilled' ? ap.value : [],
      ts: ts.status === 'fulfilled' ? ts.value : [],
      errors: [
        ap.status === 'rejected' ? ap.reason?.message : null,
        ts.status === 'rejected' ? ts.reason?.message : null,
      ].filter(Boolean),
    };
  }

  /**
   * Return cached results without fetching.
   * @param {'ap'|'ts'|'both'} state
   */
  function getCache(state = 'both') {
    if (state === 'ap')   return [..._cache.ap];
    if (state === 'ts')   return [..._cache.ts];
    return { ap: [..._cache.ap], ts: [..._cache.ts] };
  }

  /**
   * Clear cache and deduplication tracking.
   */
  function clearCache() {
    _cache = { ap: [], ts: [] };
    _seen.clear();
    _stateIdCounter = 10000;
    console.log('[StateNewsService] Cache cleared.');
  }

  /**
   * Utility: filter cached results for a given state + category.
   * @param {'ap'|'ts'} stateKey
   * @param {string}    category  - from STATE_CATEGORIES, or 'all'
   */
  function filterByCategory(stateKey, category) {
    const articles = stateKey === 'ap' ? _cache.ap : _cache.ts;
    if (!category || category === 'all') return [...articles];
    return articles.filter(a => a.category === category);
  }

  /**
   * Utility: get a summary stats object for a state.
   * @param {'ap'|'ts'} stateKey
   * @returns {{ total, real, fake, unclear, byCategory }}
   */
  function getStats(stateKey) {
    const articles = stateKey === 'ap' ? _cache.ap : _cache.ts;
    const total    = articles.length;
    const real     = articles.filter(a => a.verdict.label === 'Verified Real').length;
    const fake     = articles.filter(a => a.verdict.label === 'Likely Fake').length;
    const unclear  = total - real - fake;

    const byCategory = {};
    for (const a of articles) {
      byCategory[a.category] = (byCategory[a.category] || 0) + 1;
    }

    return {
      total,
      real,
      fake,
      unclear,
      realPct   : total ? Math.round((real  / total) * 100) : 0,
      fakePct   : total ? Math.round((fake  / total) * 100) : 0,
      byCategory,
    };
  }

  /* ── Expose public API ─────────────────────────────────────────── */
  return {
    init,
    fetchAP,
    fetchTS,
    fetchBoth,
    getCache,
    clearCache,
    filterByCategory,
    getStats,

    // Expose constants for consumers
    CATEGORIES     : STATE_CATEGORIES,
    CONFIDENCE_MIN : CONFIDENCE_THRESHOLD,
  };

})();

/* ── MODULE EXPORT (works in both browser global scope and ES modules) ── */
if (typeof module !== 'undefined' && module.exports) {
  // Node.js / CommonJS
  module.exports = StateNewsService;
} else if (typeof window !== 'undefined') {
  // Browser global
  window.StateNewsService = StateNewsService;
}
