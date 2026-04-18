/**
 * IES Hub v3 — Training Wiki UI
 * Knowledge base with category sidebar, article list, article viewer, and search.
 *
 * @module hub/training-wiki/ui
 */

import { bus } from '../../shared/event-bus.js?v=20260418-sJ';
import * as calc from './calc.js?v=20260418-sJ';

/** @type {HTMLElement|null} */
let rootEl = null;
let activeCategory = 'all';
let activeArticle = null;
let searchQuery = '';
let articles = calc.DEMO_ARTICLES.map(a => ({ ...a }));
let categories = calc.DEMO_CATEGORIES.map(c => ({ ...c }));

export async function mount(el) {
  rootEl = el;
  activeCategory = 'all';
  activeArticle = null;
  searchQuery = '';
  el.innerHTML = renderShell();
  bindEvents();
  renderSidebar();
  renderMain();
  bus.emit('wiki:mounted');
}

export function unmount() { rootEl = null; bus.emit('wiki:unmounted'); }

function renderShell() {
  return `
    <div class="hub-content-inner" style="padding:0;display:flex;height:100%;">
      <div id="wiki-sidebar" style="width:240px;flex-shrink:0;border-right:1px solid var(--ies-gray-200);padding:16px;overflow-y:auto;"></div>
      <div id="wiki-main" style="flex:1;overflow-y:auto;padding:24px;"></div>
    </div>
  `;
}

function bindEvents() {
  if (!rootEl) return;

  rootEl.addEventListener('click', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);

    // Category click in sidebar
    const catItem = target.closest('[data-cat]');
    if (catItem) {
      activeCategory = /** @type {HTMLElement} */ (catItem).dataset.cat;
      activeArticle = null;
      renderSidebar();
      renderMain();
      return;
    }

    // Article card click
    const articleCard = target.closest('[data-article]');
    if (articleCard) {
      activeArticle = articles.find(a => a.id === /** @type {HTMLElement} */ (articleCard).dataset.article);
      if (activeArticle) activeArticle.viewCount = (activeArticle.viewCount || 0) + 1;
      renderMain();
      return;
    }

    // Back button
    if (target.closest('#wiki-back')) {
      activeArticle = null;
      renderMain();
      return;
    }
  });

  rootEl.addEventListener('input', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    if (target.matches('#wiki-search')) {
      searchQuery = /** @type {HTMLInputElement} */ (target).value;
      renderMain();
    }
  });
}

function renderSidebar() {
  const el = rootEl?.querySelector('#wiki-sidebar');
  if (!el) return;
  const stats = calc.computeStats(articles, categories);
  const perCat = calc.articlesPerCategory(articles, categories);

  el.innerHTML = `
    <h2 class="text-page" style="margin:0 0 16px 0;">Training Wiki</h2>
    <div style="margin-bottom:16px;">
      <input type="text" placeholder="Search articles..." value="${searchQuery}" id="wiki-search"
             style="width:100%;padding:8px 12px;border:1px solid var(--ies-gray-200);border-radius:6px;font-size:13px;">
    </div>
    <div style="margin-bottom:12px;">
      <span class="text-caption" style="color:var(--ies-gray-400);">CATEGORIES</span>
    </div>
    <div data-cat="all" style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:6px;cursor:pointer;margin-bottom:4px;
         background:${'all' === activeCategory ? 'var(--ies-blue)' : 'transparent'};color:${'all' === activeCategory ? '#fff' : 'var(--ies-gray-600)'};">
      <span style="font-size:13px;font-weight:600;flex:1;">All Articles</span>
      <span style="font-size:11px;font-weight:700;opacity:0.7;">${stats.totalArticles}</span>
    </div>
    ${perCat.map(pc => {
      const cat = categories.find(c => c.id === pc.categoryId);
      return `
        <div data-cat="${pc.categoryId}" style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-radius:6px;cursor:pointer;margin-bottom:4px;
             background:${pc.categoryId === activeCategory ? 'var(--ies-blue)' : 'transparent'};color:${pc.categoryId === activeCategory ? '#fff' : 'var(--ies-gray-600)'};">
          <span style="font-size:14px;">${cat?.icon || '📄'}</span>
          <span style="font-size:13px;font-weight:600;flex:1;">${pc.categoryName}</span>
          <span style="font-size:11px;font-weight:700;opacity:0.7;">${pc.count}</span>
        </div>
      `;
    }).join('')}
    <div style="border-top:1px solid var(--ies-gray-200);margin:16px 0;"></div>
    <div style="font-size:11px;color:var(--ies-gray-400);">
      ${stats.publishedArticles} published • ${stats.totalViews.toLocaleString()} views
    </div>
  `;

  // Search input handled by delegated events at root level
}

function renderMain() {
  const el = rootEl?.querySelector('#wiki-main');
  if (!el) return;
  if (activeArticle) { renderArticle(el); return; }

  // Search or filter
  let filtered = searchQuery
    ? calc.searchArticles(articles, searchQuery).map(r => articles.find(a => a.id === r.articleId)).filter(Boolean)
    : calc.filterByCategory(articles, activeCategory).filter(a => a.status === 'published');

  filtered = calc.sortArticles(filtered, 'views', 'desc');

  el.innerHTML = `
    <div style="max-width:800px;">
      ${searchQuery ? `<div style="font-size:13px;color:var(--ies-gray-400);margin-bottom:16px;">${filtered.length} result(s) for "${searchQuery}"</div>` : ''}
      ${filtered.length === 0 ? '<div class="hub-card"><p class="text-body text-muted">No articles found.</p></div>' :
        filtered.map(a => `
          <div class="hub-card" style="margin-bottom:12px;cursor:pointer;padding:16px;" data-article="${a.id}">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
              <span style="font-size:14px;font-weight:700;">${a.title}</span>
              <span style="font-size:11px;color:var(--ies-gray-400);">${calc.readingTime(a.content)} min read</span>
            </div>
            <div style="font-size:13px;color:var(--ies-gray-400);margin-bottom:8px;">${a.summary || ''}</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              ${(a.tags || []).map(t => `<span style="display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:600;background:#f3f4f6;color:#6b7280;">${t}</span>`).join('')}
              <span style="margin-left:auto;font-size:11px;color:var(--ies-gray-400);">${(a.viewCount || 0).toLocaleString()} views</span>
            </div>
          </div>
        `).join('')}
    </div>
  `;

  // Article clicks handled by delegated events at root level
}

function renderArticle(el) {
  if (!activeArticle) return;
  const cat = categories.find(c => c.id === activeArticle.categoryId);
  const cleanHtml = calc.normalizeArticleHtml(activeArticle.content || '');

  el.innerHTML = `
    <div style="max-width:880px;">
      <button class="hub-btn hub-btn-sm hub-btn-secondary" id="wiki-back" style="margin-bottom:16px;">← Back to Articles</button>
      <div style="margin-bottom:8px;">
        <span style="font-size:11px;font-weight:700;color:var(--ies-gray-400);text-transform:uppercase;letter-spacing:0.04em;">${cat?.icon || ''} ${cat?.name || 'Uncategorized'}</span>
      </div>
      <h2 style="font-size:22px;font-weight:800;margin:0 0 8px 0;color:var(--ies-navy);letter-spacing:-0.01em;">${activeArticle.title}</h2>
      <div style="display:flex;gap:16px;font-size:11px;color:var(--ies-gray-400);margin-bottom:20px;font-weight:600;">
        <span>By ${activeArticle.author}</span>
        <span>${calc.readingTime(activeArticle.content)} min read</span>
        <span>${(activeArticle.viewCount || 0).toLocaleString()} views</span>
      </div>
      <div class="hub-card hub-wiki-article" style="padding:28px 32px;">
        ${cleanHtml}
      </div>
      <div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap;">
        ${(activeArticle.tags || []).map(t => `<span style="display:inline-block;padding:4px 12px;border-radius:20px;font-size:11px;font-weight:600;background:#dbeafe;color:#1d4ed8;">${t}</span>`).join('')}
      </div>
    </div>
  `;

  // Back button handled by delegated events at root level
}
