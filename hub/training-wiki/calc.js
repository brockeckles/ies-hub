/**
 * IES Hub v3 — Training Wiki Calculation Engine
 * PURE FUNCTIONS ONLY — search, filtering, stats, and content utilities.
 *
 * @module hub/training-wiki/calc
 */

// ============================================================
// SEARCH
// ============================================================

/**
 * Search articles by query text. Matches against title, content, tags.
 * @param {import('./types.js').WikiArticle[]} articles
 * @param {string} query
 * @returns {import('./types.js').WikiSearchResult[]}
 */
export function searchArticles(articles, query) {
  if (!query || query.trim().length === 0) return [];

  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 1);
  if (terms.length === 0) return [];

  return articles
    .map(article => {
      let relevance = 0;
      const titleLower = (article.title || '').toLowerCase();
      const contentLower = (article.content || '').toLowerCase();
      const tagsLower = (article.tags || []).map(t => t.toLowerCase());

      for (const term of terms) {
        if (titleLower.includes(term)) relevance += 40;
        if (tagsLower.some(t => t.includes(term))) relevance += 30;
        if (contentLower.includes(term)) relevance += 20;
      }

      // Boost for exact title match
      if (titleLower === query.toLowerCase()) relevance += 50;

      const snippet = extractSnippet(article.content, terms[0], 120);

      return { articleId: article.id, title: article.title, category: article.categoryId, snippet, relevance };
    })
    .filter(r => r.relevance > 0)
    .sort((a, b) => b.relevance - a.relevance);
}

/**
 * Extract a text snippet around the first match of a term.
 * @param {string} content
 * @param {string} term
 * @param {number} [maxLen=120]
 * @returns {string}
 */
export function extractSnippet(content, term, maxLen = 120) {
  if (!content) return '';
  // Strip HTML tags
  const text = content.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  if (!term) return text.slice(0, maxLen) + (text.length > maxLen ? '...' : '');

  const idx = text.toLowerCase().indexOf(term.toLowerCase());
  if (idx === -1) return text.slice(0, maxLen) + (text.length > maxLen ? '...' : '');

  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + term.length + 80);
  let snippet = text.slice(start, end);
  if (start > 0) snippet = '...' + snippet;
  if (end < text.length) snippet += '...';
  return snippet;
}

// ============================================================
// FILTERING
// ============================================================

/**
 * Filter articles by category.
 * @param {import('./types.js').WikiArticle[]} articles
 * @param {string} categoryId
 * @returns {import('./types.js').WikiArticle[]}
 */
export function filterByCategory(articles, categoryId) {
  if (!categoryId || categoryId === 'all') return articles;
  return articles.filter(a => a.categoryId === categoryId);
}

/**
 * Filter articles by status.
 * @param {import('./types.js').WikiArticle[]} articles
 * @param {string} status
 * @returns {import('./types.js').WikiArticle[]}
 */
export function filterByStatus(articles, status) {
  if (!status || status === 'all') return articles;
  return articles.filter(a => a.status === status);
}

/**
 * Filter articles by tag.
 * @param {import('./types.js').WikiArticle[]} articles
 * @param {string} tag
 * @returns {import('./types.js').WikiArticle[]}
 */
export function filterByTag(articles, tag) {
  if (!tag) return articles;
  const tagLower = tag.toLowerCase();
  return articles.filter(a => (a.tags || []).some(t => t.toLowerCase() === tagLower));
}

/**
 * Sort articles.
 * @param {import('./types.js').WikiArticle[]} articles
 * @param {'title' | 'views' | 'updated' | 'created'} sortBy
 * @param {'asc' | 'desc'} [dir='desc']
 * @returns {import('./types.js').WikiArticle[]}
 */
export function sortArticles(articles, sortBy, dir = 'desc') {
  const sorted = [...articles];
  const mult = dir === 'asc' ? 1 : -1;

  sorted.sort((a, b) => {
    switch (sortBy) {
      case 'title': return mult * (a.title || '').localeCompare(b.title || '');
      case 'views': return mult * ((a.viewCount || 0) - (b.viewCount || 0));
      case 'updated': return mult * ((a.updated_at || '').localeCompare(b.updated_at || ''));
      case 'created': return mult * ((a.created_at || '').localeCompare(b.created_at || ''));
      default: return 0;
    }
  });

  return sorted;
}

// ============================================================
// STATS
// ============================================================

/**
 * Compute wiki statistics.
 * @param {import('./types.js').WikiArticle[]} articles
 * @param {import('./types.js').WikiCategory[]} categories
 * @returns {import('./types.js').WikiStats}
 */
export function computeStats(articles, categories) {
  const published = articles.filter(a => a.status === 'published');
  const totalViews = articles.reduce((s, a) => s + (a.viewCount || 0), 0);

  const mostViewed = [...articles].sort((a, b) => (b.viewCount || 0) - (a.viewCount || 0))[0];
  const recentlyUpdated = [...articles].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))[0];

  return {
    totalArticles: articles.length,
    totalCategories: categories.length,
    publishedArticles: published.length,
    totalViews,
    mostViewedArticle: mostViewed?.title || '',
    recentlyUpdated: recentlyUpdated?.title || '',
  };
}

/**
 * Count articles per category.
 * @param {import('./types.js').WikiArticle[]} articles
 * @param {import('./types.js').WikiCategory[]} categories
 * @returns {Array<{ categoryId: string, categoryName: string, count: number }>}
 */
export function articlesPerCategory(articles, categories) {
  return categories.map(cat => ({
    categoryId: cat.id,
    categoryName: cat.name,
    count: articles.filter(a => a.categoryId === cat.id).length,
  }));
}

/**
 * Get all unique tags with counts.
 * @param {import('./types.js').WikiArticle[]} articles
 * @returns {Array<{ tag: string, count: number }>}
 */
export function tagCloud(articles) {
  const tagMap = new Map();
  for (const article of articles) {
    for (const tag of (article.tags || [])) {
      const key = tag.toLowerCase();
      tagMap.set(key, (tagMap.get(key) || 0) + 1);
    }
  }
  return Array.from(tagMap.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count);
}

// ============================================================
// READING TIME
// ============================================================

/**
 * Estimate reading time in minutes.
 * @param {string} content
 * @param {number} [wpm=200]
 * @returns {number}
 */
export function readingTime(content, wpm = 200) {
  if (!content) return 0;
  const text = content.replace(/<[^>]*>/g, '').trim();
  const words = text.split(/\s+/).filter(w => w.length > 0).length;
  return Math.max(1, Math.ceil(words / wpm));
}

// ============================================================
// DEMO DATA
// ============================================================

/** @type {import('./types.js').WikiCategory[]} */
export const DEMO_CATEGORIES = [
  { id: 'getting-started', name: 'Getting Started', icon: '🚀', sortOrder: 1, description: 'Onboarding and first steps' },
  { id: 'cost-modeling', name: 'Cost Modeling', icon: '💰', sortOrder: 2, description: 'Building and reviewing cost models' },
  { id: 'warehouse-design', name: 'Warehouse Design', icon: '🏭', sortOrder: 3, description: 'Facility sizing, layouts, and equipment' },
  { id: 'transportation', name: 'Transportation', icon: '🚛', sortOrder: 4, description: 'Network optimization and fleet management' },
  { id: 'dos-process', name: 'DOS Process', icon: '📋', sortOrder: 5, description: 'Deal Operating System stages and activities' },
  { id: 'best-practices', name: 'Best Practices', icon: '⭐', sortOrder: 6, description: 'Tips, patterns, and standards' },
];

/** @type {import('./types.js').WikiArticle[]} */
export const DEMO_ARTICLES = [
  { id: 'w1', title: 'Getting Started with the IES Hub', categoryId: 'getting-started', content: 'Welcome to the IES Intelligence Hub. This guide covers the basics of navigating the hub, accessing design tools, and understanding the Deal Operating System (DOS). The hub is organized into three main areas: Intelligence (Command Center and Market Explorer), Work (Deal Management and Design Tools), and Resources (Training, Change Management, and more).', summary: 'Introduction to the IES Hub', tags: ['onboarding', 'navigation', 'basics'], author: 'Brock Eckles', status: 'published', viewCount: 342 },
  { id: 'w2', title: 'Cost Model Builder: Complete Guide', categoryId: 'cost-modeling', content: 'The Cost Model Builder is the primary financial modeling tool in the IES Hub. It consists of 13 sections covering facility costs, labor, equipment, overhead, value-added services, and pricing. Each section feeds into the Summary view which shows bucket costs, financial metrics, multi-year P&L, and sensitivity analysis. Key concepts include: cost buckets (Management, Labor, Facility, Equipment, Overhead, VAS, Transportation, IT, Other), pricing models (cost-plus, transactional, hybrid), and target margin thresholds.', summary: 'Deep dive into the Cost Model Builder', tags: ['cost-model', 'pricing', 'financials', 'guide'], author: 'Brock Eckles', status: 'published', viewCount: 256 },
  { id: 'w3', title: 'MOST Labor Standards Overview', categoryId: 'cost-modeling', content: 'Maynard Operation Sequence Technique (MOST) is a predetermined motion time system used to set labor standards. The MOST tool in the hub includes: Template Library (pre-built activity templates organized by process area), Quick Analysis (build analyses from template elements with PFD allowances), and Workflow Composer (chain activities into end-to-end workflows for bottleneck detection). Key formula: Adjusted UPH = Base UPH × (100 / (100 + PFD%)).', summary: 'Understanding MOST labor analysis', tags: ['most', 'labor', 'standards', 'tmu'], author: 'Brock Eckles', status: 'published', viewCount: 189 },
  { id: 'w4', title: 'Warehouse Sizing Calculator', categoryId: 'warehouse-design', content: 'The Warehouse Sizing Calculator determines optimal facility dimensions based on product characteristics, storage requirements, and throughput volumes. It features three views: Dashboard (KPI metrics and utilization), Elevation (2D cross-section showing rack geometry), and 3D (WebGL visualization of the facility). Key parameters include pallet dimensions, beam height, flue space, aisle widths, and zone configurations.', summary: 'How to size a warehouse facility', tags: ['warehouse', 'sizing', 'facility', '3d'], author: 'Brock Eckles', status: 'published', viewCount: 178 },
  { id: 'w5', title: 'Network Optimization Guide', categoryId: 'transportation', content: 'The Network Optimizer helps determine optimal facility locations and shipping strategies. It supports multi-mode transportation costing (TL, LTL, Parcel), demand assignment with service-level constraints, and scenario comparison. Business archetypes provide quick presets for common distribution patterns: DTC E-commerce, CPG Big Box, Healthcare, Industrial, and Food & Beverage.', summary: 'Optimizing distribution networks', tags: ['network', 'transportation', 'optimization', 'logistics'], author: 'Brock Eckles', status: 'published', viewCount: 145 },
  { id: 'w6', title: 'DOS Stage Gate Process', categoryId: 'dos-process', content: 'The Deal Operating System (DOS) defines 6 stages for managing deals from pre-sales through delivery handover. Stage 1: Pre-Sales Engagement (credit check, NDA, SCAN documents). Stage 2: Deal Qualification (solution lead assignment, qualification meeting). Stage 3: Kick-Off & Solution Design (15 elements including data analysis, cost modeling, engineering workbook). Stage 4: Operations Review. Stage 5: Executive Review (ELT approvals, customer presentation). Stage 6: Delivery Handover (legal review, IPS, JPS, LOI, PAF, CoD).', summary: 'Understanding the 6-stage DOS process', tags: ['dos', 'stages', 'process', 'deals'], author: 'Brock Eckles', status: 'published', viewCount: 298 },
  { id: 'w7', title: 'Fleet Modeler Tutorial', categoryId: 'transportation', content: 'The Fleet Modeler sizes private fleets for dedicated transportation lanes. Define your lanes (origin, destination, weekly shipments, weights), configure vehicle specifications (5 ATRI-benchmarked vehicle types), and run the analysis to see fleet composition, 3-way cost comparison (Private vs. GXO Dedicated vs. Common Carrier), and ATRI benchmark comparison. Pro tip: Use the team driving toggle for long-haul lanes to see impact on fleet sizing.', summary: 'Building fleet models step by step', tags: ['fleet', 'modeler', 'transportation', 'vehicles', 'atri'], author: 'Brock Eckles', status: 'published', viewCount: 134 },
  { id: 'w8', title: 'Blue Yonder WMS Integration Notes', categoryId: 'best-practices', content: 'GXO primarily uses Blue Yonder (BY) as its Warehouse Management System. When building MOST labor standards templates, ensure activities reflect BY workflows and screen interactions. Common BY modules referenced: Receiving, Putaway, Order Management, Picking (discrete, batch, wave), Packing, Shipping, Cycle Count, and Labor Management. Template naming convention: BY-[Module]-[Activity].', summary: 'BY WMS considerations for IES tools', tags: ['blue-yonder', 'wms', 'integration', 'best-practices'], author: 'Brock Eckles', status: 'published', viewCount: 98 },
];
