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
 * @param {import('./types.js?v=20260417-p2').WikiArticle[]} articles
 * @param {string} query
 * @returns {import('./types.js?v=20260417-p2').WikiSearchResult[]}
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
 * @param {import('./types.js?v=20260417-p2').WikiArticle[]} articles
 * @param {string} categoryId
 * @returns {import('./types.js?v=20260417-p2').WikiArticle[]}
 */
export function filterByCategory(articles, categoryId) {
  if (!categoryId || categoryId === 'all') return articles;
  return articles.filter(a => a.categoryId === categoryId);
}

/**
 * Filter articles by status.
 * @param {import('./types.js?v=20260417-p2').WikiArticle[]} articles
 * @param {string} status
 * @returns {import('./types.js?v=20260417-p2').WikiArticle[]}
 */
export function filterByStatus(articles, status) {
  if (!status || status === 'all') return articles;
  return articles.filter(a => a.status === status);
}

/**
 * Filter articles by tag.
 * @param {import('./types.js?v=20260417-p2').WikiArticle[]} articles
 * @param {string} tag
 * @returns {import('./types.js?v=20260417-p2').WikiArticle[]}
 */
export function filterByTag(articles, tag) {
  if (!tag) return articles;
  const tagLower = tag.toLowerCase();
  return articles.filter(a => (a.tags || []).some(t => t.toLowerCase() === tagLower));
}

/**
 * Sort articles.
 * @param {import('./types.js?v=20260417-p2').WikiArticle[]} articles
 * @param {'title' | 'views' | 'updated' | 'created'} sortBy
 * @param {'asc' | 'desc'} [dir='desc']
 * @returns {import('./types.js?v=20260417-p2').WikiArticle[]}
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
 * @param {import('./types.js?v=20260417-p2').WikiArticle[]} articles
 * @param {import('./types.js?v=20260417-p2').WikiCategory[]} categories
 * @returns {import('./types.js?v=20260417-p2').WikiStats}
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
 * @param {import('./types.js?v=20260417-p2').WikiArticle[]} articles
 * @param {import('./types.js?v=20260417-p2').WikiCategory[]} categories
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
 * @param {import('./types.js?v=20260417-p2').WikiArticle[]} articles
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

/** @type {import('./types.js?v=20260417-p2').WikiCategory[]} */
export const DEMO_CATEGORIES = [
  { id: 'getting-started', name: 'Getting Started', icon: '🚀', sortOrder: 1, description: 'Onboarding and first steps' },
  { id: 'cost-modeling', name: 'Cost Modeling', icon: '💰', sortOrder: 2, description: 'Building and reviewing cost models' },
  { id: 'warehouse-design', name: 'Warehouse Design', icon: '🏭', sortOrder: 3, description: 'Facility sizing, layouts, and equipment' },
  { id: 'transportation', name: 'Transportation', icon: '🚛', sortOrder: 4, description: 'Network optimization and fleet management' },
  { id: 'dos-process', name: 'DOS Process', icon: '📋', sortOrder: 5, description: 'Deal Operating System stages and activities' },
  { id: 'best-practices', name: 'Best Practices', icon: '⭐', sortOrder: 6, description: 'Tips, patterns, and standards' },
];

/** @type {import('./types.js?v=20260417-p2').WikiArticle[]} */
export const DEMO_ARTICLES = [
  // Getting Started
  { id: 'w1', title: 'What is IES Hub?', categoryId: 'getting-started', content: '<p>The IES Intelligence Hub is GXOs unified platform for solutions design, cost modeling, network optimization, and deal management. Built on supply chain domain expertise, the Hub enables solutions engineers to rapidly model complex logistics operations and support the Deal Operating System (DOS) from pre-sales through delivery handover.</p><p>The Intelligence Hub serves three primary audiences: Solutions Engineers designing solutions and building cost models, Operations teams planning facility networks, and Deal Management professionals tracking deals through their lifecycle.</p><p>Key capabilities include detailed cost modeling with 13-section P&L, facility sizing with 3D visualization, MOST-based labor standards, network optimization with multi-modal transportation, and integrated market intelligence. All tools feed common data structures and share results through an event-driven architecture.</p>', summary: 'Overview of the Intelligence Hub, its purpose, and target users', tags: ['onboarding', 'overview', 'getting-started'], author: 'Brock Eckles', status: 'published', viewCount: 342 },

  { id: 'w2', title: 'Hub Navigation Guide', categoryId: 'getting-started', content: '<p>The IES Hub organizes features into three main areas visible in the left sidebar:</p><p><strong>Intelligence</strong> provides market-level insights. Command Center displays real-time alerts, news feeds, and KPIs for market awareness. Market Explorer shows geospatial demand patterns and competitive landscape using heat maps and clustering.</p><p><strong>Work</strong> contains your primary tools. Deal Management tracks opportunities through the 6-stage DOS process with 38 templates. Design Tools provide seven specialized calculators: Cost Model Builder, Warehouse Sizing, MOST Labor Standards, Network Optimizer, Fleet Modeler, Center of Gravity, and Multi-Site Analyzer.</p><p><strong>Resources</strong> support success. Training Wiki provides searchable knowledge articles. Change Management tracks organizational initiatives. Ideas & Feedback lets you suggest improvements. Reference Data (Admin) displays master tables like labor rates, equipment catalogs, and facility standards.</p><p>Use Ctrl+K to search globally, or click any sidebar item to navigate.</p>', summary: 'How to use sidebar, tools, search, and navigation patterns', tags: ['navigation', 'getting-started', 'interface'], author: 'Brock Eckles', status: 'published', viewCount: 289 },

  { id: 'w3', title: 'Quick Start: Build Your First Cost Model', categoryId: 'getting-started', content: '<p><strong>Step 1: Define the Facility</strong> — Input square footage, storage type (pallet, case, carton), and zone configuration. The Hub calculates theoretical capacity and utilization.</p><p><strong>Step 2: Configure Labor</strong> — Select Blue Yonder WMS modules (receiving, picking, packing, shipping), input product characteristics, and the MOST engine calculates labor UPH with PFD allowances.</p><p><strong>Step 3: Add Equipment & Materials</strong> — Specify MHE (WCS, conveyor, sorter), facility systems (HVAC, lighting, security), and building envelope. The Hub includes ATRI benchmarks and vendor catalogs.</p><p><strong>Step 4: Model Pricing</strong> — Choose a pricing strategy: cost-plus with fixed margin, transactional (per pallet, per line, per hour), or hybrid. Set service-level pricing tiers.</p><p><strong>Step 5: Review Summary</strong> — The P&L shows bucket totals, unit cost, contribution margin, and multi-year payback. Run sensitivity on throughput volume, labor rates, or customer mix.</p><p><strong>Step 6: Export & Present</strong> — Deck generation creates auto-formatted PPTX decks at each DOS stage gate.</p>', summary: '5-step guide to building your first cost model', tags: ['cost-model', 'getting-started', 'quick-start'], author: 'Brock Eckles', status: 'published', viewCount: 214 },

  // Design Tools
  { id: 'w4', title: 'Cost Model Builder Guide', categoryId: 'cost-modeling', content: '<p>The Cost Model Builder is the hub\'s flagship financial tool, organizing all logistics costs into 13 sections:</p><p><strong>Facility & Real Estate</strong> includes rent, utilities, taxes, and maintenance. <strong>Labor</strong> uses MOST standards to calculate headcount and payroll. <strong>Equipment & Materials</strong> covers MHE, WCS, conveyors, and consumables.</p><p><strong>Overhead & Support</strong> includes management, IT, quality, and safety. <strong>Service & VAS</strong> model value-added services like labeling, kitting, and sequencing. <strong>Transportation & Delivery</strong> covers inbound freight, handling, and last-mile delivery.</p><p><strong>Pricing Strategy</strong> supports cost-plus (markup %), transactional (per pallet, per line, per hour), or hybrid (blended). Each strategy includes tiered pricing by customer segment or volume band.</p><p><strong>Financial Summary</strong> displays the P&L, gross margin, payback period, and unit cost by SKU mix. Multi-year scenarios model inflation, volume growth, and cost escalation.</p><p><strong>Pro Tips:</strong> Use the Cost Sensitivity tab to understand which line items drive profitability. Leverage the copy/compare feature to benchmark solutions. Archive prior versions to support bid history and DOS audit trail.</p>', summary: 'How to build a cost model: setup, volumes, facility, labor, pricing, summary', tags: ['cost-model', 'pricing', 'financials', 'guide'], author: 'Brock Eckles', status: 'published', viewCount: 256 },

  { id: 'w5', title: 'Warehouse Sizing Guide', categoryId: 'warehouse-design', content: '<p>The Warehouse Sizing Calculator sizes facilities based on throughput, product mix, and equipment strategy. It features three complementary views:</p><p><strong>Dashboard</strong> displays KPIs: total square footage, pallet capacity, case capacity, utilization %, throughput per hour, and labor requirements. This is your executive summary view.</p><p><strong>Elevation</strong> shows a 2D cross-section of rack geometry, showing beam heights, flue space, aisle widths, and mezzanines. Helpful for equipment fit and vertical utilization planning.</p><p><strong>3D View</strong> provides an interactive Three.js model of the facility. Rotate, zoom, and pan to visualize operations. Color-coded zones show receiving, putaway, picking, packing, and shipping areas.</p><p><strong>Key Parameters:</strong> Pallet dimensions (48x40 standard), beam height (depends on product height + 18" flue space), aisle widths (8.5-10ft for counterbalance, 6.5ft for reach), and rack types (selective, drive-in, push-back).</p><p><strong>Pro Tips:</strong> Run multiple scenarios with different automation levels to find the cost/efficiency sweet spot. Export the 3D model to share with customer real estate teams. Use the Elevation view to identify bottleneck areas (narrow aisles, low throughput zones).</p>', summary: 'How to size a facility: input parameters, storage types, interpreting results', tags: ['warehouse', 'sizing', 'facility', '3d', 'design'], author: 'Brock Eckles', status: 'published', viewCount: 178 },

  { id: 'w6', title: 'MOST Labor Standards Guide', categoryId: 'cost-modeling', content: '<p>Maynard Operation Sequence Technique (MOST) is a predetermined motion time system for setting labor standards. The IES Hub MOST tool has three components:</p><p><strong>Template Library</strong> offers pre-built activity templates organized by Blue Yonder WMS process: Receiving (unload, dock-to-put), Putaway (slot selection, put operation), Order Management (wave planning, release), Picking (discrete, batch, wave), Packing (case build, label, weigh), and Shipping (manifest, dock).</p><p><strong>Quick Analysis</strong lets you build analyses by selecting template elements and applying PFD (Personal Fatigue Delay) allowances. The Hub calculates Total UPH = Base UPH ÷ (1 + PFD%).</p><p><strong>Workflow Composer</strong chains activities into end-to-end workflows. Example: Receive (8 min/pallet) → Putaway (12 min/pallet) → Pick (4 lines/min) → Pack (3 cartons/min) → Ship (1 pallet/min). Bottleneck detection identifies the slowest step.</p><p><strong>Pro Tips:</strong> Always include 15% PFD for manual operations. For hybrid automation (conveyor + manual), split the workflow. Use the benchmark library to compare your standards to industry norms by product type and equipment class.</p>', summary: 'How to use MOST templates, quick analysis, workflow composer', tags: ['most', 'labor', 'standards', 'wms', 'guide'], author: 'Brock Eckles', status: 'published', viewCount: 189 },

  { id: 'w7', title: 'Network & Fleet Analysis', categoryId: 'transportation', content: '<p>The IES Hub provides three complementary tools for transportation and logistics network design:</p><p><strong>Network Optimizer</strong solves facility location and mode selection. Multi-mode costing includes TL (full truckload), LTL (less-than-truckload), and Parcel (FedEx/UPS). Service-level constraints ensure meet delivery windows. The tool supports demand heatmaps to visualize concentration and scenario comparison (1 DC vs. 2 DC vs. 3 DC).</p><p><strong>Fleet Modeler</strong sizes dedicated private fleets for high-volume lanes. Configure vehicle specs (5 ATRI types from van to 53-ft trailer), input weekly shipment volumes, and solve for fleet composition. Output includes 3-way cost comparison (Private ownership vs. GXO Dedicated vs. Common Carrier) and ATRI benchmark comparison.</p><p><strong>Center of Gravity</strong uses k-means clustering to identify optimal facility locations. Inputs are weighted demand points (lat/lng, volume). Output is a set of cluster centers with assignments showing which demand points feed each facility. Sensitivity analysis shows the cost/benefit of adding more facilities.</p><p><strong>Pro Tips:</strong> Use NetOpt for strategic network design and baseline freight cost. Use Fleet Modeler for dedicated lanes with predictable volume. Use Center of Gravity for tactical facility location studies and site selection. All three tools export results for DOS documentation.</p>', summary: 'Overview of NetOpt, Fleet Modeler, COG tools and when to use each', tags: ['network', 'fleet', 'transportation', 'optimization', 'logistics'], author: 'Brock Eckles', status: 'published', viewCount: 145 },

  // Reference
  { id: 'w8', title: 'DOS Stages Explained', categoryId: 'dos-process', content: '<p>The Deal Operating System (DOS) is GXOs stage-gate process for managing opportunities from initial interest through delivery handover. Six stages ensure rigor and alignment:</p><p><strong>Stage 1: Pre-Sales Engagement</strong> — Validate customer credit, execute NDA, request SCAN documents (facility, operations, staffing profiles). Goal: determine if customer is viable. Duration: 1-2 weeks.</p><p><strong>Stage 2: Deal Qualification</strong> — Assign solution lead, schedule qualification meeting, scope the opportunity (volume, SKU mix, service-level requirements). Goal: confirm engagement and assemble team. Duration: 1-2 weeks.</p><p><strong>Stage 3: Kick-Off & Solution Design</strong> — Execute 15-element solution design workbook: data analysis, cost modeling, facility design, labor standards, equipment specs, process flows, timeline, pricing, and customer fit assessment. Goal: deliver proposal-ready documentation. Duration: 4-8 weeks.</p><p><strong>Stage 4: Operations Review</strong> — Present findings to GXO operations, logistics, and finance. Review feasibility, risk, and profitability. Goal: internal sign-off on operational plan. Duration: 1-2 weeks.</p><p><strong>Stage 5: Executive Review</strong> — Present to ELT (Executive Leadership Team) for final approval. Customer presentation and negotiation. Goal: customer acceptance and contract execution. Duration: 2-4 weeks.</p><p><strong>Stage 6: Delivery Handover</strong> — Legal review, issue SLAs, JPS (Job Plan Summary), LOI (Letter of Intent), PAF (Project Approval Form), and transition to CoD (Center of Delivery). Goal: operational readiness. Duration: 8-12 weeks.</p>', summary: '6 stages of Deal Operating System with descriptions and timelines', tags: ['dos', 'stages', 'process', 'deals', 'reference'], author: 'Brock Eckles', status: 'published', viewCount: 298 },

  { id: 'w9', title: '3PL Cost Model Fundamentals', categoryId: 'cost-modeling', content: '<p>Third-party logistics (3PL) cost models typically include six cost blocks aligned with GXOs profit centers:</p><p><strong>Facility Costs</strong> include rent, utilities, insurance, property tax, and maintenance. Typically 15-25% of total cost depending on automation level and real estate market.</p><p><strong>Labor Costs</strong> cover all direct and indirect staffing (warehouse, supervision, IT, quality). MOST standards set direct labor; burden multipliers (1.3-1.4x) include supervision, training, benefits, and payroll taxes. Usually 30-40% of total cost.</p><p><strong>Equipment & Materials</strong> include MHE (material handling equipment), WCS (warehouse control systems), conveyor, and consumables. Typically 10-15% of cost but varies by automation strategy.</p><p><strong>Overhead</strong> covers indirect costs: management, finance, legal, HR, and shared services (recruiting, training). Usually 10-15% of total.</p><p><strong>Service & VAS</strong> model value-added services: labeling, kitting, sequencing, returns, quality assurance. Priced as add-ons with high margins (30-50%). Typically 5-10% of total unless service-intensive.</p><p><strong>Transportation & Fulfillment</strong> covers inbound freight (from supplier), handling within facility, and outbound delivery. Typically 5-20% depending on destination density and service-level requirements.</p><p><strong>Pricing Models:</strong> Cost-plus (base cost + 15-25% margin), Transactional (per-pallet, per-line, per-hour rates), or Hybrid (blended fixed + variable). Customer incentives tie pricing to volume, duration, or KPI achievement.</p>', summary: 'Cost blocks, pricing types, margin targets, and financial modeling patterns', tags: ['cost-model', 'pricing', '3pl', 'financials', 'fundamentals'], author: 'Brock Eckles', status: 'published', viewCount: 167 },

  { id: 'w10', title: 'GXO Warehouse Technology & MOST Methodology', categoryId: 'best-practices', content: '<p>GXO\'s core warehouse technology stack revolves around Blue Yonder (BY) WMS, which is the standard for all IES operations. When building solutions and labor standards, align with BY workflows and configuration patterns.</p><p><strong>Blue Yonder Modules Referenced in IES:</strong> Receiving (dock management, putaway wave creation), Putaway (slot optimization, CFS), Order Management (order release, wave planning, delivery routing), Picking (discrete/batch/wave modes, task interleaving), Packing (cartonization, label generation, weight verification), Shipping (manifest creation, load planning), Labor Management (standard rate setting, productivity monitoring), and Cycle Count (inventory reconciliation).</p><p><strong>MOST Methodology Alignment:</strong> MOST is a time-study system that predicts labor productivity based on motion sequences, not historical rates. The predefined motion table (A-B-G-A) ensures consistency across locations. When building MOST templates in IES, map each step to a BY screen or physical action. This ensures our labor standards reflect real operational capability.</p><p><strong>Best Practices:</strong> Use MOST for new sites or process redesigns. Include PFD (fatigue) allowances: 15% for manual pick/pack, 10% for scanning-intensive, 5% for automated. Template naming: BY-[Module]-[Activity]. Store templates as reusable components; update annually with efficiency improvements. Cross-reference BY screen captures in templates for training.</p><p><strong>Pro Tip:</strong> MOST standards correlate tightly with customer satisfaction: unrealistic standards lead to burnout and quality issues. Conservative standards (add 5-10% buffer) often yield better results than aggressive targets.</p>', summary: 'Blue Yonder WMS, MOST methodology alignment, and BY workflow integration', tags: ['blue-yonder', 'wms', 'most', 'labor', 'best-practices', 'integration'], author: 'Brock Eckles', status: 'published', viewCount: 98 },
];
